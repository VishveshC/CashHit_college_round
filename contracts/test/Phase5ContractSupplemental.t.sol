// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IPhase3Escrow,
    IPhase3Randomness,
    Phase3TestBase
} from "./support/Phase3TestSupport.sol";

contract Phase5ContractSupplementalTest is Phase3TestBase {
    function test_Phase5_Panel2CommitAndRevealWindowsAreHalfOpen() public {
        _registerMany(9);
        (, uint256 disputeId) = _openSubmitted(10_001, 0);
        address[3] memory panel1 = _fulfillAndSelect(disputeId);

        for (uint256 i; i < panel1.length; ++i) {
            _commit(disputeId, panel1[i], 5_000, _salt(disputeId, panel1[i], 5_000));
        }
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 6, "Panel 1 enters its reveal window");
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 7, "no Panel 1 reveals starts a fresh Panel 2 draw");

        uint256 panel2Request = p3.getDispute(disputeId).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(panel2Request);
        p3.advanceDispute(disputeId);
        address[3] memory panel2 = p3.getPanel(disputeId, 2);
        _assertDistinctNonzero(panel2);

        uint16 vote = 4_000;
        bytes32 firstSalt = _salt(disputeId, panel2[0], vote);
        uint64 commitEnd = p3.getDispute(disputeId).commitDeadline;
        vm.warp(commitEnd - 1);
        _commit(disputeId, panel2[0], vote, firstSalt);
        vm.warp(commitEnd);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _commit(disputeId, panel2[1], vote, _salt(disputeId, panel2[1], vote));
        vm.warp(commitEnd + 1);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 9, "Panel 2 commit closes into reveal after E");

        uint64 revealEnd = p3.getDispute(disputeId).revealDeadline;
        vm.warp(revealEnd - 1);
        _reveal(disputeId, panel2[0], vote, firstSalt);
        vm.warp(revealEnd);
        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _reveal(disputeId, panel2[1], vote, _salt(disputeId, panel2[1], vote));
        vm.warp(revealEnd + 1);
        p3.advanceDispute(disputeId);

        IPhase3Escrow.DisputeView memory settled = p3.getDispute(disputeId);
        assertEq(settled.phase, 10, "one Panel 2 reveal reaches terminal no-quorum fallback");
        assertTrue(settled.fallbackApplied);
        assertEq(settled.fallbackReason, 3);
        assertEq(p3.lockedEscrow(address(token)), 0);
        assertEq(p3.disputeDeposits(address(token)), 0);
        assertEq(p3.totalClaimable(address(token)), 10_001 + 200);
        assertEq(
            token.balanceOf(address(escrow)),
            escrow.lockedEscrow(address(token)) + escrow.totalClaimable(address(token))
                + p3.disputeDeposits(address(token)) + p3.arbiterStakes(address(token)),
            "Panel 2 no-quorum settlement conserves every token liability"
        );
    }

    function test_Phase5_RandomnessRetryAdvanceWorksAtEndPlusOne() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_001, 0);
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        vm.warp(dispute.evidenceDeadline);
        p3.advanceDispute(disputeId);

        for (uint8 expectedAttempt; expectedAttempt < 2; ++expectedAttempt) {
            dispute = p3.getDispute(disputeId);
            assertEq(dispute.phase, 2);
            assertEq(dispute.attempt, expectedAttempt);
            vm.warp(dispute.requestEnd - 1);
            vm.expectRevert(IPhase3Escrow.WindowOpen.selector);
            p3.advanceDispute(disputeId);
            vm.warp(dispute.requestEnd + 1);
            p3.advanceDispute(disputeId);
            assertEq(p3.getDispute(disputeId).attempt, expectedAttempt + 1);
        }

        assertEq(p3.getDispute(disputeId).phase, 2, "both retries retain the pending draw");
        assertEq(p3.getDispute(disputeId).attempt, 2, "two retries remain the maximum");
    }

    function test_Phase5_AllThreeDrawsWithTwoRetriesTerminalizeWithinFifteenAdvances() public {
        _registerMany(12);
        (, uint256 disputeId) = _openSubmitted(100_001, 0);
        uint256 advances;

        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        vm.warp(dispute.evidenceDeadline);
        p3.advanceDispute(disputeId);
        ++advances;
        _retryTwiceThenConsume(disputeId, 2);
        advances += 3;

        address[3] memory firstPanel = p3.getPanel(disputeId, 1);
        _commit(disputeId, firstPanel[0], 5_000, _salt(disputeId, firstPanel[0], 5_000));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        ++advances;
        assertEq(p3.getDispute(disputeId).phase, 4, "two missing commits start one replacement draw");

        _retryTwiceThenConsume(disputeId, 4);
        advances += 3;
        address[3] memory replacedPanel = p3.getPanel(disputeId, 1);
        assertTrue(replacedPanel[1] != address(0) && replacedPanel[2] != address(0));
        assertNotEq(replacedPanel[1], replacedPanel[2]);

        vm.warp(p3.getDispute(disputeId).replacementCommitDeadline);
        p3.advanceDispute(disputeId);
        ++advances;
        _reveal(disputeId, firstPanel[0], 5_000, _salt(disputeId, firstPanel[0], 5_000));
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        ++advances;
        assertEq(p3.getDispute(disputeId).phase, 7, "one reveal starts the fresh second panel");

        _retryTwiceThenConsume(disputeId, 7);
        advances += 3;
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        ++advances;
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        ++advances;

        IPhase3Escrow.DisputeView memory settled = p3.getDispute(disputeId);
        assertEq(advances, 15, "full retry path has the documented maximum public advances");
        assertEq(settled.phase, 10, "the bounded full retry path terminalizes");
        assertTrue(settled.fallbackApplied);
        assertEq(settled.fallbackReason, 3, "the silent second panel reaches no-quorum fallback");
        assertEq(p3.getMilestone(dispute.jobId, dispute.milestoneIndex).state, 6);
        assertEq(p3.lockedEscrow(address(token)), 0);
        assertEq(p3.disputeDeposits(address(token)), 0);
        assertEq(p3.totalClaimable(address(token)), 100_001 + 2_000);
        assertEq(
            token.balanceOf(address(escrow)),
            escrow.lockedEscrow(address(token)) + escrow.totalClaimable(address(token))
                + p3.disputeDeposits(address(token)) + p3.arbiterStakes(address(token)),
            "all-principal and deposit liabilities are backed after terminalization"
        );
    }

    function _retryTwiceThenConsume(uint256 disputeId, uint8 expectedPhase) private {
        for (uint8 expectedAttempt; expectedAttempt < 2; ++expectedAttempt) {
            IPhase3Escrow.DisputeView memory pending = p3.getDispute(disputeId);
            assertEq(pending.phase, expectedPhase);
            assertEq(pending.attempt, expectedAttempt);
            vm.warp(pending.requestEnd);
            p3.advanceDispute(disputeId);
            IPhase3Escrow.DisputeView memory retried = p3.getDispute(disputeId);
            assertEq(retried.phase, expectedPhase);
            assertEq(retried.attempt, expectedAttempt + 1);
            assertNotEq(retried.activeRequestId, pending.activeRequestId);
        }

        IPhase3Escrow.DisputeView memory finalRequest = p3.getDispute(disputeId);
        assertEq(finalRequest.attempt, 2);
        IPhase3Randomness(p3.randomness()).fulfill(finalRequest.activeRequestId);
        p3.advanceDispute(disputeId);
        assertTrue(p3.getDispute(disputeId).phase != expectedPhase, "timely final attempt is consumed");
    }
}
