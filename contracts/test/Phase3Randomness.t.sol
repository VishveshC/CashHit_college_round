// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IPhase3Engine, IPhase3Escrow, IPhase3Randomness, Phase3TestBase} from "./support/Phase3TestSupport.sol";

interface IPhase3RandomnessRequestProbe {
    function requestRandomness(uint256 requestId) external;
}

contract Phase3RandomnessTest is Phase3TestBase {
    function test_A29_CallbackAcceptedAtRequestEndMinusOneCanBeConsumedAtEnd() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        IPhase3Escrow.DisputeView memory evidence = p3.getDispute(disputeId);
        vm.warp(evidence.evidenceDeadline - 1);
        vm.expectRevert(IPhase3Escrow.WindowOpen.selector);
        p3.advanceDispute(disputeId);
        uint256 requestId = _requestInitial(disputeId);
        IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
        address provider = p3.randomness();
        address engine = p3.arbitrationEngine();
        uint256 requestEnd = dispute.requestEnd;

        vm.warp(requestEnd - 1);
        vm.prank(provider);
        IPhase3Engine(engine).fulfillRandomness(requestId, 7_777);
        assertTrue(p3.getDispute(disputeId).randomnessReady, "callback just before E is accepted");
        vm.warp(requestEnd);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 3, "timely entropy wins over timeout at E");
        assertEq(p3.getDispute(disputeId).attempt, 0, "accepted entropy does not consume a retry");
        assertFalse(p3.getDispute(disputeId).fallbackApplied, "no fallback after timely callback");
    }

    function test_A29_CallbackFirstArrivingAtEndIsIgnoredAndRetrySupersedesOldRequest() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        uint256 firstRequest = _requestInitial(disputeId);
        uint64 firstEnd = p3.getDispute(disputeId).requestEnd;
        address provider = p3.randomness();
        address engine = p3.arbitrationEngine();
        vm.warp(firstEnd);
        vm.prank(provider);
        IPhase3Engine(engine).fulfillRandomness(firstRequest, 11);
        assertFalse(p3.getDispute(disputeId).randomnessReady, "callback at E is expired");
        p3.advanceDispute(disputeId);
        IPhase3Escrow.DisputeView memory retried = p3.getDispute(disputeId);
        assertEq(retried.phase, 2, "retry remains pending");
        assertEq(retried.attempt, 1, "first timeout consumes one retry");
        assertNotEq(retried.activeRequestId, firstRequest, "retry uses a fresh id");
        uint256 secondRequest = retried.activeRequestId;

        vm.warp(firstEnd + 1);
        vm.prank(provider);
        IPhase3Engine(engine).fulfillRandomness(firstRequest, 22);
        assertFalse(p3.getDispute(disputeId).randomnessReady, "superseded callback cannot satisfy retry");
        IPhase3Randomness(provider).fulfill(firstRequest);
        assertFalse(p3.getDispute(disputeId).randomnessReady, "mock stale callback reaches and is ignored by engine");
        assertEq(p3.getDispute(disputeId).activeRequestId, secondRequest, "stale callback keeps active id");
    }

    function test_A29_UnknownDuplicateAndWrongProviderCallbacksAreSafe() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        uint256 requestId = _requestInitial(disputeId);
        address provider = p3.randomness();
        address engine = p3.arbitrationEngine();

        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        IPhase3Randomness(provider).fulfill(requestId + 100);
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(OTHER);
        IPhase3RandomnessRequestProbe(provider).requestRandomness(requestId + 100);
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(OTHER);
        IPhase3Engine(engine).fulfillRandomness(requestId, 9);

        vm.prank(provider);
        IPhase3Engine(engine).fulfillRandomness(requestId + 100, 10);
        assertFalse(p3.getDispute(disputeId).randomnessReady, "unknown engine callback is ignored");
        IPhase3Randomness(provider).fulfill(requestId);
        assertTrue(p3.getDispute(disputeId).randomnessReady, "active callback is accepted");
        IPhase3Randomness(provider).fulfill(requestId);
        assertTrue(p3.getDispute(disputeId).randomnessReady, "duplicate provider callback is idempotent");
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 3, "one accepted callback selects only once");
        vm.prank(provider);
        IPhase3Engine(engine).fulfillRandomness(requestId, 11);
        assertEq(p3.getDispute(disputeId).phase, 3, "duplicate engine callback cannot reselect");
    }

    function test_A29_SynchronousMockCallbackStoresEntropyWithoutSelectingOrSettling() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_001, 0);
        uint256 lockedBefore = p3.lockedEscrow(address(token));
        uint256 claimsBefore = p3.totalClaimable(address(token));
        IPhase3Randomness(p3.randomness()).setRequestMode(2);
        IPhase3Escrow.DisputeView memory beforeRequest = p3.getDispute(disputeId);
        vm.warp(beforeRequest.evidenceDeadline);
        p3.advanceDispute(disputeId);

        IPhase3Escrow.DisputeView memory pending = p3.getDispute(disputeId);
        assertEq(pending.phase, 2, "synchronous callback does not advance phase");
        assertTrue(pending.randomnessReady, "sync callback records entropy");
        assertEq(p3.getMilestone(beforeRequest.jobId, beforeRequest.milestoneIndex).state, 3);
        assertEq(p3.lockedEscrow(address(token)), lockedBefore, "callback cannot settle principal");
        assertEq(p3.totalClaimable(address(token)), claimsBefore, "callback cannot credit claims");

        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 3, "a later public advance consumes entropy");
        assertEq(p3.lockedEscrow(address(token)), lockedBefore, "panel selection still cannot settle funds");
    }

    function test_A29_RevertedRequestsKeepTimerAndThreeDistinctIdsReachTimeoutFallback() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_001, 0);
        IPhase3Randomness(p3.randomness()).setRequestMode(1);
        _requestInitial(disputeId);
        uint256[] memory ids = _failOneDrawThroughAllAttempts(disputeId);
        assertNotEq(ids[0], ids[1]);
        assertNotEq(ids[1], ids[2]);
        assertNotEq(ids[0], ids[2]);
        IPhase3Escrow.DisputeView memory settled = p3.getDispute(disputeId);
        assertEq(settled.phase, 10, "third timeout terminates dispute");
        assertTrue(settled.fallbackApplied, "randomness timeout uses fallback");
        assertEq(settled.fallbackReason, 2, "fallback reason is RandomnessTimeout");
        assertEq(settled.rulingBps, 5_000, "timeout fallback rules 50/50");
        assertEq(p3.disputeDeposits(address(token)), 0, "fallback refunds every deposit");
    }

    function test_A30_PoolExhaustionIsCheckedAfterRequestAndTimelyCallback() public {
        _registerMany(2);
        (, uint256 disputeId) = _openSubmitted(1_001, 0);
        uint256 requestId = _requestInitial(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 2, "short pool still follows bounded request path");
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        IPhase3Escrow.DisputeView memory settled = p3.getDispute(disputeId);
        assertEq(settled.phase, 10, "short eligible pool reaches terminal fallback");
        assertEq(settled.fallbackReason, 1, "reason records pool exhaustion");
        assertEq(settled.rulingBps, 5_000);
        assertEq(p3.disputeDeposits(address(token)), 0, "pool fallback refunds posted deposit");
        assertEq(p3.claimable(address(token), CLIENT), uint256(1_001) / 2 + 1 + 20, "client receives half remainder and refunded D");
        assertEq(p3.claimable(address(token), FREELANCER), uint256(1_001) / 2, "freelancer receives floored half");
    }

    function test_A35_EntropyCannotBeBiasedByPendingRegistryRemovalOrAddition() public {
        address[] memory original = _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        uint256 requestId = _requestInitial(disputeId);
        IPhase3Randomness(p3.randomness()).fulfill(requestId); // entropy is public while still pending
        for (uint256 i; i < original.length; ++i) p3.removeArbiter(original[i]);
        address[] memory added = new address[](6);
        for (uint256 i; i < added.length; ++i) {
            added[i] = address(uint160(0xB100 + i));
            p3.addArbiter(added[i]);
        }
        p3.advanceDispute(disputeId);
        address[3] memory panel = p3.getPanel(disputeId, 1);
        _assertDistinctNonzero(panel);
        for (uint256 i; i < 3; ++i) {
            bool cameFromOriginal;
            for (uint256 j; j < original.length; ++j) cameFromOriginal = cameFromOriginal || panel[i] == original[j];
            assertTrue(cameFromOriginal, "selection uses initial candidate snapshot");
            assertFalse(p3.isArbiter(panel[i]), "removed snapshot member need not remain allowlisted");
            assertFalse(_isPanelMember(_asPanel(added), panel[i]), "later additions cannot enter pending draw");
        }
        bytes32 salt = _salt(disputeId, panel[0], 5_000);
        _commit(disputeId, panel[0], 5_000, salt);
    }

    function test_A35_RetryUsesCandidateSnapshotTakenByFirstRequest() public {
        address[] memory original = _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        IPhase3Randomness(p3.randomness()).setRequestMode(1);
        uint256 firstRequest = _requestInitial(disputeId);
        IPhase3Escrow.DisputeView memory first = p3.getDispute(disputeId);
        vm.warp(first.requestEnd);
        p3.advanceDispute(disputeId);
        uint256 retryRequest = p3.getDispute(disputeId).activeRequestId;
        assertNotEq(retryRequest, firstRequest);
        for (uint256 i; i < original.length; ++i) p3.removeArbiter(original[i]);
        address[] memory added = new address[](6);
        for (uint256 i; i < added.length; ++i) {
            added[i] = address(uint160(0xB200 + i));
            p3.addArbiter(added[i]);
        }
        IPhase3Randomness(p3.randomness()).setRequestMode(0);
        IPhase3Escrow.DisputeView memory retry = p3.getDispute(disputeId);
        vm.warp(retry.requestEnd);
        p3.advanceDispute(disputeId);
        uint256 lastRequest = p3.getDispute(disputeId).activeRequestId;
        assertNotEq(lastRequest, retryRequest);
        IPhase3Randomness(p3.randomness()).fulfill(lastRequest);
        p3.advanceDispute(disputeId);
        address[3] memory panel = p3.getPanel(disputeId, 1);
        _assertDistinctNonzero(panel);
        for (uint256 i; i < 3; ++i) {
            bool cameFromOriginal;
            for (uint256 j; j < original.length; ++j) cameFromOriginal = cameFromOriginal || panel[i] == original[j];
            assertTrue(cameFromOriginal, "retry uses the first request candidate snapshot");
            assertFalse(_isPanelMember(_asPanel(added), panel[i]), "new candidates are excluded until next draw");
        }
    }

    function test_A30_SparseReplacementAssignsAvailableMemberAndLeavesEmptySeat() public {
        address[] memory registered = _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory initial = _fulfillAndSelect(disputeId);
        _commit(disputeId, initial[0], 6_000, _salt(disputeId, initial[0], 6_000));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        uint256 remainingReplacementCandidates;
        for (uint256 i; i < registered.length; ++i) {
            if (!_isPanelMember(initial, registered[i])) {
                if (remainingReplacementCandidates == 0) {
                    ++remainingReplacementCandidates;
                } else {
                    p3.removeArbiter(registered[i]);
                }
            }
        }
        assertEq(remainingReplacementCandidates, 1, "one candidate remains when replacement draw starts");
        p3.advanceDispute(disputeId);
        IPhase3Escrow.DisputeView memory pending = p3.getDispute(disputeId);
        uint256 requestId = pending.activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        address[3] memory panel = p3.getPanel(disputeId, 1);
        uint256 zeroSeats;
        for (uint256 i; i < 3; ++i) if (panel[i] == address(0)) ++zeroSeats;
        assertEq(zeroSeats, 1, "one replacement and one vacancy are retained");
        assertEq(p3.getDispute(disputeId).phase, 5, "short replacement draw still gets its window");
        vm.warp(p3.getDispute(disputeId).replacementCommitDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 6, "replacement window remains bounded with sparse seats");
    }

    function test_A30_Panel2IsEntirelyFreshAndSecondNoQuorumFallsBack() public {
        _registerMany(9);
        (, uint256 disputeId) = _openSubmitted(101, 0);
        address[3] memory first = _fulfillAndSelect(disputeId);
        uint16 vote = 4_000;
        for (uint256 i; i < 3; ++i) _commit(disputeId, first[i], vote, _salt(disputeId, first[i], vote));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        _reveal(disputeId, first[0], vote, _salt(disputeId, first[0], vote));
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 7, "first no-quorum requests Panel 2");
        uint256 requestId = p3.getDispute(disputeId).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 8, "timely callback selects Panel 2");
        address[3] memory second = p3.getPanel(disputeId, 2);
        _assertDistinctNonzero(second);
        address[] memory history = p3.getPanel1History(disputeId);
        for (uint256 i; i < 3; ++i) {
            assertFalse(_isPanelMember(first, second[i]), "Panel 2 excludes original Panel 1");
            for (uint256 j; j < history.length; ++j) assertNotEq(second[i], history[j], "excludes replacements too");
            assertFalse(second[i] == CLIENT || second[i] == FREELANCER);
        }
        uint16 secondVote = 8_000;
        _commit(disputeId, second[0], secondVote, _salt(disputeId, second[0], secondVote));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId); // Panel 2 has no replacement phase
        assertEq(p3.getDispute(disputeId).phase, 9, "Panel 2 moves directly to reveal");
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        IPhase3Escrow.DisputeView memory settled = p3.getDispute(disputeId);
        assertEq(settled.phase, 10, "second no-quorum terminates the case");
        assertTrue(settled.fallbackApplied);
        assertEq(settled.fallbackReason, 3, "second failed panel records NoQuorum");
        assertEq(settled.rulingBps, 5_000);
        assertEq(p3.disputeDeposits(address(token)), 0, "no-quorum fallback fully refunds deposits");
        assertEq(p3.claimable(address(token), CLIENT), 53, "client receives half plus full deposit refund");
        assertEq(p3.claimable(address(token), FREELANCER), 50, "freelancer receives half principal");
    }

    function test_A30_Panel2ExcludesAnActuallyAssignedReplacement() public {
        _registerMany(12);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        address[3] memory first = _fulfillAndSelect(disputeId);
        _commit(disputeId, first[0], 4_000, _salt(disputeId, first[0], 4_000));
        _commit(disputeId, first[1], 4_000, _salt(disputeId, first[1], 4_000));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        uint256 replacementRequest = p3.getDispute(disputeId).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(replacementRequest);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 5, "one vacant seat is replaced once");
        address[3] memory replaced = p3.getPanel(disputeId, 1);
        address replacement;
        for (uint256 i; i < 3; ++i) {
            if (replaced[i] != first[0] && replaced[i] != first[1] && replaced[i] != first[2]) {
                replacement = replaced[i];
            }
        }
        assertTrue(replacement != address(0), "replacement is assigned before Panel 2");
        _commit(disputeId, replacement, 7_000, _salt(disputeId, replacement, 7_000));
        vm.warp(p3.getDispute(disputeId).replacementCommitDeadline);
        p3.advanceDispute(disputeId);
        _reveal(disputeId, first[0], 4_000, _salt(disputeId, first[0], 4_000));
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 7, "one reveal opens fresh Panel 2 draw");
        uint256 panel2Request = p3.getDispute(disputeId).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(panel2Request);
        p3.advanceDispute(disputeId);

        address[3] memory second = p3.getPanel(disputeId, 2);
        address[] memory history = p3.getPanel1History(disputeId);
        assertEq(history.length, 4, "history records originals and assigned replacement");
        _assertDistinctNonzero(second);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < history.length; ++j) {
                assertNotEq(second[i], history[j], "fresh Panel 2 excludes every assigned Panel 1 member");
            }
        }
    }

    function test_A29_ReplacementAndPanel2DrawsAlsoUseTwoRetriesThenFallback() public {
        _registerMany(9);
        (, uint256 replacementDispute) = _openSubmitted(10_000, 0);
        address[3] memory first = _fulfillAndSelect(replacementDispute);
        _commit(replacementDispute, first[0], 5_000, _salt(replacementDispute, first[0], 5_000));
        vm.warp(p3.getDispute(replacementDispute).commitDeadline);
        IPhase3Randomness(p3.randomness()).setRequestMode(1);
        p3.advanceDispute(replacementDispute);
        uint256[] memory replacementIds = _failOneDrawThroughAllAttempts(replacementDispute);
        _assertThreeUnique(replacementIds);
        assertEq(p3.getDispute(replacementDispute).fallbackReason, 2, "replacement timeout falls back");

        IPhase3Randomness(p3.randomness()).setRequestMode(0);
        (, uint256 secondPanelDispute) = _openSubmitted(10_000, 0);
        address[3] memory panelOne = _fulfillAndSelect(secondPanelDispute);
        for (uint256 i; i < 3; ++i) {
            _commit(secondPanelDispute, panelOne[i], 4_000, _salt(secondPanelDispute, panelOne[i], 4_000));
        }
        vm.warp(p3.getDispute(secondPanelDispute).commitDeadline);
        p3.advanceDispute(secondPanelDispute);
        _reveal(secondPanelDispute, panelOne[0], 4_000, _salt(secondPanelDispute, panelOne[0], 4_000));
        vm.warp(p3.getDispute(secondPanelDispute).revealDeadline);
        IPhase3Randomness(p3.randomness()).setRequestMode(1);
        p3.advanceDispute(secondPanelDispute);
        uint256[] memory panelTwoIds = _failOneDrawThroughAllAttempts(secondPanelDispute);
        _assertThreeUnique(panelTwoIds);
        assertEq(p3.getDispute(secondPanelDispute).fallbackReason, 2, "Panel 2 timeout falls back");
    }

    function _failOneDrawThroughAllAttempts(uint256 disputeId) internal returns (uint256[] memory ids) {
        ids = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            IPhase3Escrow.DisputeView memory pending = p3.getDispute(disputeId);
            assertTrue(
                pending.phase == 2 || pending.phase == 4 || pending.phase == 7,
                "draw remains in a randomness-pending phase"
            );
            ids[i] = pending.activeRequestId;
            if (i < 2) {
                vm.warp(pending.requestEnd);
                p3.advanceDispute(disputeId);
                IPhase3Escrow.DisputeView memory retried = p3.getDispute(disputeId);
                assertEq(retried.phase, pending.phase, "timeout keeps the same draw pending");
                assertEq(retried.attempt, i + 1, "each draw allows exactly two retries");
                assertNotEq(retried.activeRequestId, ids[i], "each retry has a new id");
            } else {
                vm.warp(pending.requestEnd);
                p3.advanceDispute(disputeId);
            }
        }
    }

    function _assertThreeUnique(uint256[] memory ids) internal pure {
        assertEq(ids.length, 3);
        assertTrue(ids[0] != ids[1] && ids[0] != ids[2] && ids[1] != ids[2]);
    }

    function _asPanel(address[] memory addresses_) internal pure returns (address[3] memory result) {
        result[0] = addresses_[0];
        result[1] = addresses_[1];
        result[2] = addresses_[2];
    }
}
