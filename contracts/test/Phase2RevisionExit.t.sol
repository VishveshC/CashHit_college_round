// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {FairworkEscrow} from "../src/FairworkEscrow.sol";
import {Phase2Fixture, IPhase2Surface} from "./Phase2Milestones.t.sol";

contract Phase2RevisionExitTest is Phase2Fixture {
    function test_F22_F86_ExhaustedRevisionLimitsStillReleaseAfterSilence() public {
        uint8[] memory limits = new uint8[](3);
        limits[0] = 0;
        limits[1] = 1;
        limits[2] = 5;

        for (uint256 i; i < limits.length; ++i) {
            uint8 limit = limits[i];
            uint256 amount = 100 + i * 100;
            uint256 jobId = _one(amount, 10, limit);
            _submit(jobId, 0, keccak256(abi.encode("submission", limit)), bytes32(0));

            for (uint8 revision; revision < limit; ++revision) {
                _reject(jobId, 0, keccak256(abi.encode("reason", limit, revision)));
                _resubmit(jobId, 0, keccak256(abi.encode("resubmission", limit, revision)), bytes32(0));
            }

            IPhase2Surface.MilestoneView memory exhausted = _milestone(jobId, 0);
            assertEq(exhausted.state, 1, "exhausted milestone remains Submitted");
            assertEq(exhausted.rejectionCount, limit, "rejection count reaches the signed revision limit");
            assertEq(exhausted.submissionCount, limit + 1, "final allowed version remains reviewable");

            vm.prank(CLIENT);
            vm.expectRevert(FairworkEscrow.InvalidRevisionLimit.selector);
            phase2.rejectMilestone(jobId, 0, keccak256("over limit"));
            IPhase2Surface.MilestoneView memory afterRejectedAttempt = _milestone(jobId, 0);
            assertEq(afterRejectedAttempt.state, 1, "over-limit rejection leaves submission reviewable");
            assertEq(afterRejectedAttempt.rejectionCount, limit, "failed rejection cannot consume another revision");

            uint256 claimBefore = escrow.claimable(address(token), FREELANCER);
            uint256 totalClaimsBefore = escrow.totalClaimable(address(token));
            uint256 lockedBefore = escrow.lockedEscrow(address(token));
            vm.warp(exhausted.reviewEnd);
            vm.prank(OTHER);
            phase2.releaseAfterSilence(jobId, 0);

            assertEq(_settleState(jobId, 0), 4, "review silence releases even after the revision limit is exhausted");
            assertEq(escrow.claimable(address(token), FREELANCER), claimBefore + amount, "silence credits exact freelancer principal");
            assertEq(escrow.totalClaimable(address(token)), totalClaimsBefore + amount, "silence creates exact claim liability");
            assertEq(escrow.lockedEscrow(address(token)), lockedBefore - amount, "silence removes exact locked principal");
            assertEq(uint256(escrow.getJob(jobId).state), uint256(FairworkEscrow.JobState.Closed), "terminal silence closes the job");

            vm.prank(OTHER);
            vm.expectRevert(FairworkEscrow.InvalidState.selector);
            phase2.releaseAfterSilence(jobId, 0);
            assertEq(escrow.claimable(address(token), FREELANCER), claimBefore + amount, "repeat silence cannot double-credit");
            assertEq(escrow.totalClaimable(address(token)), totalClaimsBefore + amount, "repeat silence cannot increase liabilities");
        }
    }
}
