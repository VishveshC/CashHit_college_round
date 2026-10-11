// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IPhase3Engine, IPhase3Escrow, IPhase3Randomness, Phase3TestBase} from "./support/Phase3TestSupport.sol";
import {ConfigurableFeeToken} from "./support/MockTokens.sol";

contract Phase3BoundariesTest is Phase3TestBase {
    function test_F31_MatchingFeeDepositRollsBackWithoutChangingEvidenceClock() public {
        ConfigurableFeeToken feeToken = new ConfigurableFeeToken("Fee match", "FEE", 6, 100);
        token = feeToken;
        escrow = _deployEscrow(address(feeToken), 6);
        p3 = IPhase3Escrow(address(escrow));
        feeToken.mint(CLIENT, 1_000_000);
        feeToken.mint(FREELANCER, 1_000_000);
        vm.prank(CLIENT);
        feeToken.approve(address(escrow), type(uint256).max);
        vm.prank(FREELANCER);
        feeToken.approve(address(escrow), type(uint256).max);
        (, uint256 id) = _openSubmitted(10_000, 0);
        IPhase3Escrow.DisputeView memory before_ = p3.getDispute(id);
        uint256 balance = feeToken.balanceOf(FREELANCER);
        feeToken.setFeeEnabled(true);
        vm.expectRevert(IPhase3Escrow.ExactTransferRequired.selector);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(id);
        IPhase3Escrow.DisputeView memory after_ = p3.getDispute(id);
        assertFalse(after_.freelancerDeposited);
        assertTrue(after_.clientDeposited);
        assertEq(after_.evidenceDeadline, before_.evidenceDeadline);
        assertEq(p3.disputeDeposits(address(feeToken)), 200);
        assertEq(feeToken.balanceOf(FREELANCER), balance);
        assertEq(feeToken.balanceOf(address(escrow)), 10_200);
    }

    function test_F34_RulingCanSettleAfterTokenCodeChangesAndAllTokenCallsRevert() public {
        _registerMany(6);
        (uint256 job, uint256 id) = _openSubmitted(1_001, 0);
        address[3] memory panel = _fulfillAndSelect(id);
        for (uint256 i; i < 3; ++i) _commit(id, panel[i], 5_000, _salt(id, panel[i], 5_000));
        vm.warp(p3.getDispute(id).commitDeadline);
        p3.advanceDispute(id);
        for (uint256 i; i < 3; ++i) _reveal(id, panel[i], 5_000, _salt(id, panel[i], 5_000));
        vm.warp(p3.getDispute(id).revealDeadline);
        vm.etch(address(token), hex"60006000fd");
        p3.advanceDispute(id);
        assertEq(p3.getDispute(id).phase, 10);
        assertEq(p3.getMilestone(job, 0).state, 6);
        assertEq(p3.lockedEscrow(address(token)), 0);
        assertEq(p3.disputeDeposits(address(token)), 0);
        assertEq(p3.claimable(address(token), FREELANCER), 490);
        assertEq(p3.claimable(address(token), CLIENT), 511);
        assertEq(p3.claimable(address(token), TREASURY), 20);
        vm.expectRevert();
        vm.prank(FREELANCER);
        escrow.withdraw(address(token));
        assertEq(p3.claimable(address(token), FREELANCER), 490);
    }

    function test_A29_CallbackAtEndPlusOneIsIgnoredAndAdvanceRetries() public {
        _registerMany(6);
        (, uint256 id) = _openSubmitted(1_001, 0);
        uint256 request = _requestInitial(id);
        uint64 end = p3.getDispute(id).requestEnd;
        vm.warp(end + 1);
        address engine = p3.arbitrationEngine();
        address provider = p3.randomness();
        vm.prank(provider);
        IPhase3Engine(engine).fulfillRandomness(request, 99);
        assertFalse(p3.getDispute(id).randomnessReady);
        p3.advanceDispute(id);
        assertEq(p3.getDispute(id).attempt, 1);
        assertNotEq(p3.getDispute(id).activeRequestId, request);
    }

    function test_A29_TimelyEntropyRemainsConsumableAfterTimeout() public {
        _registerMany(6);
        (, uint256 id) = _openSubmitted(1_001, 0);
        uint256 request = _requestInitial(id);
        uint64 end = p3.getDispute(id).requestEnd;
        vm.warp(end - 1);
        IPhase3Randomness(p3.randomness()).fulfill(request);
        vm.warp(end + 1);
        p3.advanceDispute(id);
        assertEq(p3.getDispute(id).phase, 3);
        assertEq(p3.getDispute(id).attempt, 0);
        assertFalse(p3.getDispute(id).fallbackApplied);
        _assertDistinctNonzero(p3.getPanel(id, 1));
    }

    function test_A29_ShortPoolRequestFailureStillUsesAllThreeTimeouts() public {
        _registerMany(2);
        (, uint256 id) = _openSubmitted(1_001, 0);
        IPhase3Randomness(p3.randomness()).setRequestMode(1);
        _requestInitial(id);
        uint256 prior;
        for (uint8 attempt; attempt < 3; ++attempt) {
            IPhase3Escrow.DisputeView memory view_ = p3.getDispute(id);
            assertEq(view_.phase, 2);
            assertEq(view_.attempt, attempt);
            assertGt(view_.activeRequestId, prior);
            prior = view_.activeRequestId;
            vm.warp(view_.requestEnd - 1);
            vm.expectRevert(IPhase3Escrow.WindowOpen.selector);
            p3.advanceDispute(id);
            vm.warp(view_.requestEnd);
            p3.advanceDispute(id);
        }
        IPhase3Escrow.DisputeView memory settled = p3.getDispute(id);
        assertEq(settled.phase, 10);
        assertTrue(settled.fallbackApplied);
        assertEq(settled.fallbackReason, 2);
        assertEq(p3.claimable(address(token), CLIENT), 521);
        assertEq(p3.claimable(address(token), FREELANCER), 500);
        assertEq(p3.claimable(address(token), TREASURY), 0);
    }

    function test_A30_EmptyReplacementStillRequestsEntropyAndGetsOneWindow() public {
        _registerMany(3);
        (, uint256 id) = _openSubmitted(1_001, 0);
        address[3] memory original = _fulfillAndSelect(id);
        _commit(id, original[0], 5_000, _salt(id, original[0], 5_000));
        vm.warp(p3.getDispute(id).commitDeadline);
        p3.advanceDispute(id);
        assertEq(p3.getDispute(id).phase, 4);
        uint256 request = p3.getDispute(id).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(request);
        p3.advanceDispute(id);
        assertEq(p3.getDispute(id).phase, 5);
        address[3] memory current = p3.getPanel(id, 1);
        assertEq(current[0], original[0]);
        assertEq(current[1], address(0));
        assertEq(current[2], address(0));
        vm.warp(p3.getDispute(id).replacementCommitDeadline);
        p3.advanceDispute(id);
        assertEq(p3.getDispute(id).phase, 6);
        assertEq(p3.getDispute(id).activeRequestId, request);
    }

    function test_F33_DisplacedNoncommitterCannotCommitOrReveal() public {
        _registerMany(9);
        (, uint256 id) = _openSubmitted(1_001, 0);
        address[3] memory original = _fulfillAndSelect(id);
        _commit(id, original[0], 5_000, _salt(id, original[0], 5_000));
        vm.warp(p3.getDispute(id).commitDeadline);
        p3.advanceDispute(id);
        IPhase3Randomness(p3.randomness()).fulfill(p3.getDispute(id).activeRequestId);
        p3.advanceDispute(id);
        address[3] memory current = p3.getPanel(id, 1);
        assertFalse(_isPanelMember(current, original[1]));
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        _commit(id, original[1], 5_000, _salt(id, original[1], 5_000));
        vm.warp(p3.getDispute(id).replacementCommitDeadline);
        p3.advanceDispute(id);
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        _reveal(id, original[1], 5_000, _salt(id, original[1], 5_000));
    }

    function test_A29_MockWordIsBoundToConsumerAndRequestAndCallerCannotChooseIt() public {
        address[] memory candidates = _registerMany(6);
        (, uint256 id) = _openSubmitted(1_001, 0);
        uint256 request = _requestInitial(id);
        address provider = p3.randomness();
        address engine = p3.arbitrationEngine();
        uint256 word = uint256(keccak256(abi.encode(block.chainid, provider, engine, request)));
        uint256 snapshot = vm.snapshotState();
        vm.prank(OTHER);
        IPhase3Randomness(provider).fulfill(request);
        p3.advanceDispute(id);
        address[3] memory actual = p3.getPanel(id, 1);
        // Reuse the exact request context, without assuming a selection algorithm.
        assertTrue(vm.revertToState(snapshot));
        vm.prank(provider);
        IPhase3Engine(engine).fulfillRandomness(request, word);
        p3.advanceDispute(id);
        address[3] memory expected = p3.getPanel(id, 1);
        for (uint256 i; i < 3; ++i) {
            assertEq(actual[i], expected[i]);
            bool eligible;
            for (uint256 j; j < candidates.length; ++j) eligible = eligible || actual[i] == candidates[j];
            assertTrue(eligible);
        }
    }
}
