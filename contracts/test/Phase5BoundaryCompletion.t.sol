// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IPhase3Escrow,
    IPhase3Randomness,
    Phase3TestBase
} from "./support/Phase3TestSupport.sol";

interface IPhase5EngineVoteProbe {
    function commitVote(uint256 disputeId, address actor, bytes32 commitment) external;
}

/// @dev Additive direct-boundary proofs. Keep separate from the first Phase 5 frozen test file.
contract Phase5BoundaryCompletionTest is Phase3TestBase {
    function test_Phase5_EvidenceAdvanceRejectsEminusOneOnFreshDispute() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_001, 0);
        uint64 end = p3.getDispute(disputeId).evidenceDeadline;

        vm.warp(end - 1);
        vm.expectRevert(IPhase3Escrow.WindowOpen.selector);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 1);
    }

    function test_Phase5_EvidenceAdvanceSucceedsAtEOnFreshDispute() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_001, 0);
        vm.warp(p3.getDispute(disputeId).evidenceDeadline);

        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 2);
        assertEq(p3.getDispute(disputeId).attempt, 0);
    }

    function test_Phase5_EvidenceAdvanceSucceedsAtEplusOneOnFreshDispute() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_001, 0);
        vm.warp(p3.getDispute(disputeId).evidenceDeadline + 1);

        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 2);
        assertEq(p3.getDispute(disputeId).attempt, 0);
    }

    function test_Phase5_Panel1CommitDirectlyRejectsAtEplusOne() public {
        (, uint256 disputeId, address[3] memory panel) = _startPanel1Commit();
        uint16 bps = 5_000;
        bytes32 salt = _salt(disputeId, panel[0], bps);
        vm.warp(p3.getDispute(disputeId).commitDeadline + 1);

        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _commit(disputeId, panel[0], bps, salt);
        (bytes32 commitment,,) = p3.getVote(disputeId, 1, panel[0]);
        assertEq(commitment, bytes32(0));
    }

    function test_Phase5_ReplacementCommitDirectlyRejectsAtEplusOne() public {
        (, uint256 disputeId, address[3] memory panel) = _startReplacementCommit();
        address actor = _firstUncommittedPanel1(disputeId, panel);
        uint16 bps = 5_000;
        bytes32 salt = _salt(disputeId, actor, bps);
        vm.warp(p3.getDispute(disputeId).replacementCommitDeadline + 1);

        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _commit(disputeId, actor, bps, salt);
        (bytes32 commitment,,) = p3.getVote(disputeId, 1, actor);
        assertEq(commitment, bytes32(0));
    }

    function test_Phase5_Panel1RevealDirectlyRejectsAtEplusOne() public {
        (, uint256 disputeId, address[3] memory panel) = _startPanel1Reveal();
        uint16 bps = 5_000;
        bytes32 salt = _salt(disputeId, panel[0], bps);
        vm.warp(p3.getDispute(disputeId).revealDeadline + 1);

        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _reveal(disputeId, panel[0], bps, salt);
        (bytes32 commitment,, bool revealed) = p3.getVote(disputeId, 1, panel[0]);
        assertTrue(commitment != bytes32(0));
        assertFalse(revealed);
    }

    function test_Phase5_Panel2CommitDirectlyRejectsAtEplusOne() public {
        (, uint256 disputeId, address[3] memory panel) = _startPanel2Commit();
        uint16 bps = 5_000;
        bytes32 salt = _salt(disputeId, panel[0], bps);
        vm.warp(p3.getDispute(disputeId).commitDeadline + 1);

        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _commit(disputeId, panel[0], bps, salt);
        (bytes32 commitment,,) = p3.getVote(disputeId, 2, panel[0]);
        assertEq(commitment, bytes32(0));
    }

    function test_Phase5_Panel2RevealDirectlyRejectsAtEplusOne() public {
        (, uint256 disputeId, address[3] memory panel) = _startPanel2Reveal();
        uint16 bps = 5_000;
        bytes32 salt = _salt(disputeId, panel[0], bps);
        vm.warp(p3.getDispute(disputeId).revealDeadline + 1);

        vm.expectRevert(IPhase3Escrow.WindowClosed.selector);
        _reveal(disputeId, panel[0], bps, salt);
        (bytes32 commitment,, bool revealed) = p3.getVote(disputeId, 2, panel[0]);
        assertTrue(commitment != bytes32(0));
        assertFalse(revealed);
    }

    function test_Phase5_Panel2RejectsUnassignedArbiterForCommitAndReveal() public {
        (uint256 disputeId, address[3] memory panel, address outsider) = _startPanel2WithOutsider();

        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(outsider);
        p3.commitVote(disputeId, keccak256("outsider commit"));

        uint16 bps = 5_000;
        bytes32 salt = _salt(disputeId, panel[0], bps);
        _commit(disputeId, panel[0], bps, salt);
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);

        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(outsider);
        p3.revealVote(disputeId, bps, salt);
    }

    function test_Phase5_ArbiterCannotSpoofForwardedCommitDirectlyToEngine() public {
        (, uint256 disputeId, address[3] memory panel) = _startPanel1Commit();
        address engine = p3.arbitrationEngine();
        vm.expectRevert(IPhase3Escrow.Unauthorized.selector);
        vm.prank(panel[0]);
        IPhase5EngineVoteProbe(engine).commitVote(disputeId, panel[0], keccak256("spoofed commit"));

        (bytes32 commitment,,) = p3.getVote(disputeId, 1, panel[0]);
        assertEq(commitment, bytes32(0));
    }

    function _startPanel1Commit() private returns (uint256 jobId, uint256 disputeId, address[3] memory panel) {
        _registerMany(9);
        (jobId, disputeId) = _openSubmitted(10_001, 0);
        panel = _fulfillAndSelect(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 3);
    }

    function _startReplacementCommit()
        private
        returns (uint256 jobId, uint256 disputeId, address[3] memory panel)
    {
        (jobId, disputeId, panel) = _startPanel1Commit();
        _commit(disputeId, panel[0], 5_000, _salt(disputeId, panel[0], 5_000));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 4);

        uint256 requestId = p3.getDispute(disputeId).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 5);
        panel = p3.getPanel(disputeId, 1);
    }

    function _startPanel1Reveal() private returns (uint256 jobId, uint256 disputeId, address[3] memory panel) {
        (jobId, disputeId, panel) = _startPanel1Commit();
        for (uint256 i; i < panel.length; ++i) {
            _commit(disputeId, panel[i], 5_000, _salt(disputeId, panel[i], 5_000));
        }
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 6);
    }

    function _startPanel2Commit() private returns (uint256 jobId, uint256 disputeId, address[3] memory panel) {
        (jobId, disputeId, panel) = _startPanel1Reveal();
        _reveal(disputeId, panel[0], 5_000, _salt(disputeId, panel[0], 5_000));
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 7);

        uint256 requestId = p3.getDispute(disputeId).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 8);
        panel = p3.getPanel(disputeId, 2);
    }

    function _startPanel2Reveal() private returns (uint256 jobId, uint256 disputeId, address[3] memory panel) {
        (jobId, disputeId, panel) = _startPanel2Commit();
        _commit(disputeId, panel[0], 5_000, _salt(disputeId, panel[0], 5_000));
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 9);
    }

    function _startPanel2WithOutsider()
        private
        returns (uint256 disputeId, address[3] memory panel, address outsider)
    {
        address[] memory arbiters = _registerMany(12);
        (, disputeId) = _openSubmitted(10_001, 0);
        address[3] memory firstPanel = _fulfillAndSelect(disputeId);
        for (uint256 i; i < firstPanel.length; ++i) {
            _commit(disputeId, firstPanel[i], 5_000, _salt(disputeId, firstPanel[i], 5_000));
        }
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        _reveal(disputeId, firstPanel[0], 5_000, _salt(disputeId, firstPanel[0], 5_000));
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 7);

        uint256 requestId = p3.getDispute(disputeId).activeRequestId;
        IPhase3Randomness(p3.randomness()).fulfill(requestId);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 8);
        panel = p3.getPanel(disputeId, 2);

        for (uint256 i; i < arbiters.length; ++i) {
            if (!_isPanelMember(panel, arbiters[i])) {
                outsider = arbiters[i];
                break;
            }
        }
        assertTrue(outsider != address(0), "the registered pool contains an unassigned Panel 2 arbiter");
    }

    function _firstUncommittedPanel1(uint256 disputeId, address[3] memory panel) private view returns (address) {
        for (uint256 i; i < panel.length; ++i) {
            (bytes32 commitment,,) = p3.getVote(disputeId, 1, panel[i]);
            if (commitment == bytes32(0)) return panel[i];
        }
        revert("expected uncommitted panel member");
    }
}
