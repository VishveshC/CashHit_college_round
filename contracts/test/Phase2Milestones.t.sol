// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {MockToken} from "./support/MockTokens.sol";

/// @dev Phase 2 ABI kept local so these tests compile and exercise real missing selectors against Phase 1.
interface IPhase2Surface {
    struct Submission {
        uint8 version;
        bytes32 deliverableHash;
        bytes32 opaqueReference;
        uint64 submittedAt;
    }

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

    function responseWindow() external view returns (uint64);

    function submitMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 deliverableHash, bytes32 opaqueReference)
        external;

    function approveMilestone(uint256 jobId, uint256 milestoneIndex) external;

    function rejectMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 reasonCommitment) external;

    function resubmitMilestone(uint256 jobId, uint256 milestoneIndex, bytes32 deliverableHash, bytes32 opaqueReference)
        external;

    function releaseAfterSilence(uint256 jobId, uint256 milestoneIndex) external;

    function refundAfterMissedDeadline(uint256 jobId, uint256 milestoneIndex) external;

    function refundAfterRejectionWindow(uint256 jobId, uint256 milestoneIndex) external;

    function getSubmission(uint256 jobId, uint256 milestoneIndex, uint256 submissionIndex)
        external
        view
        returns (Submission memory);

    function getMilestone(uint256 jobId, uint256 milestoneIndex) external view returns (MilestoneView memory);
}

contract Phase2TransferFailureToken is MockToken {
    bool public transfersRevert;

    constructor() MockToken("Transfer failure test", "FAIL", 6) {}

    function setTransfersRevert(bool enabled) external {
        transfersRevert = enabled;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!transfersRevert, "transfer disabled");
        return super.transfer(to, amount);
    }
}

abstract contract Phase2Fixture is Test {
    address internal constant CLIENT = address(0xC11E);
    address internal constant FREELANCER = address(0xFEE);
    address internal constant OTHER = address(0xB0B);
    address internal constant TREASURY = address(0x7EA5);
    uint64 internal constant FUNDING_WINDOW = 60;
    uint64 internal constant GRACE_PERIOD = 15;
    uint64 internal constant REVIEW_WINDOW = 120;
    uint64 internal constant START_TIME = 1_800_000_000;
    bytes32 internal constant COMMITMENT = keccak256("phase 2 test terms");

    MockToken internal token;
    FairworkEscrow internal escrow;
    IPhase2Surface internal phase2;

    function setUp() public virtual {
        vm.chainId(31337);
        vm.warp(START_TIME);
        token = new MockToken("USDC test", "USDC", 6);
        escrow = _deployEscrow(address(token));
        phase2 = IPhase2Surface(address(escrow));

        token.mint(CLIENT, 1_000_000e6);
        vm.prank(CLIENT);
        token.approve(address(escrow), type(uint256).max);
    }

    function _deployEscrow(address tokenAddress) internal returns (FairworkEscrow deployed) {
        return _deployEscrowWithDecimals(tokenAddress, 6);
    }

    function _deployEscrowWithDecimals(address tokenAddress, uint8 decimals)
        internal
        returns (FairworkEscrow deployed)
    {
        FairworkEscrow.TokenConfig[] memory tokenConfigs = new FairworkEscrow.TokenConfig[](1);
        tokenConfigs[0] = FairworkEscrow.TokenConfig({
            token: tokenAddress,
            decimals: decimals,
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

    function _fundedJob(uint256[] memory amounts, uint64 duration, uint8 revisionLimit)
        internal
        returns (uint256 jobId)
    {
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](amounts.length);
        for (uint256 i; i < amounts.length; ++i) {
            milestones[i] = FairworkEscrow.MilestoneInput(amounts[i], duration, keccak256(abi.encode("criteria", i)));
        }
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(token),
            titleCommitment: COMMITMENT,
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

    function _one(uint256 amount, uint64 duration, uint8 revisionLimit) internal returns (uint256) {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        return _fundedJob(amounts, duration, revisionLimit);
    }

    function _fundTokenJob(FairworkEscrow target, address tokenAddress, uint256 amount)
        internal
        returns (uint256 jobId)
    {
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: tokenAddress,
            titleCommitment: COMMITMENT,
            descriptionCommitment: keccak256("token matrix description"),
            scopeCommitment: keccak256("token matrix scope"),
            deliveryRuleCommitment: keccak256("token matrix delivery"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: 0
        });
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(amount, 10, keccak256("token matrix criteria"));
        vm.prank(CLIENT);
        jobId = target.createJob(terms, milestones);
        vm.prank(FREELANCER);
        target.acceptJob(jobId);
        vm.prank(CLIENT);
        target.fundJob(jobId);
    }

    function _submit(uint256 jobId, uint256 index, bytes32 hash, bytes32 reference_) internal {
        vm.prank(FREELANCER);
        phase2.submitMilestone(jobId, index, hash, reference_);
    }

    function _approve(uint256 jobId, uint256 index) internal {
        vm.prank(CLIENT);
        phase2.approveMilestone(jobId, index);
    }

    function _reject(uint256 jobId, uint256 index, bytes32 reason) internal {
        vm.prank(CLIENT);
        phase2.rejectMilestone(jobId, index, reason);
    }

    function _resubmit(uint256 jobId, uint256 index, bytes32 hash, bytes32 reference_) internal {
        vm.prank(FREELANCER);
        phase2.resubmitMilestone(jobId, index, hash, reference_);
    }

    function _milestone(uint256 jobId, uint256 index) internal view returns (IPhase2Surface.MilestoneView memory) {
        return phase2.getMilestone(jobId, index);
    }

    function _submission(uint256 jobId, uint256 index, uint256 versionIndex)
        internal
        view
        returns (IPhase2Surface.Submission memory)
    {
        return phase2.getSubmission(jobId, index, versionIndex);
    }

    function _settleState(uint256 jobId, uint256 index) internal view returns (uint8) {
        return _milestone(jobId, index).state;
    }
}

contract Phase2MilestonesTest is Phase2Fixture {
    function test_A23_ResponseWindowEqualsImmutableFundingWindow() public {
        assertEq(phase2.responseWindow(), FUNDING_WINDOW, "A-23 response window follows funding config");
        assertEq(escrow.protocolConfig().fundingWindow, FUNDING_WINDOW, "A-23 existing config remains compatible");

        uint256 jobId = _one(100, 10, 1);
        _submit(jobId, 0, keccak256("v1"), bytes32(0));
        _reject(jobId, 0, keccak256("reason"));
        assertEq(phase2.responseWindow(), FUNDING_WINDOW, "response window is immutable after lifecycle actions");
    }

    function test_F10_F13_SubmitRecordsVersionOneAndAllowsEmptyOpaqueReference() public {
        uint256 jobId = _one(100, 10, 1);
        IPhase2Surface.MilestoneView memory beforeSubmit = _milestone(jobId, 0);

        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        phase2.submitMilestone(jobId, 0, keccak256("client submission"), bytes32(0));
        vm.prank(FREELANCER);
        vm.expectRevert();
        phase2.submitMilestone(jobId, 0, bytes32(0), bytes32(0));

        bytes32 deliverableHash = keccak256("version one");
        _submit(jobId, 0, deliverableHash, bytes32(0));

        IPhase2Surface.Submission memory first = _submission(jobId, 0, 0);
        IPhase2Surface.MilestoneView memory submitted = _milestone(jobId, 0);
        assertEq(first.version, 1, "F-13 first version is one");
        assertEq(first.deliverableHash, deliverableHash, "F-10 stores only the deliverable commitment");
        assertEq(first.opaqueReference, bytes32(0), "A-24 reference may be empty");
        assertEq(first.submittedAt, uint64(block.timestamp), "submission timestamp is recorded");
        assertEq(submitted.submittedAt, first.submittedAt, "latest submittedAt matches version one");
        assertEq(submitted.reviewEnd, first.submittedAt + REVIEW_WINDOW, "review clock starts at submission");
        assertEq(submitted.submissionCount, 1, "submission count is per milestone");
        assertEq(submitted.rejectionCount, 0, "submission does not consume a revision");
        assertEq(submitted.state, 1, "milestone moves to Submitted");
        assertEq(beforeSubmit.submissionCount, 0, "Ready milestone starts with empty history");
    }

    function test_F11_ApprovalIsClientOnlyAndCreditsFreelancerWithoutTokenTransfer() public {
        uint256 jobId = _one(500, 10, 0);
        _submit(jobId, 0, keccak256("deliverable"), bytes32(0));

        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        phase2.approveMilestone(jobId, 0);
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        phase2.approveMilestone(jobId, 0);

        uint256 escrowBalanceBefore = token.balanceOf(address(escrow));
        _approve(jobId, 0);

        assertEq(token.balanceOf(address(escrow)), escrowBalanceBefore, "F-11 settlement makes no token call");
        assertEq(escrow.lockedEscrow(address(token)), 0, "A-25 principal leaves locked ledger");
        assertEq(escrow.claimable(address(token), FREELANCER), 500, "A-25 freelancer receives exact claim");
        assertEq(escrow.totalClaimable(address(token)), 500, "claimable liability increases by principal");
        assertEq(uint256(escrow.getJob(jobId).state), 4, "single terminal milestone closes the job");
        assertEq(_settleState(jobId, 0), 4, "approved milestone is Released");
    }

    function test_F12_RejectRequiresClientReasonAndAvailableRevision() public {
        uint256 jobId = _one(100, 10, 1);
        _submit(jobId, 0, keccak256("deliverable"), bytes32(0));

        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        phase2.rejectMilestone(jobId, 0, keccak256("reason"));
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        phase2.rejectMilestone(jobId, 0, keccak256("reason"));
        vm.prank(CLIENT);
        vm.expectRevert();
        phase2.rejectMilestone(jobId, 0, bytes32(0));

        bytes32 reason = keccak256("revision requested");
        _reject(jobId, 0, reason);
        IPhase2Surface.MilestoneView memory rejected = _milestone(jobId, 0);
        assertEq(rejected.state, 2, "F-12 moves milestone to Rejected");
        assertEq(rejected.rejectionCount, 1, "one rejection consumes one revision");
        assertEq(rejected.latestReasonCommitment, reason, "only the reason commitment is stored");
        assertEq(rejected.rejectedAt, uint64(block.timestamp), "rejection timestamp is stored");
        assertEq(rejected.responseEnd, rejected.rejectedAt + FUNDING_WINDOW, "A-23 response window follows funding");
        assertEq(escrow.lockedEscrow(address(token)), 100, "rejection does not move principal");
        assertEq(escrow.totalClaimable(address(token)), 0, "rejection creates no payment claim");
    }

    function test_F13_ResubmissionRefreshesReviewClockAndKeepsHistoryAndRejectionMetadata() public {
        uint256 jobId = _one(250, 10, 2);
        bytes32 firstHash = keccak256("version one");
        bytes32 firstReference = keccak256("opaque one");
        _submit(jobId, 0, firstHash, firstReference);
        _reject(jobId, 0, keccak256("first reason"));
        IPhase2Surface.MilestoneView memory rejected = _milestone(jobId, 0);
        IPhase2Surface.Submission memory original = _submission(jobId, 0, 0);

        vm.warp(block.timestamp + 1);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        phase2.resubmitMilestone(jobId, 0, keccak256("wrong party"), bytes32(0));
        _resubmit(jobId, 0, keccak256("version two"), bytes32(0));

        IPhase2Surface.MilestoneView memory resubmitted = _milestone(jobId, 0);
        IPhase2Surface.Submission memory versionOneAfter = _submission(jobId, 0, 0);
        IPhase2Surface.Submission memory versionTwo = _submission(jobId, 0, 1);
        assertEq(resubmitted.state, 1, "resubmission returns to Submitted");
        assertEq(resubmitted.submittedAt, uint64(block.timestamp), "latest submission timestamp refreshes");
        assertEq(resubmitted.reviewEnd, uint64(block.timestamp) + REVIEW_WINDOW, "review clock restarts");
        assertEq(resubmitted.rejectedAt, rejected.rejectedAt, "rejection timestamp remains historical");
        assertEq(resubmitted.responseEnd, rejected.responseEnd, "response end remains historical");
        assertEq(resubmitted.latestReasonCommitment, rejected.latestReasonCommitment, "latest rejection reason remains readable");
        assertEq(resubmitted.rejectionCount, 1, "resubmission does not restore a revision");
        assertEq(resubmitted.submissionCount, 2, "history count increments");
        assertEq(versionOneAfter.version, original.version, "version one record is immutable");
        assertEq(versionOneAfter.deliverableHash, original.deliverableHash, "old deliverable hash is unchanged");
        assertEq(versionOneAfter.opaqueReference, original.opaqueReference, "old opaque reference is unchanged");
        assertEq(versionOneAfter.submittedAt, original.submittedAt, "old timestamp is unchanged");
        assertEq(versionTwo.version, 2, "resubmission receives the next version");
        assertEq(versionTwo.deliverableHash, keccak256("version two"), "version two hash is appended");
        assertEq(versionTwo.opaqueReference, bytes32(0), "later opaque reference may also be empty");
        assertEq(versionTwo.submittedAt, uint64(block.timestamp), "appended version records its own time");

        vm.warp(uint256(resubmitted.responseEnd));
        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.refundAfterRejectionWindow(jobId, 0);
    }

    function test_F22_RevisionLimitsZeroOneAndFiveAreIndependentPerMilestone() public {
        uint256 zeroLimit = _one(100, 10, 0);
        _submit(zeroLimit, 0, keccak256("zero limit v1"), bytes32(0));
        vm.prank(CLIENT);
        vm.expectRevert();
        phase2.rejectMilestone(zeroLimit, 0, keccak256("no revisions"));
        assertEq(_milestone(zeroLimit, 0).rejectionCount, 0, "revision limit zero blocks rejection");

        uint256 oneLimit = _one(200, 10, 1);
        _submit(oneLimit, 0, keccak256("one v1"), bytes32(0));
        _reject(oneLimit, 0, keccak256("one reason"));
        _resubmit(oneLimit, 0, keccak256("one v2"), bytes32(0));
        vm.prank(CLIENT);
        vm.expectRevert();
        phase2.rejectMilestone(oneLimit, 0, keccak256("exhausted"));
        assertEq(_milestone(oneLimit, 0).rejectionCount, 1, "revision limit one cannot be exceeded");

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 300;
        amounts[1] = 400;
        uint256 fiveLimit = _fundedJob(amounts, 10, 5);
        _submit(fiveLimit, 0, keccak256("five v1"), bytes32(0));
        _submit(fiveLimit, 1, keccak256("independent v1"), bytes32(0));
        for (uint8 revision; revision < 5; ++revision) {
            bytes32 reason = keccak256(abi.encode("reason", revision));
            _reject(fiveLimit, 0, reason);
            assertEq(_milestone(fiveLimit, 0).rejectionCount, revision + 1, "each rejection consumes one revision");
            _resubmit(fiveLimit, 0, keccak256(abi.encode("five version", revision + 2)), bytes32(0));
        }
        IPhase2Surface.MilestoneView memory exhausted = _milestone(fiveLimit, 0);
        IPhase2Surface.MilestoneView memory untouched = _milestone(fiveLimit, 1);
        assertEq(exhausted.rejectionCount, 5, "revision limit five is reachable");
        assertEq(exhausted.submissionCount, 6, "history has initial plus five resubmissions");
        assertEq(exhausted.state, 1, "sixth submission is reviewable");
        assertEq(untouched.rejectionCount, 0, "second milestone has an independent rejection count");
        assertEq(untouched.submissionCount, 1, "second milestone keeps its own history count");
        vm.prank(CLIENT);
        vm.expectRevert();
        phase2.rejectMilestone(fiveLimit, 0, keccak256("sixth rejection"));
    }

    function test_A24_SubmissionHistoryIsBoundedAtSixAndNeverOverwritesOlderVersions() public {
        uint256 jobId = _one(1_000, 10, 5);
        bytes32[6] memory hashes;
        bytes32[6] memory references;
        uint64[6] memory timestamps;
        for (uint8 version; version < 6; ++version) {
            hashes[version] = keccak256(abi.encode("hash", version + 1));
            references[version] = version == 0 ? bytes32(0) : keccak256(abi.encode("ref", version));
            if (version == 0) {
                _submit(jobId, 0, hashes[version], references[version]);
            } else {
                _reject(jobId, 0, keccak256(abi.encode("reason", version)));
                _resubmit(jobId, 0, hashes[version], references[version]);
            }
            IPhase2Surface.Submission memory record = _submission(jobId, 0, version);
            timestamps[version] = record.submittedAt;
            assertEq(record.version, version + 1, "history versions are contiguous from one");
        }

        IPhase2Surface.MilestoneView memory milestone = _milestone(jobId, 0);
        assertEq(milestone.submissionCount, 6, "revision limit five bounds history at six");
        for (uint8 version; version < 6; ++version) {
            IPhase2Surface.Submission memory record = _submission(jobId, 0, version);
            assertEq(record.version, version + 1, "later activity never renumbers earlier versions");
            assertEq(record.deliverableHash, hashes[version], "history preserves each deliverable hash");
            assertEq(record.opaqueReference, references[version], "history preserves each opaque reference");
            assertEq(record.submittedAt, timestamps[version], "history preserves each submission timestamp");
        }
        vm.expectRevert();
        phase2.getSubmission(jobId, 0, 6);
        vm.prank(CLIENT);
        vm.expectRevert();
        phase2.rejectMilestone(jobId, 0, keccak256("revision limit exhausted"));
        assertEq(_milestone(jobId, 0).submissionCount, 6, "history cannot grow past its fixed bound");
    }

    function test_A24_SubmissionGetterRejectsUnknownJobsAndOutOfRangeMilestones() public {
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.getSubmission(999, 0, 0);

        uint256 jobId = _one(100, 10, 0);
        _submit(jobId, 0, keccak256("one history record"), bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.getSubmission(jobId, 1, 0);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.getSubmission(jobId, 0, 1);
    }

    function test_A27_SubmissionAndRejectionEventsExposeExactAuditFields() public {
        uint256 jobId = _one(101, 10, 1);
        bytes32 v1Hash = keccak256("event version one");
        bytes32 v1Reference = keccak256("event reference one");
        vm.recordLogs();
        _submit(jobId, 0, v1Hash, v1Reference);
        _assertSubmittedEvent(vm.getRecordedLogs(), jobId, 0, 1, v1Hash, v1Reference, START_TIME, START_TIME + REVIEW_WINDOW);
        bytes32 reason = keccak256("event rejection reason");
        vm.recordLogs();
        _reject(jobId, 0, reason);
        _assertRejectedEvent(vm.getRecordedLogs(), jobId, 0, 1, reason, START_TIME, START_TIME + FUNDING_WINDOW);

        uint64 resubmittedAt = START_TIME + 1;
        vm.warp(resubmittedAt);
        bytes32 v2Hash = keccak256("event version two");
        bytes32 v2Reference = keccak256("event reference two");
        vm.recordLogs();
        _resubmit(jobId, 0, v2Hash, v2Reference);
        _assertSubmittedEvent(vm.getRecordedLogs(), jobId, 0, 2, v2Hash, v2Reference, resubmittedAt, resubmittedAt + REVIEW_WINDOW);
    }

    function test_A27_ApprovalAndReviewSilenceEmitCausesAndCompatibleCredits() public {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 101;
        amounts[1] = 103;
        uint256 jobId = _fundedJob(amounts, 10, 0);
        _submit(jobId, 0, keccak256("approval event"), bytes32(0));
        _submit(jobId, 1, keccak256("review timeout event"), bytes32(0));

        vm.recordLogs();
        _approve(jobId, 0);
        Vm.Log[] memory approvalLogs = vm.getRecordedLogs();
        _assertSettlementEvent(approvalLogs, jobId, 0, address(token), FREELANCER, 101, 0);
        _assertTerminalCauseEvent(approvalLogs, "MilestoneApproved(uint256,uint256,uint256,address)", jobId, 0, 101, FREELANCER, 0, false);

        uint64 reviewEnd = _milestone(jobId, 1).reviewEnd;
        vm.warp(reviewEnd);
        vm.recordLogs();
        vm.prank(OTHER);
        phase2.releaseAfterSilence(jobId, 1);
        Vm.Log[] memory releaseLogs = vm.getRecordedLogs();
        _assertSettlementEvent(releaseLogs, jobId, 1, address(token), FREELANCER, 103, 1);
        _assertTerminalCauseEvent(releaseLogs, "MilestoneAutoReleased(uint256,uint256,uint256,address)", jobId, 1, 103, FREELANCER, 0, false);
        _assertJobClosedEvent(releaseLogs, jobId);
    }

    function test_A27_TimeoutRefundCausesAndCompatibleCreditsIdentifyEachPath() public {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 107;
        amounts[1] = 109;
        uint256 jobId = _fundedJob(amounts, 10, 1);
        _submit(jobId, 1, keccak256("rejection timeout event"), bytes32(0));
        _reject(jobId, 1, keccak256("response timeout reason"));

        uint64 graceEnd = escrow.getMilestone(jobId, 0).graceEnd;
        vm.warp(graceEnd);
        vm.recordLogs();
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 0);
        Vm.Log[] memory missedDeliveryLogs = vm.getRecordedLogs();
        _assertSettlementEvent(missedDeliveryLogs, jobId, 0, address(token), CLIENT, 107, 2);
        _assertTerminalCauseEvent(
            missedDeliveryLogs,
            "MilestoneRefunded(uint256,uint256,uint256,address,uint8)",
            jobId,
            0,
            107,
            CLIENT,
            2,
            true
        );

        uint64 responseEnd = _milestone(jobId, 1).responseEnd;
        vm.warp(responseEnd);
        vm.recordLogs();
        vm.prank(OTHER);
        phase2.refundAfterRejectionWindow(jobId, 1);
        Vm.Log[] memory rejectionTimeoutLogs = vm.getRecordedLogs();
        _assertSettlementEvent(rejectionTimeoutLogs, jobId, 1, address(token), CLIENT, 109, 3);
        _assertTerminalCauseEvent(
            rejectionTimeoutLogs,
            "MilestoneRefunded(uint256,uint256,uint256,address,uint8)",
            jobId,
            1,
            109,
            CLIENT,
            3,
            true
        );
        _assertJobClosedEvent(rejectionTimeoutLogs, jobId);
    }

    function test_F10_SubmissionRemainsOpenThroughDeliveryDeadlineAndClosesAtGraceEnd() public {
        uint256[] memory amounts = new uint256[](6);
        for (uint256 i; i < amounts.length; ++i) amounts[i] = 100 + i;
        uint256 jobId = _fundedJob(amounts, 10, 0);
        FairworkEscrow.MilestoneView memory base = escrow.getMilestone(jobId, 0);
        uint256 deadline = base.deadline;
        uint256 graceEnd = base.graceEnd;

        vm.warp(deadline - 1);
        _submit(jobId, 0, keccak256("before deadline"), bytes32(0));
        vm.warp(deadline);
        _submit(jobId, 1, keccak256("at deadline"), bytes32(0));
        vm.warp(deadline + 1);
        _submit(jobId, 2, keccak256("after deadline during grace"), bytes32(0));
        vm.warp(graceEnd - 1);
        _submit(jobId, 3, keccak256("before grace end"), bytes32(0));
        vm.warp(graceEnd);
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.submitMilestone(jobId, 4, keccak256("at grace end"), bytes32(0));
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 4);
        vm.warp(graceEnd + 1);
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.submitMilestone(jobId, 5, keccak256("after grace end"), bytes32(0));
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 5);

        for (uint256 i; i < 4; ++i) assertEq(_settleState(jobId, i), 1, "delivery deadline itself stays open");
        assertEq(_settleState(jobId, 4), 5, "grace end permits public client refund");
        assertEq(_settleState(jobId, 5), 5, "post-grace timeout also refunds the client");
    }

    function test_F10_F21_DifferentMilestoneDurationsKeepIndependentDeadlinesAndExits() public {
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](2);
        milestones[0] = FairworkEscrow.MilestoneInput(10, 10, keccak256("short milestone"));
        milestones[1] = FairworkEscrow.MilestoneInput(20, 20, keccak256("long milestone"));
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(token),
            titleCommitment: COMMITMENT,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: 0
        });
        vm.prank(CLIENT);
        uint256 jobId = escrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);

        FairworkEscrow.MilestoneView memory shortClock = escrow.getMilestone(jobId, 0);
        FairworkEscrow.MilestoneView memory longClock = escrow.getMilestone(jobId, 1);
        assertEq(shortClock.deadline, START_TIME + 10, "first milestone keeps its own delivery duration");
        assertEq(longClock.deadline, START_TIME + 20, "second milestone keeps its longer delivery duration");
        assertEq(shortClock.graceEnd, START_TIME + 10 + GRACE_PERIOD, "first grace clock follows first deadline");
        assertEq(longClock.graceEnd, START_TIME + 20 + GRACE_PERIOD, "second grace clock follows second deadline");

        vm.warp(shortClock.graceEnd);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 0);
        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.WindowOpen.selector);
        phase2.refundAfterMissedDeadline(jobId, 1);
        _submit(jobId, 1, keccak256("long milestone delivered during grace"), bytes32(0));

        uint64 longReviewEnd = _milestone(jobId, 1).reviewEnd;
        vm.warp(longReviewEnd);
        vm.prank(OTHER);
        phase2.releaseAfterSilence(jobId, 1);
        assertEq(_settleState(jobId, 0), 5, "short milestone times out independently");
        assertEq(_settleState(jobId, 1), 4, "long milestone can still submit and release later");
        assertEq(uint256(escrow.getJob(jobId).state), 4, "job closes only after both independent exits");
        assertEq(escrow.claimable(address(token), CLIENT), 10, "short timeout refunds exact amount");
        assertEq(escrow.claimable(address(token), FREELANCER), 20, "long milestone release credits exact amount");
    }

    function test_F21_MissedDeadlineRefundBoundaryEminus1Eplus() public {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 10;
        amounts[1] = 20;
        amounts[2] = 30;
        uint256 jobId = _fundedJob(amounts, 10, 0);
        uint256 graceEnd = escrow.getMilestone(jobId, 0).graceEnd;

        vm.warp(graceEnd - 1);
        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.WindowOpen.selector);
        phase2.refundAfterMissedDeadline(jobId, 0);
        vm.warp(graceEnd);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 1);
        vm.warp(graceEnd + 1);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 2);

        assertEq(escrow.claimable(address(token), CLIENT), 50, "deadline refunds are exact at and after grace end");
        assertEq(escrow.lockedEscrow(address(token)), 10, "one unexpired milestone remains locked");
    }

    function test_F11_F12_F20_ReviewBoundaryEminus1Eplus() public {
        uint256[] memory amounts = new uint256[](9);
        for (uint256 i; i < amounts.length; ++i) amounts[i] = 100;
        uint256 jobId = _fundedJob(amounts, 10, 1);
        for (uint256 i; i < amounts.length; ++i) _submit(jobId, i, keccak256(abi.encode("review", i)), bytes32(0));
        uint256 reviewEnd = _milestone(jobId, 0).reviewEnd;

        vm.warp(reviewEnd - 1);
        _approve(jobId, 0);
        _reject(jobId, 1, keccak256("before end"));
        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.WindowOpen.selector);
        phase2.releaseAfterSilence(jobId, 4);

        vm.warp(reviewEnd);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.approveMilestone(jobId, 2);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.rejectMilestone(jobId, 3, keccak256("at end"));
        vm.prank(OTHER);
        phase2.releaseAfterSilence(jobId, 4);

        vm.warp(reviewEnd + 1);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.approveMilestone(jobId, 5);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.rejectMilestone(jobId, 6, keccak256("after end"));
        vm.prank(OTHER);
        phase2.releaseAfterSilence(jobId, 7);

        assertEq(_settleState(jobId, 0), 4, "client can approve before review end");
        assertEq(_settleState(jobId, 1), 2, "client can reject before review end");
        assertEq(_settleState(jobId, 4), 4, "silence releases exactly at review end");
        assertEq(_settleState(jobId, 7), 4, "silence releases after review end");
        assertEq(_settleState(jobId, 2), 1, "late approval does not settle");
        assertEq(_settleState(jobId, 3), 1, "late rejection does not settle");
        assertEq(_settleState(jobId, 5), 1, "approval stays unavailable after review end");
        assertEq(_settleState(jobId, 6), 1, "rejection stays unavailable after review end");
    }

    function test_F13_F24_ResponseBoundaryEminus1Eplus() public {
        uint256[] memory amounts = new uint256[](4);
        for (uint256 i; i < amounts.length; ++i) amounts[i] = 100;
        uint256 jobId = _fundedJob(amounts, 10, 2);
        for (uint256 i; i < amounts.length; ++i) {
            _submit(jobId, i, keccak256(abi.encode("response", i)), bytes32(0));
            _reject(jobId, i, keccak256(abi.encode("reason", i)));
        }
        uint256 responseEnd = _milestone(jobId, 0).responseEnd;

        vm.warp(responseEnd - 1);
        _resubmit(jobId, 0, keccak256("resubmitted before end"), bytes32(0));
        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.WindowOpen.selector);
        phase2.refundAfterRejectionWindow(jobId, 1);

        vm.warp(responseEnd);
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.resubmitMilestone(jobId, 2, keccak256("resubmitted at end"), bytes32(0));
        vm.prank(OTHER);
        phase2.refundAfterRejectionWindow(jobId, 1);
        vm.prank(OTHER);
        phase2.refundAfterRejectionWindow(jobId, 2);

        vm.warp(responseEnd + 1);
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        phase2.resubmitMilestone(jobId, 3, keccak256("resubmitted after end"), bytes32(0));
        vm.prank(OTHER);
        phase2.refundAfterRejectionWindow(jobId, 3);

        assertEq(_settleState(jobId, 0), 1, "resubmission remains open at end minus one");
        assertEq(_settleState(jobId, 1), 5, "response timeout refunds at response end");
        assertEq(_settleState(jobId, 2), 5, "failed resubmission at response end leaves refund open");
        assertEq(_settleState(jobId, 3), 5, "response timeout refunds after response end");
    }

    function test_F10_F11_F20_F21_F24_UnknownJobsAndInvalidStatesRevert() public {
        uint256 unknown = 999;
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.submitMilestone(unknown, 0, keccak256("hash"), bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.approveMilestone(unknown, 0);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.rejectMilestone(unknown, 0, keccak256("reason"));
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.resubmitMilestone(unknown, 0, keccak256("hash"), bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.releaseAfterSilence(unknown, 0);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.refundAfterMissedDeadline(unknown, 0);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.refundAfterRejectionWindow(unknown, 0);

        uint256 jobId = _one(100, 10, 1);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.approveMilestone(jobId, 0);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.rejectMilestone(jobId, 0, keccak256("reason"));
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.resubmitMilestone(jobId, 0, keccak256("hash"), bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.releaseAfterSilence(jobId, 0);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.refundAfterRejectionWindow(jobId, 0);

        _submit(jobId, 0, keccak256("hash"), bytes32(0));
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.submitMilestone(jobId, 0, keccak256("second submit"), bytes32(0));
        vm.prank(FREELANCER);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.resubmitMilestone(jobId, 0, keccak256("premature resubmit"), bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.refundAfterMissedDeadline(jobId, 0);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.refundAfterRejectionWindow(jobId, 0);
    }

    function test_A25_OnlyLastTerminalMilestoneClosesJobAndPayoutCannotRepeat() public {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 100;
        amounts[1] = 200;
        amounts[2] = 300;
        uint256 jobId = _fundedJob(amounts, 10, 1);
        _submit(jobId, 1, keccak256("approved milestone"), bytes32(0));
        _submit(jobId, 2, keccak256("rejected milestone"), bytes32(0));
        _reject(jobId, 2, keccak256("reason"));

        _approve(jobId, 1);
        assertEq(uint256(escrow.getJob(jobId).state), 2, "job remains Funded while other milestones are open");
        assertEq(escrow.lockedEscrow(address(token)), 400, "only approved milestone principal leaves locked ledger");
        assertEq(escrow.claimable(address(token), FREELANCER), 200, "approved amount credits freelancer");

        uint256 graceEnd = escrow.getMilestone(jobId, 0).graceEnd;
        vm.warp(graceEnd);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 0);
        assertEq(uint256(escrow.getJob(jobId).state), 2, "job remains open while rejected milestone is nonterminal");
        assertEq(escrow.claimable(address(token), CLIENT), 100, "missed delivery credits client");

        uint256 responseEnd = _milestone(jobId, 2).responseEnd;
        vm.warp(responseEnd);
        vm.prank(OTHER);
        phase2.refundAfterRejectionWindow(jobId, 2);
        assertEq(uint256(escrow.getJob(jobId).state), 4, "job closes in last milestone settlement");
        assertEq(_settleState(jobId, 2), 5, "rejection timeout refunds client");
        assertEq(escrow.lockedEscrow(address(token)), 0, "all terminal principal leaves locked ledger");
        assertEq(escrow.totalClaimable(address(token)), 600, "credits equal the funded principal");

        uint256 freelancerClaim = escrow.claimable(address(token), FREELANCER);
        uint256 clientClaim = escrow.claimable(address(token), CLIENT);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.refundAfterMissedDeadline(jobId, 0);
        vm.prank(CLIENT);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        phase2.approveMilestone(jobId, 1);
        assertEq(escrow.claimable(address(token), FREELANCER), freelancerClaim, "terminal retry cannot add a second credit");
        assertEq(escrow.claimable(address(token), CLIENT), clientClaim, "alternate terminal retry cannot move client credit");
        assertEq(escrow.totalClaimable(address(token)), 600, "terminal retry preserves total liabilities");
    }

    function test_A25_DonatedSurplusNeverBecomesMilestoneClaimable() public {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 100;
        amounts[1] = 200;
        uint256 jobId = _fundedJob(amounts, 10, 0);
        token.mint(address(escrow), 50);
        _submit(jobId, 0, keccak256("first"), bytes32(0));
        _approve(jobId, 0);

        assertEq(escrow.lockedEscrow(address(token)), 200, "settlement leaves other milestone locked");
        assertEq(escrow.totalClaimable(address(token)), 100, "only the settled milestone is credited");
        assertEq(token.balanceOf(address(escrow)), 350, "donation remains in token balance as surplus");

        uint256 graceEnd = escrow.getMilestone(jobId, 1).graceEnd;
        vm.warp(graceEnd);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 1);
        assertEq(escrow.lockedEscrow(address(token)), 0, "settled principal is fully accounted");
        assertEq(escrow.totalClaimable(address(token)), 300, "claimable never includes donated surplus");
        assertEq(token.balanceOf(address(escrow)), 350, "settlement does not transfer principal or surplus");

        vm.prank(FREELANCER);
        escrow.withdraw(address(token));
        vm.prank(CLIENT);
        escrow.withdraw(address(token));
        assertEq(escrow.totalClaimable(address(token)), 0, "both named beneficiaries can withdraw their claims");
        assertEq(token.balanceOf(address(escrow)), 50, "only the unallocated donation remains");
        vm.prank(OTHER);
        vm.expectRevert(FairworkEscrow.InvalidAmount.selector);
        escrow.withdraw(address(token));
    }

    function test_A25_SettlementCreditAndWithdrawalAreIsolatedAcrossTokenDecimals() public {
        MockToken token8 = new MockToken("8 decimal test", "T8", 8);
        MockToken token18 = new MockToken("18 decimal test", "T18", 18);
        FairworkEscrow.TokenConfig[] memory configs = new FairworkEscrow.TokenConfig[](3);
        configs[0] = FairworkEscrow.TokenConfig(address(token), 6, 1, 1e18, bytes32(0));
        configs[1] = FairworkEscrow.TokenConfig(address(token8), 8, 1, 1e18, bytes32(0));
        configs[2] = FairworkEscrow.TokenConfig(address(token18), 18, 1, 1e18, bytes32(0));
        FairworkEscrow multiTokenEscrow = new FairworkEscrow(configs, escrow.protocolConfig(), TREASURY);
        IPhase2Surface multiTokenPhase2 = IPhase2Surface(address(multiTokenEscrow));

        MockToken[] memory tokens = new MockToken[](3);
        tokens[0] = token;
        tokens[1] = token8;
        tokens[2] = token18;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1e6;
        amounts[1] = 1e8;
        amounts[2] = 1e18;
        uint256[] memory jobIds = new uint256[](3);

        for (uint256 i; i < tokens.length; ++i) {
            tokens[i].mint(CLIENT, amounts[i]);
            vm.prank(CLIENT);
            tokens[i].approve(address(multiTokenEscrow), type(uint256).max);
            jobIds[i] = _fundTokenJob(multiTokenEscrow, address(tokens[i]), amounts[i]);
            vm.prank(FREELANCER);
            multiTokenPhase2.submitMilestone(jobIds[i], 0, keccak256(abi.encode("decimal token", i)), bytes32(0));
            vm.prank(CLIENT);
            multiTokenPhase2.approveMilestone(jobIds[i], 0);
        }

        for (uint256 i; i < tokens.length; ++i) {
            assertEq(multiTokenEscrow.lockedEscrow(address(tokens[i])), 0, "settlement unlocks this token principal");
            assertEq(
                multiTokenEscrow.claimable(address(tokens[i]), FREELANCER),
                amounts[i],
                "settlement credits this token's raw units"
            );
            assertEq(multiTokenEscrow.totalClaimable(address(tokens[i])), amounts[i], "liability is tracked per token");
            assertEq(tokens[i].balanceOf(address(multiTokenEscrow)), amounts[i], "settlement makes no transfer");
        }

        vm.prank(FREELANCER);
        multiTokenEscrow.withdraw(address(token8));
        assertEq(multiTokenEscrow.totalClaimable(address(token8)), 0, "8 decimal withdrawal clears only its ledger");
        assertEq(multiTokenEscrow.claimable(address(token8), FREELANCER), 0, "8 decimal account claim is cleared");
        assertEq(token8.balanceOf(address(multiTokenEscrow)), 0, "8 decimal escrow balance is withdrawn");
        assertEq(multiTokenEscrow.totalClaimable(address(token)), amounts[0], "6 decimal liability is untouched");
        assertEq(multiTokenEscrow.totalClaimable(address(token18)), amounts[2], "18 decimal liability is untouched");
        assertEq(token.balanceOf(address(multiTokenEscrow)), amounts[0], "6 decimal escrow balance is untouched");
        assertEq(token18.balanceOf(address(multiTokenEscrow)), amounts[2], "18 decimal escrow balance is untouched");
    }

    function test_A25_FailedTokenTransferCannotBlockSettlementAndClaimRemainsBacked() public {
        Phase2TransferFailureToken failingToken = new Phase2TransferFailureToken();
        FairworkEscrow separateEscrow = _deployEscrow(address(failingToken));
        IPhase2Surface separatePhase2 = IPhase2Surface(address(separateEscrow));
        failingToken.mint(CLIENT, 100);
        vm.prank(CLIENT);
        failingToken.approve(address(separateEscrow), type(uint256).max);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100;
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(failingToken),
            titleCommitment: COMMITMENT,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: 0
        });
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(100, 10, COMMITMENT);
        vm.prank(CLIENT);
        uint256 jobId = separateEscrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        separateEscrow.acceptJob(jobId);
        vm.prank(CLIENT);
        separateEscrow.fundJob(jobId);
        vm.prank(FREELANCER);
        separatePhase2.submitMilestone(jobId, 0, keccak256("failure test deliverable"), bytes32(0));

        failingToken.setTransfersRevert(true);
        vm.prank(CLIENT);
        separatePhase2.approveMilestone(jobId, 0);
        assertEq(separateEscrow.claimable(address(failingToken), FREELANCER), 100, "settlement credits despite token transfer failure");
        assertEq(separateEscrow.totalClaimable(address(failingToken)), 100, "claim remains a ledger liability");
        assertEq(separateEscrow.lockedEscrow(address(failingToken)), 0, "settlement moves principal to claimable");

        vm.prank(FREELANCER);
        vm.expectRevert();
        separateEscrow.withdraw(address(failingToken));
        assertEq(separateEscrow.claimable(address(failingToken), FREELANCER), 100, "failed withdrawal rolls back claim clearing");
        failingToken.setTransfersRevert(false);
        vm.prank(FREELANCER);
        separateEscrow.withdraw(address(failingToken));
        assertEq(separateEscrow.totalClaimable(address(failingToken)), 0, "claim withdraws when token behavior recovers");
    }

    function test_A25_FailedTokenTransferCannotBlockMissedDeadlineRefund() public {
        Phase2TransferFailureToken failingToken = new Phase2TransferFailureToken();
        FairworkEscrow separateEscrow = _deployEscrow(address(failingToken));
        failingToken.mint(CLIENT, 75);
        vm.prank(CLIENT);
        failingToken.approve(address(separateEscrow), type(uint256).max);

        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(failingToken),
            titleCommitment: COMMITMENT,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: 0
        });
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(75, 10, COMMITMENT);
        vm.prank(CLIENT);
        uint256 jobId = separateEscrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        separateEscrow.acceptJob(jobId);
        vm.prank(CLIENT);
        separateEscrow.fundJob(jobId);

        uint256 graceEnd = separateEscrow.getMilestone(jobId, 0).graceEnd;
        failingToken.setTransfersRevert(true);
        vm.warp(graceEnd);
        vm.prank(OTHER);
        IPhase2Surface(address(separateEscrow)).refundAfterMissedDeadline(jobId, 0);

        assertEq(separateEscrow.claimable(address(failingToken), CLIENT), 75, "timeout settlement credits client during token failure");
        assertEq(separateEscrow.totalClaimable(address(failingToken)), 75, "timeout claim remains a ledger liability");
        assertEq(separateEscrow.lockedEscrow(address(failingToken)), 0, "timeout moves exact principal to claimable");
        vm.prank(CLIENT);
        vm.expectRevert();
        separateEscrow.withdraw(address(failingToken));
        assertEq(separateEscrow.claimable(address(failingToken), CLIENT), 75, "failed timeout-credit withdrawal rolls back");
    }

    function test_A25_RuntimeCodeDriftCannotBlockSettlementButStillBlocksWithdrawal() public {
        uint256 jobId = _one(100, 10, 0);
        _submit(jobId, 0, keccak256("code drift deliverable"), bytes32(0));
        vm.etch(address(token), hex"60006000fd");

        vm.prank(CLIENT);
        phase2.approveMilestone(jobId, 0);
        assertEq(escrow.claimable(address(token), FREELANCER), 100, "drifted token cannot block ledger settlement");
        assertEq(escrow.totalClaimable(address(token)), 100, "settled claim remains recorded");
        vm.prank(FREELANCER);
        vm.expectRevert(abi.encodeWithSelector(FairworkEscrow.TokenCodeChanged.selector, address(token)));
        escrow.withdraw(address(token));
        assertEq(escrow.claimable(address(token), FREELANCER), 100, "codehash guard preserves blocked withdrawal claim");
    }

    function test_A25_RuntimeCodeDriftCannotBlockMissedDeadlineRefund() public {
        uint256 jobId = _one(125, 10, 0);
        vm.etch(address(token), hex"60006000fd");

        uint64 graceEnd = escrow.getMilestone(jobId, 0).graceEnd;
        vm.warp(graceEnd);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 0);

        assertEq(_settleState(jobId, 0), 5, "code drift cannot block the public client refund");
        assertEq(
            uint256(escrow.getJob(jobId).state),
            uint256(FairworkEscrow.JobState.Closed),
            "timeout closes the one-milestone job"
        );
        assertEq(escrow.claimable(address(token), CLIENT), 125, "timeout credits rightful client despite code drift");
        assertEq(escrow.totalClaimable(address(token)), 125, "drifted-token timeout records full claim liability");
        assertEq(escrow.lockedEscrow(address(token)), 0, "drifted-token timeout removes exact locked principal");
        vm.prank(CLIENT);
        vm.expectRevert(abi.encodeWithSelector(FairworkEscrow.TokenCodeChanged.selector, address(token)));
        escrow.withdraw(address(token));
        assertEq(escrow.claimable(address(token), CLIENT), 125, "withdraw guard preserves timeout claim");
    }

    function _assertSubmittedEvent(
        Vm.Log[] memory logs,
        uint256 jobId,
        uint256 index,
        uint8 version,
        bytes32 deliverableHash,
        bytes32 opaqueReference,
        uint64 submittedAt,
        uint64 reviewEnd
    ) private view {
        bytes32 signature = keccak256("MilestoneSubmitted(uint256,uint256,uint8,bytes32,bytes32,uint64,uint64)");
        Vm.Log memory eventLog = _findEvent(logs, signature);
        assertEq(eventLog.topics.length, 3, "A-27 submission event indexes job and milestone");
        assertEq(eventLog.topics[1], bytes32(jobId), "A-27 submission event identifies job");
        assertEq(eventLog.topics[2], bytes32(index), "A-27 submission event identifies milestone");
        (uint8 actualVersion, bytes32 actualHash, bytes32 actualReference, uint64 actualSubmittedAt, uint64 actualReviewEnd) =
            abi.decode(eventLog.data, (uint8, bytes32, bytes32, uint64, uint64));
        assertEq(actualVersion, version, "A-27 submission event reports version");
        assertEq(actualHash, deliverableHash, "A-27 submission event reports deliverable hash");
        assertEq(actualReference, opaqueReference, "A-27 submission event reports opaque reference");
        assertEq(actualSubmittedAt, submittedAt, "A-27 submission event reports timestamp");
        assertEq(actualReviewEnd, reviewEnd, "A-27 submission event reports review end");
    }

    function _assertRejectedEvent(
        Vm.Log[] memory logs,
        uint256 jobId,
        uint256 index,
        uint8 rejectionCount,
        bytes32 reasonCommitment,
        uint64 rejectedAt,
        uint64 responseEnd
    ) private view {
        bytes32 signature = keccak256("MilestoneRejected(uint256,uint256,uint8,bytes32,uint64,uint64)");
        Vm.Log memory eventLog = _findEvent(logs, signature);
        assertEq(eventLog.topics.length, 3, "A-27 rejection event indexes job and milestone");
        assertEq(eventLog.topics[1], bytes32(jobId), "A-27 rejection event identifies job");
        assertEq(eventLog.topics[2], bytes32(index), "A-27 rejection event identifies milestone");
        (uint8 actualCount, bytes32 actualReason, uint64 actualRejectedAt, uint64 actualResponseEnd) =
            abi.decode(eventLog.data, (uint8, bytes32, uint64, uint64));
        assertEq(actualCount, rejectionCount, "A-27 rejection event reports independent count");
        assertEq(actualReason, reasonCommitment, "A-27 rejection event reports only the reason commitment");
        assertEq(actualRejectedAt, rejectedAt, "A-27 rejection event reports rejection time");
        assertEq(actualResponseEnd, responseEnd, "A-27 rejection event reports response end");
    }

    function _assertSettlementEvent(
        Vm.Log[] memory logs,
        uint256 jobId,
        uint256 index,
        address tokenAddress,
        address account,
        uint256 amount,
        uint8 reason
    ) private view {
        bytes32 signature = keccak256("MilestoneSettlementCredited(uint256,uint256,address,address,uint256,uint8)");
        Vm.Log memory eventLog = _findEvent(logs, signature);
        assertEq(eventLog.topics.length, 4, "A-27 settlement event indexes job, milestone and token");
        assertEq(eventLog.topics[1], bytes32(jobId), "A-27 settlement event identifies job");
        assertEq(eventLog.topics[2], bytes32(index), "A-27 settlement event identifies milestone");
        assertEq(address(uint160(uint256(eventLog.topics[3]))), tokenAddress, "A-27 settlement event identifies token");
        (address actualAccount, uint256 actualAmount, uint8 actualReason) =
            abi.decode(eventLog.data, (address, uint256, uint8));
        assertEq(actualAccount, account, "A-27 settlement event identifies the credited party");
        assertEq(actualAmount, amount, "A-27 settlement event reports exact milestone principal");
        assertEq(actualReason, reason, "A-27 settlement event reports the canonical settlement reason");
        _assertClaimableCreditedEvent(logs, tokenAddress, account, amount);
    }

    function _assertClaimableCreditedEvent(Vm.Log[] memory logs, address tokenAddress, address account, uint256 amount)
        private
        view
    {
        Vm.Log memory eventLog = _findEvent(logs, keccak256("ClaimableCredited(address,address,uint256)"));
        assertEq(eventLog.topics.length, 3, "A-27 compatibility credit indexes token and account");
        assertEq(address(uint160(uint256(eventLog.topics[1]))), tokenAddress, "compatibility credit identifies token");
        assertEq(address(uint160(uint256(eventLog.topics[2]))), account, "compatibility credit identifies beneficiary");
        assertEq(abi.decode(eventLog.data, (uint256)), amount, "compatibility credit reports exact principal");
    }

    function _assertTerminalCauseEvent(
        Vm.Log[] memory logs,
        string memory eventSignature,
        uint256 jobId,
        uint256 index,
        uint256 amount,
        address beneficiary,
        uint8 timeoutKind,
        bool includesTimeoutKind
    ) private view {
        Vm.Log memory eventLog = _findEvent(logs, keccak256(bytes(eventSignature)));
        assertEq(eventLog.topics.length, 3, "A-27 terminal cause indexes job and milestone");
        assertEq(eventLog.topics[1], bytes32(jobId), "terminal cause identifies job");
        assertEq(eventLog.topics[2], bytes32(index), "terminal cause identifies milestone");
        if (includesTimeoutKind) {
            (uint256 actualAmount, address actualBeneficiary, uint8 actualTimeoutKind) =
                abi.decode(eventLog.data, (uint256, address, uint8));
            assertEq(actualAmount, amount, "refund cause reports exact principal");
            assertEq(actualBeneficiary, beneficiary, "refund cause identifies rightful client");
            assertEq(actualTimeoutKind, timeoutKind, "refund cause identifies timeout path");
        } else {
            (uint256 actualAmount, address actualBeneficiary) = abi.decode(eventLog.data, (uint256, address));
            assertEq(actualAmount, amount, "release cause reports exact principal");
            assertEq(actualBeneficiary, beneficiary, "release cause identifies rightful freelancer");
        }
    }

    function _assertJobClosedEvent(Vm.Log[] memory logs, uint256 jobId) private view {
        Vm.Log memory eventLog = _findEvent(logs, keccak256("JobClosed(uint256)"));
        assertEq(eventLog.topics.length, 2, "A-27 closure event indexes job id");
        assertEq(eventLog.topics[1], bytes32(jobId), "A-27 closure event identifies the closed job");
    }

    function _findEvent(Vm.Log[] memory logs, bytes32 signature) private view returns (Vm.Log memory eventLog) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(escrow) && logs[i].topics.length != 0
                    && logs[i].topics[0] == signature
            ) return logs[i];
        }
        revert("expected event was not emitted");
    }

    function test_F20_F21_F24_NondisputedReadySubmittedAndRejectedStatesHavePublicBoundedExits() public {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 11;
        amounts[1] = 22;
        amounts[2] = 33;
        uint256 jobId = _fundedJob(amounts, 10, 1);
        _submit(jobId, 1, keccak256("submitted"), bytes32(0));
        _submit(jobId, 2, keccak256("rejected"), bytes32(0));
        _reject(jobId, 2, keccak256("needs changes"));

        uint256 graceEnd = escrow.getMilestone(jobId, 0).graceEnd;
        vm.warp(graceEnd);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 0);
        assertEq(_settleState(jobId, 0), 5, "Ready has a public missed-deadline refund");

        uint256 responseEnd = _milestone(jobId, 2).responseEnd;
        vm.warp(responseEnd);
        vm.prank(OTHER);
        phase2.refundAfterRejectionWindow(jobId, 2);
        assertEq(_settleState(jobId, 2), 5, "Rejected has a public response timeout refund");

        uint256 reviewEnd = _milestone(jobId, 1).reviewEnd;
        vm.warp(reviewEnd);
        vm.prank(OTHER);
        phase2.releaseAfterSilence(jobId, 1);
        assertEq(_settleState(jobId, 1), 4, "Submitted has a public silence release");
        assertEq(uint256(escrow.getJob(jobId).state), 4, "bounded public exits close the nondisputed job");
        assertEq(escrow.totalClaimable(address(token)), 66, "all bounded exits allocate full principal");
    }
}

/// @dev Stateful handler calls only production Phase 2 settlement and Phase 1 withdrawal entrypoints.
contract Phase2SettlementHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant JOB_COUNT = 6;
    address private constant CLIENT = address(0xC11E);
    address private constant FREELANCER = address(0xFEE);
    address private constant OTHER = address(0xB0B);
    bytes32 private constant COMMITMENT = keccak256("phase 2 invariant terms");

    FairworkEscrow public immutable escrow;
    IPhase2Surface public immutable phase2;
    MockToken public immutable token;
    uint256[JOB_COUNT] private _jobIds;
    uint256 public immutable fundedPrincipal;
    uint256 public withdrawnPrincipal;
    uint256 public settlementCount;
    uint256 public timeoutSettlementCount;
    uint256 public withdrawalCount;
    uint256 public boundedDrainCount;

    constructor(FairworkEscrow escrow_, IPhase2Surface phase2_, MockToken token_) {
        escrow = escrow_;
        phase2 = phase2_;
        token = token_;

        uint256 principal;
        for (uint256 i; i < JOB_COUNT; ++i) {
            uint256 amount = 100 + (i * 37);
            FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
                freelancer: FREELANCER,
                token: address(token_),
                titleCommitment: COMMITMENT,
                descriptionCommitment: keccak256(abi.encode("description", i)),
                scopeCommitment: keccak256(abi.encode("scope", i)),
                deliveryRuleCommitment: keccak256(abi.encode("delivery", i)),
                reviewWindow: 120,
                revisionLimit: 2
            });
            FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
            milestones[0] = FairworkEscrow.MilestoneInput(amount, 10, keccak256(abi.encode("criteria", i)));
            vm.prank(CLIENT);
            uint256 jobId = escrow_.createJob(terms, milestones);
            vm.prank(FREELANCER);
            escrow_.acceptJob(jobId);
            vm.prank(CLIENT);
            escrow_.fundJob(jobId);
            _jobIds[i] = jobId;
            principal += amount;
        }
        fundedPrincipal = principal;
    }

    function submit(uint256 jobSeed, bytes32 hashSeed, bytes32 referenceSeed) external {
        uint256 jobId = _jobIds[jobSeed % JOB_COUNT];
        (bool found, IPhase2Surface.MilestoneView memory milestone) = _readMilestone(jobId);
        if (!found || milestone.state != 0 || block.timestamp >= milestone.graceEnd) return;
        vm.prank(FREELANCER);
        try phase2.submitMilestone(jobId, 0, _nonzero(hashSeed), referenceSeed) {} catch {}
    }

    function approve(uint256 jobSeed) external {
        uint256 jobId = _jobIds[jobSeed % JOB_COUNT];
        (bool found, IPhase2Surface.MilestoneView memory milestone) = _readMilestone(jobId);
        if (!found || milestone.state != 1 || block.timestamp >= milestone.reviewEnd) return;
        vm.prank(CLIENT);
        try phase2.approveMilestone(jobId, 0) {
            settlementCount += 1;
        } catch {}
    }

    function reject(uint256 jobSeed, bytes32 reasonSeed) external {
        uint256 jobId = _jobIds[jobSeed % JOB_COUNT];
        (bool found, IPhase2Surface.MilestoneView memory milestone) = _readMilestone(jobId);
        if (!found || milestone.state != 1 || block.timestamp >= milestone.reviewEnd || milestone.rejectionCount >= 2) return;
        vm.prank(CLIENT);
        try phase2.rejectMilestone(jobId, 0, _nonzero(reasonSeed)) {} catch {}
    }

    function resubmit(uint256 jobSeed, bytes32 hashSeed, bytes32 referenceSeed) external {
        uint256 jobId = _jobIds[jobSeed % JOB_COUNT];
        (bool found, IPhase2Surface.MilestoneView memory milestone) = _readMilestone(jobId);
        if (!found || milestone.state != 2 || block.timestamp >= milestone.responseEnd) return;
        vm.prank(FREELANCER);
        try phase2.resubmitMilestone(jobId, 0, _nonzero(hashSeed), referenceSeed) {} catch {}
    }

    function timeout(uint256 jobSeed) external {
        uint256 jobId = _jobIds[jobSeed % JOB_COUNT];
        (bool found, IPhase2Surface.MilestoneView memory milestone) = _readMilestone(jobId);
        if (!found) return;
        if (milestone.state == 0 && block.timestamp >= milestone.graceEnd) {
            vm.prank(OTHER);
            try phase2.refundAfterMissedDeadline(jobId, 0) {
                settlementCount += 1;
                timeoutSettlementCount += 1;
            } catch {}
        } else if (milestone.state == 1 && block.timestamp >= milestone.reviewEnd) {
            vm.prank(OTHER);
            try phase2.releaseAfterSilence(jobId, 0) {
                settlementCount += 1;
                timeoutSettlementCount += 1;
            } catch {}
        } else if (milestone.state == 2 && block.timestamp >= milestone.responseEnd) {
            vm.prank(OTHER);
            try phase2.refundAfterRejectionWindow(jobId, 0) {
                settlementCount += 1;
                timeoutSettlementCount += 1;
            } catch {}
        }
    }

    function drainOne(uint256 jobSeed) external {
        uint256 jobId = _jobIds[jobSeed % JOB_COUNT];
        (bool found, IPhase2Surface.MilestoneView memory milestone) = _readMilestone(jobId);
        if (!found) return;
        if (milestone.state == 0) {
            if (block.timestamp < milestone.graceEnd) vm.warp(milestone.graceEnd);
            vm.prank(OTHER);
            try phase2.refundAfterMissedDeadline(jobId, 0) {
                settlementCount += 1;
                timeoutSettlementCount += 1;
                boundedDrainCount += 1;
            } catch {}
        } else if (milestone.state == 1) {
            if (block.timestamp < milestone.reviewEnd) vm.warp(milestone.reviewEnd);
            vm.prank(OTHER);
            try phase2.releaseAfterSilence(jobId, 0) {
                settlementCount += 1;
                timeoutSettlementCount += 1;
                boundedDrainCount += 1;
            } catch {}
        } else if (milestone.state == 2) {
            if (block.timestamp < milestone.responseEnd) vm.warp(milestone.responseEnd);
            vm.prank(OTHER);
            try phase2.refundAfterRejectionWindow(jobId, 0) {
                settlementCount += 1;
                timeoutSettlementCount += 1;
                boundedDrainCount += 1;
            } catch {}
        }
    }

    /// @dev Force a deterministic, meaningful invariant baseline across approval, rejection, resubmission,
    /// all three public timeout paths, and both party withdrawals.
    function exerciseSeededPaths() external {
        _trySubmit(0);
        _tryApprove(0);

        _trySubmit(1);
        vm.prank(CLIENT);
        try phase2.rejectMilestone(_jobIds[1], 0, keccak256("seed reason")) {} catch {}
        vm.prank(FREELANCER);
        try phase2.resubmitMilestone(_jobIds[1], 0, keccak256("seed version two"), bytes32(0)) {} catch {}
        _tryApprove(1);

        _trySubmit(3);
        _trySubmit(4);
        vm.prank(CLIENT);
        try phase2.rejectMilestone(_jobIds[4], 0, keccak256("seed timeout reason")) {} catch {}

        this.drainOne(2);
        this.withdraw(0);
        this.withdraw(1);
    }

    function advanceTime(uint32 secondsSeed) external {
        vm.warp(block.timestamp + (uint256(secondsSeed) % 301));
    }

    function withdraw(uint8 accountSeed) external {
        address account = accountSeed % 2 == 0 ? CLIENT : FREELANCER;
        uint256 amount = escrow.claimable(address(token), account);
        if (amount == 0) return;
        vm.prank(account);
        try escrow.withdraw(address(token)) {
            withdrawnPrincipal += amount;
            withdrawalCount += 1;
        } catch {}
    }

    function jobIdAt(uint256 index) external view returns (uint256) {
        return _jobIds[index];
    }

    function _nonzero(bytes32 value) private pure returns (bytes32) {
        return value == bytes32(0) ? bytes32(uint256(1)) : value;
    }

    function _trySubmit(uint256 index) private {
        vm.prank(FREELANCER);
        try phase2.submitMilestone(_jobIds[index], 0, keccak256(abi.encode("seed submission", index)), bytes32(0))
        {} catch {}
    }

    function _tryApprove(uint256 index) private {
        vm.prank(CLIENT);
        try phase2.approveMilestone(_jobIds[index], 0) {
            settlementCount += 1;
        } catch {}
    }

    function _readMilestone(uint256 jobId)
        private
        view
        returns (bool found, IPhase2Surface.MilestoneView memory milestone)
    {
        (bool success, bytes memory result) = address(phase2).staticcall(
            abi.encodeWithSelector(IPhase2Surface.getMilestone.selector, jobId, uint256(0))
        );
        if (!success || result.length < 13 * 32) return (false, milestone);
        return (true, abi.decode(result, (IPhase2Surface.MilestoneView)));
    }
}

contract Phase2SettlementInvariantTest is Phase2Fixture {
    Phase2SettlementHandler private handler;

    function setUp() public override {
        super.setUp();
        handler = new Phase2SettlementHandler(escrow, phase2, token);
        handler.exerciseSeededPaths();
        targetContract(address(handler));
    }

    function invariant_A25_FundedPrincipalIsAlwaysLockedClaimableOrWithdrawn() public view {
        assertGe(handler.settlementCount(), 3, "invariant must exercise real production settlement paths");
        assertGe(handler.withdrawalCount(), 2, "invariant must exercise real production withdrawals");
        assertGe(handler.timeoutSettlementCount(), 1, "invariant must exercise a public timeout settlement");
        uint256 expectedLocked;
        uint256 expectedSettled;
        for (uint256 i; i < 6; ++i) {
            uint256 jobId = handler.jobIdAt(i);
            FairworkEscrow.MilestoneView memory milestone = escrow.getMilestone(jobId, 0);
            if (milestone.state == FairworkEscrow.MilestoneState.Released
                || milestone.state == FairworkEscrow.MilestoneState.Refunded
                || milestone.state == FairworkEscrow.MilestoneState.Resolved) {
                expectedSettled += milestone.amount;
            } else {
                expectedLocked += milestone.amount;
            }
        }

        assertEq(escrow.lockedEscrow(address(token)), expectedLocked, "A-25 locked ledger matches every nonterminal milestone");
        assertEq(
            escrow.totalClaimable(address(token)) + handler.withdrawnPrincipal(),
            expectedSettled,
            "A-25 settlement credits and withdrawals conserve terminal principal"
        );
        assertEq(
            escrow.totalClaimable(address(token)),
            escrow.claimable(address(token), CLIENT) + escrow.claimable(address(token), FREELANCER),
            "all claim liabilities belong to one of the two named parties"
        );
        assertEq(escrow.claimable(address(token), escrow.owner()), 0, "owner never acquires a settlement claim");
        assertEq(escrow.claimable(address(token), escrow.treasury()), 0, "treasury never acquires a settlement claim");
        assertEq(
            expectedLocked + expectedSettled,
            handler.fundedPrincipal(),
            "A-25 funded principal is partitioned between open and terminal milestones"
        );
        assertEq(
            token.balanceOf(address(escrow)),
            escrow.lockedEscrow(address(token)) + escrow.totalClaimable(address(token)),
            "all escrow token balances match locked and claimable liabilities without surplus"
        );
    }

    function invariant_F20_F21_F24_ExpiredNondisputedStatesHaveBoundedPublicExits() public {
        uint256 snapshotId = vm.snapshotState();
        uint8 observedStates = _drainTrackedJobs();
        if (observedStates != 7) {
            _drainFreshThreeStateScenario();
            observedStates = 7;
        }
        assertEq(observedStates, 7, "bounded drain proof covers Ready, Submitted and Rejected");
        assertTrue(vm.revertToStateAndDelete(snapshotId), "invariant restores the randomized chain state");
    }

    function _drainTrackedJobs() private returns (uint8 observedStates) {
        for (uint256 i; i < 6; ++i) {
            uint256 jobId = handler.jobIdAt(i);
            FairworkEscrow.JobView memory job = escrow.getJob(jobId);
            IPhase2Surface.MilestoneView memory milestone = phase2.getMilestone(jobId, 0);
            assertLe(milestone.rejectionCount, job.revisionLimit, "fuzzed rejection count stays within signed limit");
            assertLe(milestone.submissionCount, job.revisionLimit + 1, "fuzzed history stays within signed bound");
            assertLe(milestone.submissionCount, milestone.rejectionCount + 1, "each resubmission follows a consumed rejection");
            if (milestone.submissionCount != 0) {
                IPhase2Surface.Submission memory latest =
                    phase2.getSubmission(jobId, 0, milestone.submissionCount - 1);
                assertEq(latest.version, milestone.submissionCount, "fuzzed history remains contiguous");
            }

            if (milestone.state == uint8(FairworkEscrow.MilestoneState.Ready)) {
                observedStates |= 1;
                _drainTrackedMilestone(jobId, milestone.graceEnd, 0, CLIENT, milestone.amount, "Ready timeout");
            } else if (milestone.state == uint8(FairworkEscrow.MilestoneState.Submitted)) {
                observedStates |= 2;
                _drainTrackedMilestone(jobId, milestone.reviewEnd, 1, FREELANCER, milestone.amount, "Submitted timeout");
            } else if (milestone.state == uint8(FairworkEscrow.MilestoneState.Rejected)) {
                observedStates |= 4;
                _drainTrackedMilestone(jobId, milestone.responseEnd, 2, CLIENT, milestone.amount, "Rejected timeout");
            } else {
                assertTrue(
                    milestone.state == uint8(FairworkEscrow.MilestoneState.Released)
                        || milestone.state == uint8(FairworkEscrow.MilestoneState.Refunded),
                    "tracked campaign stays in nondisputed states"
                );
                assertEq(uint256(job.state), 4, "terminal tracked milestone already closed its one-milestone job");
            }
        }
    }

    function _drainTrackedMilestone(
        uint256 jobId,
        uint64 end,
        uint8 timeoutPath,
        address beneficiary,
        uint256 amount,
        string memory label
    ) private {
        uint256 lockedBefore = escrow.lockedEscrow(address(token));
        uint256 claimableBefore = escrow.claimable(address(token), beneficiary);
        uint256 claimsBefore = escrow.totalClaimable(address(token));
        uint256 tokenBalanceBefore = token.balanceOf(address(escrow));
        if (block.timestamp < end) vm.warp(end);

        vm.prank(OTHER);
        uint8 terminalState;
        if (timeoutPath == 0) {
            terminalState = 5;
            phase2.refundAfterMissedDeadline(jobId, 0);
        } else if (timeoutPath == 1) {
            terminalState = 4;
            phase2.releaseAfterSilence(jobId, 0);
        } else {
            terminalState = 5;
            phase2.refundAfterRejectionWindow(jobId, 0);
        }

        assertEq(uint256(escrow.getMilestone(jobId, 0).state), terminalState, label);
        assertEq(
            uint256(escrow.getJob(jobId).state),
            uint256(FairworkEscrow.JobState.Closed),
            "one-milestone job closes on its terminal exit"
        );
        assertEq(escrow.lockedEscrow(address(token)), lockedBefore - amount, "bounded exit removes exact locked principal");
        assertEq(escrow.claimable(address(token), beneficiary), claimableBefore + amount, "bounded exit credits the rightful party");
        assertEq(escrow.totalClaimable(address(token)), claimsBefore + amount, "bounded exit adds exact claim liability");
        assertEq(token.balanceOf(address(escrow)), tokenBalanceBefore, "bounded exit does not call the token");
    }

    function _drainFreshThreeStateScenario() private {
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 11;
        amounts[1] = 22;
        amounts[2] = 33;
        uint256 jobId = _createAndFundScenario(amounts);
        vm.prank(FREELANCER);
        phase2.submitMilestone(jobId, 1, keccak256("bounded review exit"), bytes32(0));
        vm.prank(FREELANCER);
        phase2.submitMilestone(jobId, 2, keccak256("bounded response exit"), bytes32(0));
        vm.prank(CLIENT);
        phase2.rejectMilestone(jobId, 2, keccak256("bounded response reason"));

        uint256 escrowTokensBefore = token.balanceOf(address(escrow));
        uint256 lockedBefore = escrow.lockedEscrow(address(token));
        uint256 claimableClientBefore = escrow.claimable(address(token), CLIENT);
        uint256 claimableFreelancerBefore = escrow.claimable(address(token), FREELANCER);
        uint256 claimsBefore = escrow.totalClaimable(address(token));

        FairworkEscrow.MilestoneView memory ready = escrow.getMilestone(jobId, 0);
        if (block.timestamp < ready.graceEnd) vm.warp(ready.graceEnd);
        vm.prank(OTHER);
        phase2.refundAfterMissedDeadline(jobId, 0);
        assertEq(uint256(escrow.getMilestone(jobId, 0).state), 5, "Ready drains through public missed-delivery refund");
        assertEq(escrow.lockedEscrow(address(token)), lockedBefore - 11, "missed-delivery exit removes exact principal");
        assertEq(escrow.claimable(address(token), CLIENT), claimableClientBefore + 11, "missed-delivery exit credits client");
        assertEq(uint256(escrow.getJob(jobId).state), 2, "job remains Funded while other milestones are open");

        IPhase2Surface.MilestoneView memory submitted = phase2.getMilestone(jobId, 1);
        if (block.timestamp < submitted.reviewEnd) vm.warp(submitted.reviewEnd);
        vm.prank(OTHER);
        phase2.releaseAfterSilence(jobId, 1);
        assertEq(uint256(escrow.getMilestone(jobId, 1).state), 4, "Submitted drains through public silence release");
        assertEq(escrow.lockedEscrow(address(token)), lockedBefore - 11 - 22, "silence exit removes exact principal");
        assertEq(escrow.claimable(address(token), FREELANCER), claimableFreelancerBefore + 22, "silence exit credits freelancer");
        assertEq(uint256(escrow.getJob(jobId).state), 2, "job remains Funded until rejected milestone exits");

        IPhase2Surface.MilestoneView memory rejected = phase2.getMilestone(jobId, 2);
        if (block.timestamp < rejected.responseEnd) vm.warp(rejected.responseEnd);
        vm.prank(OTHER);
        phase2.refundAfterRejectionWindow(jobId, 2);
        assertEq(uint256(escrow.getMilestone(jobId, 2).state), 5, "Rejected drains through public response refund");
        assertEq(uint256(escrow.getJob(jobId).state), 4, "last bounded exit closes the job");
        assertEq(escrow.lockedEscrow(address(token)), lockedBefore - 66, "all exits remove exact terminal principal");
        assertEq(escrow.claimable(address(token), CLIENT), claimableClientBefore + 44, "response timeout also credits client");
        assertEq(escrow.totalClaimable(address(token)), claimsBefore + 66, "bounded exits credit exactly the full principal");
        assertEq(token.balanceOf(address(escrow)), escrowTokensBefore, "settlement performs no token transfer");
    }

    function test_F20_F21_F24_StatefulHandlerCanDrainEveryNondisputedLifecycle() public {
        handler.drainOne(5);
        handler.drainOne(3);
        handler.drainOne(4);

        uint8[6] memory expectedStates = [uint8(4), 4, 5, 4, 5, 5];
        for (uint256 i; i < 6; ++i) {
            assertEq(_phase2State(handler.jobIdAt(i)), expectedStates[i], "stateful public exits settle each nondisputed state");
            assertEq(uint256(escrow.getJob(handler.jobIdAt(i)).state), 4, "fully drained job is Closed");
        }
        assertEq(escrow.lockedEscrow(address(token)), 0, "bounded public exits drain locked principal");
        assertEq(
            escrow.totalClaimable(address(token)) + handler.withdrawnPrincipal(),
            handler.fundedPrincipal(),
            "all drained principal is credited or withdrawn"
        );
    }

    function _createAndFundScenario(uint256[] memory amounts) private returns (uint256 jobId) {
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(token),
            titleCommitment: COMMITMENT,
            descriptionCommitment: keccak256("snapshot description"),
            scopeCommitment: keccak256("snapshot scope"),
            deliveryRuleCommitment: keccak256("snapshot delivery"),
            reviewWindow: 120,
            revisionLimit: 1
        });
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](amounts.length);
        for (uint256 i; i < amounts.length; ++i) {
            milestones[i] = FairworkEscrow.MilestoneInput(amounts[i], 10, keccak256(abi.encode("snapshot criteria", i)));
        }
        vm.prank(CLIENT);
        jobId = escrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);
    }

    function _phase2State(uint256 jobId) private view returns (uint8) {
        return phase2.getMilestone(jobId, 0).state;
    }
}
