// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {MockToken, ConfigurableFeeToken, FalseReturnToken, NoReturnToken, ReentrantToken} from "./support/MockTokens.sol";

/// @dev Test-only subclass. It exposes no production credit endpoint and seeds only after funded principal exists.
contract FairworkEscrowHarness is FairworkEscrow {
    constructor(TokenConfig[] memory tokenConfigs, ProtocolConfig memory config, address treasury_)
        FairworkEscrow(tokenConfigs, config, treasury_)
    {}

    function seedClaimableFromLocked(address token, address recipient, uint256 amount) external {
        _creditFromEscrow(token, recipient, amount);
    }
}

contract EscrowInvariantHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant MAX_AMOUNT = 1e18;
    uint256 private constant MAX_DURATION = 365 days;
    uint256 private constant MAX_JOBS = 20;

    FairworkEscrowHarness public immutable escrow;
    address[3] private _tokens;
    uint256[] private _jobIds;

    address private constant CLIENT = address(0xC11E);
    address private constant FREELANCER = address(0xFEE);
    bytes32 private constant COMMITMENT = keccak256("invariant commitment");

    constructor(FairworkEscrowHarness escrow_, address token6_, address token8_, address token18_) {
        escrow = escrow_;
        _tokens = [token6_, token8_, token18_];
    }

    function createJob(uint8 tokenSeed, uint256 amountSeed, uint64 durationSeed, uint8 revisionSeed) external {
        if (_jobIds.length >= MAX_JOBS) return;
        address token = _tokens[uint256(tokenSeed) % _tokens.length];
        uint256 amount = bound(amountSeed, 1, MAX_AMOUNT);
        uint64 duration = uint64(bound(durationSeed, 1, MAX_DURATION));
        uint8 revisionLimit = uint8(bound(revisionSeed, 0, 5));
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: token,
            titleCommitment: COMMITMENT,
            descriptionCommitment: COMMITMENT,
            scopeCommitment: COMMITMENT,
            deliveryRuleCommitment: COMMITMENT,
            reviewWindow: 30,
            revisionLimit: revisionLimit
        });
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput({
            amount: amount,
            duration: duration,
            acceptanceCriteriaCommitment: COMMITMENT
        });
        vm.prank(CLIENT);
        try escrow.createJob(terms, milestones) returns (uint256 jobId) {
            _jobIds.push(jobId);
        } catch {}
    }

    function acceptJob(uint256 jobSeed) external {
        if (_jobIds.length == 0) return;
        uint256 jobId = _jobIds[jobSeed % _jobIds.length];
        vm.prank(FREELANCER);
        try escrow.acceptJob(jobId) {} catch {}
    }

    function fundJob(uint256 jobSeed) external {
        if (_jobIds.length == 0) return;
        uint256 jobId = _jobIds[jobSeed % _jobIds.length];
        vm.prank(CLIENT);
        try escrow.fundJob(jobId) {} catch {}
    }

    function advanceTime(uint32 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 2 days));
    }

    function bound(uint256 value, uint256 min, uint256 max) private pure returns (uint256) {
        return min + (value % (max - min + 1));
    }
}

contract Phase1EscrowTest is Test {
    address private constant CLIENT = address(0xC11E);
    address private constant FREELANCER = address(0xFEE);
    address private constant OTHER = address(0xB0B);
    address private constant TREASURY = address(0x7EA5);
    uint64 private constant FUNDING_WINDOW = 60;
    uint64 private constant GRACE_PERIOD = 15;
    uint64 private constant MIN_DURATION = 1;
    uint64 private constant MAX_DURATION = 365 days;
    uint64 private constant MIN_REVIEW_WINDOW = 1;
    uint64 private constant MAX_REVIEW_WINDOW = 30 days;
    uint256 private constant MAX_RAW_AMOUNT = 1e18;
    bytes32 private constant COMMITMENT = keccak256("committed terms");

    MockToken internal token6;
    MockToken internal token8;
    ReentrantToken internal token18;
    FairworkEscrowHarness internal escrow;
    EscrowInvariantHandler internal invariantHandler;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_800_000_000);

        token6 = new MockToken("USDC test", "USDC", 6);
        token8 = new MockToken("WBTC test", "WBTC", 8);
        token18 = new ReentrantToken(18);
        escrow = _deployEscrow(address(token6), address(token8), address(token18));

        token6.mint(CLIENT, 20e18);
        token8.mint(CLIENT, 20e18);
        token18.mint(CLIENT, 20e18);
        vm.startPrank(CLIENT);
        token6.approve(address(escrow), type(uint256).max);
        token8.approve(address(escrow), type(uint256).max);
        token18.approve(address(escrow), type(uint256).max);
        vm.stopPrank();

        invariantHandler = new EscrowInvariantHandler(
            escrow, address(token6), address(token8), address(token18)
        );
        targetContract(address(invariantHandler));
    }

    function test_F01_F02_F03_CreateAcceptFundStartsIndependentRawUnitClocks() public {
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](2);
        milestones[0] = FairworkEscrow.MilestoneInput(1_000_001, 7, COMMITMENT);
        milestones[1] = FairworkEscrow.MilestoneInput(2_000_003, 37, keccak256("criteria two"));
        FairworkEscrow.JobInput memory terms = _terms(address(token6), 30, 3);

        vm.prank(CLIENT);
        uint256 jobId = escrow.createJob(terms, milestones);
        FairworkEscrow.JobView memory proposed = escrow.getJob(jobId);
        assertEq(uint256(proposed.state), 0, "F-01 job starts Proposed");
        assertEq(proposed.totalAmount, 3_000_004, "F-01 amounts stay raw units");
        assertEq(proposed.proposalEnd, proposed.createdAt + FUNDING_WINDOW, "A-01 proposal clock starts at create");
        assertEq(escrow.getMilestone(jobId, 0).deadline, 0, "F-03 work clock has not started");
        assertEq(escrow.getMilestone(jobId, 1).graceEnd, 0, "F-03 grace clock has not started");

        vm.warp(proposed.proposalEnd - 1);
        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
        FairworkEscrow.JobView memory accepted = escrow.getJob(jobId);
        assertEq(uint256(accepted.state), 1, "F-02 named freelancer accepts");
        assertEq(accepted.fundingDeadline, accepted.acceptedAt + FUNDING_WINDOW, "F-85 funding clock starts at acceptance");
        assertEq(escrow.getMilestone(jobId, 0).deadline, 0, "F-03 acceptance does not start delivery clock");

        vm.warp(accepted.fundingDeadline - 1);
        uint256 beforeClient = token6.balanceOf(CLIENT);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);

        FairworkEscrow.JobView memory funded = escrow.getJob(jobId);
        FairworkEscrow.MilestoneView memory first = escrow.getMilestone(jobId, 0);
        FairworkEscrow.MilestoneView memory second = escrow.getMilestone(jobId, 1);
        assertEq(uint256(funded.state), 2, "F-03 job becomes Funded");
        assertEq(token6.balanceOf(CLIENT), beforeClient - 3_000_004, "F-03 client pays exact raw total");
        assertEq(escrow.lockedEscrow(address(token6)), 3_000_004, "F-03 principal is locked");
        assertEq(first.deadline, funded.fundedAt + 7, "D-01 first clock starts at funding");
        assertEq(second.deadline, funded.fundedAt + 37, "D-01 second clock is independent");
        assertEq(first.graceEnd, first.deadline + GRACE_PERIOD, "F-03 grace end follows first deadline");
        assertEq(second.graceEnd, second.deadline + GRACE_PERIOD, "F-03 grace end follows second deadline");
        assertEq(escrow.claimable(address(token6), FREELANCER), 0, "F-03 funding does not create a claim");
        assertEq(escrow.totalClaimable(address(token6)), 0, "F-03 funding has no claimable liability");
    }

    function test_F01_F03_RawUnitsForSixEightEighteenDecimalTokens() public {
        address[3] memory tokens = [address(token6), address(token8), address(token18)];
        uint256[3] memory amounts = [uint256(1_234_567), uint256(123_456_789), uint256(987_654_321_012_345_678)];
        uint8[3] memory decimals = [uint8(6), uint8(8), uint8(18)];

        for (uint256 i; i < tokens.length; ++i) {
            FairworkEscrow.TokenConfig memory config = escrow.tokenConfig(tokens[i]);
            assertEq(uint256(config.decimals), decimals[i], "D-06 configured decimals");
            uint256 jobId = _fundedJob(tokens[i], amounts[i], 10);
            assertEq(escrow.getJob(jobId).totalAmount, amounts[i], "F-01 stores amount without decimal scaling");
            assertEq(escrow.lockedEscrow(tokens[i]), amounts[i], "F-03 locks exact raw amount");
            assertEq(IERC20(tokens[i]).balanceOf(address(escrow)), amounts[i], "F-03 receives exact raw amount");
        }
    }

    function testFuzz_F01_F03_RawAmountRemainsTokenUnits(uint256 rawAmount, uint8 tokenSeed) public {
        address[3] memory tokens = [address(token6), address(token8), address(token18)];
        address token = tokens[uint256(tokenSeed) % tokens.length];
        uint256 amount = bound(rawAmount, 1, MAX_RAW_AMOUNT);
        uint256 beforeEscrow = IERC20(token).balanceOf(address(escrow));
        uint256 jobId = _fundedJob(token, amount, 10);

        assertEq(escrow.getJob(jobId).totalAmount, amount, "F-01 preserves raw amount");
        assertEq(IERC20(token).balanceOf(address(escrow)) - beforeEscrow, amount, "F-03 exact balance delta");
        assertEq(escrow.lockedEscrow(token), amount, "F-03 ledger matches raw principal");
    }

    function test_F01_RejectsInvalidPartiesTokensCommitmentsAndBounds() public {
        FairworkEscrow.MilestoneInput[] memory milestones = _milestones(1, 10, COMMITMENT);
        FairworkEscrow.JobInput memory terms = _terms(address(token6), 30, 0);

        terms.freelancer = address(0);
        vm.expectRevert(FairworkEscrow.InvalidAddress.selector);
        _createWith(CLIENT, terms, milestones);
        terms.freelancer = CLIENT;
        vm.expectRevert(FairworkEscrow.InvalidAddress.selector);
        _createWith(CLIENT, terms, milestones);
        terms.freelancer = FREELANCER;
        terms.token = address(0xBAD);
        vm.expectRevert(abi.encodeWithSelector(FairworkEscrow.InvalidToken.selector, address(0xBAD)));
        _createWith(CLIENT, terms, milestones);
        terms.token = address(token6);
        terms.titleCommitment = bytes32(0);
        vm.expectRevert(FairworkEscrow.InvalidCommitment.selector);
        _createWith(CLIENT, terms, milestones);
        terms.titleCommitment = COMMITMENT;
        terms.reviewWindow = 0;
        vm.expectRevert(FairworkEscrow.InvalidWindow.selector);
        _createWith(CLIENT, terms, milestones);
        terms.reviewWindow = MAX_REVIEW_WINDOW + 1;
        vm.expectRevert(FairworkEscrow.InvalidWindow.selector);
        _createWith(CLIENT, terms, milestones);
        terms.reviewWindow = 30;
        terms.revisionLimit = 6;
        vm.expectRevert(FairworkEscrow.InvalidRevisionLimit.selector);
        _createWith(CLIENT, terms, milestones);

        terms.revisionLimit = 0;
        milestones[0].amount = 0;
        vm.expectRevert(FairworkEscrow.InvalidAmount.selector);
        _createWith(CLIENT, terms, milestones);
        milestones[0].amount = MAX_RAW_AMOUNT + 1;
        vm.expectRevert(FairworkEscrow.InvalidAmount.selector);
        _createWith(CLIENT, terms, milestones);
        milestones[0].amount = 1;
        milestones[0].duration = 0;
        vm.expectRevert(FairworkEscrow.InvalidDuration.selector);
        _createWith(CLIENT, terms, milestones);
        milestones[0].duration = MAX_DURATION + 1;
        vm.expectRevert(FairworkEscrow.InvalidDuration.selector);
        _createWith(CLIENT, terms, milestones);
        milestones[0].duration = 10;
        milestones[0].acceptanceCriteriaCommitment = bytes32(0);
        vm.expectRevert(FairworkEscrow.InvalidCommitment.selector);
        _createWith(CLIENT, terms, milestones);

        FairworkEscrow.MilestoneInput[] memory none = new FairworkEscrow.MilestoneInput[](0);
        vm.expectRevert(FairworkEscrow.InvalidMilestoneCount.selector);
        _createWith(CLIENT, terms, none);
        FairworkEscrow.MilestoneInput[] memory tooMany = new FairworkEscrow.MilestoneInput[](11);
        for (uint256 i; i < tooMany.length; ++i) {
            tooMany[i] = FairworkEscrow.MilestoneInput(1, 1, COMMITMENT);
        }
        vm.expectRevert(FairworkEscrow.InvalidMilestoneCount.selector);
        _createWith(CLIENT, terms, tooMany);
    }

    function test_F02_F03_EnforceRolesAndFundingOrder() public {
        uint256 jobId = _create(address(token6), 100, 10, 0);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        vm.prank(OTHER);
        escrow.acceptJob(jobId);

        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);

        _accept(jobId);
        vm.expectRevert(FairworkEscrow.Unauthorized.selector);
        vm.prank(OTHER);
        escrow.fundJob(jobId);

        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        _accept(jobId);
        _fund(jobId);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        _fund(jobId);
        assertEq(escrow.lockedEscrow(address(token6)), 100, "F-03 funds once");
    }

    function test_F01_F02_F03_UnknownJobsAndUnauthorizedWithdrawalCannotMoveFunds() public {
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        vm.prank(FREELANCER);
        escrow.acceptJob(999);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        vm.prank(CLIENT);
        escrow.fundJob(999);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        vm.prank(OTHER);
        escrow.cancelExpiredProposal(999);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        vm.prank(OTHER);
        escrow.cancelUnfundedJob(999);

        uint256 jobId = _fundedJob(address(token6), 500, 10);
        vm.expectRevert(FairworkEscrow.InvalidAmount.selector);
        vm.prank(address(this));
        escrow.withdraw(address(token6));
        assertEq(escrow.lockedEscrow(address(token6)), 500, "F-03 no caller can withdraw locked principal");
        assertEq(escrow.claimable(address(token6), FREELANCER), 0, "F-03 no claim is created by funding");
        assertEq(escrow.getJob(jobId).fundedAt, block.timestamp, "F-03 funded state remains readable");
    }

    function test_A01_F02_ProposalUsesHalfOpenExpiryAndPublicCancellation() public {
        uint256 acceptsBeforeEnd = _create(address(token6), 100, 10, 0);
        FairworkEscrow.JobView memory first = escrow.getJob(acceptsBeforeEnd);
        vm.warp(first.proposalEnd - 1);
        vm.prank(FREELANCER);
        escrow.acceptJob(acceptsBeforeEnd);
        assertEq(uint256(escrow.getJob(acceptsBeforeEnd).state), 1, "A-01 accept at end-1");

        uint256 expiresAtEnd = _create(address(token8), 100, 10, 0);
        FairworkEscrow.JobView memory second = escrow.getJob(expiresAtEnd);
        vm.warp(second.proposalEnd);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        vm.prank(FREELANCER);
        escrow.acceptJob(expiresAtEnd);
        uint256 beforeBalance = token8.balanceOf(address(escrow));
        vm.prank(OTHER);
        escrow.cancelExpiredProposal(expiresAtEnd);
        assertEq(uint256(escrow.getJob(expiresAtEnd).state), 3, "A-01 anyone cancels at end");
        assertEq(token8.balanceOf(address(escrow)), beforeBalance, "A-01 proposal cancellation moves no funds");

        uint256 expiresAfterEnd = _create(address(token18), 100, 10, 0);
        FairworkEscrow.JobView memory third = escrow.getJob(expiresAfterEnd);
        vm.warp(third.proposalEnd + 1);
        vm.prank(OTHER);
        escrow.cancelExpiredProposal(expiresAfterEnd);
        assertEq(uint256(escrow.getJob(expiresAfterEnd).state), 3, "A-01 anyone cancels after end");
    }

    function test_F85_F03_FundingUsesHalfOpenExpiryAndPublicCancellation() public {
        uint256 fundsBeforeEnd = _create(address(token6), 200, 10, 0);
        _accept(fundsBeforeEnd);
        FairworkEscrow.JobView memory first = escrow.getJob(fundsBeforeEnd);
        vm.warp(first.fundingDeadline - 1);
        vm.prank(CLIENT);
        escrow.fundJob(fundsBeforeEnd);
        assertEq(uint256(escrow.getJob(fundsBeforeEnd).state), 2, "F-85 fund at end-1");

        uint256 expiresAtEnd = _create(address(token8), 300, 10, 0);
        _accept(expiresAtEnd);
        FairworkEscrow.JobView memory second = escrow.getJob(expiresAtEnd);
        vm.warp(second.fundingDeadline);
        uint256 beforeBalance = token8.balanceOf(address(escrow));
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        vm.prank(CLIENT);
        escrow.fundJob(expiresAtEnd);
        vm.prank(OTHER);
        escrow.cancelUnfundedJob(expiresAtEnd);
        assertEq(uint256(escrow.getJob(expiresAtEnd).state), 3, "F-85 anyone cancels at end");
        assertEq(token8.balanceOf(address(escrow)), beforeBalance, "F-85 timeout moves no funds");

        uint256 expiresAfterEnd = _create(address(token18), 400, 10, 0);
        _accept(expiresAfterEnd);
        FairworkEscrow.JobView memory third = escrow.getJob(expiresAfterEnd);
        vm.warp(third.fundingDeadline + 1);
        vm.prank(OTHER);
        escrow.cancelUnfundedJob(expiresAfterEnd);
        assertEq(uint256(escrow.getJob(expiresAfterEnd).state), 3, "F-85 anyone cancels after end");
    }

    function test_F03_RejectsFeeOnTransferAndFalseReturnDepositsWithRollback() public {
        ConfigurableFeeToken feeToken = new ConfigurableFeeToken("Fee", "FEE", 6, 100);
        feeToken.setFeeEnabled(true);
        FairworkEscrowHarness feeEscrow = _deployEscrow(address(feeToken), address(0), address(0));
        feeToken.mint(CLIENT, 1_000_000);
        vm.prank(CLIENT);
        feeToken.approve(address(feeEscrow), type(uint256).max);
        uint256 feeJob = _createOn(feeEscrow, address(feeToken), 100_000, 10);
        _acceptOn(feeEscrow, feeJob);
        uint256 feeBefore = feeToken.balanceOf(CLIENT);
        vm.expectRevert(FairworkEscrow.ExactTransferRequired.selector);
        vm.prank(CLIENT);
        feeEscrow.fundJob(feeJob);
        assertEq(feeToken.balanceOf(CLIENT), feeBefore, "F-03 fee deposit rolls back sender balance");
        assertEq(feeToken.balanceOf(address(feeEscrow)), 0, "F-03 fee deposit rolls back escrow balance");
        assertEq(feeEscrow.lockedEscrow(address(feeToken)), 0, "F-03 fee deposit rolls back ledger");
        assertEq(uint256(feeEscrow.getJob(feeJob).state), 1, "F-03 failed deposit remains AcceptedUnfunded");

        FalseReturnToken falseToken = new FalseReturnToken(8);
        falseToken.setFalseOnTransferFrom(true);
        FairworkEscrowHarness falseEscrow = _deployEscrow(address(falseToken), address(0), address(0));
        falseToken.mint(CLIENT, 1_000_000);
        vm.prank(CLIENT);
        falseToken.approve(address(falseEscrow), type(uint256).max);
        uint256 falseJob = _createOn(falseEscrow, address(falseToken), 100_001, 10);
        _acceptOn(falseEscrow, falseJob);
        uint256 falseBefore = falseToken.balanceOf(CLIENT);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(falseToken)));
        vm.prank(CLIENT);
        falseEscrow.fundJob(falseJob);
        assertEq(falseToken.balanceOf(CLIENT), falseBefore, "F-03 false-return deposit does not debit client");
        assertEq(falseToken.balanceOf(address(falseEscrow)), 0, "F-03 false-return deposit adds no escrow balance");
        assertEq(falseEscrow.lockedEscrow(address(falseToken)), 0, "F-03 false-return deposit adds no liability");
    }

    function test_F03_SafeERC20SupportsNoReturnTokenAndExactBalanceDeltas() public {
        NoReturnToken noReturn = new NoReturnToken(8);
        FairworkEscrowHarness noReturnEscrow = _deployEscrow(address(noReturn), address(0), address(0));
        noReturn.mint(CLIENT, 1_000_000);
        vm.prank(CLIENT);
        noReturn.approve(address(noReturnEscrow), type(uint256).max);
        uint256 jobId = _createOn(noReturnEscrow, address(noReturn), 123_457, 10);
        _acceptOn(noReturnEscrow, jobId);
        uint256 beforeEscrow = noReturn.balanceOf(address(noReturnEscrow));
        vm.prank(CLIENT);
        noReturnEscrow.fundJob(jobId);
        assertEq(noReturn.balanceOf(address(noReturnEscrow)) - beforeEscrow, 123_457, "F-03 no-return token exact delta");
        assertEq(noReturnEscrow.lockedEscrow(address(noReturn)), 123_457, "F-03 no-return token liability");

        noReturnEscrow.seedClaimableFromLocked(address(noReturn), FREELANCER, 123_457);
        uint256 beforeRecipient = noReturn.balanceOf(FREELANCER);
        vm.prank(FREELANCER);
        noReturnEscrow.withdraw(address(noReturn));
        assertEq(noReturn.balanceOf(FREELANCER) - beforeRecipient, 123_457, "F-03 no-return token withdrawal exact delta");
        assertEq(noReturn.balanceOf(address(noReturnEscrow)), 0, "F-03 no-return token withdrawal empties escrow balance");
        assertEq(noReturnEscrow.claimable(address(noReturn), FREELANCER), 0, "F-03 no-return token clears ledger");
    }

    function test_F03_DirectSurplusNeverCreatesClaimableLiability() public {
        _fundedJob(address(token8), 123_459, 10);
        token8.mint(address(escrow), 7_777);
        assertEq(token8.balanceOf(address(escrow)), 123_459 + 7_777, "F-03 direct transfer is surplus");
        assertEq(escrow.lockedEscrow(address(token8)), 123_459, "F-03 surplus does not change locked principal");
        assertEq(escrow.claimable(address(token8), CLIENT), 0, "F-03 surplus creates no client claim");
        assertEq(escrow.claimable(address(token8), FREELANCER), 0, "F-03 surplus creates no freelancer claim");
        assertEq(escrow.totalClaimable(address(token8)), 0, "F-03 surplus creates no claimable liability");
    }

    function test_F03_WithdrawalTransfersExactBackedClaimableAndClearsLedger() public {
        uint256 amount = 456_789;
        uint256 jobId = _fundedJob(address(token6), amount, 10);
        escrow.seedClaimableFromLocked(address(token6), FREELANCER, amount);
        uint256 escrowBefore = token6.balanceOf(address(escrow));
        uint256 recipientBefore = token6.balanceOf(FREELANCER);

        vm.prank(FREELANCER);
        escrow.withdraw(address(token6));

        assertEq(escrowBefore - token6.balanceOf(address(escrow)), amount, "A-20 escrow pays exact amount");
        assertEq(token6.balanceOf(FREELANCER) - recipientBefore, amount, "A-20 recipient receives exact amount");
        assertEq(escrow.claimable(address(token6), FREELANCER), 0, "F-03 withdrawal clears claimable");
        assertEq(escrow.totalClaimable(address(token6)), 0, "F-03 withdrawal clears aggregate claimable");
        assertEq(escrow.lockedEscrow(address(token6)), 0, "F-03 harness moved only backed principal");
        assertEq(uint256(escrow.getJob(jobId).state), 2, "F-03 withdrawing does not change funded job state");
    }

    function test_A20_F03_WithdrawalTransferFailureRollsBackAllLiabilityAndBalances() public {
        uint256 amount = 200_000;
        uint256 jobId = _fundedJob(address(token18), amount, 10);
        escrow.seedClaimableFromLocked(address(token18), FREELANCER, amount);
        token18.setFeeEnabled(true);
        uint256 escrowBefore = token18.balanceOf(address(escrow));
        uint256 recipientBefore = token18.balanceOf(FREELANCER);

        vm.expectRevert(FairworkEscrow.ExactTransferRequired.selector);
        vm.prank(FREELANCER);
        escrow.withdraw(address(token18));

        assertEq(token18.balanceOf(address(escrow)), escrowBefore, "A-20 failed withdrawal restores escrow balance");
        assertEq(token18.balanceOf(FREELANCER), recipientBefore, "A-20 failed withdrawal restores recipient balance");
        assertEq(escrow.claimable(address(token18), FREELANCER), amount, "A-20 failed withdrawal restores claimable");
        assertEq(escrow.totalClaimable(address(token18)), amount, "A-20 failed withdrawal restores aggregate liability");
        assertEq(escrow.lockedEscrow(address(token18)), 0, "A-20 claim remains claimable after rollback");
        assertEq(uint256(escrow.getJob(jobId).state), 2, "A-20 failure leaves job state intact");
    }

    function test_A20_F03_WithdrawalIsEffectsFirstAndReentrancyGuarded() public {
        uint256 amount = 300_001;
        _fundedJob(address(token18), amount, 10);
        escrow.seedClaimableFromLocked(address(token18), address(token18), amount);
        bytes memory withdrawCall = abi.encodeWithSelector(escrow.withdraw.selector, address(token18));
        token18.configureCallback(address(escrow), withdrawCall, false, true);
        uint256 escrowBefore = token18.balanceOf(address(escrow));

        bool outerSuccess = token18.callConfiguredTarget();

        assertTrue(outerSuccess, "A-20 beneficiary withdraw succeeds");
        assertTrue(token18.reentryAttempted(), "A-20 token callback attempted a nested withdrawal");
        assertFalse(token18.reentrySucceeded(), "A-20 nested withdrawal is rejected");
        assertEq(token18.observedClaimable(), 0, "A-20 claim is cleared before token interaction");
        assertEq(escrow.claimable(address(token18), address(token18)), 0, "A-20 no duplicate claim remains");
        assertEq(token18.balanceOf(address(escrow)), escrowBefore - amount, "A-20 escrow balance decreases once");
        assertEq(token18.balanceOf(address(token18)), amount, "A-20 beneficiary receives exact amount once");
        assertEq(escrow.totalClaimable(address(token18)), 0, "A-20 no liability remains after withdrawal");
    }

    function test_F03_CallbackCannotReenterCreateDuringFunding() public {
        uint256 jobId = _create(address(token18), 100_003, 10, 0);
        _accept(jobId);
        FairworkEscrow.JobInput memory nestedTerms = _terms(address(token18), 30, 0);
        FairworkEscrow.MilestoneInput[] memory nestedMilestones = _milestones(1, 10, COMMITMENT);
        bytes memory nestedCreate = abi.encodeWithSelector(escrow.createJob.selector, nestedTerms, nestedMilestones);
        token18.configureCallback(address(escrow), nestedCreate, true, false);

        vm.prank(CLIENT);
        escrow.fundJob(jobId);

        assertTrue(token18.reentryAttempted(), "F-03 callback attempted cross-create");
        assertFalse(token18.reentrySucceeded(), "F-03 nested create is guarded");
        assertEq(escrow.jobCount(), 1, "F-03 callback cannot create a second job");
        assertEq(escrow.lockedEscrow(address(token18)), 100_003, "F-03 outer funding records one liability");
    }

    function test_F01_RejectsInvalidDeploymentConfiguration() public {
        vm.chainId(1);
        FairworkEscrow.TokenConfig[] memory configs = _configs(address(token6), address(0), address(0));
        vm.expectRevert(FairworkEscrow.InvalidChainId.selector);
        new FairworkEscrowHarness(configs, _protocolConfig(), TREASURY);
        vm.chainId(31337);

        MockToken sevenDecimals = new MockToken("Unsupported", "NOPE", 7);
        configs = _configs(address(sevenDecimals), address(0), address(0));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrowHarness(configs, _protocolConfig(), TREASURY);

        FairworkEscrow.TokenConfig[] memory duplicate = new FairworkEscrow.TokenConfig[](2);
        duplicate[0] = FairworkEscrow.TokenConfig(address(token6), 6, 1, MAX_RAW_AMOUNT, bytes32(0));
        duplicate[1] = FairworkEscrow.TokenConfig(address(token6), 6, 1, MAX_RAW_AMOUNT, bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrowHarness(duplicate, _protocolConfig(), TREASURY);
    }

    function invariant_F03_EachTokenBalanceCoversItsLiabilities() public view {
        address[3] memory tokens = [address(token6), address(token8), address(token18)];
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            assertGe(
                IERC20(token).balanceOf(address(escrow)),
                escrow.lockedEscrow(token) + escrow.totalClaimable(token),
                "F-03 per-token solvency"
            );
            assertEq(escrow.totalClaimable(token), 0, "Phase 1 does not create settlement claims");
        }
    }

    function _deployEscrow(address tokenA, address tokenB, address tokenC)
        internal
        returns (FairworkEscrowHarness deployed)
    {
        FairworkEscrow.TokenConfig[] memory configs = _configs(tokenA, tokenB, tokenC);
        deployed = new FairworkEscrowHarness(configs, _protocolConfig(), TREASURY);
    }

    function _configs(address tokenA, address tokenB, address tokenC)
        internal
        view
        returns (FairworkEscrow.TokenConfig[] memory configs)
    {
        uint256 count = 1 + (tokenB == address(0) ? 0 : 1) + (tokenC == address(0) ? 0 : 1);
        configs = new FairworkEscrow.TokenConfig[](count);
        configs[0] = FairworkEscrow.TokenConfig(tokenA, _decimalsFor(tokenA), 1, MAX_RAW_AMOUNT, bytes32(0));
        if (tokenB != address(0)) {
            configs[1] = FairworkEscrow.TokenConfig(tokenB, _decimalsFor(tokenB), 1, MAX_RAW_AMOUNT, bytes32(0));
        }
        if (tokenC != address(0)) {
            configs[count - 1] = FairworkEscrow.TokenConfig(tokenC, _decimalsFor(tokenC), 1, MAX_RAW_AMOUNT, bytes32(0));
        }
    }

    function _decimalsFor(address token) internal view returns (uint8) {
        if (token == address(token6)) return 6;
        if (token == address(token8)) return 8;
        if (token == address(token18)) return 18;
        return IERC20MetadataLike(token).decimals();
    }

    function _protocolConfig() internal pure returns (FairworkEscrow.ProtocolConfig memory) {
        return FairworkEscrow.ProtocolConfig({
            fundingWindow: FUNDING_WINDOW,
            gracePeriod: GRACE_PERIOD,
            minDuration: MIN_DURATION,
            maxDuration: MAX_DURATION,
            minReviewWindow: MIN_REVIEW_WINDOW,
            maxReviewWindow: MAX_REVIEW_WINDOW
        });
    }

    function _terms(address token, uint64 reviewWindow, uint8 revisionLimit)
        internal
        pure
        returns (FairworkEscrow.JobInput memory)
    {
        return FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: token,
            titleCommitment: COMMITMENT,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: reviewWindow,
            revisionLimit: revisionLimit
        });
    }

    function _milestones(uint256 amount, uint64 duration, bytes32 criteria)
        internal
        pure
        returns (FairworkEscrow.MilestoneInput[] memory milestones)
    {
        milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(amount, duration, criteria);
    }

    function _create(address token, uint256 amount, uint64 duration, uint8 revisionLimit)
        internal
        returns (uint256)
    {
        return _createWith(CLIENT, _terms(token, 30, revisionLimit), _milestones(amount, duration, COMMITMENT));
    }

    function _createWith(address caller, FairworkEscrow.JobInput memory terms, FairworkEscrow.MilestoneInput[] memory milestones)
        internal
        returns (uint256 jobId)
    {
        vm.prank(caller);
        jobId = escrow.createJob(terms, milestones);
    }

    function _createOn(FairworkEscrowHarness target, address token, uint256 amount, uint64 duration)
        internal
        returns (uint256 jobId)
    {
        vm.prank(CLIENT);
        jobId = target.createJob(_terms(token, 30, 0), _milestones(amount, duration, COMMITMENT));
    }

    function _accept(uint256 jobId) internal {
        _acceptOn(escrow, jobId);
    }

    function _acceptOn(FairworkEscrowHarness target, uint256 jobId) internal {
        vm.prank(FREELANCER);
        target.acceptJob(jobId);
    }

    function _fund(uint256 jobId) internal {
        vm.prank(CLIENT);
        escrow.fundJob(jobId);
    }

    function _fundedJob(address token, uint256 amount, uint64 duration) internal returns (uint256 jobId) {
        jobId = _create(token, amount, duration, 0);
        _accept(jobId);
        _fund(jobId);
    }
}

interface IERC20MetadataLike {
    function decimals() external view returns (uint8);
}
