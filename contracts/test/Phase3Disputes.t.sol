// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ConfigurableFeeToken, MockToken} from "./support/MockTokens.sol";
import {Vm} from "forge-std/Vm.sol";
import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {
    IPhase2Read,
    IPhase3Engine,
    IPhase3Escrow,
    IPhase3Randomness,
    Phase3TestBase
} from "./support/Phase3TestSupport.sol";

interface IPhase3EngineForwardingProbe {
    function addArbiter(address arbiter) external;
    function removeArbiter(address arbiter) external;
    function submitEvidence(uint256 disputeId, address actor, bytes32 evidenceHash, bytes32 opaqueReference)
        external;
}

contract Phase3DisputesTest is Phase3TestBase {
    function test_F30_SubmittedClientOpensOneDisputeAndFreezesPrincipalAtReviewBoundary() public {
        uint256 jobId = _fundedJob(10_001, 0);
        _submit(jobId);
        IPhase3Escrow.MilestoneView memory milestone = p3.getMilestone(jobId, 0);
        uint256 deposit = uint256(10_001) * 200 / 10_000;
        uint256 beforeClient = token.balanceOf(CLIENT);
        uint256 beforeEscrow = token.balanceOf(address(escrow));
        vm.warp(milestone.reviewEnd - 1);
        uint64 openedAt = uint64(block.timestamp);
        uint64 evidenceDeadline = openedAt + FUNDING_WINDOW;
        vm.recordLogs();
        vm.prank(CLIENT);
        uint256 disputeId = p3.openDispute(jobId, 0);

        assertGt(disputeId, 0, "zero remains the unopened-milestone sentinel");
        _assertOpenedEvent(vm.getRecordedLogs(), disputeId, jobId, deposit, evidenceDeadline);
        assertEq(p3.getMilestoneDispute(jobId, 0), disputeId, "milestone binds one dispute id");
        assertEq(p3.getDispute(disputeId).phase, 1, "new dispute opens evidence phase");
        assertEq(p3.getDispute(disputeId).opener, CLIENT, "the opener is recorded");
        assertEq(p3.getDispute(disputeId).depositAmount, deposit, "deposit uses raw-unit floor math");
        assertEq(p3.getDispute(disputeId).evidenceDeadline, evidenceDeadline, "evidence clock starts at opening");
        assertEq(beforeClient - token.balanceOf(CLIENT), deposit, "opener pays exactly one deposit");
        assertEq(token.balanceOf(address(escrow)) - beforeEscrow, deposit, "escrow receives exact raw units");
        assertEq(p3.disputeDeposits(address(token)), deposit, "deposit liability is recorded");
        assertEq(p3.lockedEscrow(address(token)), 10_001, "dispute principal remains locked");
        assertEq(p3.getMilestone(jobId, 0).state, 3, "milestone enters Disputed");

        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        vm.prank(CLIENT);
        p3.openDispute(jobId, 0);
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(CLIENT);
        p3.matchDisputeDeposit(disputeId);

        vm.warp(milestone.reviewEnd);
        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        p3.releaseAfterSilence(jobId, 0);
        assertEq(p3.getDispute(disputeId).phase, 1, "the review timeout cannot end a dispute");
    }

    function test_F30_RejectedMilestoneAllowsEitherPartyBeforeResponseEndOnly() public {
        (uint256 jobFreelancerOpens, uint256 freelancerDispute) = _openRejected(1_000, FREELANCER);
        IPhase3Escrow.MilestoneView memory rejected = p3.getMilestone(jobFreelancerOpens, 0);
        vm.warp(rejected.responseEnd - 1);
        assertEq(p3.getDispute(freelancerDispute).opener, FREELANCER, "freelancer may open after rejection");

        uint256 jobClientOpens = _fundedJob(2_000, 1);
        _submit(jobClientOpens);
        vm.prank(CLIENT);
        IPhase2Read(address(escrow)).rejectMilestone(jobClientOpens, 0, keccak256("second reason"));
        IPhase3Escrow.MilestoneView memory rejected2 = p3.getMilestone(jobClientOpens, 0);
        vm.warp(rejected2.responseEnd - 1);
        vm.prank(CLIENT);
        uint256 clientDispute = p3.openDispute(jobClientOpens, 0);
        assertEq(p3.getDispute(clientDispute).opener, CLIENT, "client may open after rejection");
        assertEq(p3.getMilestone(jobClientOpens, 0).state, 3, "opening stops the rejection refund path");
        vm.warp(rejected2.responseEnd);
        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        p3.refundAfterRejectionWindow(jobClientOpens, 0);
    }

    function test_F30_RejectedDisputeRejectsAtResponseEndAndAfter() public {
        uint256 jobId = _fundedJob(1_000, 1);
        _submit(jobId);
        vm.prank(CLIENT);
        IPhase2Read(address(escrow)).rejectMilestone(jobId, 0, keccak256("reason"));
        uint64 responseEnd = p3.getMilestone(jobId, 0).responseEnd;
        vm.warp(responseEnd);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        vm.prank(CLIENT);
        p3.openDispute(jobId, 0);
        vm.warp(responseEnd + 1);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        vm.prank(FREELANCER);
        p3.openDispute(jobId, 0);
        assertEq(p3.getMilestoneDispute(jobId, 0), 0, "late rejected-state attempts leave sentinel unchanged");
    }

    function test_F30_SubmittedDisputeRejectsAtReviewEndAndAfter() public {
        uint256 jobId = _fundedJob(100, 0);
        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        vm.prank(CLIENT);
        p3.openDispute(jobId, 0); // Ready is not an eligible source state.
        _submit(jobId);
        uint64 reviewEnd = p3.getMilestone(jobId, 0).reviewEnd;
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(FREELANCER);
        p3.openDispute(jobId, 0);
        vm.warp(reviewEnd);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        vm.prank(CLIENT);
        p3.openDispute(jobId, 0);
        vm.warp(reviewEnd + 1);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        vm.prank(CLIENT);
        p3.openDispute(jobId, 0);
        assertEq(p3.getMilestoneDispute(jobId, 0), 0, "late attempts do not bind a dispute");
    }

    function test_F30_DisputeIdCannotBeReusedForAnotherMilestoneOrJob() public {
        uint256 jobId = _fundedJob(1_000, 0);
        _submit(jobId);
        vm.prank(CLIENT);
        uint256 disputeId = p3.openDispute(jobId, 0);
        assertGt(disputeId, 0, "dispute id zero is reserved as the unopened sentinel");
        uint256 otherJob = _fundedJob(2_000, 0);
        _submit(otherJob);
        assertEq(p3.getMilestoneDispute(jobId, 0), disputeId, "original milestone retains its id");
        assertEq(p3.getMilestoneDispute(otherJob, 0), 0, "another milestone has no inherited id");
        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        p3.getDispute(type(uint256).max);
    }

    function test_F30_DepositMinimumRawDeltaMatchOnceAndEvidenceCutoff() public {
        (uint256 jobId, uint256 disputeId) = _openSubmitted(49, 0);
        uint256 deposit = 1; // floor(49 * 200 / 10,000), then min 1 raw unit
        assertEq(p3.getDispute(disputeId).depositAmount, deposit);

        uint256 beforeFreelancer = token.balanceOf(FREELANCER);
        uint256 beforeEscrow = token.balanceOf(address(escrow));
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(disputeId);
        assertEq(beforeFreelancer - token.balanceOf(FREELANCER), deposit, "counterparty pays exactly D");
        assertEq(token.balanceOf(address(escrow)) - beforeEscrow, deposit, "match has exact incoming delta");
        assertEq(p3.disputeDeposits(address(token)), 2 * deposit, "both posted deposits are liabilities");
        assertTrue(p3.getDispute(disputeId).freelancerDeposited, "counterparty deposit is marked once");
        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(disputeId);

        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        vm.warp(dispute.evidenceDeadline - 1);
        vm.prank(FREELANCER);
        p3.submitEvidence(disputeId, keccak256("last valid evidence"), bytes32(0));
        vm.warp(dispute.evidenceDeadline);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(disputeId);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        vm.prank(FREELANCER);
        p3.submitEvidence(disputeId, keccak256("at cutoff"), bytes32(0));
        vm.warp(dispute.evidenceDeadline + 1);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        vm.prank(CLIENT);
        p3.submitEvidence(disputeId, keccak256("after cutoff"), bytes32(0));
        assertEq(p3.getMilestoneDispute(jobId, 0), disputeId, "cutoff does not change dispute binding");
    }

    function test_F30_F31_DepositExactDeltaFailureRollsBackOpenAndLiabilities() public {
        ConfigurableFeeToken feeToken = new ConfigurableFeeToken("Fee", "FEE", 6, 100);
        FairworkEscrow feeEscrow = _deployEscrow(address(feeToken), 6);
        IPhase3Escrow feeP3 = IPhase3Escrow(address(feeEscrow));
        feeToken.mint(CLIENT, 1_000_000);
        vm.prank(CLIENT);
        feeToken.approve(address(feeEscrow), type(uint256).max);
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(10_000, 10, keccak256("criteria"));
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(feeToken),
            titleCommitment: TERMS,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: 0
        });
        vm.prank(CLIENT);
        uint256 jobId = feeEscrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        feeEscrow.acceptJob(jobId);
        vm.prank(CLIENT);
        feeEscrow.fundJob(jobId);
        vm.prank(FREELANCER);
        IPhase2Read(address(feeEscrow)).submitMilestone(jobId, 0, keccak256("delivery"), bytes32(0));
        feeToken.setFeeEnabled(true);
        uint256 clientBefore = feeToken.balanceOf(CLIENT);
        vm.expectRevert(IPhase3Escrow.ExactTransferRequired.selector);
        vm.prank(CLIENT);
        feeP3.openDispute(jobId, 0);
        assertEq(feeToken.balanceOf(CLIENT), clientBefore, "failed exact deposit rolls back token transfer");
        assertEq(feeP3.lockedEscrow(address(feeToken)), 10_000, "principal remains locked");
        assertEq(feeP3.disputeDeposits(address(feeToken)), 0, "failed deposit creates no liability");
        assertEq(feeP3.getMilestoneDispute(jobId, 0), 0, "failed open leaves no dispute record");
        assertEq(feeP3.getMilestone(jobId, 0).state, 1, "milestone remains Submitted");
    }

    function test_F31_EachPartyMaySubmitFiveEvidenceItemsAndSixthReverts() public {
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        vm.warp(dispute.evidenceDeadline - 1);
        for (uint256 i; i < 5; ++i) {
            vm.prank(CLIENT);
            p3.submitEvidence(disputeId, keccak256(abi.encode("client", i)), bytes32(0));
            vm.prank(FREELANCER);
            p3.submitEvidence(disputeId, keccak256(abi.encode("freelancer", i)), bytes32(uint256(i)));
        }
        dispute = p3.getDispute(disputeId);
        assertEq(dispute.clientEvidenceCount, 5, "client cap is independent");
        assertEq(dispute.freelancerEvidenceCount, 5, "freelancer cap is independent");
        (bytes32 clientHash, bytes32 clientReference,) = p3.getEvidence(disputeId, CLIENT, 0);
        assertEq(clientHash, keccak256(abi.encode("client", uint256(0))));
        assertEq(clientReference, bytes32(0), "zero opaque reference is permitted");
        (bytes32 freelancerHash, bytes32 freelancerReference,) = p3.getEvidence(disputeId, FREELANCER, 4);
        assertEq(freelancerHash, keccak256(abi.encode("freelancer", uint256(4))));
        assertEq(freelancerReference, bytes32(uint256(4)));

        vm.expectRevert(IPhase3Escrow.EvidenceLimitReached.selector);
        vm.prank(CLIENT);
        p3.submitEvidence(disputeId, keccak256("client sixth"), bytes32(0));
        vm.expectRevert(IPhase3Escrow.EvidenceLimitReached.selector);
        vm.prank(FREELANCER);
        p3.submitEvidence(disputeId, keccak256("freelancer sixth"), bytes32(0));
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(OTHER);
        p3.submitEvidence(disputeId, keccak256("outsider"), bytes32(0));
        vm.expectRevert(IPhase3Escrow.InvalidCommitment.selector);
        vm.prank(CLIENT);
        p3.submitEvidence(disputeId, bytes32(0), bytes32(0));
    }

    function test_F31_EngineCannotBeCalledDirectlyWithSpoofedForwardedActor() public {
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address engine = p3.arbitrationEngine();
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(CLIENT);
        IPhase3EngineForwardingProbe(engine).submitEvidence(disputeId, CLIENT, keccak256("spoof"), bytes32(0));
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(OTHER);
        IPhase3EngineForwardingProbe(engine).submitEvidence(disputeId, CLIENT, keccak256("spoof"), bytes32(0));
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(CLIENT);
        IPhase3EngineForwardingProbe(engine).addArbiter(OTHER);
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(CLIENT);
        IPhase3EngineForwardingProbe(engine).removeArbiter(OTHER);
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(OTHER);
        IPhase3Engine(address(engine)).fulfillRandomness(1, 1);
    }

    function test_F45_ArbiterRegistryIsOwnerOnlyDistinctAndCappedAt128() public {
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(OTHER);
        p3.addArbiter(address(0x5000));
        vm.expectRevert(IPhase3Escrow.InvalidArbiter.selector);
        p3.addArbiter(address(0));
        address first = address(0x5000);
        p3.addArbiter(first);
        vm.expectRevert(IPhase3Escrow.InvalidArbiter.selector);
        p3.addArbiter(first);

        for (uint256 i = 1; i < 128; ++i) p3.addArbiter(address(uint160(0x5000 + i)));
        assertEq(p3.arbiterCount(), 128, "registry stores at most 128 active addresses");
        for (uint256 i; i < 128; ++i) {
            assertEq(p3.arbiterAt(i), address(uint160(0x5000 + i)), "registry enumeration is complete");
            assertTrue(p3.isArbiter(address(uint160(0x5000 + i))));
        }
        vm.expectRevert(IPhase3Escrow.ArbiterLimitReached.selector);
        p3.addArbiter(address(0x9000));
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(OTHER);
        p3.removeArbiter(first);

        p3.removeArbiter(address(uint160(0x5000 + 17)));
        assertEq(p3.arbiterCount(), 127, "remove reduces active registry size");
        assertFalse(p3.isArbiter(address(uint160(0x5000 + 17))));
        p3.addArbiter(address(0x9000));
        assertEq(p3.arbiterCount(), 128, "removal creates bounded registry capacity");
        assertTrue(p3.isArbiter(address(0x9000)));
    }

    function test_F32_FirstPanelHasThreeDistinctAllowlistedMembersAndExcludesParties() public {
        _register(CLIENT);
        _register(FREELANCER);
        address[] memory arbiters = _registerMany(8);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory panel = _fulfillAndSelect(disputeId);
        _assertDistinctNonzero(panel);
        assertFalse(_isPanelMember(panel, CLIENT), "client cannot be selected");
        assertFalse(_isPanelMember(panel, FREELANCER), "freelancer cannot be selected");
        for (uint256 i; i < 3; ++i) assertTrue(p3.isArbiter(panel[i]), "panel member remains allowlisted");
        for (uint256 i; i < arbiters.length; ++i) {
            assertTrue(p3.isArbiter(arbiters[i]));
        }
    }

    function test_F32_RemovedAssignedArbiterKeepsSnapshottedVoteRight() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory panel = _fulfillAndSelect(disputeId);
        address removed = panel[0];
        p3.removeArbiter(removed);
        assertFalse(p3.isArbiter(removed), "registry removal affects future assignments");
        bytes32 salt = _salt(disputeId, removed, 5_000);
        _commit(disputeId, removed, 5_000, salt);
        (bytes32 storedCommitment,,) = p3.getVote(disputeId, 1, removed);
        assertEq(storedCommitment, p3.voteCommitment(disputeId, removed, 5_000, salt));
    }

    function test_F33_VoteCommitmentBindsChainEscrowDisputeArbiterBpsAndSalt() public {
        _registerMany(3);
        (, uint256 dispute1) = _openSubmitted(10_000, 0);
        uint256 dispute2 = _openAnotherSubmitted(11_000);
        address arbiter = address(0xA000);
        uint16 vote = 6_123;
        bytes32 salt = keccak256("domain-bound salt");
        bytes32 expected = keccak256(abi.encode(block.chainid, address(escrow), dispute1, arbiter, vote, salt));
        bytes32 actual = p3.voteCommitment(dispute1, arbiter, vote, salt);
        assertEq(actual, expected, "vote hash matches fixed A-33 encoding");
        assertNotEq(actual, p3.voteCommitment(dispute2, arbiter, vote, salt), "dispute id is bound");
        assertNotEq(actual, p3.voteCommitment(dispute1, address(0xA001), vote, salt), "arbiter address is bound");
        assertNotEq(actual, p3.voteCommitment(dispute1, arbiter, vote + 1, salt), "vote bps is bound");
        assertNotEq(actual, p3.voteCommitment(dispute1, arbiter, vote, keccak256("other salt")), "salt is bound");

        vm.chainId(31338);
        bytes32 otherChain = p3.voteCommitment(dispute1, arbiter, vote, salt);
        vm.chainId(31337);
        assertNotEq(actual, otherChain, "chain id is bound");

        FairworkEscrow otherEscrow = _deployEscrow(address(token), 6);
        IPhase3Escrow otherP3 = IPhase3Escrow(address(otherEscrow));
        vm.prank(CLIENT);
        token.approve(address(otherEscrow), type(uint256).max);
        uint256 otherDispute = _openSubmittedOn(otherEscrow, address(token), 10_000);
        assertNotEq(actual, otherP3.voteCommitment(otherDispute, arbiter, vote, salt), "escrow address is bound");
    }

    function _openAnotherSubmitted(uint256 amount) private returns (uint256 disputeId) {
        uint256 jobId = _fundedJob(amount, 0);
        _submit(jobId);
        vm.prank(CLIENT);
        disputeId = p3.openDispute(jobId, 0);
    }

    function _openSubmittedOn(FairworkEscrow targetEscrow, address tokenAddress, uint256 amount)
        private
        returns (uint256 disputeId)
    {
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(amount, 10, keccak256("criteria"));
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: tokenAddress,
            titleCommitment: TERMS,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: 0
        });
        vm.prank(CLIENT);
        uint256 jobId = targetEscrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        targetEscrow.acceptJob(jobId);
        vm.prank(CLIENT);
        targetEscrow.fundJob(jobId);
        vm.prank(FREELANCER);
        IPhase2Read(address(targetEscrow)).submitMilestone(jobId, 0, keccak256("delivery"), bytes32(0));
        vm.prank(CLIENT);
        disputeId = IPhase3Escrow(address(targetEscrow)).openDispute(jobId, 0);
    }

    function test_F33_WrongSaltBpsAndCopiedCommitCannotReveal() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory panel = _fulfillAndSelect(disputeId);
        uint16 vote = 6_000;
        bytes32 salt0 = _salt(disputeId, panel[0], vote);
        bytes32 commitment0 = p3.voteCommitment(disputeId, panel[0], vote, salt0);
        vm.prank(panel[0]);
        p3.commitVote(disputeId, commitment0);
        bytes32 wrongBpsCommitment = p3.voteCommitment(disputeId, panel[0], vote + 1, salt0);
        vm.expectRevert(IPhase3Escrow.InvalidVote.selector);
        vm.prank(panel[0]);
        p3.commitVote(disputeId, wrongBpsCommitment);
        vm.prank(panel[1]);
        p3.commitVote(disputeId, commitment0); // copied hash is address-bound to panel[0]
        bytes32 salt2 = _salt(disputeId, panel[2], vote);
        _commit(disputeId, panel[2], vote, salt2);
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        vm.expectRevert();
        _reveal(disputeId, panel[2], vote, salt2); // Reveal is closed until the phase advances.
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 6, "all commits advance to reveal");
        vm.expectRevert(IPhase3Escrow.InvalidVote.selector);
        _reveal(disputeId, panel[0], vote, keccak256("wrong salt"));
        vm.expectRevert(IPhase3Escrow.InvalidVote.selector);
        _reveal(disputeId, panel[0], vote + 1, salt0);
        vm.expectRevert(IPhase3Escrow.InvalidVote.selector);
        _reveal(disputeId, panel[0], 10_001, salt0);
        vm.expectRevert(IPhase3Escrow.InvalidVote.selector);
        _reveal(disputeId, panel[1], vote, salt0);
        _reveal(disputeId, panel[0], vote, salt0);
        _reveal(disputeId, panel[2], vote, salt2);
        vm.expectRevert(IPhase3Escrow.InvalidVote.selector);
        _reveal(disputeId, panel[0], vote, salt0);
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        assertEq(dispute.phase, 6, "rejected reveals do not corrupt valid votes");
    }

    function test_F33_CommitAndRevealWindowsAreHalfOpen() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory panel = _fulfillAndSelect(disputeId);
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        vm.warp(dispute.commitDeadline - 1);
        _commit(disputeId, panel[0], 5_000, _salt(disputeId, panel[0], 5_000));
        vm.warp(dispute.commitDeadline);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _commit(disputeId, panel[1], 5_000, _salt(disputeId, panel[1], 5_000));
        vm.warp(dispute.commitDeadline + 1);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 4, "one missing commit starts one replacement draw");
    }

    function test_F33_ReplacementCommitWindowIsHalfOpenAndNeverReplacesTwice() public {
        _registerMany(9);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory firstPanel = _fulfillAndSelect(disputeId);
        _commit(disputeId, firstPanel[0], 5_000, _salt(disputeId, firstPanel[0], 5_000));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        uint256 requestId = dispute.activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 5, "replacement commit window starts");
        dispute = p3.getDispute(disputeId);
        address[3] memory replacedPanel = p3.getPanel(disputeId, 1);
        _assertDistinctNonzero(replacedPanel);
        assertEq(replacedPanel[0], firstPanel[0], "committed original remains assigned");
        assertFalse(replacedPanel[1] == firstPanel[1] || replacedPanel[1] == firstPanel[2]);
        assertFalse(replacedPanel[2] == firstPanel[1] || replacedPanel[2] == firstPanel[2]);

        address replacement = replacedPanel[1] != firstPanel[0] ? replacedPanel[1] : replacedPanel[2];
        uint16 vote = 4_000;
        bytes32 salt = _salt(disputeId, replacement, vote);
        vm.warp(dispute.replacementCommitDeadline - 1);
        _commit(disputeId, replacement, vote, salt);
        vm.warp(dispute.replacementCommitDeadline);
        address otherReplacement = replacement == replacedPanel[1] ? replacedPanel[2] : replacedPanel[1];
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _commit(disputeId, otherReplacement, vote, _salt(disputeId, otherReplacement, vote));
        vm.warp(dispute.replacementCommitDeadline + 1);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 6, "replacement window advances to reveal once");
        assertEq(p3.getDispute(disputeId).activeRequestId, requestId, "no second replacement request starts");
        assertTrue(p3.getPanel1History(disputeId).length <= 6, "panel one history is bounded");
    }

    function test_F33_RevealWindowIsHalfOpen() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory panel = _fulfillAndSelect(disputeId);
        uint16 vote = 5_000;
        bytes32 salt = _salt(disputeId, panel[0], vote);
        _commit(disputeId, panel[0], vote, salt);
        _commit(disputeId, panel[1], vote, _salt(disputeId, panel[1], vote));
        _commit(disputeId, panel[2], vote, _salt(disputeId, panel[2], vote));
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        vm.warp(dispute.commitDeadline);
        p3.advanceDispute(disputeId);
        dispute = p3.getDispute(disputeId);
        vm.warp(dispute.revealDeadline - 1);
        _reveal(disputeId, panel[0], vote, salt);
        vm.warp(dispute.revealDeadline);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _reveal(disputeId, panel[1], vote, _salt(disputeId, panel[1], vote));
        vm.warp(dispute.revealDeadline + 1);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 7, "one reveal requests an entirely fresh second panel");
    }

    function _assertOpenedEvent(
        Vm.Log[] memory logs,
        uint256 disputeId,
        uint256 jobId,
        uint256 deposit,
        uint64 evidenceDeadline
    ) private view {
        bytes32 signature = keccak256("DisputeOpened(uint256,uint256,uint256,address,uint256,uint64)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter != address(escrow) || log.topics.length != 4 || log.topics[0] != signature) continue;
            assertEq(uint256(log.topics[1]), disputeId, "event contains returned dispute id");
            assertEq(uint256(log.topics[2]), jobId, "event contains job id");
            assertEq(uint256(log.topics[3]), 0, "event contains milestone index");
            (address opener, uint256 eventDeposit, uint64 eventDeadline) =
                abi.decode(log.data, (address, uint256, uint64));
            assertEq(opener, CLIENT);
            assertEq(eventDeposit, deposit);
            assertEq(eventDeadline, evidenceDeadline);
            found = true;
        }
        assertTrue(found, "open emits a complete escrow-address event");
    }
}
