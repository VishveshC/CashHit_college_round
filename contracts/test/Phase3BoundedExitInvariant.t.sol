// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {MockToken} from "./support/MockTokens.sol";
import {IPhase2Read, IPhase3Escrow, IPhase3Randomness} from "./support/Phase3TestSupport.sol";

/// @dev Drives one actual dispute from its live evidence window to a bounded ruling or fallback.
contract Phase3BoundedExitHandler is Test {
    address private constant CLIENT = address(0xC11E);
    address private constant FREELANCER = address(0xFEE);

    struct VoteData {
        uint16 bps;
        bytes32 salt;
        bool committed;
        bool revealed;
    }

    FairworkEscrow private immutable escrow;
    MockToken private immutable token;
    IPhase3Escrow private immutable p3;
    IPhase3Randomness private immutable adapter;
    uint256 private immutable disputeId;
    uint64 private immutable openedAt;
    mapping(uint8 round => mapping(address arbiter => VoteData vote)) private _votes;

    uint256 public campaignCalls;
    uint256 public advanceCount;
    uint256 public terminalizations;
    uint64 public terminalAt;

    error BoundedExitFailed();

    constructor(FairworkEscrow escrow_, MockToken token_, uint256 disputeId_) {
        escrow = escrow_;
        token = token_;
        p3 = IPhase3Escrow(address(escrow_));
        adapter = IPhase3Randomness(p3.randomness());
        disputeId = disputeId_;
        openedAt = p3.getDispute(disputeId_).openedAt;
    }

    function runBoundedCampaign(uint256 seed) external {
        ++campaignCalls;
        if (p3.getDispute(disputeId).phase == 10) return;

        // Three initial seats, at most one replacement draw, and a fresh Panel 2
        // fit in this fixed bound. Each public advance performs at most one step.
        for (uint256 step; step < 12; ++step) {
            IPhase3Escrow.DisputeView memory dispute = p3.getDispute(disputeId);
            uint8 phase = dispute.phase;
            if (phase == 10) break;

            if (phase == 1) {
                vm.warp(dispute.evidenceDeadline);
                p3.advanceDispute(disputeId);
                ++advanceCount;
            } else if (phase == 2 || phase == 4 || phase == 7) {
                if (seed % 4 == 0) {
                    vm.warp(dispute.requestEnd);
                    p3.advanceDispute(disputeId);
                } else {
                    adapter.fulfill(dispute.activeRequestId);
                    p3.advanceDispute(disputeId);
                }
                ++advanceCount;
            } else if (phase == 3 || phase == 5 || phase == 8) {
                uint8 round = phase == 8 ? 2 : 1;
                address[3] memory panel = p3.getPanel(disputeId, round);
                uint256 commitLimit = phase == 3 && seed % 2 == 1 ? 2 : 3;
                _commitSome(panel, round, seed, commitLimit);
                if (phase == 3 || phase == 8) vm.warp(dispute.commitDeadline);
                else vm.warp(dispute.replacementCommitDeadline);
                p3.advanceDispute(disputeId);
                ++advanceCount;
            } else if (phase == 6 || phase == 9) {
                uint8 round = phase == 6 ? 1 : 2;
                address[3] memory panel = p3.getPanel(disputeId, round);
                uint256 revealLimit = seed % 2 == 0 ? 2 : 1;
                _revealSome(panel, round, revealLimit);
                vm.warp(dispute.revealDeadline);
                p3.advanceDispute(disputeId);
                ++advanceCount;
            } else {
                revert BoundedExitFailed();
            }
            _assertLedgerConservation();
        }

        if (p3.getDispute(disputeId).phase != 10) revert BoundedExitFailed();
        ++terminalizations;
        terminalAt = uint64(block.timestamp);
    }

    function dispute() external view returns (IPhase3Escrow.DisputeView memory) {
        return p3.getDispute(disputeId);
    }

    function disputeIdValue() external view returns (uint256) {
        return disputeId;
    }

    function openedAtValue() external view returns (uint64) {
        return openedAt;
    }

    function tokenAddress() external view returns (address) {
        return address(token);
    }

    function _commitSome(address[3] memory panel, uint8 round, uint256 seed, uint256 commitLimit) private {
        uint256 committed;
        for (uint256 i; i < 3 && committed < commitLimit; ++i) {
            address arbiter = panel[i];
            if (arbiter == address(0)) continue;
            (bytes32 existing,,) = p3.getVote(disputeId, round, arbiter);
            if (existing != bytes32(0)) continue;
            uint16 bps = uint16((seed % 10_001 + i * 997) % 10_001);
            bytes32 salt = keccak256(abi.encode("bounded-exit-vote", seed, disputeId, round, arbiter));
            bytes32 commitment = keccak256(abi.encode(block.chainid, address(escrow), disputeId, arbiter, bps, salt));
            _votes[round][arbiter] = VoteData({bps: bps, salt: salt, committed: true, revealed: false});
            vm.prank(arbiter);
            p3.commitVote(disputeId, commitment);
            ++committed;
        }
    }

    function _assertLedgerConservation() private view {
        uint256 claimLiabilities = escrow.claimable(address(token), CLIENT)
            + escrow.claimable(address(token), FREELANCER) + escrow.claimable(address(token), address(0x7EA5));
        assertEq(escrow.totalClaimable(address(token)), claimLiabilities, "only named parties and treasury hold claims");
        assertEq(escrow.claimable(address(token), escrow.owner()), 0, "owner acquires no dispute reward");
        assertEq(escrow.claimable(address(token), address(this)), 0, "handler acquires no dispute reward");
        assertEq(
            token.balanceOf(address(escrow)),
            escrow.lockedEscrow(address(token)) + escrow.totalClaimable(address(token))
                + p3.disputeDeposits(address(token)) + p3.arbiterStakes(address(token)),
            "token balance backs all principal, claim, deposit, and stake ledgers after this step"
        );
    }

    function _revealSome(address[3] memory panel, uint8 round, uint256 revealLimit) private {
        uint256 revealed;
        for (uint256 i; i < 3 && revealed < revealLimit; ++i) {
            address arbiter = panel[i];
            VoteData storage vote = _votes[round][arbiter];
            if (arbiter == address(0) || !vote.committed || vote.revealed) continue;
            vm.prank(arbiter);
            p3.revealVote(disputeId, vote.bps, vote.salt);
            vote.revealed = true;
            ++revealed;
        }
    }
}

contract Phase3BoundedExitInvariantTest is Test {
    address private constant CLIENT = address(0xC11E);
    address private constant FREELANCER = address(0xFEE);
    address private constant TREASURY = address(0x7EA5);
    uint64 private constant START_TIME = 1_800_000_000;

    FairworkEscrow private escrow;
    MockToken private token;
    IPhase3Escrow private p3;
    Phase3BoundedExitHandler private handler;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(START_TIME);
        token = new MockToken("USDC test", "USDC", 6);
        FairworkEscrow.TokenConfig[] memory tokenConfigs = new FairworkEscrow.TokenConfig[](1);
        tokenConfigs[0] = FairworkEscrow.TokenConfig(address(token), 6, 1, 1e18, bytes32(0));
        FairworkEscrow.ProtocolConfig memory config = FairworkEscrow.ProtocolConfig({
            fundingWindow: 60,
            gracePeriod: 15,
            minDuration: 1,
            maxDuration: 365 days,
            minReviewWindow: 1,
            maxReviewWindow: 30 days
        });
        escrow = new FairworkEscrow(tokenConfigs, config, TREASURY);
        p3 = IPhase3Escrow(address(escrow));
        token.mint(CLIENT, 100_000);
        token.mint(FREELANCER, 100_000);
        vm.prank(CLIENT);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(FREELANCER);
        token.approve(address(escrow), type(uint256).max);
        for (uint256 i; i < 9; ++i) p3.addArbiter(address(uint160(0xA000 + i)));

        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(10_001, 10, keccak256("criteria"));
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(token),
            titleCommitment: keccak256("terms"),
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery"),
            reviewWindow: 120,
            revisionLimit: 0
        });
        vm.prank(CLIENT);
        uint256 jobId = escrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);
        vm.prank(FREELANCER);
        IPhase2Read(address(escrow)).submitMilestone(jobId, 0, keccak256("delivery"), bytes32(0));
        vm.prank(CLIENT);
        uint256 disputeId = p3.openDispute(jobId, 0);

        handler = new Phase3BoundedExitHandler(escrow, token, disputeId);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Phase3BoundedExitHandler.runBoundedCampaign.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_F45_LiveDisputeHasBoundedRealExitAndConservedLiabilities() public view {
        IPhase3Escrow.DisputeView memory dispute = handler.dispute();
        assertEq(
            escrow.totalClaimable(address(token)),
            escrow.claimable(address(token), CLIENT) + escrow.claimable(address(token), FREELANCER)
                + escrow.claimable(address(token), TREASURY),
            "only named parties and treasury hold claim liabilities"
        );
        assertEq(
            token.balanceOf(address(escrow)),
            escrow.lockedEscrow(address(token)) + escrow.totalClaimable(address(token))
                + p3.disputeDeposits(address(token)) + p3.arbiterStakes(address(token)),
            "live and terminal states both conserve actual token balance"
        );
        if (handler.campaignCalls() == 0) {
            assertEq(dispute.phase, 1, "before the campaign, the real dispute is live in Evidence");
            assertEq(escrow.lockedEscrow(address(token)), 10_001);
            assertEq(p3.disputeDeposits(address(token)), 200);
            assertEq(escrow.totalClaimable(address(token)), 0);
            return;
        }
        _assertTerminalExit();
    }

    function afterInvariant() public view {
        _assertTerminalExit();
    }

    function _assertTerminalExit() private view {
        IPhase3Escrow.DisputeView memory dispute = handler.dispute();
        assertGt(handler.campaignCalls(), 0, "stateful campaign actually ran from a live dispute");
        assertEq(handler.terminalizations(), 1, "one live dispute reaches exactly one terminal state");
        assertEq(dispute.phase, 10, "handler reaches a ruling or fallback");
        assertLe(handler.advanceCount(), 12, "exit uses a fixed number of public phase advances");
        assertLe(uint256(handler.terminalAt()), uint256(handler.openedAtValue()) + 12 * 60, "exit stays within bounded windows");
        assertEq(
            token.balanceOf(address(escrow)),
            escrow.lockedEscrow(address(token)) + escrow.totalClaimable(address(token))
                + p3.disputeDeposits(address(token)) + p3.arbiterStakes(address(token)),
            "real token balance equals every recorded escrow liability"
        );
        assertEq(escrow.lockedEscrow(address(token)), 0, "terminal dispute releases its full principal");
        assertEq(p3.disputeDeposits(address(token)), 0, "terminal dispute clears deposit liabilities");
        assertEq(p3.arbiterStakes(address(token)), 0, "P0 carries no stake liabilities");
        assertEq(escrow.totalClaimable(address(token)), 10_001 + 200, "principal and opener deposit are both allocated");
    }
}
