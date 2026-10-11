// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FairworkArbitration} from "./FairworkArbitration.sol";

/// @title Fairwork Phase 3 milestone escrow
/// @notice Local-chain-only job agreements, exact-token funding, milestone settlement, and bounded arbitration.
/// @dev Arbitration state lives in a separate engine; settlement credits ledgers without calling the configured token.
contract FairworkEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant MAX_WINDOW = 365 days;
    uint8 public constant MAX_MILESTONES = 10;
    uint8 public constant MAX_REVISION_LIMIT = 5;
    uint8 public constant MAX_TOKENS = 3;
    uint16 private constant DISPUTE_DEPOSIT_BPS = 200;
    uint256 public constant MAX_MILESTONE_AMOUNT = 1e18;
    uint256 public constant MAX_JOB_TOTAL_AMOUNT = 10e18;

    enum JobState {
        Proposed,
        AcceptedUnfunded,
        Funded,
        Cancelled,
        Closed
    }

    enum MilestoneState {
        Ready,
        Submitted,
        Rejected,
        Disputed,
        Released,
        Refunded,
        Resolved
    }

    enum SettlementReason {
        Approval,
        ReviewSilence,
        MissedDelivery,
        RejectionSilence
    }

    struct TokenConfig {
        address token;
        uint8 decimals;
        uint256 minAmount;
        uint256 maxAmount;
        bytes32 codehash;
    }

    struct ProtocolConfig {
        uint64 fundingWindow;
        uint64 gracePeriod;
        uint64 minDuration;
        uint64 maxDuration;
        uint64 minReviewWindow;
        uint64 maxReviewWindow;
    }

    struct JobInput {
        address freelancer;
        address token;
        bytes32 titleCommitment;
        bytes32 descriptionCommitment;
        bytes32 scopeCommitment;
        bytes32 deliveryRuleCommitment;
        uint64 reviewWindow;
        uint8 revisionLimit;
    }

    struct MilestoneInput {
        uint256 amount;
        uint64 duration;
        bytes32 acceptanceCriteriaCommitment;
    }

    struct JobView {
        address client;
        address freelancer;
        address token;
        JobState state;
        uint256 totalAmount;
        uint64 createdAt;
        uint64 proposalEnd;
        uint64 acceptedAt;
        uint64 fundingDeadline;
        uint64 fundedAt;
        uint64 reviewWindow;
        uint8 revisionLimit;
        uint8 milestoneCount;
    }

    struct MilestoneView {
        uint256 amount;
        uint64 duration;
        bytes32 acceptanceCriteriaCommitment;
        uint64 deadline;
        uint64 graceEnd;
        MilestoneState state;
        uint64 submittedAt;
        uint64 reviewEnd;
        uint64 rejectedAt;
        uint64 responseEnd;
        uint8 rejectionCount;
        uint8 submissionCount;
        bytes32 latestReasonCommitment;
    }

    struct Submission {
        uint8 version;
        bytes32 deliverableHash;
        bytes32 opaqueReference;
        uint64 submittedAt;
    }

    struct Job {
        address client;
        address freelancer;
        address token;
        JobState state;
        uint256 totalAmount;
        uint64 createdAt;
        uint64 proposalEnd;
        uint64 acceptedAt;
        uint64 fundingDeadline;
        uint64 fundedAt;
        uint64 reviewWindow;
        uint8 revisionLimit;
        uint8 milestoneCount;
        bytes32 titleCommitment;
        bytes32 descriptionCommitment;
        bytes32 scopeCommitment;
        bytes32 deliveryRuleCommitment;
        uint8 terminalMilestoneCount;
    }

    struct Milestone {
        uint256 amount;
        uint64 duration;
        bytes32 acceptanceCriteriaCommitment;
        uint64 deadline;
        uint64 graceEnd;
        MilestoneState state;
        uint64 submittedAt;
        uint64 reviewEnd;
        uint64 rejectedAt;
        uint64 responseEnd;
        uint8 rejectionCount;
        uint8 submissionCount;
        bytes32 latestReasonCommitment;
    }

    struct DisputeSettlement {
        uint256 clientPrincipalCredit;
        uint256 freelancerPrincipalCredit;
        uint256 clientRefund;
        uint256 freelancerRefund;
        uint256 clientCredit;
        uint256 freelancerCredit;
        uint256 treasuryCredit;
        uint256 postedDeposits;
    }

    error Unauthorized();
    error InvalidChainId();
    error InvalidAddress();
    error InvalidToken(address token);
    error InvalidTokenConfig();
    error InvalidAmount();
    error InvalidDuration();
    error InvalidWindow();
    error InvalidCommitment();
    error InvalidRevisionLimit();
    error InvalidMilestoneCount();
    error InvalidState();
    error WindowOpen();
    error WindowClosed();
    error ExactTransferRequired();
    error TokenCodeChanged(address token);
    error InvalidArbiter();
    error ArbiterLimitReached();
    error EvidenceLimitReached();
    error InvalidVote();

    address public immutable owner;
    address public immutable treasury;
    uint64 public immutable responseWindow;
    address public immutable arbitrationEngine;
    address public immutable randomness;

    uint256 public jobCount;
    mapping(address token => uint256 amount) public lockedEscrow;
    mapping(address token => uint256 amount) public totalClaimable;
    mapping(address token => mapping(address account => uint256 amount)) public claimable;
    mapping(address token => uint256 amount) public disputeDeposits;
    mapping(address token => uint256 amount) public arbiterStakes;

    mapping(address token => TokenConfig config) private _tokenConfigs;
    mapping(uint256 jobId => Job job) private _jobs;
    mapping(uint256 jobId => Milestone[] milestones) private _milestones;
    mapping(uint256 jobId => mapping(uint256 milestoneIndex => Submission[] submissions)) private _submissions;
    ProtocolConfig private _protocolConfig;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed freelancer,
        address token,
        uint256 totalAmount,
        uint8 milestoneCount,
        uint64 createdAt,
        uint64 proposalEnd
    );
    event JobAccepted(uint256 indexed jobId, uint64 acceptedAt, uint64 fundingDeadline);
    event JobFunded(uint256 indexed jobId, uint256 totalAmount, uint64 fundedAt);
    event JobCancelled(uint256 indexed jobId);
    event ClaimableCredited(address indexed token, address indexed account, uint256 amount);
    event WithdrawalCompleted(address indexed token, address indexed account, uint256 amount);
    event MilestoneSubmitted(
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        uint8 version,
        bytes32 deliverableHash,
        bytes32 opaqueReference,
        uint64 submittedAt,
        uint64 reviewEnd
    );
    event MilestoneRejected(
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        uint8 rejectionCount,
        bytes32 reasonCommitment,
        uint64 rejectedAt,
        uint64 responseEnd
    );
    event MilestoneApproved(
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        uint256 amount,
        address freelancer
    );
    event MilestoneAutoReleased(
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        uint256 amount,
        address freelancer
    );
    event MilestoneRefunded(
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        uint256 amount,
        address client,
        uint8 timeoutKind
    );
    event MilestoneSettlementCredited(
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        address indexed token,
        address account,
        uint256 amount,
        uint8 reason
    );
    event JobClosed(uint256 indexed jobId);
    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        address opener,
        uint256 depositAmount,
        uint64 evidenceDeadline
    );
    event DisputeDepositMatched(uint256 indexed disputeId, address indexed party, uint256 amount);
    event DisputeSettlementCredited(
        uint256 indexed disputeId,
        address indexed token,
        address indexed account,
        uint256 amount,
        uint8 source
    );
    event MilestoneResolved(
        uint256 indexed jobId,
        uint256 indexed milestoneIndex,
        uint256 indexed disputeId,
        uint16 bps,
        uint256 freelancerCredit,
        uint256 clientCredit,
        uint256 treasuryCredit,
        bool fallbackApplied
    );

    /// @notice Deploys an immutable allowlist and protocol timing configuration for local chain 31337.
    /// @dev A zero configured codehash captures the deployed token's current runtime codehash.
    constructor(TokenConfig[] memory tokenConfigs, ProtocolConfig memory protocolConfig_, address treasury_) {
        if (block.chainid != 31337) revert InvalidChainId();
        if (treasury_ == address(0)) revert InvalidAddress();
        _validateProtocolConfig(protocolConfig_);
        if (tokenConfigs.length == 0 || tokenConfigs.length > MAX_TOKENS) revert InvalidTokenConfig();

        for (uint256 i; i < tokenConfigs.length; ++i) {
            TokenConfig memory config = tokenConfigs[i];
            if (
                config.token == address(0) || config.token.code.length == 0 || config.minAmount == 0
                    || config.maxAmount < config.minAmount || config.maxAmount > MAX_MILESTONE_AMOUNT
                    || !_supportedDecimals(config.decimals)
            ) revert InvalidTokenConfig();

            for (uint256 j; j < i; ++j) {
                if (tokenConfigs[j].token == config.token) revert InvalidTokenConfig();
            }

            uint8 runtimeDecimals;
            try IERC20Metadata(config.token).decimals() returns (uint8 value) {
                runtimeDecimals = value;
            } catch {
                revert InvalidTokenConfig();
            }
            if (runtimeDecimals != config.decimals) revert InvalidTokenConfig();

            bytes32 runtimeCodehash = config.token.codehash;
            if (config.codehash != bytes32(0) && config.codehash != runtimeCodehash) {
                revert InvalidTokenConfig();
            }
            config.codehash = runtimeCodehash;
            _tokenConfigs[config.token] = config;
        }

        owner = msg.sender;
        treasury = treasury_;
        _protocolConfig = protocolConfig_;
        responseWindow = protocolConfig_.fundingWindow;

        FairworkArbitration engine = new FairworkArbitration(address(this), protocolConfig_.fundingWindow);
        arbitrationEngine = address(engine);
        randomness = engine.randomness();
    }

    /// @notice Owner forwards bounded arbiter-registry changes to the immutable arbitration engine.
    function addArbiter(address arbiter) external nonReentrant {
        if (msg.sender != owner) revert Unauthorized();
        FairworkArbitration(arbitrationEngine).addArbiter(arbiter);
    }

    function removeArbiter(address arbiter) external nonReentrant {
        if (msg.sender != owner) revert Unauthorized();
        FairworkArbitration(arbitrationEngine).removeArbiter(arbiter);
    }

    function arbiterCount() external view returns (uint256) {
        return FairworkArbitration(arbitrationEngine).arbiterCount();
    }

    function arbiterAt(uint256 index) external view returns (address) {
        return FairworkArbitration(arbitrationEngine).arbiterAt(index);
    }

    function isArbiter(address arbiter) external view returns (bool) {
        return FairworkArbitration(arbitrationEngine).isArbiter(arbiter);
    }

    function disputeConfig()
        external
        view
        returns (
            uint64 evidenceWindow,
            uint64 commitWindow,
            uint64 replacementCommitWindow,
            uint64 revealWindow,
            uint64 randomnessTimeout,
            uint16 depositBps
        )
    {
        FairworkArbitration engine = FairworkArbitration(arbitrationEngine);
        return (
            engine.evidenceWindow(),
            engine.commitWindow(),
            engine.replacementCommitWindow(),
            engine.revealWindow(),
            engine.randomnessTimeout(),
            DISPUTE_DEPOSIT_BPS
        );
    }

    /// @notice Opens a single dispute from an eligible submitted or rejected milestone and collects its opener deposit.
    /// @dev Principal stays locked; the exact incoming deposit is tracked as a separate per-token liability.
    function openDispute(uint256 jobId, uint256 milestoneIndex)
        external
        nonReentrant
        returns (uint256 disputeId)
    {
        Job storage job = _jobOrRevert(jobId);
        if (job.state != JobState.Funded || milestoneIndex >= _milestones[jobId].length) revert InvalidState();
        Milestone storage milestone = _milestones[jobId][milestoneIndex];
        uint64 openedAt = _now64();
        if (milestone.state == MilestoneState.Submitted) {
            if (msg.sender != job.client) revert Unauthorized();
            if (openedAt >= milestone.reviewEnd) revert WindowClosed();
        } else if (milestone.state == MilestoneState.Rejected) {
            if (msg.sender != job.client && msg.sender != job.freelancer) revert Unauthorized();
            if (openedAt >= milestone.responseEnd) revert WindowClosed();
        } else {
            revert InvalidState();
        }

        TokenConfig storage config = _requireToken(job.token);
        IERC20 token = IERC20(job.token);
        uint256 balanceBefore = token.balanceOf(address(this));
        uint256 depositAmount = milestone.amount * DISPUTE_DEPOSIT_BPS / 10_000;
        if (depositAmount == 0) depositAmount = 1;

        milestone.state = MilestoneState.Disputed;
        disputeId = FairworkArbitration(arbitrationEngine).openDispute(
            jobId,
            milestoneIndex,
            job.client,
            job.freelancer,
            job.token,
            milestone.amount,
            depositAmount,
            msg.sender
        );
        disputeDeposits[job.token] += depositAmount;
        uint64 evidenceDeadline = openedAt + _protocolConfig.fundingWindow;
        emit DisputeOpened(disputeId, jobId, milestoneIndex, msg.sender, depositAmount, evidenceDeadline);

        token.safeTransferFrom(msg.sender, address(this), depositAmount);
        _assertCodehash(job.token, config);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != depositAmount) {
            revert ExactTransferRequired();
        }
    }

    /// @notice Allows only the dispute counterparty to post one exact matching deposit before evidence closes.
    function matchDisputeDeposit(uint256 disputeId) external nonReentrant {
        (address tokenAddress, uint256 depositAmount) =
            FairworkArbitration(arbitrationEngine).matchDisputeDeposit(disputeId, msg.sender);
        TokenConfig storage config = _requireToken(tokenAddress);
        IERC20 token = IERC20(tokenAddress);
        uint256 balanceBefore = token.balanceOf(address(this));
        disputeDeposits[tokenAddress] += depositAmount;
        emit DisputeDepositMatched(disputeId, msg.sender, depositAmount);

        token.safeTransferFrom(msg.sender, address(this), depositAmount);
        _assertCodehash(tokenAddress, config);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != depositAmount) {
            revert ExactTransferRequired();
        }
    }

    function submitEvidence(uint256 disputeId, bytes32 evidenceHash, bytes32 opaqueReference) external nonReentrant {
        FairworkArbitration(arbitrationEngine).submitEvidence(disputeId, msg.sender, evidenceHash, opaqueReference);
    }

    function advanceDispute(uint256 disputeId) external nonReentrant {
        (bool terminal, uint16 rulingBps, bool fallbackApplied) =
            FairworkArbitration(arbitrationEngine).advanceDispute(disputeId);
        if (terminal) _settleDispute(disputeId, rulingBps, fallbackApplied);
    }

    function commitVote(uint256 disputeId, bytes32 commitment) external nonReentrant {
        FairworkArbitration(arbitrationEngine).commitVote(disputeId, msg.sender, commitment);
    }

    function revealVote(uint256 disputeId, uint16 bps, bytes32 salt) external nonReentrant {
        FairworkArbitration(arbitrationEngine).revealVote(disputeId, msg.sender, bps, salt);
    }

    function voteCommitment(uint256 disputeId, address arbiter, uint16 bps, bytes32 salt)
        external
        view
        returns (bytes32)
    {
        return FairworkArbitration(arbitrationEngine).voteCommitment(disputeId, arbiter, bps, salt);
    }

    function getMilestoneDispute(uint256 jobId, uint256 milestoneIndex) external view returns (uint256) {
        _jobOrRevert(jobId);
        if (milestoneIndex >= _milestones[jobId].length) revert InvalidState();
        return FairworkArbitration(arbitrationEngine).getMilestoneDispute(jobId, milestoneIndex);
    }

    function getDispute(uint256 disputeId) external view returns (FairworkArbitration.DisputeView memory) {
        return FairworkArbitration(arbitrationEngine).getDispute(disputeId);
    }

    function getPanel(uint256 disputeId, uint8 round) external view returns (address[3] memory) {
        return FairworkArbitration(arbitrationEngine).getPanel(disputeId, round);
    }

    function getPanel1History(uint256 disputeId) external view returns (address[] memory) {
        return FairworkArbitration(arbitrationEngine).getPanel1History(disputeId);
    }

    function getVote(uint256 disputeId, uint8 round, address arbiter)
        external
        view
        returns (bytes32 commitment, uint16 bps, bool revealed)
    {
        return FairworkArbitration(arbitrationEngine).getVote(disputeId, round, arbiter);
    }

    function getEvidence(uint256 disputeId, address party, uint256 index)
        external
        view
        returns (bytes32 evidenceHash, bytes32 opaqueReference, uint64 submittedAt)
    {
        return FairworkArbitration(arbitrationEngine).getEvidence(disputeId, party, index);
    }

    /// @notice Creates a direct job proposal whose named freelancer must accept before funding.
    /// @dev Commitment fields are opaque bytes32 values; the client is always msg.sender.
    function createJob(JobInput calldata terms, MilestoneInput[] calldata milestones)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (terms.freelancer == address(0) || terms.freelancer == msg.sender) revert InvalidAddress();
        TokenConfig storage config = _requireToken(terms.token);
        if (
            terms.titleCommitment == bytes32(0) || terms.descriptionCommitment == bytes32(0)
                || terms.scopeCommitment == bytes32(0) || terms.deliveryRuleCommitment == bytes32(0)
        ) revert InvalidCommitment();
        if (terms.revisionLimit > MAX_REVISION_LIMIT) revert InvalidRevisionLimit();
        if (
            terms.reviewWindow < _protocolConfig.minReviewWindow
                || terms.reviewWindow > _protocolConfig.maxReviewWindow
        ) revert InvalidWindow();
        if (milestones.length == 0 || milestones.length > MAX_MILESTONES) {
            revert InvalidMilestoneCount();
        }

        uint256 totalAmount;
        for (uint256 i; i < milestones.length; ++i) {
            MilestoneInput calldata input = milestones[i];
            if (input.amount < config.minAmount || input.amount > config.maxAmount) revert InvalidAmount();
            if (
                input.duration < _protocolConfig.minDuration || input.duration > _protocolConfig.maxDuration
            ) revert InvalidDuration();
            if (input.acceptanceCriteriaCommitment == bytes32(0)) revert InvalidCommitment();
            totalAmount += input.amount;
            if (totalAmount > MAX_JOB_TOTAL_AMOUNT) revert InvalidAmount();
        }

        uint64 createdAt = _now64();
        uint64 proposalEnd = createdAt + _protocolConfig.fundingWindow;
        jobId = jobCount;
        jobCount = jobId + 1;

        Job storage job = _jobs[jobId];
        job.client = msg.sender;
        job.freelancer = terms.freelancer;
        job.token = terms.token;
        job.state = JobState.Proposed;
        job.totalAmount = totalAmount;
        job.createdAt = createdAt;
        job.proposalEnd = proposalEnd;
        job.reviewWindow = terms.reviewWindow;
        job.revisionLimit = terms.revisionLimit;
        job.milestoneCount = uint8(milestones.length);
        job.titleCommitment = terms.titleCommitment;
        job.descriptionCommitment = terms.descriptionCommitment;
        job.scopeCommitment = terms.scopeCommitment;
        job.deliveryRuleCommitment = terms.deliveryRuleCommitment;

        Milestone[] storage storedMilestones = _milestones[jobId];
        for (uint256 i; i < milestones.length; ++i) {
            MilestoneInput calldata input = milestones[i];
            storedMilestones.push(
                Milestone({
                    amount: input.amount,
                    duration: input.duration,
                    acceptanceCriteriaCommitment: input.acceptanceCriteriaCommitment,
                    deadline: 0,
                    graceEnd: 0,
                    state: MilestoneState.Ready,
                    submittedAt: 0,
                    reviewEnd: 0,
                    rejectedAt: 0,
                    responseEnd: 0,
                    rejectionCount: 0,
                    submissionCount: 0,
                    latestReasonCommitment: bytes32(0)
                })
            );
        }

        emit JobCreated(
            jobId,
            msg.sender,
            terms.freelancer,
            terms.token,
            totalAmount,
            uint8(milestones.length),
            createdAt,
            proposalEnd
        );
    }

    /// @notice Records acceptance by the freelancer named in the proposal before proposal expiry.
    /// @dev Acceptance starts a fresh bounded funding window but does not start delivery clocks.
    function acceptJob(uint256 jobId) external nonReentrant {
        Job storage job = _jobOrRevert(jobId);
        if (job.state != JobState.Proposed) revert InvalidState();
        if (msg.sender != job.freelancer) revert Unauthorized();
        uint64 acceptedAt = _now64();
        if (acceptedAt >= job.proposalEnd) revert WindowClosed();

        job.state = JobState.AcceptedUnfunded;
        job.acceptedAt = acceptedAt;
        job.fundingDeadline = acceptedAt + _protocolConfig.fundingWindow;
        emit JobAccepted(jobId, job.acceptedAt, job.fundingDeadline);
    }

    /// @notice Locks the client's complete raw-unit milestone total before the funding deadline.
    /// @dev State, liabilities, and event are written before transferFrom; a non-exact receipt reverts all changes.
    function fundJob(uint256 jobId) external nonReentrant {
        Job storage job = _jobOrRevert(jobId);
        if (job.state != JobState.AcceptedUnfunded) revert InvalidState();
        if (msg.sender != job.client) revert Unauthorized();
        uint64 fundedAt = _now64();
        if (fundedAt >= job.fundingDeadline) revert WindowClosed();

        TokenConfig storage config = _requireToken(job.token);
        IERC20 token = IERC20(job.token);
        uint256 balanceBefore = token.balanceOf(address(this));

        job.state = JobState.Funded;
        job.fundedAt = fundedAt;
        lockedEscrow[job.token] += job.totalAmount;
        Milestone[] storage milestones = _milestones[jobId];
        for (uint256 i; i < milestones.length; ++i) {
            Milestone storage milestone = milestones[i];
            milestone.deadline = fundedAt + milestone.duration;
            milestone.graceEnd = milestone.deadline + _protocolConfig.gracePeriod;
        }
        emit JobFunded(jobId, job.totalAmount, fundedAt);

        token.safeTransferFrom(msg.sender, address(this), job.totalAmount);
        _assertCodehash(job.token, config);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != job.totalAmount) {
            revert ExactTransferRequired();
        }
    }

    /// @notice Cancels an unaccepted proposal at or after its expiry without moving funds.
    /// @dev Anyone may perform this bounded timeout transition.
    function cancelExpiredProposal(uint256 jobId) external nonReentrant {
        Job storage job = _jobOrRevert(jobId);
        if (job.state != JobState.Proposed) revert InvalidState();
        if (_now64() < job.proposalEnd) revert WindowOpen();
        job.state = JobState.Cancelled;
        emit JobCancelled(jobId);
    }

    /// @notice Cancels an accepted job at or after the funding deadline without moving funds.
    /// @dev Anyone may perform this bounded timeout transition.
    function cancelUnfundedJob(uint256 jobId) external nonReentrant {
        Job storage job = _jobOrRevert(jobId);
        if (job.state != JobState.AcceptedUnfunded) revert InvalidState();
        if (_now64() < job.fundingDeadline) revert WindowOpen();
        job.state = JobState.Cancelled;
        emit JobCancelled(jobId);
    }

    /// @notice The named freelancer records a deliverable commitment before the milestone's grace cutoff.
    /// @dev Appends immutable versioned metadata and starts the agreed review window; the opaque reference may be zero.
    function submitMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 deliverableHash, bytes32 opaqueReference)
        external
        nonReentrant
    {
        Job storage job = _jobOrRevert(jobId);
        if (msg.sender != job.freelancer) revert Unauthorized();
        Milestone storage milestone = _fundedMilestone(jobId, milestoneIndex);
        if (milestone.state != MilestoneState.Ready) revert InvalidState();
        if (deliverableHash == bytes32(0)) revert InvalidCommitment();

        uint64 submittedAt = _now64();
        if (submittedAt >= milestone.graceEnd) revert WindowClosed();
        _appendSubmission(jobId, milestoneIndex, job, milestone, deliverableHash, opaqueReference, submittedAt);
    }

    /// @notice The named client approves the current submission before its review window ends.
    /// @dev Releases the milestone to the freelancer's claimable ledger without calling the token.
    function approveMilestone(uint256 jobId, uint256 milestoneIndex) external nonReentrant {
        Job storage job = _jobOrRevert(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        Milestone storage milestone = _fundedMilestone(jobId, milestoneIndex);
        if (milestone.state != MilestoneState.Submitted) revert InvalidState();

        uint64 now_ = _now64();
        if (now_ >= milestone.reviewEnd) revert WindowClosed();

        (address token, uint256 amount, bool closesJob) =
            _settleMilestone(jobId, milestoneIndex, job.freelancer, MilestoneState.Released);
        emit MilestoneApproved(jobId, milestoneIndex, amount, job.freelancer);
        _emitSettlementCredit(jobId, milestoneIndex, token, job.freelancer, amount, SettlementReason.Approval);
        if (closesJob) emit JobClosed(jobId);
    }

    /// @notice The named client rejects the current submission while a negotiated revision remains.
    /// @dev Stores only a nonzero reason commitment and starts a fresh response window for this milestone.
    function rejectMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 reasonCommitment) external nonReentrant {
        Job storage job = _jobOrRevert(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        Milestone storage milestone = _fundedMilestone(jobId, milestoneIndex);
        if (milestone.state != MilestoneState.Submitted) revert InvalidState();
        if (milestone.rejectionCount >= job.revisionLimit) revert InvalidRevisionLimit();
        if (reasonCommitment == bytes32(0)) revert InvalidCommitment();

        uint64 rejectedAt = _now64();
        if (rejectedAt >= milestone.reviewEnd) revert WindowClosed();
        uint8 rejectionCount = milestone.rejectionCount + 1;
        uint64 responseEnd = rejectedAt + responseWindow;
        milestone.rejectionCount = rejectionCount;
        milestone.latestReasonCommitment = reasonCommitment;
        milestone.rejectedAt = rejectedAt;
        milestone.responseEnd = responseEnd;
        milestone.state = MilestoneState.Rejected;
        emit MilestoneRejected(jobId, milestoneIndex, rejectionCount, reasonCommitment, rejectedAt, responseEnd);
    }

    /// @notice The named freelancer appends a new version during the rejection response window.
    /// @dev Resubmission restarts review and may proceed after the original delivery grace period.
    function resubmitMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 deliverableHash, bytes32 opaqueReference)
        external
        nonReentrant
    {
        Job storage job = _jobOrRevert(jobId);
        if (msg.sender != job.freelancer) revert Unauthorized();
        Milestone storage milestone = _fundedMilestone(jobId, milestoneIndex);
        if (milestone.state != MilestoneState.Rejected) revert InvalidState();
        if (deliverableHash == bytes32(0)) revert InvalidCommitment();

        uint64 submittedAt = _now64();
        if (submittedAt >= milestone.responseEnd) revert WindowClosed();
        _appendSubmission(jobId, milestoneIndex, job, milestone, deliverableHash, opaqueReference, submittedAt);
    }

    /// @notice Anyone can release a submitted milestone after the client review window expires.
    /// @dev Credits the named freelancer and terminalizes the milestone without an external token call.
    function releaseAfterSilence(uint256 jobId, uint256 milestoneIndex) external nonReentrant {
        Job storage job = _jobOrRevert(jobId);
        Milestone storage milestone = _fundedMilestone(jobId, milestoneIndex);
        if (milestone.state != MilestoneState.Submitted) revert InvalidState();

        uint64 now_ = _now64();
        if (now_ < milestone.reviewEnd) revert WindowOpen();

        (address token, uint256 amount, bool closesJob) =
            _settleMilestone(jobId, milestoneIndex, job.freelancer, MilestoneState.Released);
        emit MilestoneAutoReleased(jobId, milestoneIndex, amount, job.freelancer);
        _emitSettlementCredit(jobId, milestoneIndex, token, job.freelancer, amount, SettlementReason.ReviewSilence);
        if (closesJob) emit JobClosed(jobId);
    }

    /// @notice Anyone can refund a Ready milestone after its delivery grace period expires.
    /// @dev Credits the named client and terminalizes the milestone without an external token call.
    function refundAfterMissedDeadline(uint256 jobId, uint256 milestoneIndex) external nonReentrant {
        _jobOrRevert(jobId);
        Milestone storage milestone = _fundedMilestone(jobId, milestoneIndex);
        if (milestone.state != MilestoneState.Ready) revert InvalidState();

        uint64 now_ = _now64();
        if (now_ < milestone.graceEnd) revert WindowOpen();

        Job storage job = _jobs[jobId];
        (address token, uint256 amount, bool closesJob) =
            _settleMilestone(jobId, milestoneIndex, job.client, MilestoneState.Refunded);
        emit MilestoneRefunded(
            jobId,
            milestoneIndex,
            amount,
            job.client,
            uint8(SettlementReason.MissedDelivery)
        );
        _emitSettlementCredit(jobId, milestoneIndex, token, job.client, amount, SettlementReason.MissedDelivery);
        if (closesJob) emit JobClosed(jobId);
    }

    /// @notice Anyone can refund a rejected milestone after its response window expires.
    /// @dev Credits the named client; a resubmitted milestone is no longer eligible for this timer.
    function refundAfterRejectionWindow(uint256 jobId, uint256 milestoneIndex) external nonReentrant {
        _jobOrRevert(jobId);
        Milestone storage milestone = _fundedMilestone(jobId, milestoneIndex);
        if (milestone.state != MilestoneState.Rejected) revert InvalidState();

        uint64 now_ = _now64();
        if (now_ < milestone.responseEnd) revert WindowOpen();

        Job storage job = _jobs[jobId];
        (address token, uint256 amount, bool closesJob) =
            _settleMilestone(jobId, milestoneIndex, job.client, MilestoneState.Refunded);
        emit MilestoneRefunded(
            jobId,
            milestoneIndex,
            amount,
            job.client,
            uint8(SettlementReason.RejectionSilence)
        );
        _emitSettlementCredit(jobId, milestoneIndex, token, job.client, amount, SettlementReason.RejectionSilence);
        if (closesJob) emit JobClosed(jobId);
    }

    /// @notice Withdraws only the caller's claimable amount for one configured token.
    /// @dev Claim effects precede transfer; both escrow debit and recipient credit must match exactly.
    function withdraw(address tokenAddress) external nonReentrant {
        TokenConfig storage config = _requireToken(tokenAddress);
        uint256 amount = claimable[tokenAddress][msg.sender];
        if (amount == 0) revert InvalidAmount();

        IERC20 token = IERC20(tokenAddress);
        uint256 escrowBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(msg.sender);
        if (escrowBefore < amount) revert ExactTransferRequired();

        claimable[tokenAddress][msg.sender] = 0;
        totalClaimable[tokenAddress] -= amount;
        emit WithdrawalCompleted(tokenAddress, msg.sender, amount);

        token.safeTransfer(msg.sender, amount);
        _assertCodehash(tokenAddress, config);

        uint256 escrowAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(msg.sender);
        if (
            escrowAfter > escrowBefore || escrowBefore - escrowAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert ExactTransferRequired();
    }

    /// @notice Returns the bounded read model for a job.
    /// @dev Unknown job IDs revert instead of returning a default record.
    function getJob(uint256 jobId) external view returns (JobView memory view_) {
        Job storage job = _jobOrRevert(jobId);
        view_ = JobView({
            client: job.client,
            freelancer: job.freelancer,
            token: job.token,
            state: job.state,
            totalAmount: job.totalAmount,
            createdAt: job.createdAt,
            proposalEnd: job.proposalEnd,
            acceptedAt: job.acceptedAt,
            fundingDeadline: job.fundingDeadline,
            fundedAt: job.fundedAt,
            reviewWindow: job.reviewWindow,
            revisionLimit: job.revisionLimit,
            milestoneCount: job.milestoneCount
        });
    }

    /// @notice Returns one milestone from a job's bounded milestone list.
    /// @dev Milestone order is fixed at creation and clocks remain zero until funding.
    function getMilestone(uint256 jobId, uint256 milestoneIndex) external view returns (MilestoneView memory view_) {
        _jobOrRevert(jobId);
        if (milestoneIndex >= _milestones[jobId].length) revert InvalidState();
        Milestone storage milestone = _milestones[jobId][milestoneIndex];
        view_ = MilestoneView({
            amount: milestone.amount,
            duration: milestone.duration,
            acceptanceCriteriaCommitment: milestone.acceptanceCriteriaCommitment,
            deadline: milestone.deadline,
            graceEnd: milestone.graceEnd,
            state: milestone.state,
            submittedAt: milestone.submittedAt,
            reviewEnd: milestone.reviewEnd,
            rejectedAt: milestone.rejectedAt,
            responseEnd: milestone.responseEnd,
            rejectionCount: milestone.rejectionCount,
            submissionCount: milestone.submissionCount,
            latestReasonCommitment: milestone.latestReasonCommitment
        });
    }

    /// @notice Returns one immutable version from a milestone's bounded submission history.
    /// @dev Unknown jobs, milestones, and submission indexes revert instead of returning default metadata.
    function getSubmission(uint256 jobId, uint256 milestoneIndex, uint256 submissionIndex)
        external
        view
        returns (Submission memory submission)
    {
        _jobOrRevert(jobId);
        if (milestoneIndex >= _milestones[jobId].length) revert InvalidState();
        Submission[] storage history = _submissions[jobId][milestoneIndex];
        if (submissionIndex >= history.length) revert InvalidState();
        return history[submissionIndex];
    }

    /// @notice Returns the four opaque commitments agreed when the job was created.
    /// @dev No commitment is interpreted as public text or a URL by this contract.
    function getJobCommitments(uint256 jobId)
        external
        view
        returns (bytes32 title, bytes32 description, bytes32 scope, bytes32 deliveryRule)
    {
        Job storage job = _jobOrRevert(jobId);
        return (job.titleCommitment, job.descriptionCommitment, job.scopeCommitment, job.deliveryRuleCommitment);
    }

    /// @notice Returns the immutable deployment-time config for one supported token.
    /// @dev The returned codehash is the pinned runtime hash used before token interactions.
    function tokenConfig(address token) external view returns (TokenConfig memory) {
        TokenConfig storage config = _tokenConfigs[token];
        if (config.token == address(0)) revert InvalidToken(token);
        return config;
    }

    /// @dev Applies a completed engine ruling to the principal and deposit ledgers without calling the token.
    function _settleDispute(uint256 disputeId, uint16 bps, bool fallbackApplied) private {
        FairworkArbitration.DisputeView memory dispute =
            FairworkArbitration(arbitrationEngine).getDispute(disputeId);
        Job storage job = _jobs[dispute.jobId];
        Milestone storage milestone = _milestones[dispute.jobId][dispute.milestoneIndex];
        if (job.state != JobState.Funded || milestone.state != MilestoneState.Disputed) revert InvalidState();

        DisputeSettlement memory amounts = _calculateDisputeSettlement(dispute, bps, fallbackApplied);

        lockedEscrow[dispute.token] -= dispute.amount;
        disputeDeposits[dispute.token] -= amounts.postedDeposits;
        milestone.state = MilestoneState.Resolved;
        job.terminalMilestoneCount += 1;
        bool closesJob = job.terminalMilestoneCount == job.milestoneCount;
        if (closesJob) job.state = JobState.Closed;

        claimable[dispute.token][dispute.client] += amounts.clientCredit;
        claimable[dispute.token][dispute.freelancer] += amounts.freelancerCredit;
        claimable[dispute.token][treasury] += amounts.treasuryCredit;
        totalClaimable[dispute.token] += amounts.clientCredit + amounts.freelancerCredit + amounts.treasuryCredit;

        _emitDisputeCredit(disputeId, dispute.token, dispute.client, amounts.clientPrincipalCredit, 0);
        _emitDisputeCredit(disputeId, dispute.token, dispute.freelancer, amounts.freelancerPrincipalCredit, 0);
        _emitDisputeCredit(disputeId, dispute.token, dispute.client, amounts.clientRefund, 1);
        _emitDisputeCredit(disputeId, dispute.token, dispute.freelancer, amounts.freelancerRefund, 1);
        _emitDisputeCredit(disputeId, dispute.token, treasury, amounts.treasuryCredit, 2);
        emit MilestoneResolved(
            dispute.jobId,
            dispute.milestoneIndex,
            disputeId,
            bps,
            amounts.freelancerCredit,
            amounts.clientCredit,
            amounts.treasuryCredit,
            fallbackApplied
        );
        if (closesJob) emit JobClosed(dispute.jobId);
    }

    function _calculateDisputeSettlement(
        FairworkArbitration.DisputeView memory dispute,
        uint16 bps,
        bool fallbackApplied
    ) private pure returns (DisputeSettlement memory amounts) {
        uint256 freelancerPrincipal = dispute.amount * bps / 10_000;
        uint256 clientPrincipal = dispute.amount - freelancerPrincipal;
        uint256 clientForfeitDue;
        uint256 freelancerForfeitDue;
        if (!fallbackApplied) {
            if (bps > 5_000) clientForfeitDue = dispute.depositAmount;
            else if (bps < 5_000) freelancerForfeitDue = dispute.depositAmount;
            else {
                clientForfeitDue = dispute.depositAmount / 2;
                freelancerForfeitDue = dispute.depositAmount / 2;
            }
        }

        uint256 clientDepositForfeit = dispute.clientDeposited ? clientForfeitDue : 0;
        uint256 freelancerDepositForfeit = dispute.freelancerDeposited ? freelancerForfeitDue : 0;
        uint256 clientPrincipalForfeit = dispute.clientDeposited
            ? 0
            : (clientForfeitDue < clientPrincipal ? clientForfeitDue : clientPrincipal);
        uint256 freelancerPrincipalForfeit = dispute.freelancerDeposited
            ? 0
            : (freelancerForfeitDue < freelancerPrincipal ? freelancerForfeitDue : freelancerPrincipal);
        amounts.clientRefund = dispute.clientDeposited ? dispute.depositAmount - clientDepositForfeit : 0;
        amounts.freelancerRefund = dispute.freelancerDeposited
            ? dispute.depositAmount - freelancerDepositForfeit
            : 0;
        amounts.clientPrincipalCredit = clientPrincipal - clientPrincipalForfeit;
        amounts.freelancerPrincipalCredit = freelancerPrincipal - freelancerPrincipalForfeit;
        amounts.clientCredit = amounts.clientPrincipalCredit + amounts.clientRefund;
        amounts.freelancerCredit = amounts.freelancerPrincipalCredit + amounts.freelancerRefund;
        amounts.treasuryCredit = clientDepositForfeit + freelancerDepositForfeit + clientPrincipalForfeit
            + freelancerPrincipalForfeit;
        amounts.postedDeposits = (dispute.clientDeposited ? dispute.depositAmount : 0)
            + (dispute.freelancerDeposited ? dispute.depositAmount : 0);
    }

    function _emitDisputeCredit(
        uint256 disputeId,
        address token,
        address account,
        uint256 amount,
        uint8 source
    ) private {
        if (amount == 0) return;
        emit DisputeSettlementCredited(disputeId, token, account, amount, source);
        emit ClaimableCredited(token, account, amount);
    }

    /// @notice Returns the immutable duration and funding bounds selected at deployment.
    /// @dev This local-only build runs on chain 31337; no production configuration is implemented.
    function protocolConfig() external view returns (ProtocolConfig memory) {
        return _protocolConfig;
    }

    /// @dev Internal test-fixture seam: move existing locked principal into a claimable balance.
    /// This helper is not an external payout path or a production settlement proof.
    function _creditFromEscrow(address token, address recipient, uint256 amount) internal {
        TokenConfig storage config = _requireToken(token);
        _assertCodehash(token, config);
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        if (amount == 0 || amount > lockedEscrow[token]) revert InvalidAmount();

        lockedEscrow[token] -= amount;
        claimable[token][recipient] += amount;
        totalClaimable[token] += amount;
        emit ClaimableCredited(token, recipient, amount);
    }

    function _fundedMilestone(uint256 jobId, uint256 milestoneIndex) private view returns (Milestone storage milestone) {
        Job storage job = _jobs[jobId];
        if (job.state != JobState.Funded) revert InvalidState();
        if (milestoneIndex >= _milestones[jobId].length) revert InvalidState();
        milestone = _milestones[jobId][milestoneIndex];
    }

    function _appendSubmission(
        uint256 jobId,
        uint256 milestoneIndex,
        Job storage job,
        Milestone storage milestone,
        bytes32 deliverableHash,
        bytes32 opaqueReference,
        uint64 submittedAt
    ) private {
        uint8 historyLimit = job.revisionLimit + 1;
        if (milestone.submissionCount >= historyLimit) revert InvalidRevisionLimit();

        uint8 version = milestone.submissionCount + 1;
        uint64 reviewEnd = submittedAt + job.reviewWindow;
        _submissions[jobId][milestoneIndex].push(
            Submission({
                version: version,
                deliverableHash: deliverableHash,
                opaqueReference: opaqueReference,
                submittedAt: submittedAt
            })
        );
        milestone.submissionCount = version;
        milestone.submittedAt = submittedAt;
        milestone.reviewEnd = reviewEnd;
        milestone.state = MilestoneState.Submitted;
        emit MilestoneSubmitted(
            jobId,
            milestoneIndex,
            version,
            deliverableHash,
            opaqueReference,
            submittedAt,
            reviewEnd
        );
    }

    function _settleMilestone(
        uint256 jobId,
        uint256 milestoneIndex,
        address beneficiary,
        MilestoneState terminalState
    ) private returns (address token, uint256 amount, bool closesJob) {
        Job storage job = _jobs[jobId];
        Milestone storage milestone = _milestones[jobId][milestoneIndex];
        token = job.token;
        amount = milestone.amount;

        milestone.state = terminalState;
        lockedEscrow[token] -= amount;
        claimable[token][beneficiary] += amount;
        totalClaimable[token] += amount;
        job.terminalMilestoneCount += 1;
        closesJob = job.terminalMilestoneCount == job.milestoneCount;
        if (closesJob) job.state = JobState.Closed;
    }

    function _emitSettlementCredit(
        uint256 jobId,
        uint256 milestoneIndex,
        address token,
        address beneficiary,
        uint256 amount,
        SettlementReason reason
    ) private {
        emit MilestoneSettlementCredited(jobId, milestoneIndex, token, beneficiary, amount, uint8(reason));
        emit ClaimableCredited(token, beneficiary, amount);
    }

    function _jobOrRevert(uint256 jobId) private view returns (Job storage job) {
        job = _jobs[jobId];
        if (job.client == address(0)) revert InvalidState();
    }

    function _requireToken(address token) private view returns (TokenConfig storage config) {
        config = _tokenConfigs[token];
        if (config.token == address(0)) revert InvalidToken(token);
        _assertCodehash(token, config);
    }

    function _assertCodehash(address token, TokenConfig storage config) private view {
        if (token.codehash != config.codehash) revert TokenCodeChanged(token);
    }

    function _validateProtocolConfig(ProtocolConfig memory config) private pure {
        if (
            config.fundingWindow == 0 || config.fundingWindow > MAX_WINDOW || config.gracePeriod == 0
                || config.gracePeriod > MAX_WINDOW
        ) revert InvalidWindow();
        if (
            config.minDuration == 0 || config.minDuration > config.maxDuration || config.maxDuration > MAX_WINDOW
        ) revert InvalidDuration();
        if (
            config.minReviewWindow == 0 || config.minReviewWindow > config.maxReviewWindow
                || config.maxReviewWindow > MAX_WINDOW
        ) revert InvalidWindow();
    }

    function _supportedDecimals(uint8 decimals_) private pure returns (bool) {
        return decimals_ == 6 || decimals_ == 8 || decimals_ == 18;
    }

    function _now64() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert InvalidWindow();
        return uint64(block.timestamp);
    }
}
