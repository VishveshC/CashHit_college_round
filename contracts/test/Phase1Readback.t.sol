// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {MockToken} from "./support/MockTokens.sol";

/// @dev Metadata endpoint deliberately reverts so constructor try/catch validation is exercised.
contract RevertingDecimalsToken {
    function decimals() external pure returns (uint8) {
        revert("metadata unavailable");
    }
}

contract Phase1ReadbackTest is Test {
    address private constant CLIENT = address(0xC11E);
    address private constant FREELANCER = address(0xFEE);
    address private constant TREASURY = address(0x7EA5);

    uint64 private constant FUNDING_WINDOW = 3 days;
    uint64 private constant GRACE_PERIOD = 5 days;
    uint64 private constant MIN_DURATION = 1;
    uint64 private constant MAX_DURATION = 365 days;
    uint64 private constant MIN_REVIEW_WINDOW = 1;
    uint64 private constant MAX_REVIEW_WINDOW = 30 days;

    bytes32 private constant TITLE = keccak256("readback title");
    bytes32 private constant DESCRIPTION = keccak256("readback description");
    bytes32 private constant SCOPE = keccak256("readback scope");
    bytes32 private constant DELIVERY_RULE = keccak256("readback delivery rule");
    bytes32 private constant CRITERIA_FIRST = keccak256("first acceptance criteria");
    bytes32 private constant CRITERIA_SECOND = keccak256("second acceptance criteria");

    MockToken private token;
    FairworkEscrow private escrow;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_800_000_000);

        token = new MockToken("Readback Token", "READ", 6);
        FairworkEscrow.TokenConfig[] memory tokenConfigs = new FairworkEscrow.TokenConfig[](1);
        tokenConfigs[0] = FairworkEscrow.TokenConfig({
            token: address(token),
            decimals: 6,
            minAmount: 1,
            maxAmount: 1e18,
            codehash: bytes32(0)
        });
        escrow = new FairworkEscrow(tokenConfigs, _protocolConfig(), TREASURY);

        token.mint(CLIENT, 1_000_000);
        vm.prank(CLIENT);
        token.approve(address(escrow), type(uint256).max);
    }

    function test_A17_ReadbackPreservesTermsAndProtocolConfigAcrossLifecycle() public {
        FairworkEscrow.JobInput memory terms = FairworkEscrow.JobInput({
            freelancer: FREELANCER,
            token: address(token),
            titleCommitment: TITLE,
            descriptionCommitment: DESCRIPTION,
            scopeCommitment: SCOPE,
            deliveryRuleCommitment: DELIVERY_RULE,
            reviewWindow: 2 days,
            revisionLimit: 3
        });
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](2);
        milestones[0] = FairworkEscrow.MilestoneInput(123_457, 7 days, CRITERIA_FIRST);
        milestones[1] = FairworkEscrow.MilestoneInput(789_011, 11 days, CRITERIA_SECOND);

        vm.prank(CLIENT);
        uint256 jobId = escrow.createJob(terms, milestones);
        uint256 total = 123_457 + 789_011;

        _assertProtocolConfig();
        _assertAgreementReadback(jobId, total, 0);

        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
        _assertProtocolConfig();
        _assertAgreementReadback(jobId, total, 0);

        vm.prank(CLIENT);
        escrow.fundJob(jobId);
        _assertProtocolConfig();
        _assertAgreementReadback(jobId, total, escrow.getJob(jobId).fundedAt);
    }

    function test_A17_UnknownJobReadbackGettersRejectRatherThanReturnDefaults() public {
        uint256 unknownJobId = escrow.jobCount() + 17;

        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        escrow.getJobCommitments(unknownJobId);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        escrow.getMilestone(unknownJobId, 0);
        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        escrow.getJob(unknownJobId);

        vm.expectRevert(FairworkEscrow.InvalidState.selector);
        escrow.getMilestone(unknownJobId, 1);
    }

    function test_A17_ConstructorRejectsRevertingDecimalsMetadata() public {
        RevertingDecimalsToken brokenMetadata = new RevertingDecimalsToken();
        FairworkEscrow.TokenConfig[] memory tokenConfigs = new FairworkEscrow.TokenConfig[](1);
        tokenConfigs[0] = FairworkEscrow.TokenConfig({
            token: address(brokenMetadata),
            decimals: 6,
            minAmount: 1,
            maxAmount: 1e18,
            codehash: bytes32(0)
        });

        vm.expectRevert(FairworkEscrow.InvalidTokenConfig.selector);
        new FairworkEscrow(tokenConfigs, _protocolConfig(), TREASURY);
    }

    function _assertAgreementReadback(uint256 jobId, uint256 total, uint64 fundedAt) private view {
        FairworkEscrow.JobView memory job = escrow.getJob(jobId);
        assertEq(job.client, CLIENT, "A-17 readback client is the proposal author");
        assertEq(job.freelancer, FREELANCER, "A-17 readback names the accepted freelancer");
        assertEq(job.token, address(token), "D-06 readback preserves the selected token address");
        assertEq(job.totalAmount, total, "F-01 readback preserves the checked milestone sum");
        assertEq(job.reviewWindow, 2 days, "A-17 readback preserves review window");
        assertEq(job.revisionLimit, 3, "A-17 readback preserves revision limit");
        assertEq(job.milestoneCount, 2, "F-01 readback preserves milestone count");

        (bytes32 title, bytes32 description, bytes32 scope, bytes32 deliveryRule) =
            escrow.getJobCommitments(jobId);
        assertEq(title, TITLE, "A-17 title commitment remains unchanged");
        assertEq(description, DESCRIPTION, "A-17 description commitment remains unchanged");
        assertEq(scope, SCOPE, "A-17 scope commitment remains unchanged");
        assertEq(deliveryRule, DELIVERY_RULE, "A-17 delivery rule commitment remains unchanged");

        FairworkEscrow.MilestoneView memory first = escrow.getMilestone(jobId, 0);
        assertEq(first.amount, 123_457, "F-01 first raw amount remains unchanged");
        assertEq(first.duration, 7 days, "F-01 first duration remains unchanged");
        assertEq(first.acceptanceCriteriaCommitment, CRITERIA_FIRST, "A-17 first criteria hash remains unchanged");
        FairworkEscrow.MilestoneView memory second = escrow.getMilestone(jobId, 1);
        assertEq(second.amount, 789_011, "F-01 second raw amount remains unchanged");
        assertEq(second.duration, 11 days, "F-01 second duration remains unchanged");
        assertEq(second.acceptanceCriteriaCommitment, CRITERIA_SECOND, "A-17 second criteria hash remains unchanged");

        if (fundedAt == 0) {
            assertEq(first.deadline, 0, "F-03 first delivery clock stays unset before funding");
            assertEq(first.graceEnd, 0, "F-03 first grace end stays unset before funding");
            assertEq(second.deadline, 0, "F-03 second delivery clock stays unset before funding");
            assertEq(second.graceEnd, 0, "F-03 second grace end stays unset before funding");
        } else {
            assertEq(first.deadline, fundedAt + 7 days, "D-01 first deadline is derived from funding");
            assertEq(first.graceEnd, first.deadline + GRACE_PERIOD, "D-01 first grace end follows its deadline");
            assertEq(second.deadline, fundedAt + 11 days, "D-01 second deadline is derived from funding");
            assertEq(second.graceEnd, second.deadline + GRACE_PERIOD, "D-01 second grace end follows its deadline");
        }
    }

    function _assertProtocolConfig() private view {
        FairworkEscrow.ProtocolConfig memory config = escrow.protocolConfig();
        assertEq(config.fundingWindow, FUNDING_WINDOW, "A-17 funding window readback");
        assertEq(config.gracePeriod, GRACE_PERIOD, "A-17 grace period readback");
        assertEq(config.minDuration, MIN_DURATION, "A-17 minimum duration readback");
        assertEq(config.maxDuration, MAX_DURATION, "A-17 maximum duration readback");
        assertEq(config.minReviewWindow, MIN_REVIEW_WINDOW, "A-17 minimum review window readback");
        assertEq(config.maxReviewWindow, MAX_REVIEW_WINDOW, "A-17 maximum review window readback");
    }

    function _protocolConfig() private pure returns (FairworkEscrow.ProtocolConfig memory) {
        return FairworkEscrow.ProtocolConfig({
            fundingWindow: FUNDING_WINDOW,
            gracePeriod: GRACE_PERIOD,
            minDuration: MIN_DURATION,
            maxDuration: MAX_DURATION,
            minReviewWindow: MIN_REVIEW_WINDOW,
            maxReviewWindow: MAX_REVIEW_WINDOW
        });
    }
}
