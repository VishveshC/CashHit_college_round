// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {MockToken, ReentrantToken} from "./support/MockTokens.sol";

/// @dev Test-only replacement token keeps the OZ ERC-20 storage layout but has a distinct runtime hash.
contract AdditionalCodeChangedMockToken is MockToken {
    constructor() MockToken("Changed code", "CHANGED", 6) {}

    function changedImplementationMarker() external pure returns (uint256) {
        return 1;
    }
}

/// @dev Test-only fixture that can move only backed locked principal into claimable.
contract AdditionalCreditHarness is FairworkEscrow {
    constructor(TokenConfig[] memory tokenConfigs, ProtocolConfig memory config, address treasury_)
        FairworkEscrow(tokenConfigs, config, treasury_)
    {}

    function seedBackedClaim(address token, address recipient, uint256 amount) external {
        _creditFromEscrow(token, recipient, amount);
    }
}

contract AdditionalLedgerHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant MAX_RAW_AMOUNT = 1e18;
    uint256 private constant MAX_DURATION = 365 days;
    uint256 private constant MAX_TRACKED_JOBS = 64;
    uint64 private constant FUNDING_WINDOW = 60;

    enum Phase {
        Proposed,
        Accepted,
        Funded,
        Cancelled
    }

    struct TrackedJob {
        uint256 id;
        address token;
        uint256 amount;
        Phase phase;
    }

    FairworkEscrow public immutable escrow;
    address[3] private _tokens;
    TrackedJob[] private _jobs;
    mapping(address token => uint256 amount) public expectedLocked;

    uint256 public seededFundedCount;
    uint256 public randomFundedCount;
    uint256 public invalidMutationReverts;
    uint256 public earlyProposalCancelReverts;
    uint256 public earlyFundingCancelReverts;
    uint256 public proposalExpiryCount;
    uint256 public unfundedExpiryCount;
    uint256 public donationCount;
    uint256 public emptyWithdrawalReverts;

    address private constant CLIENT = address(0xC11E);
    address private constant FREELANCER = address(0xFEE);
    address private constant OTHER = address(0xB0B);
    bytes32 private constant COMMITMENT = keccak256("additional invariant commitment");

    constructor(FairworkEscrow escrow_, address token6_, address token8_, address token18_) {
        escrow = escrow_;
        _tokens = [token6_, token8_, token18_];
        _seedAndFund(token6_, 101);
        _seedAndFund(token8_, 203);
        _seedAndFund(token18_, 307);
    }

    function step(uint8 tokenSeed, uint256 amountSeed, uint64 durationSeed, uint32 salt) external {
        address token = _tokens[uint256(tokenSeed) % _tokens.length];

        if (_jobs.length + 2 < MAX_TRACKED_JOBS) {
            uint256 amount = _bound(amountSeed, 1, MAX_RAW_AMOUNT);
            uint64 duration = uint64(_bound(durationSeed, 1, MAX_DURATION));
            uint256 fundedId = _create(token, amount, duration);
            _accept(fundedId);
            _fund(fundedId);
            randomFundedCount++;

            vm.prank(OTHER);
            try escrow.fundJob(fundedId) {} catch {
                invalidMutationReverts++;
            }

            _donate(token, _bound(uint256(salt), 1, 10_000));
            vm.prank(OTHER);
            try escrow.withdraw(token) {} catch {
                emptyWithdrawalReverts++;
            }

            uint256 proposalId = _create(token, 1, 1);
            uint64 proposalEnd = escrow.getJob(proposalId).proposalEnd;
            vm.prank(OTHER);
            try escrow.cancelExpiredProposal(proposalId) {} catch {
                earlyProposalCancelReverts++;
            }
            vm.warp(proposalEnd);
            vm.prank(OTHER);
            escrow.cancelExpiredProposal(proposalId);
            _setPhase(proposalId, Phase.Cancelled);
            proposalExpiryCount++;

            uint256 unfundedId = _create(token, 1, 1);
            _accept(unfundedId);
            uint64 fundingDeadline = escrow.getJob(unfundedId).fundingDeadline;
            vm.prank(OTHER);
            try escrow.cancelUnfundedJob(unfundedId) {} catch {
                earlyFundingCancelReverts++;
            }
            vm.warp(fundingDeadline);
            vm.prank(OTHER);
            escrow.cancelUnfundedJob(unfundedId);
            _setPhase(unfundedId, Phase.Cancelled);
            unfundedExpiryCount++;
        }
    }

    function expectedJobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function _seedAndFund(address token, uint256 amount) private {
        uint256 id = _create(token, amount, 20);
        _accept(id);
        _fund(id);
        seededFundedCount++;
    }

    function _create(address token, uint256 amount, uint64 duration) private returns (uint256 id) {
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: token,
            titleCommitment: COMMITMENT,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery"),
            reviewWindow: 120,
            revisionLimit: 2
        });
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput({
            amount: amount,
            duration: duration,
            acceptanceCriteriaCommitment: COMMITMENT
        });
        vm.prank(CLIENT);
        id = escrow.createJob(terms, milestones);
        _jobs.push(TrackedJob(id, token, amount, Phase.Proposed));
    }

    function _accept(uint256 id) private {
        vm.prank(FREELANCER);
        escrow.acceptJob(id);
        _setPhase(id, Phase.Accepted);
    }

    function _fund(uint256 id) private {
        TrackedJob storage tracked = _tracked(id);
        vm.prank(CLIENT);
        escrow.fundJob(id);
        tracked.phase = Phase.Funded;
        expectedLocked[tracked.token] += tracked.amount;
    }

    function _setPhase(uint256 id, Phase phase) private {
        _tracked(id).phase = phase;
    }

    function _tracked(uint256 id) private view returns (TrackedJob storage tracked) {
        for (uint256 i; i < _jobs.length; ++i) {
            if (_jobs[i].id == id) return _jobs[i];
        }
        revert("unknown tracked job");
    }

    function _donate(address token, uint256 amount) private {
        MockToken(token).mint(address(this), amount);
        MockToken(token).transfer(address(escrow), amount);
        donationCount++;
    }

    function _bound(uint256 value, uint256 min, uint256 max) private pure returns (uint256) {
        return min + (value % (max - min + 1));
    }
}

abstract contract Phase1AdditionalFixture is Test {
    address internal constant CLIENT = address(0xC11E);
    address internal constant FREELANCER = address(0xFEE);
    address internal constant OTHER = address(0xB0B);
    address internal constant TREASURY = address(0x7EA5);
    uint64 internal constant FUNDING_WINDOW = 60;
    uint64 internal constant GRACE_PERIOD = 15;
    uint64 internal constant MIN_DURATION = 1;
    uint64 internal constant MAX_DURATION = 365 days;
    uint64 internal constant MIN_REVIEW_WINDOW = 1;
    uint64 internal constant MAX_REVIEW_WINDOW = 30 days;
    uint256 internal constant MAX_RAW_AMOUNT = 1e18;
    bytes32 internal constant COMMITMENT = keccak256("additional terms commitment");

    MockToken internal token6;
    MockToken internal token8;
    ReentrantToken internal token18;
    FairworkEscrow internal escrow;
    AdditionalLedgerHandler internal handler;

    function setUp() public virtual {
        vm.chainId(31337);
        vm.warp(1_800_000_000);
        token6 = new MockToken("USDC test", "USDC", 6);
        token8 = new MockToken("WBTC test", "WBTC", 8);
        token18 = new ReentrantToken(18);
        escrow = _deployEscrow(address(token6), address(token8), address(token18), _protocolConfig(), TREASURY);

        token6.mint(CLIENT, 1_000e18);
        token8.mint(CLIENT, 1_000e18);
        token18.mint(CLIENT, 1_000e18);
        vm.startPrank(CLIENT);
        token6.approve(address(escrow), type(uint256).max);
        token8.approve(address(escrow), type(uint256).max);
        token18.approve(address(escrow), type(uint256).max);
        vm.stopPrank();

        handler = new AdditionalLedgerHandler(
            escrow, address(token6), address(token8), address(token18)
        );
    }

    function _deployEscrow(address tokenA, address tokenB, address tokenC, FairworkEscrow.ProtocolConfig memory config, address treasury)
        internal
        returns (FairworkEscrow)
    {
        return new FairworkEscrow(_configs(tokenA, tokenB, tokenC), config, treasury);
    }

    function _configs(address tokenA, address tokenB, address tokenC)
        internal
        view
        returns (FairworkEscrow.TokenConfig[] memory configs)
    {
        uint256 count = 1 + (tokenB == address(0) ? 0 : 1) + (tokenC == address(0) ? 0 : 1);
        configs = new FairworkEscrow.TokenConfig[](count);
        configs[0] = _tokenConfig(tokenA);
        if (tokenB != address(0)) configs[1] = _tokenConfig(tokenB);
        if (tokenC != address(0)) configs[count - 1] = _tokenConfig(tokenC);
    }

    function _tokenConfig(address token) internal view returns (FairworkEscrow.TokenConfig memory) {
        return FairworkEscrow.TokenConfig({
            token: token,
            decimals: IERC20Metadata(token).decimals(),
            minAmount: 1,
            maxAmount: MAX_RAW_AMOUNT,
            codehash: bytes32(0)
        });
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
            deliveryRuleCommitment: keccak256("delivery"),
            reviewWindow: reviewWindow,
            revisionLimit: revisionLimit
        });
    }

    function _milestones(uint256 count, uint256 amount, uint64 duration)
        internal
        pure
        returns (FairworkEscrow.MilestoneInput[] memory milestones)
    {
        milestones = new FairworkEscrow.MilestoneInput[](count);
        for (uint256 i; i < count; ++i) {
            milestones[i] = FairworkEscrow.MilestoneInput(amount, duration, COMMITMENT);
        }
    }

    function _create(address token, uint256 count, uint256 amount, uint64 duration)
        internal
        returns (uint256 jobId)
    {
        vm.prank(CLIENT);
        jobId = escrow.createJob(_terms(token, 120, 2), _milestones(count, amount, duration));
    }

    function _accept(uint256 jobId) internal {
        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
    }

    function _fund(uint256 jobId) internal {
        vm.prank(CLIENT);
        escrow.fundJob(jobId);
    }
}

contract Phase1AdditionalTest is Phase1AdditionalFixture {
    function test_F01_AcceptsOneAndTenMilestonesAtTheRawAmountLimits() public {
        uint256 one = _create(address(token6), 1, 1, MAX_DURATION);
        assertEq(escrow.getJob(one).totalAmount, 1, "F-01 minimum raw amount accepted");

        uint256 lockedBefore = escrow.lockedEscrow(address(token8));
        uint256 ten = _create(address(token8), 10, MAX_RAW_AMOUNT, MAX_DURATION);
        FairworkEscrow.JobView memory job = escrow.getJob(ten);
        assertEq(job.milestoneCount, 10, "F-01 maximum milestone count accepted");
        assertEq(job.totalAmount, 10 * MAX_RAW_AMOUNT, "F-01 checked maximum job total");
        assertEq(escrow.getMilestone(ten, 9).amount, MAX_RAW_AMOUNT, "F-01 last milestone keeps raw max");

        _accept(ten);
        _fund(ten);
        assertEq(
            escrow.lockedEscrow(address(token8)),
            lockedBefore + 10 * MAX_RAW_AMOUNT,
            "F-03 maximum total is added exactly to existing seeded liabilities"
        );
        assertEq(escrow.totalClaimable(address(token8)), 0, "F-03 funding is not a production payout");
    }

    function test_F01_RequiresEveryAgreementCommitmentToBeNonzero() public {
        FairworkEscrow.JobInput memory terms = _terms(address(token6), 120, 0);
        FairworkEscrow.MilestoneInput[] memory milestone = _milestones(1, 10, 1);

        terms.titleCommitment = bytes32(0);
        vm.expectRevert(FairworkEscrow.InvalidCommitment.selector);
        vm.prank(CLIENT);
        escrow.createJob(terms, milestone);
        terms = _terms(address(token6), 120, 0);
        terms.descriptionCommitment = bytes32(0);
        vm.expectRevert(FairworkEscrow.InvalidCommitment.selector);
        vm.prank(CLIENT);
        escrow.createJob(terms, milestone);
        terms = _terms(address(token6), 120, 0);
        terms.scopeCommitment = bytes32(0);
        vm.expectRevert(FairworkEscrow.InvalidCommitment.selector);
        vm.prank(CLIENT);
        escrow.createJob(terms, milestone);
        terms = _terms(address(token6), 120, 0);
        terms.deliveryRuleCommitment = bytes32(0);
        vm.expectRevert(FairworkEscrow.InvalidCommitment.selector);
        vm.prank(CLIENT);
        escrow.createJob(terms, milestone);
        milestone[0].acceptanceCriteriaCommitment = bytes32(0);
        vm.expectRevert(FairworkEscrow.InvalidCommitment.selector);
        vm.prank(CLIENT);
        escrow.createJob(_terms(address(token6), 120, 0), milestone);
    }

    function test_F01_ConstructorRejectsInvalidTokenAndProtocolConfiguration() public {
        FairworkEscrow.TokenConfig[] memory validOneToken =
            _configs(address(token6), address(0), address(0));
        FairworkEscrow.TokenConfig[] memory empty = new FairworkEscrow.TokenConfig[](0);
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(empty, _protocolConfig(), TREASURY);

        MockToken extraA = new MockToken("Extra A", "EA", 6);
        MockToken extraB = new MockToken("Extra B", "EB", 6);
        MockToken extraC = new MockToken("Extra C", "EC", 6);
        MockToken extraD = new MockToken("Extra D", "ED", 6);
        FairworkEscrow.TokenConfig[] memory tooMany = new FairworkEscrow.TokenConfig[](4);
        tooMany[0] = _tokenConfig(address(extraA));
        tooMany[1] = _tokenConfig(address(extraB));
        tooMany[2] = _tokenConfig(address(extraC));
        tooMany[3] = _tokenConfig(address(extraD));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(tooMany, _protocolConfig(), TREASURY);

        vm.expectRevert(FairworkEscrow.InvalidAddress.selector);
        new FairworkEscrow(validOneToken, _protocolConfig(), address(0));

        FairworkEscrow.TokenConfig[] memory noCode = new FairworkEscrow.TokenConfig[](1);
        noCode[0] = FairworkEscrow.TokenConfig(address(0xBEEF), 6, 1, MAX_RAW_AMOUNT, bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(noCode, _protocolConfig(), TREASURY);

        FairworkEscrow.TokenConfig[] memory wrongDecimals = new FairworkEscrow.TokenConfig[](1);
        wrongDecimals[0] = FairworkEscrow.TokenConfig(address(token6), 8, 1, MAX_RAW_AMOUNT, bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(wrongDecimals, _protocolConfig(), TREASURY);

        FairworkEscrow.TokenConfig[] memory wrongHash = new FairworkEscrow.TokenConfig[](1);
        wrongHash[0] = FairworkEscrow.TokenConfig(
            address(token6), 6, 1, MAX_RAW_AMOUNT, bytes32(uint256(address(token6).codehash) ^ 1)
        );
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(wrongHash, _protocolConfig(), TREASURY);

        FairworkEscrow.TokenConfig[] memory badLimits = new FairworkEscrow.TokenConfig[](1);
        badLimits[0] = FairworkEscrow.TokenConfig(address(token6), 6, 0, MAX_RAW_AMOUNT, bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(badLimits, _protocolConfig(), TREASURY);
        badLimits[0] = FairworkEscrow.TokenConfig(address(token6), 6, 2, 1, bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(badLimits, _protocolConfig(), TREASURY);
        badLimits[0] = FairworkEscrow.TokenConfig(address(token6), 6, 1, MAX_RAW_AMOUNT + 1, bytes32(0));
        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(badLimits, _protocolConfig(), TREASURY);

        FairworkEscrow.ProtocolConfig memory invalid = _protocolConfig();
        invalid.fundingWindow = 0;
        vm.expectRevert(FairworkEscrow.InvalidWindow.selector);
        new FairworkEscrow(validOneToken, invalid, TREASURY);
        invalid = _protocolConfig();
        invalid.gracePeriod = 0;
        vm.expectRevert(FairworkEscrow.InvalidWindow.selector);
        new FairworkEscrow(validOneToken, invalid, TREASURY);
        invalid = _protocolConfig();
        invalid.maxDuration = 0;
        vm.expectRevert(FairworkEscrow.InvalidDuration.selector);
        new FairworkEscrow(validOneToken, invalid, TREASURY);
        invalid = _protocolConfig();
        invalid.minDuration = 2;
        invalid.maxDuration = 1;
        vm.expectRevert(FairworkEscrow.InvalidDuration.selector);
        new FairworkEscrow(validOneToken, invalid, TREASURY);
        invalid = _protocolConfig();
        invalid.maxReviewWindow = 0;
        vm.expectRevert(FairworkEscrow.InvalidWindow.selector);
        new FairworkEscrow(validOneToken, invalid, TREASURY);
        invalid = _protocolConfig();
        invalid.maxReviewWindow = 365 days + 1;
        vm.expectRevert(FairworkEscrow.InvalidWindow.selector);
        new FairworkEscrow(validOneToken, invalid, TREASURY);
    }

    function test_A18_F03_RuntimeCodehashDriftBlocksFundingWithoutChangingLiabilities() public {
        uint256 lockedBefore = escrow.lockedEscrow(address(token6));
        uint256 jobId = _create(address(token6), 1, 200_000, 20);
        _accept(jobId);
        bytes32 expectedHash = escrow.tokenConfig(address(token6)).codehash;
        vm.etch(address(token6), hex"60006000fd");
        assertTrue(address(token6).codehash != expectedHash, "A-18 test token code changed");

        vm.expectRevert(abi.encodeWithSelector(FairworkEscrow.TokenCodeChanged.selector, address(token6)));
        vm.prank(CLIENT);
        escrow.fundJob(jobId);

        assertEq(uint256(escrow.getJob(jobId).state), 1, "A-18 code drift leaves job unfunded");
        assertEq(
            escrow.lockedEscrow(address(token6)),
            lockedBefore,
            "A-18 code drift creates no additional liability"
        );
        assertEq(escrow.totalClaimable(address(token6)), 0, "A-18 code drift creates no claim");
    }

    function test_A18_F03_RuntimeCodehashDriftBlocksWithdrawalAndPreservesBackedClaim() public {
        AdditionalCreditHarness creditEscrow = new AdditionalCreditHarness(
            _configs(address(token6), address(0), address(0)), _protocolConfig(), TREASURY
        );
        uint256 amount = 55_019;
        vm.prank(CLIENT);
        token6.approve(address(creditEscrow), type(uint256).max);
        vm.prank(CLIENT);
        uint256 jobId = creditEscrow.createJob(
            _terms(address(token6), 120, 2), _milestones(1, amount, 20)
        );
        vm.prank(FREELANCER);
        creditEscrow.acceptJob(jobId);
        vm.prank(CLIENT);
        creditEscrow.fundJob(jobId);
        creditEscrow.seedBackedClaim(address(token6), FREELANCER, amount);

        uint256 escrowBefore = token6.balanceOf(address(creditEscrow));
        uint256 recipientBefore = token6.balanceOf(FREELANCER);
        AdditionalCodeChangedMockToken changedCode = new AdditionalCodeChangedMockToken();
        vm.etch(address(token6), address(changedCode).code);
        assertTrue(
            address(token6).codehash != creditEscrow.tokenConfig(address(token6)).codehash,
            "A-18 changed token runtime differs from pinned hash"
        );

        vm.expectRevert(
            abi.encodeWithSelector(FairworkEscrow.TokenCodeChanged.selector, address(token6))
        );
        vm.prank(FREELANCER);
        creditEscrow.withdraw(address(token6));

        assertEq(token6.balanceOf(address(creditEscrow)), escrowBefore, "A-18 drifted token moved no escrow balance");
        assertEq(token6.balanceOf(FREELANCER), recipientBefore, "A-18 drifted token moved no recipient balance");
        assertEq(creditEscrow.claimable(address(token6), FREELANCER), amount, "A-18 failed withdrawal preserves claim");
        assertEq(creditEscrow.totalClaimable(address(token6)), amount, "A-18 failed withdrawal preserves liability");
        assertEq(creditEscrow.lockedEscrow(address(token6)), 0, "A-18 claim remains separate from locked principal");
    }

    function test_F03_DeadlineAdditionRejectsUint64Overflow() public {
        uint256 maxTimestamp = type(uint64).max;
        uint256 jobsBefore = escrow.jobCount();
        vm.warp(maxTimestamp - uint256(FUNDING_WINDOW) + 1);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        _create(address(token6), 1, 10, 1);
        assertEq(escrow.jobCount(), jobsBefore, "F-03 overflowing proposal deadline creates no job");

        vm.warp(maxTimestamp - uint256(FUNDING_WINDOW));
        uint256 proposalEndAtMax = _create(address(token6), 1, 10, 1);
        vm.warp(maxTimestamp - 1);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        _accept(proposalEndAtMax);
        assertEq(
            uint256(escrow.getJob(proposalEndAtMax).state),
            0,
            "F-03 overflowing funding deadline leaves proposal unaccepted"
        );

        vm.warp(maxTimestamp + 1);
        vm.expectRevert(FairworkEscrow.InvalidWindow.selector);
        _create(address(token6), 1, 10, 1);
    }

    function test_A18_F03_DeployerAndTreasuryCannotWithdrawLockedPrincipal() public {
        uint256 lockedBefore = escrow.lockedEscrow(address(token8));
        uint256 jobId = _create(address(token8), 1, 400_000, 20);
        _accept(jobId);
        _fund(jobId);

        vm.expectRevert(FairworkEscrow.InvalidAmount.selector);
        vm.prank(address(this));
        escrow.withdraw(address(token8));
        vm.expectRevert(FairworkEscrow.InvalidAmount.selector);
        vm.prank(TREASURY);
        escrow.withdraw(address(token8));

        assertEq(
            escrow.lockedEscrow(address(token8)),
            lockedBefore + 400_000,
            "A-18 locked principal remains in escrow"
        );
        assertEq(escrow.claimable(address(token8), address(this)), 0, "A-18 deployer has no principal claim");
        assertEq(escrow.claimable(address(token8), TREASURY), 0, "A-18 treasury has no principal claim");
    }

    function test_A01_F85_TimeoutsAreClosedOnlyAtAndAfterEachEnd() public {
        uint256 proposalAccepts = _create(address(token6), 1, 10, 10);
        uint64 proposalEnd = escrow.getJob(proposalAccepts).proposalEnd;
        vm.warp(proposalEnd - 1);
        vm.expectRevert(FairworkEscrow.WindowOpen.selector);
        vm.prank(OTHER);
        escrow.cancelExpiredProposal(proposalAccepts);
        vm.prank(FREELANCER);
        escrow.acceptJob(proposalAccepts);

        uint256 proposalAt = _create(address(token6), 1, 10, 10);
        uint64 proposalAtEnd = escrow.getJob(proposalAt).proposalEnd;
        vm.warp(proposalAtEnd);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        vm.prank(FREELANCER);
        escrow.acceptJob(proposalAt);
        vm.prank(OTHER);
        escrow.cancelExpiredProposal(proposalAt);

        uint256 proposalAfter = _create(address(token6), 1, 10, 10);
        uint64 proposalAfterEnd = escrow.getJob(proposalAfter).proposalEnd;
        vm.warp(proposalAfterEnd + 1);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        vm.prank(FREELANCER);
        escrow.acceptJob(proposalAfter);
        vm.prank(OTHER);
        escrow.cancelExpiredProposal(proposalAfter);

        uint256 fundBefore = _create(address(token8), 1, 20, 10);
        _accept(fundBefore);
        uint64 fundingEnd = escrow.getJob(fundBefore).fundingDeadline;
        vm.warp(fundingEnd - 1);
        vm.expectRevert(FairworkEscrow.WindowOpen.selector);
        vm.prank(OTHER);
        escrow.cancelUnfundedJob(fundBefore);
        _fund(fundBefore);

        uint256 fundAt = _create(address(token8), 1, 20, 10);
        _accept(fundAt);
        uint64 fundingAtEnd = escrow.getJob(fundAt).fundingDeadline;
        vm.warp(fundingAtEnd);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        vm.prank(CLIENT);
        escrow.fundJob(fundAt);
        vm.prank(OTHER);
        escrow.cancelUnfundedJob(fundAt);

        uint256 fundAfter = _create(address(token8), 1, 20, 10);
        _accept(fundAfter);
        uint64 fundingAfterEnd = escrow.getJob(fundAfter).fundingDeadline;
        vm.warp(fundingAfterEnd + 1);
        vm.expectRevert(FairworkEscrow.WindowClosed.selector);
        vm.prank(CLIENT);
        escrow.fundJob(fundAfter);
        vm.prank(OTHER);
        escrow.cancelUnfundedJob(fundAfter);
    }

    function test_F03_DonationsStaySurplusAndEmptyWithdrawalsCannotTouchFundedPrincipal() public {
        uint256 jobId = _create(address(token18), 1, 600_000, 20);
        _accept(jobId);
        _fund(jobId);
        uint256 lockedBefore = escrow.lockedEscrow(address(token18));
        uint256 surplus = 123_457;
        token18.mint(address(this), surplus);
        token18.transfer(address(escrow), surplus);

        vm.expectRevert(FairworkEscrow.InvalidAmount.selector);
        vm.prank(OTHER);
        escrow.withdraw(address(token18));

        assertEq(escrow.lockedEscrow(address(token18)), lockedBefore, "F-03 donation does not alter principal ledger");
        assertEq(escrow.totalClaimable(address(token18)), 0, "F-03 no settlement endpoint exists in Phase 1");
        assertEq(escrow.claimable(address(token18), FREELANCER), 0, "F-03 freelancer has no premature claim");
        assertEq(token18.balanceOf(address(escrow)), lockedBefore + surplus, "F-03 donation is unassigned surplus");
    }

    function test_Stateful_F03_SeededAndRandomLedgerPathsAreNonVacuous() public {
        assertEq(handler.seededFundedCount(), 3, "F-03 starts with one backed funded job per token");
        uint256 previousRandomFunds = handler.randomFundedCount();

        handler.step(1, 404_041, 77, 19);

        assertEq(handler.randomFundedCount(), previousRandomFunds + 1, "F-03 one randomized funded path succeeded");
        assertGt(handler.invalidMutationReverts(), 0, "F-03 invalid transition was exercised");
        assertGt(handler.earlyProposalCancelReverts(), 0, "A-01 early proposal timeout was rejected");
        assertGt(handler.earlyFundingCancelReverts(), 0, "F-85 early funding timeout was rejected");
        assertGt(handler.proposalExpiryCount(), 0, "A-01 proposal expiry was exercised");
        assertGt(handler.unfundedExpiryCount(), 0, "F-85 unfunded expiry was exercised");
        assertGt(handler.donationCount(), 0, "F-03 surplus donation was exercised");
        assertGt(handler.emptyWithdrawalReverts(), 0, "F-03 empty withdrawal was rejected");
        _assertLedgerInvariants();
    }

    function _assertLedgerInvariants() internal view {
        address[3] memory tokens = [address(token6), address(token8), address(token18)];
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            assertEq(escrow.lockedEscrow(token), handler.expectedLocked(token), "F-03 locked ledger equals funded-job sum");
            assertGe(
                IERC20(token).balanceOf(address(escrow)),
                escrow.lockedEscrow(token) + escrow.totalClaimable(token),
                "F-03 per-token balance covers liabilities"
            );
            assertEq(escrow.totalClaimable(token), 0, "F-03 funding does not create claimable balances");
        }
    }
}

contract Phase1AdditionalInvariantTest is Phase1AdditionalFixture {
    function setUp() public override {
        super.setUp();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = AdditionalLedgerHandler.step.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        // Foundry checks the invariant before starting its randomized calls; seed one full stateful
        // path here so its non-vacuity counters are meaningful from the first assertion onward.
        handler.step(1, 404_041, 77, 19);
    }

    function invariant_F03_LedgerMatchesSeededAndRandomFundedPrincipal() public view {
        assertEq(handler.seededFundedCount(), 3, "F-03 three decimal tokens are preseeded with real funding");
        assertGt(handler.randomFundedCount(), 0, "F-03 randomized funded transition is nonvacuous");
        assertGt(handler.invalidMutationReverts(), 0, "F-03 invalid transition reverts are observed");
        assertGt(handler.earlyProposalCancelReverts(), 0, "A-01 early proposal timeout reverts are observed");
        assertGt(handler.earlyFundingCancelReverts(), 0, "F-85 early funding timeout reverts are observed");
        assertGt(handler.proposalExpiryCount(), 0, "A-01 proposal timeouts are exercised");
        assertGt(handler.unfundedExpiryCount(), 0, "F-85 funding timeouts are exercised");
        assertGt(handler.donationCount(), 0, "F-03 direct surplus is exercised");
        assertGt(handler.emptyWithdrawalReverts(), 0, "F-03 empty withdrawals are exercised");

        address[3] memory tokens = [address(token6), address(token8), address(token18)];
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            assertEq(escrow.lockedEscrow(token), handler.expectedLocked(token), "F-03 liability equals independent funded sum");
            assertGe(
                IERC20(token).balanceOf(address(escrow)),
                escrow.lockedEscrow(token) + escrow.totalClaimable(token),
                "F-03 token balance covers liabilities independently per token"
            );
            assertEq(escrow.totalClaimable(token), 0, "Phase 1 has no production credit path");
        }
    }
}
