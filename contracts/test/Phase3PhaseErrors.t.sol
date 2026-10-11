// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {FairworkArbitration} from "../src/FairworkArbitration.sol";
import {MockRandomness} from "../src/mocks/MockRandomness.sol";

/// @dev Public engine API regression; this controller fixture holds no tokens or ledger.
contract Phase3PhaseErrorsTest is Test {
    function test_A31_VoteWrongPhaseIsInvalidStateWhileValidPhaseWrongSeatIsUnauthorized() public {
        vm.chainId(31337);
        vm.warp(1_800_000_000);
        FairworkArbitration engine = new FairworkArbitration(address(this), 60);
        address client = address(0xC11E);
        address freelancer = address(0xFEE);
        address actor = address(0xA001);
        uint256 id = engine.openDispute(0, 0, client, freelancer, address(0x1234), 1_001, 20, client);
        vm.expectRevert(FairworkArbitration.InvalidState.selector);
        engine.commitVote(id, actor, bytes32(uint256(1)));
        vm.expectRevert(FairworkArbitration.InvalidState.selector);
        engine.revealVote(id, actor, 5_000, bytes32(0));

        engine.addArbiter(actor);
        engine.addArbiter(address(0xA002));
        engine.addArbiter(address(0xA003));
        vm.warp(engine.getDispute(id).evidenceDeadline);
        engine.advanceDispute(id);
        MockRandomness(engine.randomness()).fulfill(engine.getDispute(id).activeRequestId);
        engine.advanceDispute(id);
        address[3] memory panel = engine.getPanel(id, 1);
        vm.expectRevert(FairworkArbitration.Unauthorized.selector);
        engine.commitVote(id, address(0xB0B), bytes32(uint256(1)));
        vm.expectRevert(FairworkArbitration.InvalidState.selector);
        engine.revealVote(id, panel[0], 5_000, bytes32(0));
        for (uint256 i; i < 3; ++i) {
            bytes32 salt = bytes32(i + 1);
            bytes32 commitment = engine.voteCommitment(id, panel[i], 5_000, salt);
            engine.commitVote(id, panel[i], commitment);
        }
        vm.warp(engine.getDispute(id).commitDeadline);
        engine.advanceDispute(id);
        vm.expectRevert(FairworkArbitration.InvalidState.selector);
        engine.commitVote(id, panel[0], bytes32(uint256(1)));
        vm.expectRevert(FairworkArbitration.Unauthorized.selector);
        engine.revealVote(id, address(0xB0B), 5_000, bytes32(0));
        for (uint256 i; i < 3; ++i) engine.revealVote(id, panel[i], 5_000, bytes32(i + 1));
        vm.warp(engine.getDispute(id).revealDeadline);
        (bool terminal, uint16 bps, bool fallbackApplied) = engine.advanceDispute(id);
        assertTrue(terminal);
        assertEq(bps, 5_000);
        assertFalse(fallbackApplied);
        vm.expectRevert(FairworkArbitration.InvalidState.selector);
        engine.commitVote(id, panel[0], bytes32(uint256(1)));
        vm.expectRevert(FairworkArbitration.InvalidState.selector);
        engine.revealVote(id, panel[0], 5_000, bytes32(uint256(1)));
    }
}
