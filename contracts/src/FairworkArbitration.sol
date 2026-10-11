// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IRandomness} from "./interfaces/IRandomness.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @title Fairwork arbitration state engine
/// @notice Bounded registry, dispute, panel, evidence, vote, and randomness state for the local Phase 3 slice.
/// @dev This engine never handles tokens or escrow liabilities. Every mutation is forwarded by its immutable escrow,
///      except the entropy-only callback from its immutable DEMO ONLY adapter.
contract FairworkArbitration {
    uint8 private constant EVIDENCE = 1;
    uint8 private constant RANDOMNESS_PENDING_1 = 2;
    uint8 private constant PANEL_1_COMMIT = 3;
    uint8 private constant REPLACEMENT_RANDOMNESS_PENDING = 4;
    uint8 private constant PANEL_1_REPLACEMENT_COMMIT = 5;
    uint8 private constant PANEL_1_REVEAL = 6;
    uint8 private constant RANDOMNESS_PENDING_2 = 7;
    uint8 private constant PANEL_2_COMMIT = 8;
    uint8 private constant PANEL_2_REVEAL = 9;
    uint8 private constant SETTLED = 10;

    uint8 private constant INITIAL_PANEL = 0;
    uint8 private constant REPLACEMENT = 1;
    uint8 private constant SECOND_PANEL = 2;

    uint8 private constant FALLBACK_POOL_EXHAUSTED = 1;
    uint8 private constant FALLBACK_RANDOMNESS_TIMEOUT = 2;
    uint8 private constant FALLBACK_NO_QUORUM = 3;

    uint8 private constant MAX_ARBITERS = 128;
    uint8 private constant EVIDENCE_LIMIT = 5;
    uint8 private constant MAX_RETRIES = 2;
    uint8 private constant PANEL_SIZE = 3;

    error Unauthorized();
    error InvalidChainId();
    error InvalidAddress();
    error InvalidState();
    error WindowOpen();
    error WindowClosed();
    error InvalidCommitment();
    error InvalidArbiter();
    error ArbiterLimitReached();
    error EvidenceLimitReached();
    error InvalidVote();
    error InvalidWindow();

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

    struct Evidence {
        bytes32 evidenceHash;
        bytes32 opaqueReference;
        uint64 submittedAt;
    }

    struct Vote {
        bytes32 commitment;
        uint16 bps;
        bool revealed;
    }

    struct Dispute {
        DisputeView viewData;
        address[3] panel1;
        address[3] panel2;
        address[] panel1History;
        address[] drawCandidates;
        bool[3] replacementSlots;
        uint8 replacementVacancies;
        uint8 panel1RevealCount;
        uint8 panel2RevealCount;
        uint256 entropyWord;
        mapping(uint8 round => mapping(address arbiter => Vote vote)) votes;
        mapping(address party => Evidence[] items) evidence;
    }

    address public immutable escrow;
    address public immutable randomness;
    uint64 public immutable evidenceWindow;
    uint64 public immutable commitWindow;
    uint64 public immutable replacementCommitWindow;
    uint64 public immutable revealWindow;
    uint64 public immutable randomnessTimeout;

    address[] private _arbiters;
    mapping(address arbiter => uint256 indexPlusOne) private _arbiterIndex;
    mapping(uint256 disputeId => Dispute dispute) private _disputes;
    mapping(bytes32 milestoneKey => uint256 disputeId) private _milestoneDisputes;
    mapping(uint256 requestId => uint256 disputeId) private _requestDisputes;
    uint256 private _lastDisputeId;
    uint256 private _nextRequestId = 1;

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
    event PanelRequested(
        uint256 indexed disputeId,
        uint256 indexed requestId,
        uint8 purpose,
        uint8 attempt,
        uint64 requestEnd
    );
    event RandomnessReceived(uint256 indexed disputeId, uint256 indexed requestId);
    event PanelSelected(uint256 indexed disputeId, uint8 round, address[3] panel);
    event PanelPhaseAdvanced(uint256 indexed disputeId, uint8 phase, uint64 deadline);
    event VoteCommitted(uint256 indexed disputeId, uint8 round, address indexed arbiter, bytes32 commitment);
    event VoteRevealed(uint256 indexed disputeId, uint8 round, address indexed arbiter, uint16 bps);
    event DisputeRuled(uint256 indexed disputeId, uint16 bps);
    event DisputeFallbackApplied(uint256 indexed disputeId, uint8 reason);

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert Unauthorized();
        _;
    }

    constructor(address escrow_, uint64 fundingWindow) {
        if (block.chainid != 31337) revert InvalidChainId();
        if (escrow_ == address(0)) revert InvalidAddress();
        if (fundingWindow == 0) revert InvalidWindow();

        escrow = escrow_;
        evidenceWindow = fundingWindow;
        commitWindow = fundingWindow;
        replacementCommitWindow = fundingWindow;
        revealWindow = fundingWindow;
        randomnessTimeout = fundingWindow;
        randomness = address(new MockRandomness());
    }

    /// @notice Adds one distinct allowlisted wallet; only the immutable escrow may forward this mutation.
    function addArbiter(address arbiter) external onlyEscrow {
        if (arbiter == address(0) || _arbiterIndex[arbiter] != 0) revert InvalidArbiter();
        if (_arbiters.length >= MAX_ARBITERS) revert ArbiterLimitReached();
        _arbiters.push(arbiter);
        _arbiterIndex[arbiter] = _arbiters.length;
        emit ArbiterAdded(arbiter);
    }

    /// @notice Removes an allowlisted wallet with swap-pop enumeration; existing assignments remain valid.
    function removeArbiter(address arbiter) external onlyEscrow {
        uint256 indexPlusOne = _arbiterIndex[arbiter];
        if (indexPlusOne == 0) revert InvalidArbiter();
        uint256 index = indexPlusOne - 1;
        uint256 last = _arbiters.length - 1;
        if (index != last) {
            address moved = _arbiters[last];
            _arbiters[index] = moved;
            _arbiterIndex[moved] = index + 1;
        }
        _arbiters.pop();
        delete _arbiterIndex[arbiter];
        emit ArbiterRemoved(arbiter);
    }

    function arbiterCount() external view returns (uint256) {
        return _arbiters.length;
    }

    function arbiterAt(uint256 index) external view returns (address) {
        if (index >= _arbiters.length) revert InvalidState();
        return _arbiters[index];
    }

    function isArbiter(address arbiter) external view returns (bool) {
        return _arbiterIndex[arbiter] != 0;
    }

    /// @notice Binds a freshly allocated dispute ID permanently to one escrow milestone.
    function openDispute(
        uint256 jobId,
        uint256 milestoneIndex,
        address client,
        address freelancer,
        address token,
        uint256 amount,
        uint256 depositAmount,
        address opener
    ) external onlyEscrow returns (uint256 disputeId) {
        if (client == address(0) || freelancer == address(0) || token == address(0) || opener == address(0)) {
            revert InvalidAddress();
        }
        bytes32 key = _milestoneKey(jobId, milestoneIndex);
        if (_milestoneDisputes[key] != 0) revert InvalidState();

        disputeId = ++_lastDisputeId;
        Dispute storage dispute = _disputes[disputeId];
        uint64 openedAt = _now64();
        dispute.viewData = DisputeView({
            jobId: jobId,
            milestoneIndex: milestoneIndex,
            client: client,
            freelancer: freelancer,
            token: token,
            amount: amount,
            depositAmount: depositAmount,
            opener: opener,
            phase: EVIDENCE,
            round: 0,
            purpose: INITIAL_PANEL,
            attempt: 0,
            openedAt: openedAt,
            evidenceDeadline: openedAt + evidenceWindow,
            commitDeadline: 0,
            replacementCommitDeadline: 0,
            revealDeadline: 0,
            requestEnd: 0,
            activeRequestId: 0,
            randomnessReady: false,
            rulingBps: 0,
            fallbackApplied: false,
            clientDeposited: opener == client,
            freelancerDeposited: opener == freelancer,
            clientEvidenceCount: 0,
            freelancerEvidenceCount: 0,
            fallbackReason: 0
        });
        _milestoneDisputes[key] = disputeId;
    }

    /// @notice Marks the one counterparty deposit before the evidence deadline.
    function matchDisputeDeposit(uint256 disputeId, address actor)
        external
        onlyEscrow
        returns (address token, uint256 depositAmount)
    {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        DisputeView storage view_ = dispute.viewData;
        bool isClient = actor == view_.client;
        bool isFreelancer = actor == view_.freelancer;
        if (!isClient && !isFreelancer) revert Unauthorized();
        if (actor == view_.opener) revert Unauthorized();
        if (view_.phase != EVIDENCE) revert InvalidState();
        if (_now64() >= view_.evidenceDeadline) revert WindowClosed();
        if (isClient ? view_.clientDeposited : view_.freelancerDeposited) {
            revert InvalidState();
        }
        if (isClient) view_.clientDeposited = true;
        else view_.freelancerDeposited = true;
        return (view_.token, view_.depositAmount);
    }

    /// @notice Stores only bounded evidence commitments and opaque references supplied by a dispute party.
    function submitEvidence(uint256 disputeId, address actor, bytes32 evidenceHash, bytes32 opaqueReference)
        external
        onlyEscrow
    {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        DisputeView storage view_ = dispute.viewData;
        if (actor != view_.client && actor != view_.freelancer) revert Unauthorized();
        if (view_.phase != EVIDENCE) revert InvalidState();
        uint64 submittedAt = _now64();
        if (submittedAt >= view_.evidenceDeadline) revert WindowClosed();
        if (evidenceHash == bytes32(0)) revert InvalidCommitment();

        Evidence[] storage items = dispute.evidence[actor];
        if (items.length >= EVIDENCE_LIMIT) revert EvidenceLimitReached();
        items.push(Evidence(evidenceHash, opaqueReference, submittedAt));
        uint8 version = uint8(items.length);
        if (actor == view_.client) view_.clientEvidenceCount = version;
        else view_.freelancerEvidenceCount = version;
        emit EvidenceCommitted(disputeId, actor, version, evidenceHash, opaqueReference, submittedAt);
    }

    /// @notice Commits one hash for a currently assigned arbiter during its commit window.
    function commitVote(uint256 disputeId, address actor, bytes32 commitment) external onlyEscrow {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        DisputeView storage view_ = dispute.viewData;
        uint8 round = _currentRound(view_.phase);
        if (round == 0) revert InvalidState();
        if (!_isPanelMember(dispute, round, actor)) revert Unauthorized();
        uint64 deadline;
        if (view_.phase == PANEL_1_COMMIT) deadline = view_.commitDeadline;
        else if (view_.phase == PANEL_1_REPLACEMENT_COMMIT) deadline = view_.replacementCommitDeadline;
        else if (view_.phase == PANEL_2_COMMIT) deadline = view_.commitDeadline;
        else revert InvalidState();
        if (_now64() >= deadline) revert WindowClosed();
        if (commitment == bytes32(0)) revert InvalidCommitment();

        Vote storage vote = dispute.votes[round][actor];
        if (vote.commitment != bytes32(0)) revert InvalidVote();
        vote.commitment = commitment;
        emit VoteCommitted(disputeId, round, actor, commitment);
    }

    /// @notice Reveals a valid committed vote for a current panel member in the reveal window.
    function revealVote(uint256 disputeId, address actor, uint16 bps, bytes32 salt) external onlyEscrow {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        DisputeView storage view_ = dispute.viewData;
        uint8 round = view_.phase == PANEL_1_REVEAL ? 1 : view_.phase == PANEL_2_REVEAL ? 2 : 0;
        if (round == 0) revert InvalidState();
        if (!_isPanelMember(dispute, round, actor)) revert Unauthorized();
        if (_now64() >= view_.revealDeadline) revert WindowClosed();

        Vote storage vote = dispute.votes[round][actor];
        if (
            vote.commitment == bytes32(0) || vote.revealed || bps > 10_000
                || vote.commitment != _voteCommitment(disputeId, actor, bps, salt)
        ) revert InvalidVote();
        vote.bps = bps;
        vote.revealed = true;
        if (round == 1) ++dispute.panel1RevealCount;
        else ++dispute.panel2RevealCount;
        emit VoteRevealed(disputeId, round, actor, bps);
    }

    /// @notice Authenticated entropy-only callback; it cannot advance a phase or touch escrow liabilities.
    function fulfillRandomness(uint256 requestId, uint256 word) external {
        if (msg.sender != randomness) revert Unauthorized();
        uint256 disputeId = _requestDisputes[requestId];
        if (disputeId == 0) return;
        Dispute storage dispute = _disputes[disputeId];
        DisputeView storage view_ = dispute.viewData;
        if (
            view_.activeRequestId != requestId || !_isRandomnessPending(view_.phase) || view_.randomnessReady
                || _now64() >= view_.requestEnd
        ) return;
        view_.randomnessReady = true;
        dispute.entropyWord = word;
        emit RandomnessReceived(disputeId, requestId);
    }

    /// @notice Advances one bounded arbitration phase or request retry.
    /// @return terminal True only when the escrow must atomically settle this dispute.
    function advanceDispute(uint256 disputeId)
        external
        onlyEscrow
        returns (bool terminal, uint16 rulingBps, bool fallbackApplied)
    {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        DisputeView storage view_ = dispute.viewData;
        uint64 now_ = _now64();

        if (view_.phase == EVIDENCE) {
            if (now_ < view_.evidenceDeadline) revert WindowOpen();
            _beginDraw(disputeId, dispute, INITIAL_PANEL, RANDOMNESS_PENDING_1, PANEL_SIZE);
            return (false, 0, false);
        }
        if (_isRandomnessPending(view_.phase)) {
            if (view_.randomnessReady) return _consumeEntropy(disputeId, dispute, now_);
            if (now_ < view_.requestEnd) revert WindowOpen();
            if (view_.attempt < MAX_RETRIES) {
                _requestAgain(disputeId, dispute, now_);
                return (false, 0, false);
            }
            return _applyFallback(disputeId, dispute, FALLBACK_RANDOMNESS_TIMEOUT);
        }
        if (view_.phase == PANEL_1_COMMIT) {
            if (now_ < view_.commitDeadline) revert WindowOpen();
            uint8 vacancies = _markMissingPanel1Commits(dispute);
            if (vacancies == 0) {
                _beginReveal(disputeId, view_, PANEL_1_REVEAL, now_);
                return (false, 0, false);
            }
            _beginDraw(disputeId, dispute, REPLACEMENT, REPLACEMENT_RANDOMNESS_PENDING, vacancies);
            return (false, 0, false);
        }
        if (view_.phase == PANEL_1_REPLACEMENT_COMMIT) {
            if (now_ < view_.replacementCommitDeadline) revert WindowOpen();
            _beginReveal(disputeId, view_, PANEL_1_REVEAL, now_);
            return (false, 0, false);
        }
        if (view_.phase == PANEL_1_REVEAL) {
            if (now_ < view_.revealDeadline) revert WindowOpen();
            if (dispute.panel1RevealCount >= 2) return _applyRuling(disputeId, dispute, 1);
            _beginDraw(disputeId, dispute, SECOND_PANEL, RANDOMNESS_PENDING_2, PANEL_SIZE);
            return (false, 0, false);
        }
        if (view_.phase == PANEL_2_COMMIT) {
            if (now_ < view_.commitDeadline) revert WindowOpen();
            _beginReveal(disputeId, view_, PANEL_2_REVEAL, now_);
            return (false, 0, false);
        }
        if (view_.phase == PANEL_2_REVEAL) {
            if (now_ < view_.revealDeadline) revert WindowOpen();
            if (dispute.panel2RevealCount >= 2) return _applyRuling(disputeId, dispute, 2);
            return _applyFallback(disputeId, dispute, FALLBACK_NO_QUORUM);
        }
        revert InvalidState();
    }

    function voteCommitment(uint256 disputeId, address arbiter, uint16 bps, bytes32 salt)
        external
        view
        returns (bytes32)
    {
        return _voteCommitment(disputeId, arbiter, bps, salt);
    }

    function getMilestoneDispute(uint256 jobId, uint256 milestoneIndex) external view returns (uint256) {
        return _milestoneDisputes[_milestoneKey(jobId, milestoneIndex)];
    }

    function getDispute(uint256 disputeId) external view returns (DisputeView memory) {
        return _disputeOrRevert(disputeId).viewData;
    }

    function getPanel(uint256 disputeId, uint8 round) external view returns (address[3] memory) {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        if (round == 1) return dispute.panel1;
        if (round == 2) return dispute.panel2;
        revert InvalidState();
    }

    function getPanel1History(uint256 disputeId) external view returns (address[] memory) {
        return _disputeOrRevert(disputeId).panel1History;
    }

    function getVote(uint256 disputeId, uint8 round, address arbiter)
        external
        view
        returns (bytes32 commitment, uint16 bps, bool revealed)
    {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        if (round != 1 && round != 2) revert InvalidState();
        Vote storage vote = dispute.votes[round][arbiter];
        return (vote.commitment, vote.bps, vote.revealed);
    }

    function getEvidence(uint256 disputeId, address party, uint256 index)
        external
        view
        returns (bytes32 evidenceHash, bytes32 opaqueReference, uint64 submittedAt)
    {
        Dispute storage dispute = _disputeOrRevert(disputeId);
        if (party != dispute.viewData.client && party != dispute.viewData.freelancer) revert InvalidAddress();
        Evidence[] storage items = dispute.evidence[party];
        if (index >= items.length) revert InvalidState();
        Evidence storage item = items[index];
        return (item.evidenceHash, item.opaqueReference, item.submittedAt);
    }

    function _beginDraw(
        uint256 disputeId,
        Dispute storage dispute,
        uint8 purpose,
        uint8 pendingPhase,
        uint8 vacancies
    ) private {
        delete dispute.drawCandidates;
        DisputeView storage view_ = dispute.viewData;
        for (uint256 i; i < _arbiters.length; ++i) {
            address candidate = _arbiters[i];
            if (_eligible(dispute, candidate)) dispute.drawCandidates.push(candidate);
        }
        dispute.replacementVacancies = vacancies;
        view_.purpose = purpose;
        view_.round = purpose == SECOND_PANEL ? 2 : 1;
        view_.attempt = 0;
        _request(disputeId, dispute, pendingPhase, 0, _now64());
    }

    function _requestAgain(uint256 disputeId, Dispute storage dispute, uint64 now_) private {
        DisputeView storage view_ = dispute.viewData;
        _request(disputeId, dispute, view_.phase, view_.attempt + 1, now_);
    }

    function _request(uint256 disputeId, Dispute storage dispute, uint8 pendingPhase, uint8 attempt, uint64 now_)
        private
    {
        DisputeView storage view_ = dispute.viewData;
        uint256 requestId = _nextRequestId++;
        uint64 requestEnd = now_ + randomnessTimeout;
        view_.phase = pendingPhase;
        view_.attempt = attempt;
        view_.activeRequestId = requestId;
        view_.requestEnd = requestEnd;
        view_.randomnessReady = false;
        dispute.entropyWord = 0;
        _requestDisputes[requestId] = disputeId;
        emit PanelRequested(disputeId, requestId, view_.purpose, attempt, requestEnd);
        emit PanelPhaseAdvanced(disputeId, pendingPhase, requestEnd);
        try IRandomness(randomness).requestRandomness(requestId) {} catch {}
    }

    function _consumeEntropy(uint256 disputeId, Dispute storage dispute, uint64 now_)
        private
        returns (bool terminal, uint16 rulingBps, bool fallbackApplied)
    {
        DisputeView storage view_ = dispute.viewData;
        uint8 purpose = view_.purpose;
        if (purpose == INITIAL_PANEL || purpose == SECOND_PANEL) {
            if (dispute.drawCandidates.length < PANEL_SIZE) {
                return _applyFallback(disputeId, dispute, FALLBACK_POOL_EXHAUSTED);
            }
            address[3] memory selected = _select(dispute, disputeId, PANEL_SIZE);
            if (purpose == INITIAL_PANEL) {
                dispute.panel1 = selected;
                for (uint256 i; i < PANEL_SIZE; ++i) dispute.panel1History.push(selected[i]);
                view_.phase = PANEL_1_COMMIT;
                view_.round = 1;
                view_.commitDeadline = now_ + commitWindow;
                emit PanelSelected(disputeId, 1, selected);
                emit PanelPhaseAdvanced(disputeId, PANEL_1_COMMIT, view_.commitDeadline);
            } else {
                dispute.panel2 = selected;
                view_.phase = PANEL_2_COMMIT;
                view_.round = 2;
                view_.commitDeadline = now_ + commitWindow;
                emit PanelSelected(disputeId, 2, selected);
                emit PanelPhaseAdvanced(disputeId, PANEL_2_COMMIT, view_.commitDeadline);
            }
        } else {
            address[3] memory replacements = _select(
                dispute,
                disputeId,
                dispute.drawCandidates.length < dispute.replacementVacancies
                    ? uint8(dispute.drawCandidates.length)
                    : dispute.replacementVacancies
            );
            uint8 assigned;
            for (uint256 i; i < PANEL_SIZE; ++i) {
                if (!dispute.replacementSlots[i]) continue;
                address replacement = assigned < dispute.drawCandidates.length ? replacements[assigned] : address(0);
                dispute.panel1[i] = replacement;
                if (replacement != address(0)) dispute.panel1History.push(replacement);
                ++assigned;
            }
            view_.phase = PANEL_1_REPLACEMENT_COMMIT;
            view_.round = 1;
            view_.replacementCommitDeadline = now_ + replacementCommitWindow;
            emit PanelSelected(disputeId, 1, dispute.panel1);
            emit PanelPhaseAdvanced(disputeId, PANEL_1_REPLACEMENT_COMMIT, view_.replacementCommitDeadline);
        }
        view_.randomnessReady = false;
        return (false, 0, false);
    }

    function _markMissingPanel1Commits(Dispute storage dispute) private returns (uint8 vacancies) {
        for (uint256 i; i < PANEL_SIZE; ++i) {
            address arbiter = dispute.panel1[i];
            bool missing = arbiter == address(0) || dispute.votes[1][arbiter].commitment == bytes32(0);
            dispute.replacementSlots[i] = missing;
            if (missing) ++vacancies;
        }
    }

    function _beginReveal(uint256 disputeId, DisputeView storage view_, uint8 phase, uint64 now_) private {
        view_.phase = phase;
        view_.revealDeadline = now_ + revealWindow;
        emit PanelPhaseAdvanced(disputeId, phase, view_.revealDeadline);
    }

    function _applyRuling(uint256 disputeId, Dispute storage dispute, uint8 round)
        private
        returns (bool, uint16 rulingBps, bool)
    {
        DisputeView storage view_ = dispute.viewData;
        uint16[3] memory values;
        uint8 count;
        address[3] storage panel = round == 1 ? dispute.panel1 : dispute.panel2;
        for (uint256 i; i < PANEL_SIZE; ++i) {
            Vote storage vote = dispute.votes[round][panel[i]];
            if (panel[i] != address(0) && vote.revealed) values[count++] = vote.bps;
        }
        if (count == 2) rulingBps = uint16((uint256(values[0]) + values[1]) / 2);
        else {
            if (values[0] > values[1]) (values[0], values[1]) = (values[1], values[0]);
            if (values[1] > values[2]) (values[1], values[2]) = (values[2], values[1]);
            if (values[0] > values[1]) (values[0], values[1]) = (values[1], values[0]);
            rulingBps = values[1];
        }
        view_.rulingBps = rulingBps;
        view_.fallbackApplied = false;
        view_.fallbackReason = 0;
        view_.phase = SETTLED;
        emit DisputeRuled(disputeId, rulingBps);
        emit PanelPhaseAdvanced(disputeId, SETTLED, 0);
        return (true, rulingBps, false);
    }

    function _applyFallback(uint256 disputeId, Dispute storage dispute, uint8 reason)
        private
        returns (bool, uint16, bool)
    {
        DisputeView storage view_ = dispute.viewData;
        view_.rulingBps = 5_000;
        view_.fallbackApplied = true;
        view_.fallbackReason = reason;
        view_.phase = SETTLED;
        view_.randomnessReady = false;
        emit DisputeFallbackApplied(disputeId, reason);
        emit PanelPhaseAdvanced(disputeId, SETTLED, 0);
        return (true, 5_000, true);
    }

    function _select(Dispute storage dispute, uint256 disputeId, uint8 count)
        private
        view
        returns (address[3] memory selected)
    {
        uint256 length = dispute.drawCandidates.length;
        address[] memory pool = new address[](length);
        for (uint256 i; i < length; ++i) pool[i] = dispute.drawCandidates[i];
        uint256 seed = uint256(keccak256(abi.encode(dispute.entropyWord, disputeId, dispute.viewData.purpose)));
        for (uint256 i; i < count; ++i) {
            uint256 remaining = length - i;
            uint256 index = uint256(keccak256(abi.encode(seed, i))) % remaining;
            selected[i] = pool[index];
            pool[index] = pool[remaining - 1];
        }
    }

    function _eligible(Dispute storage dispute, address candidate) private view returns (bool) {
        DisputeView storage view_ = dispute.viewData;
        if (candidate == view_.client || candidate == view_.freelancer) return false;
        for (uint256 i; i < dispute.panel1History.length; ++i) {
            if (dispute.panel1History[i] == candidate) return false;
        }
        return true;
    }

    function _isPanelMember(Dispute storage dispute, uint8 round, address actor) private view returns (bool) {
        address[3] storage panel = round == 1 ? dispute.panel1 : dispute.panel2;
        return actor != address(0) && (panel[0] == actor || panel[1] == actor || panel[2] == actor);
    }

    function _currentRound(uint8 phase) private pure returns (uint8) {
        if (phase == PANEL_1_COMMIT || phase == PANEL_1_REPLACEMENT_COMMIT) return 1;
        if (phase == PANEL_2_COMMIT) return 2;
        return 0;
    }

    function _isRandomnessPending(uint8 phase) private pure returns (bool) {
        return phase == RANDOMNESS_PENDING_1 || phase == REPLACEMENT_RANDOMNESS_PENDING
            || phase == RANDOMNESS_PENDING_2;
    }

    function _voteCommitment(uint256 disputeId, address arbiter, uint16 bps, bytes32 salt)
        private
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, escrow, disputeId, arbiter, bps, salt));
    }

    function _disputeOrRevert(uint256 disputeId) private view returns (Dispute storage dispute) {
        dispute = _disputes[disputeId];
        if (dispute.viewData.phase == 0) revert InvalidState();
    }

    function _milestoneKey(uint256 jobId, uint256 milestoneIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(jobId, milestoneIndex));
    }

    function _now64() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert InvalidWindow();
        return uint64(block.timestamp);
    }
}
