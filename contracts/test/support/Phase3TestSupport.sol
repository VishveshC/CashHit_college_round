// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {FairworkEscrow} from "../../src/FairworkEscrow.sol";
import {MockToken} from "./MockTokens.sol";

/// @dev ABI-only Phase 3 seam. Keeping this local lets the suite compile against
/// the frozen Phase 2 source and produce runtime RED for absent selectors.
interface IPhase3Escrow {
    struct MilestoneView {
        uint256 amount;
        uint64 duration;
        bytes32 acceptanceCriteriaCommitment;
        uint64 deadline;
        uint64 graceEnd;
        uint8 state;
        uint64 submittedAt;
        uint64 reviewEnd;
        uint64 rejectedAt;
        uint64 responseEnd;
        uint8 rejectionCount;
        uint8 submissionCount;
        bytes32 latestReasonCommitment;
    }

    struct DisputeView {
        uint256 jobId;
        uint256 milestoneIndex;
        address client;
        address freelancer;
        address token;
        uint256 amount;
        uint256 depositAmount;
        address opener;
        uint8 phase;
        uint8 round;
        uint8 purpose;
        uint8 attempt;
        uint64 openedAt;
        uint64 evidenceDeadline;
        uint64 commitDeadline;
        uint64 replacementCommitDeadline;
        uint64 revealDeadline;
        uint64 requestEnd;
        uint256 activeRequestId;
        bool randomnessReady;
        uint16 rulingBps;
        bool fallbackApplied;
        bool clientDeposited;
        bool freelancerDeposited;
        uint8 clientEvidenceCount;
        uint8 freelancerEvidenceCount;
        uint8 fallbackReason;
    }

    error Unauthorized();
    error InvalidState();
    error WindowOpen();
    error WindowClosed();
    error InvalidCommitment();
    error InvalidAmount();
    error InvalidAddress();
    error ExactTransferRequired();
    error InvalidArbiter();
    error ArbiterLimitReached();
    error EvidenceLimitReached();
    error InvalidVote();

    event ArbiterAdded(address indexed arbiter);
    event ArbiterRemoved(address indexed arbiter);
    event EvidenceCommitted(
        uint256 indexed disputeId,
        address indexed party,
        uint8 version,
        bytes32 evidenceHash,
        bytes32 opaqueReference,
        uint64 submittedAt
    );
    event PanelRequested(uint256 indexed disputeId, uint256 indexed requestId, uint8 purpose, uint8 attempt, uint64 requestEnd);
    event RandomnessReceived(uint256 indexed disputeId, uint256 indexed requestId);
    event PanelSelected(uint256 indexed disputeId, uint8 round, address[3] panel);
    event PanelPhaseAdvanced(uint256 indexed disputeId, uint8 phase, uint64 deadline);
    event VoteCommitted(uint256 indexed disputeId, uint8 round, address indexed arbiter, bytes32 commitment);
    event VoteRevealed(uint256 indexed disputeId, uint8 round, address indexed arbiter, uint16 bps);
    event DisputeRuled(uint256 indexed disputeId, uint16 bps);
    event DisputeFallbackApplied(uint256 indexed disputeId, uint8 reason);
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

    function owner() external view returns (address);
    function treasury() external view returns (address);
    function arbitrationEngine() external view returns (address);
    function randomness() external view returns (address);
    function disputeConfig()
        external
        view
        returns (uint64 evidenceWindow, uint64 commitWindow, uint64 replacementCommitWindow, uint64 revealWindow, uint64 randomnessTimeout, uint16 depositBps);
    function addArbiter(address arbiter) external;
    function removeArbiter(address arbiter) external;
    function arbiterCount() external view returns (uint256);
    function arbiterAt(uint256 index) external view returns (address);
    function isArbiter(address arbiter) external view returns (bool);
    function openDispute(uint256 jobId, uint256 milestoneIndex) external returns (uint256 disputeId);
    function matchDisputeDeposit(uint256 disputeId) external;
    function submitEvidence(uint256 disputeId, bytes32 evidenceHash, bytes32 opaqueReference) external;
    function advanceDispute(uint256 disputeId) external;
    function commitVote(uint256 disputeId, bytes32 commitment) external;
    function revealVote(uint256 disputeId, uint16 bps, bytes32 salt) external;
    function voteCommitment(uint256 disputeId, address arbiter, uint16 bps, bytes32 salt) external view returns (bytes32);
    function getMilestoneDispute(uint256 jobId, uint256 milestoneIndex) external view returns (uint256);
    function disputeDeposits(address token) external view returns (uint256);
    function arbiterStakes(address token) external view returns (uint256);
    function getDispute(uint256 disputeId) external view returns (DisputeView memory);
    function getPanel(uint256 disputeId, uint8 round) external view returns (address[3] memory);
    function getPanel1History(uint256 disputeId) external view returns (address[] memory);
    function getVote(uint256 disputeId, uint8 round, address arbiter)
        external
        view
        returns (bytes32 commitment, uint16 bps, bool revealed);
    function getEvidence(uint256 disputeId, address party, uint256 index)
        external
        view
        returns (bytes32 evidenceHash, bytes32 opaqueReference, uint64 submittedAt);
    function getMilestone(uint256 jobId, uint256 milestoneIndex) external view returns (MilestoneView memory);
    function releaseAfterSilence(uint256 jobId, uint256 milestoneIndex) external;
    function refundAfterRejectionWindow(uint256 jobId, uint256 milestoneIndex) external;
    function lockedEscrow(address token) external view returns (uint256);
    function totalClaimable(address token) external view returns (uint256);
    function claimable(address token, address account) external view returns (uint256);
}

interface IPhase3Engine {
    function fulfillRandomness(uint256 requestId, uint256 word) external;
}

interface IPhase3Randomness {
    function fulfill(uint256 requestId) external;
    function setRequestMode(uint8 mode) external;
}

abstract contract Phase3TestBase is Test {
    address internal constant CLIENT = address(0xC11E);
    address internal constant FREELANCER = address(0xFEE);
    address internal constant OTHER = address(0xB0B);
    address internal constant TREASURY = address(0x7EA5);
    uint64 internal constant FUNDING_WINDOW = 60;
    uint64 internal constant GRACE_PERIOD = 15;
    uint64 internal constant REVIEW_WINDOW = 120;
    uint64 internal constant START_TIME = 1_800_000_000;
    bytes32 internal constant TERMS = keccak256("phase 3 test terms");

    MockToken internal token;
    FairworkEscrow internal escrow;
    IPhase3Escrow internal p3;

    function setUp() public virtual {
        vm.chainId(31337);
        vm.warp(START_TIME);
        token = new MockToken("USDC test", "USDC", 6);
        escrow = _deployEscrow(address(token), 6);
        p3 = IPhase3Escrow(address(escrow));
        token.mint(CLIENT, 10_000_000e6);
        token.mint(FREELANCER, 10_000_000e6);
        vm.prank(CLIENT);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(FREELANCER);
        token.approve(address(escrow), type(uint256).max);
    }

    function _deployEscrow(address tokenAddress, uint8 decimals_) internal returns (FairworkEscrow deployed) {
        FairworkEscrow.TokenConfig[] memory tokenConfigs = new FairworkEscrow.TokenConfig[](1);
        tokenConfigs[0] = FairworkEscrow.TokenConfig({
            token: tokenAddress,
            decimals: decimals_,
            minAmount: 1,
            maxAmount: 1e18,
            codehash: bytes32(0)
        });
        FairworkEscrow.ProtocolConfig memory config = FairworkEscrow.ProtocolConfig({
            fundingWindow: FUNDING_WINDOW,
            gracePeriod: GRACE_PERIOD,
            minDuration: 1,
            maxDuration: 365 days,
            minReviewWindow: 1,
            maxReviewWindow: 30 days
        });
        deployed = new FairworkEscrow(tokenConfigs, config, TREASURY);
    }

    function _fundedJob(uint256 amount, uint8 revisionLimit) internal returns (uint256 jobId) {
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(amount, 10, keccak256("criteria"));
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(token),
            titleCommitment: TERMS,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: revisionLimit
        });
        vm.prank(CLIENT);
        jobId = escrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);
    }

    function _fundedJobWithToken(address tokenAddress, uint256 amount, uint8 revisionLimit, address freelancer)
        internal
        returns (uint256 jobId)
    {
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(amount, 10, keccak256("criteria"));
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: freelancer,
            token: tokenAddress,
            titleCommitment: TERMS,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: revisionLimit
        });
        vm.prank(CLIENT);
        jobId = escrow.createJob(terms, milestones);
        vm.prank(freelancer);
        escrow.acceptJob(jobId);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);
    }

    function _submit(uint256 jobId) internal {
        vm.prank(FREELANCER);
        IPhase2Read(address(escrow)).submitMilestone(jobId, 0, keccak256("delivery"), bytes32(0));
    }

    function _openSubmitted(uint256 amount, uint8 revisionLimit) internal returns (uint256 jobId, uint256 disputeId) {
        jobId = _fundedJob(amount, revisionLimit);
        _submit(jobId);
        vm.prank(CLIENT);
        disputeId = p3.openDispute(jobId, 0);
    }

    function _openRejected(uint256 amount, address opener) internal returns (uint256 jobId, uint256 disputeId) {
        jobId = _fundedJob(amount, 1);
        _submit(jobId);
        vm.prank(CLIENT);
        IPhase2Read(address(escrow)).rejectMilestone(jobId, 0, keccak256("reason"));
        vm.prank(opener);
        disputeId = p3.openDispute(jobId, 0);
    }

    function _register(address arbiter) internal {
        p3.addArbiter(arbiter);
    }

    function _registerMany(uint256 count) internal returns (address[] memory arbiters) {
        arbiters = new address[](count);
        for (uint256 i; i < count; ++i) {
            address arbiter = address(uint160(0xA000 + i));
            arbiters[i] = arbiter;
            p3.addArbiter(arbiter);
        }
    }

    function _requestInitial(uint256 disputeId) internal returns (uint256 requestId) {
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        assertEq(dispute.phase, 1, "evidence phase before the first panel request");
        vm.warp(dispute.evidenceDeadline);
        p3.advanceDispute(disputeId);
        dispute = p3.getDispute(disputeId);
        assertEq(dispute.phase, 2, "first request enters pending phase");
        requestId = dispute.activeRequestId;
        assertGt(requestId, 0, "request id is nonzero");
    }

    function _fulfillAndSelect(uint256 disputeId) internal returns (address[3] memory panel) {
        uint256 requestId = _requestInitial(disputeId);
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 3, "timely entropy selects Panel 1");
        panel = p3.getPanel(disputeId, 1);
    }

    function _commit(uint256 disputeId, address arbiter, uint16 bps, bytes32 salt) internal {
        bytes32 commitment = keccak256(abi.encode(block.chainid, address(escrow), disputeId, arbiter, bps, salt));
        vm.prank(arbiter);
        p3.commitVote(disputeId, commitment);
    }

    function _reveal(uint256 disputeId, address arbiter, uint16 bps, bytes32 salt) internal {
        vm.prank(arbiter);
        p3.revealVote(disputeId, bps, salt);
    }

    function _salt(uint256 disputeId, address arbiter, uint16 bps) internal pure returns (bytes32) {
        return keccak256(abi.encode("vote test salt", disputeId, arbiter, bps));
    }

    function _isPanelMember(address[3] memory panel, address who) internal pure returns (bool) {
        return panel[0] == who || panel[1] == who || panel[2] == who;
    }

    function _assertDistinctNonzero(address[3] memory panel) internal pure {
        assertTrue(panel[0] != address(0) && panel[1] != address(0) && panel[2] != address(0));
        assertTrue(panel[0] != panel[1] && panel[0] != panel[2] && panel[1] != panel[2]);
    }
}

interface IPhase2Read {
    function submitMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 deliverableHash, bytes32 opaqueReference)
        external;
    function rejectMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 reasonCommitment) external;
    function getMilestone(uint256 jobId, uint256 milestoneIndex) external view returns (IPhase3Escrow.MilestoneView memory);
}
