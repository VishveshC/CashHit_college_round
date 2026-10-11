// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ReentrantToken, MockToken} from "./support/MockTokens.sol";
import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {IPhase2Read, IPhase3Escrow, Phase3TestBase} from "./support/Phase3TestSupport.sol";

contract Phase3AccountingTest is Phase3TestBase {
    function test_F34_ThreeVotesUseMedianAndTwoVotesUseFlooredMean() public {
        _registerMany(6);
        (, uint256 medianDispute) = _openSubmitted(10_003, 0);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(medianDispute);
        uint256 clientBefore = p3.claimable(address(token), CLIENT);
        uint256 freelancerBefore = p3.claimable(address(token), FREELANCER);
        uint256 treasuryBefore = p3.claimable(address(token), TREASURY);
        uint16[3] memory medianVotes = [uint16(9_000), uint16(1_000), uint16(5_000)];
        _rulePanel1(medianDispute, medianVotes, 3);

        IPhase3Escrow.DisputeView memory median = p3.getDispute(medianDispute);
        assertEq(median.rulingBps, 5_000, "three votes settle to the median");
        assertFalse(median.fallbackApplied, "a normal 5000 ruling is not fallback");
        assertEq(p3.claimable(address(token), FREELANCER) - freelancerBefore, 5_101);
        assertEq(p3.claimable(address(token), CLIENT) - clientBefore, 5_102);
        assertEq(p3.claimable(address(token), TREASURY) - treasuryBefore, 200);
        assertEq(p3.disputeDeposits(address(token)), 0, "deposits leave the liability bucket exactly once");

        (, uint256 meanDispute) = _openSubmitted(10_005, 0);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(meanDispute);
        clientBefore = p3.claimable(address(token), CLIENT);
        freelancerBefore = p3.claimable(address(token), FREELANCER);
        treasuryBefore = p3.claimable(address(token), TREASURY);
        uint16[3] memory meanVotes = [uint16(5_001), uint16(5_002), uint16(9_000)];
        _rulePanel1(meanDispute, meanVotes, 2);

        IPhase3Escrow.DisputeView memory mean = p3.getDispute(meanDispute);
        assertEq(mean.rulingBps, 5_001, "two votes use the floored arithmetic mean");
        assertFalse(mean.fallbackApplied);
        assertEq(p3.claimable(address(token), FREELANCER) - freelancerBefore, 5_203);
        assertEq(p3.claimable(address(token), CLIENT) - clientBefore, 5_002);
        assertEq(p3.claimable(address(token), TREASURY) - treasuryBefore, 200);
        assertEq(p3.disputeDeposits(address(token)), 0);
        assertEq(p3.lockedEscrow(address(token)), 0, "both rulings release all principal");
    }

    function test_F34_NormalFiftyFiftyForfeitsFloorPerPartyForDepositOneAndThree() public {
        _registerMany(6);
        (, uint256 oneUnitDispute) = _openSubmitted(49, 0);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(oneUnitDispute);
        uint16[3] memory evenVotes = [uint16(5_000), uint16(5_000), uint16(5_000)];
        uint256 clientBefore = p3.claimable(address(token), CLIENT);
        uint256 freelancerBefore = p3.claimable(address(token), FREELANCER);
        uint256 treasuryBefore = p3.claimable(address(token), TREASURY);
        _rulePanel1(oneUnitDispute, evenVotes, 3);
        assertEq(p3.getDispute(oneUnitDispute).rulingBps, 5_000);
        assertFalse(p3.getDispute(oneUnitDispute).fallbackApplied);
        assertEq(p3.claimable(address(token), CLIENT) - clientBefore, 26, "D=1 has zero half-deposit forfeiture");
        assertEq(p3.claimable(address(token), FREELANCER) - freelancerBefore, 25);
        assertEq(p3.claimable(address(token), TREASURY) - treasuryBefore, 0);

        (, uint256 threeUnitDispute) = _openSubmitted(151, 0);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(threeUnitDispute);
        clientBefore = p3.claimable(address(token), CLIENT);
        freelancerBefore = p3.claimable(address(token), FREELANCER);
        treasuryBefore = p3.claimable(address(token), TREASURY);
        _rulePanel1(threeUnitDispute, evenVotes, 3);
        assertFalse(p3.getDispute(threeUnitDispute).fallbackApplied, "the same 5000 result has quorum");
        assertEq(p3.claimable(address(token), CLIENT) - clientBefore, 78);
        assertEq(p3.claimable(address(token), FREELANCER) - freelancerBefore, 77);
        assertEq(p3.claimable(address(token), TREASURY) - treasuryBefore, 2, "each side forfeits floor(3/2)");
        assertEq(p3.disputeDeposits(address(token)), 0);
    }

    function test_F34_BelowHalfRulingForfeitsFreelancerDepositWhenBothPartiesPost() public {
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(1_001, 0);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(disputeId);
        uint16[3] memory votes = [uint16(3_000), uint16(3_000), uint16(3_000)];
        _rulePanel1(disputeId, votes, 3);
        assertEq(p3.getDispute(disputeId).rulingBps, 3_000);
        assertFalse(p3.getDispute(disputeId).fallbackApplied);
        assertEq(p3.claimable(address(token), FREELANCER), 300, "freelancer principal remains, posted deposit is forfeited");
        assertEq(p3.claimable(address(token), CLIENT), 721, "client receives principal and returned posted deposit");
        assertEq(p3.claimable(address(token), TREASURY), 20);
    }

    function test_F34_MissingLoserDepositIsDeductedExactlyAndCappedAtPrincipal() public {
        _registerMany(6);
        (, uint256 freelancerLoser) = _openSubmitted(10_000, 0);
        uint16[3] memory lowVotes = [uint16(2_500), uint16(2_500), uint16(2_500)];
        uint256 clientBefore = p3.claimable(address(token), CLIENT);
        uint256 freelancerBefore = p3.claimable(address(token), FREELANCER);
        uint256 treasuryBefore = p3.claimable(address(token), TREASURY);
        _rulePanel1(freelancerLoser, lowVotes, 3);
        assertEq(p3.claimable(address(token), FREELANCER) - freelancerBefore, 2_300, "unposted freelancer loss is deducted");
        assertEq(p3.claimable(address(token), CLIENT) - clientBefore, 7_700, "client receives principal and own refund");
        assertEq(p3.claimable(address(token), TREASURY) - treasuryBefore, 200);

        (, uint256 clientLoser) = _openRejected(10_000, FREELANCER);
        uint16[3] memory highVotes = [uint16(7_500), uint16(7_500), uint16(7_500)];
        clientBefore = p3.claimable(address(token), CLIENT);
        freelancerBefore = p3.claimable(address(token), FREELANCER);
        treasuryBefore = p3.claimable(address(token), TREASURY);
        _rulePanel1(clientLoser, highVotes, 3);
        assertEq(p3.claimable(address(token), CLIENT) - clientBefore, 2_300, "unposted client loss is deducted");
        assertEq(p3.claimable(address(token), FREELANCER) - freelancerBefore, 7_700, "freelancer receives principal and own refund");
        assertEq(p3.claimable(address(token), TREASURY) - treasuryBefore, 200);

        (, uint256 zeroPayoutLoser) = _openSubmitted(49, 0);
        uint256 beforeClient = p3.claimable(address(token), CLIENT);
        uint256 beforeFreelancer = p3.claimable(address(token), FREELANCER);
        uint256 beforeTreasury = p3.claimable(address(token), TREASURY);
        uint16[3] memory zeroVotes = [uint16(0), uint16(0), uint16(0)];
        _rulePanel1(zeroPayoutLoser, zeroVotes, 3);
        assertEq(p3.claimable(address(token), FREELANCER) - beforeFreelancer, 0, "deduction cannot exceed zero principal payout");
        assertEq(p3.claimable(address(token), TREASURY) - beforeTreasury, 0, "capped deduction cannot mint forfeiture");
        assertEq(p3.claimable(address(token), CLIENT) - beforeClient, 50, "all principal and opener deposit are preserved");

        (, uint256 partialCap) = _openSubmitted(101, 0);
        beforeClient = p3.claimable(address(token), CLIENT);
        beforeFreelancer = p3.claimable(address(token), FREELANCER);
        beforeTreasury = p3.claimable(address(token), TREASURY);
        uint16[3] memory oneBpsVotes = [uint16(100), uint16(100), uint16(100)];
        _rulePanel1(partialCap, oneBpsVotes, 3);
        assertEq(p3.claimable(address(token), FREELANCER) - beforeFreelancer, 0, "D=2 is capped by one raw unit of loser principal");
        assertEq(p3.claimable(address(token), CLIENT) - beforeClient, 102);
        assertEq(p3.claimable(address(token), TREASURY) - beforeTreasury, 1, "only the available loser principal is forfeited");
    }

    function test_F34_ZeroAndFullVoteEndpointsSettleAndTerminalAdvanceCannotRepeat() public {
        _registerMany(6);
        (, uint256 zeroDispute) = _openSubmitted(1_001, 0);
        uint16[3] memory zeroVotes = [uint16(0), uint16(0), uint16(0)];
        _rulePanel1(zeroDispute, zeroVotes, 3);
        assertEq(p3.getDispute(zeroDispute).rulingBps, 0);
        assertFalse(p3.getDispute(zeroDispute).fallbackApplied);
        assertEq(p3.claimable(address(token), FREELANCER), 0);
        assertEq(p3.claimable(address(token), CLIENT), 1_021, "missing loser deposit is capped at zero principal");
        assertEq(p3.claimable(address(token), TREASURY), 0);
        vm.expectRevert(IPhase3Escrow.InvalidState.selector);
        p3.advanceDispute(zeroDispute);
        assertEq(p3.claimable(address(token), CLIENT), 1_021, "terminal advance cannot duplicate settlement credits");

        uint256 clientBefore = p3.claimable(address(token), CLIENT);
        (, uint256 fullDispute) = _openSubmitted(1_001, 0);
        uint16[3] memory fullVotes = [uint16(10_000), uint16(10_000), uint16(10_000)];
        _rulePanel1(fullDispute, fullVotes, 3);
        assertEq(p3.getDispute(fullDispute).rulingBps, 10_000);
        assertFalse(p3.getDispute(fullDispute).fallbackApplied);
        assertEq(p3.claimable(address(token), FREELANCER), 1_001, "full vote transfers all principal to freelancer");
        assertEq(p3.claimable(address(token), CLIENT) - clientBefore, 0, "client receives no principal and forfeits its posted deposit");
        assertEq(p3.claimable(address(token), TREASURY), 20, "client's posted losing deposit is forfeited");
    }

    function test_F34_TreasuryAliasPartyReceivesAdditiveCredits() public {
        FairworkEscrow aliasEscrow = _deployForTreasury(CLIENT);
        escrow = aliasEscrow;
        p3 = IPhase3Escrow(address(aliasEscrow));
        vm.prank(CLIENT);
        token.approve(address(aliasEscrow), type(uint256).max);
        vm.prank(FREELANCER);
        token.approve(address(aliasEscrow), type(uint256).max);
        _registerMany(6);
        (, uint256 disputeId) = _openSubmitted(10_000, 0);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(disputeId);
        uint16[3] memory votes = [uint16(7_500), uint16(7_500), uint16(7_500)];
        _rulePanel1(disputeId, votes, 3);

        assertEq(aliasEscrow.treasury(), CLIENT);
        assertEq(p3.claimable(address(token), CLIENT), 2_700, "party principal and treasury forfeiture add together");
        assertEq(p3.claimable(address(token), FREELANCER), 7_700, "other posted deposit is refunded");
        assertEq(p3.totalClaimable(address(token)), 10_400, "aliasing preserves aggregate liabilities");
        assertEq(p3.disputeDeposits(address(token)), 0);
    }

    function test_F34_OddRawUnitSplitsFuzzAcrossSixEightAndEighteenDecimals(
        uint64 amountSeed,
        uint16 bpsSeed
    ) public {
        MockToken token8 = new MockToken("8 decimal", "T8", 8);
        MockToken token18 = new MockToken("18 decimal", "T18", 18);
        FairworkEscrow.TokenConfig[] memory tokenConfigs = new FairworkEscrow.TokenConfig[](3);
        tokenConfigs[0] = FairworkEscrow.TokenConfig(address(token), 6, 1, 1e18, bytes32(0));
        tokenConfigs[1] = FairworkEscrow.TokenConfig(address(token8), 8, 1, 1e18, bytes32(0));
        tokenConfigs[2] = FairworkEscrow.TokenConfig(address(token18), 18, 1, 1e18, bytes32(0));
        FairworkEscrow multiTokenEscrow = new FairworkEscrow(tokenConfigs, escrow.protocolConfig(), TREASURY);
        escrow = multiTokenEscrow;
        p3 = IPhase3Escrow(address(multiTokenEscrow));
        MockToken[3] memory testedTokens = [token, token8, token18];
        _registerMany(6);

        uint256 amount = 100_001 + uint256(amountSeed) % 100_000_000;
        if (amount % 2 == 0) ++amount;
        uint16 rulingBps = uint16(uint256(bpsSeed) % 10_001);

        for (uint256 i; i < testedTokens.length; ++i) {
            _exerciseRawSplit(testedTokens[i], amount, rulingBps, multiTokenEscrow);
        }
    }

    function _exerciseRawSplit(MockToken currentToken, uint256 amount, uint16 rulingBps, FairworkEscrow targetEscrow)
        private
    {
        token = currentToken;
        currentToken.mint(CLIENT, 1e18);
        currentToken.mint(FREELANCER, 1e18);
        vm.prank(CLIENT);
        currentToken.approve(address(targetEscrow), type(uint256).max);
        vm.prank(FREELANCER);
        currentToken.approve(address(targetEscrow), type(uint256).max);
        uint256 jobId = _fundedJob(amount, 0);
        _submit(jobId);
        assertEq(currentToken.balanceOf(address(targetEscrow)), targetEscrow.lockedEscrow(address(currentToken)));
        vm.prank(CLIENT);
        uint256 disputeId = p3.openDispute(jobId, 0);
        uint256 deposit = amount * 200 / 10_000;
        assertEq(currentToken.balanceOf(address(targetEscrow)), amount + deposit);
        assertEq(p3.disputeDeposits(address(currentToken)), deposit);
        vm.prank(FREELANCER);
        p3.matchDisputeDeposit(disputeId);
        assertEq(currentToken.balanceOf(address(targetEscrow)), amount + 2 * deposit);
        assertEq(
            currentToken.balanceOf(address(targetEscrow)),
            targetEscrow.lockedEscrow(address(currentToken)) + p3.disputeDeposits(address(currentToken)),
            "funded principal and posted deposits exactly cover escrow tokens"
        );

        uint16[3] memory votes = [rulingBps, rulingBps, rulingBps];
        _rulePanel1(disputeId, votes, 3);
        uint256 freelancerPrincipal = amount * rulingBps / 10_000;
        uint256 clientPrincipal = amount - freelancerPrincipal;
        uint256 clientForfeit;
        uint256 freelancerForfeit;
        if (rulingBps > 5_000) clientForfeit = deposit;
        else if (rulingBps < 5_000) freelancerForfeit = deposit;
        else {
            clientForfeit = deposit / 2;
            freelancerForfeit = deposit / 2;
        }
        assertEq(
            p3.claimable(address(currentToken), CLIENT),
            clientPrincipal + deposit - clientForfeit,
            "raw-unit client split is exact"
        );
        assertEq(
            p3.claimable(address(currentToken), FREELANCER),
            freelancerPrincipal + deposit - freelancerForfeit,
            "raw-unit freelancer split is exact"
        );
        assertEq(p3.claimable(address(currentToken), TREASURY), clientForfeit + freelancerForfeit);
        assertEq(p3.lockedEscrow(address(currentToken)), 0);
        assertEq(p3.disputeDeposits(address(currentToken)), 0);
        assertEq(p3.arbiterStakes(address(currentToken)), 0, "P0 creates no arbiter stake liability");
        assertEq(p3.totalClaimable(address(currentToken)), amount + 2 * deposit);
        assertEq(currentToken.balanceOf(address(targetEscrow)), p3.totalClaimable(address(currentToken)));
    }

    function test_F34_DisputeOnOneMilestoneDoesNotBlockAnotherMilestoneSettlement() public {
        _registerMany(6);
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](2);
        milestones[0] = FairworkEscrow.MilestoneInput(5_000, 10, keccak256("first"));
        milestones[1] = FairworkEscrow.MilestoneInput(6_000, 10, keccak256("second"));
        FairworkEscrow.JobInput memory terms = _jobTerms(address(token), FREELANCER, 0);
        vm.prank(CLIENT);
        uint256 jobId = escrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        escrow.acceptJob(jobId);
        vm.prank(CLIENT);
        escrow.fundJob(jobId);
        vm.prank(FREELANCER);
        IPhase2Read(address(escrow)).submitMilestone(jobId, 0, keccak256("first delivery"), bytes32(0));
        vm.prank(FREELANCER);
        IPhase2Read(address(escrow)).submitMilestone(jobId, 1, keccak256("second delivery"), bytes32(0));
        vm.prank(CLIENT);
        uint256 disputeId = p3.openDispute(jobId, 0);
        vm.prank(CLIENT);
        escrow.approveMilestone(jobId, 1);

        assertEq(p3.getMilestone(jobId, 0).state, 3, "first milestone is disputed");
        assertEq(p3.getMilestone(jobId, 1).state, 4, "second milestone settles independently");
        assertEq(escrow.claimable(address(token), FREELANCER), 6_000, "independent approval credits freelancer");
        assertEq(uint256(escrow.getJob(jobId).state), 2, "job remains funded while one milestone is disputed");
        assertEq(p3.getMilestoneDispute(jobId, 1), 0, "sibling milestone has no dispute binding");

        uint16[3] memory votes = [uint16(5_000), uint16(5_000), uint16(5_000)];
        _rulePanel1(disputeId, votes, 3);
        assertEq(p3.getMilestone(jobId, 0).state, 6, "dispute resolves the first milestone");
        assertEq(uint256(escrow.getJob(jobId).state), 4, "job closes after both terminal milestones");
        assertEq(p3.lockedEscrow(address(token)), 0);
        assertEq(p3.totalClaimable(address(token)), 11_100, "both milestone settlements and deposit liability reconcile");
    }

    function test_F31_OpenDepositUsesExactDeltaAndRejectsReentryWithoutDoubleDeposit() public {
        ReentrantToken reentrantToken = new ReentrantToken(6);
        FairworkEscrow reentrantEscrow = _deployForToken(address(reentrantToken), 6, TREASURY);
        IPhase3Escrow reentrantP3 = IPhase3Escrow(address(reentrantEscrow));
        reentrantToken.mint(CLIENT, 1_000_000);
        reentrantToken.mint(FREELANCER, 1_000_000);
        vm.prank(CLIENT);
        reentrantToken.approve(address(reentrantEscrow), type(uint256).max);
        vm.prank(FREELANCER);
        reentrantToken.approve(address(reentrantEscrow), type(uint256).max);
        FairworkEscrow.MilestoneInput[] memory milestones = new FairworkEscrow.MilestoneInput[](1);
        milestones[0] = FairworkEscrow.MilestoneInput(1_001, 10, keccak256("criteria"));
        FairworkEscrow.JobInput memory terms = _jobTerms(address(reentrantToken), FREELANCER, 0);
        vm.prank(CLIENT);
        uint256 jobId = reentrantEscrow.createJob(terms, milestones);
        vm.prank(FREELANCER);
        reentrantEscrow.acceptJob(jobId);
        vm.prank(CLIENT);
        reentrantEscrow.fundJob(jobId);
        vm.prank(FREELANCER);
        IPhase2Read(address(reentrantEscrow)).submitMilestone(jobId, 0, keccak256("delivery"), bytes32(0));
        bytes memory callback = abi.encodeWithSelector(FairworkEscrow.createJob.selector, terms, milestones);
        reentrantToken.configureCallback(address(reentrantEscrow), callback, true, false);

        uint256 clientBefore = reentrantToken.balanceOf(CLIENT);
        uint256 escrowBefore = reentrantToken.balanceOf(address(reentrantEscrow));
        vm.prank(CLIENT);
        uint256 disputeId = reentrantP3.openDispute(jobId, 0);
        uint256 deposit = uint256(1_001) * 200 / 10_000;
        assertTrue(reentrantToken.reentryAttempted(), "deposit token attempted the configured nested call");
        assertFalse(reentrantToken.reentrySucceeded(), "nested opening did not succeed");
        assertEq(reentrantEscrow.jobCount(), 1, "deposit callback cannot create a nested job");
        assertEq(clientBefore - reentrantToken.balanceOf(CLIENT), deposit, "client pays one raw deposit only");
        assertEq(reentrantToken.balanceOf(address(reentrantEscrow)) - escrowBefore, deposit, "escrow receives exact delta");
        assertEq(reentrantP3.disputeDeposits(address(reentrantToken)), deposit, "one deposit liability is recorded");
        assertEq(reentrantP3.getMilestoneDispute(jobId, 0), disputeId, "one dispute binds the milestone");

        reentrantToken.configureCallback(address(reentrantEscrow), callback, true, false);
        uint256 freelancerBefore = reentrantToken.balanceOf(FREELANCER);
        escrowBefore = reentrantToken.balanceOf(address(reentrantEscrow));
        vm.prank(FREELANCER);
        reentrantP3.matchDisputeDeposit(disputeId);
        assertTrue(reentrantToken.reentryAttempted(), "matching token transfer also exercises nested-call protection");
        assertFalse(reentrantToken.reentrySucceeded());
        assertEq(reentrantEscrow.jobCount(), 1, "match callback cannot create a nested job");
        assertEq(freelancerBefore - reentrantToken.balanceOf(FREELANCER), deposit);
        assertEq(reentrantToken.balanceOf(address(reentrantEscrow)) - escrowBefore, deposit);
        assertEq(reentrantP3.disputeDeposits(address(reentrantToken)), 2 * deposit);
    }

    function _rulePanel1(uint256 disputeId, uint16[3] memory votes, uint8 revealCount)
        private
        returns (address[3] memory panel)
    {
        panel = _fulfillAndSelect(disputeId);
        bytes32[3] memory salts;
        for (uint256 i; i < 3; ++i) {
            salts[i] = _salt(disputeId, panel[i], votes[i]);
            _commit(disputeId, panel[i], votes[i], salts[i]);
        }
        vm.warp(p3.getDispute(disputeId).commitDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 6, "three commits open the Panel 1 reveal window");
        for (uint256 i; i < revealCount; ++i) _reveal(disputeId, panel[i], votes[i], salts[i]);
        vm.warp(p3.getDispute(disputeId).revealDeadline);
        p3.advanceDispute(disputeId);
        assertEq(p3.getDispute(disputeId).phase, 10, "quorum settles without an extra panel");
    }

    function _deployForTreasury(address treasuryAddress) private returns (FairworkEscrow deployed) {
        deployed = _deployForToken(address(token), 6, treasuryAddress);
    }

    function _deployForToken(address tokenAddress, uint8 decimals_, address treasuryAddress)
        private
        returns (FairworkEscrow deployed)
    {
        FairworkEscrow.TokenConfig[] memory tokenConfigs = new FairworkEscrow.TokenConfig[](1);
        tokenConfigs[0] = FairworkEscrow.TokenConfig(tokenAddress, decimals_, 1, 1e18, bytes32(0));
        FairworkEscrow.ProtocolConfig memory config = escrow.protocolConfig();
        deployed = new FairworkEscrow(tokenConfigs, config, treasuryAddress);
    }

    function _jobTerms(address tokenAddress, address freelancer, uint8 revisionLimit)
        private
        pure
        returns (FairworkEscrow.JobInput memory terms)
    {
        terms = FairworkEscrow.JobInput({
            freelancer: freelancer,
            token: tokenAddress,
            titleCommitment: TERMS,
            descriptionCommitment: keccak256("description"),
            scopeCommitment: keccak256("scope"),
            deliveryRuleCommitment: keccak256("delivery rule"),
            reviewWindow: REVIEW_WINDOW,
            revisionLimit: revisionLimit
        });
    }
}
