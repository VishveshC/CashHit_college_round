import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveActionPolicy } from '../lib/client/action-policy.ts';

const client = '0x1111111111111111111111111111111111111111';
const freelancer = '0x2222222222222222222222222222222222222222';
function allowed(account: string, milestone: any) {
  return deriveActionPolicy({ account, chainId: 31337, config: { chainId: 31337 } as any,
    snapshot: { now: 100n, job: { state: 2, client, freelancer, revisionLimit: 2 },
      milestones: [milestone], claimable: 0n } as any }).allowedActionIds;
}
test('Submitted dispute opening belongs to client; rejection permits either party', () => {
  const submitted = { state: 1, disputeId: 0n, reviewEnd: 200n };
  assert.ok(allowed(client, submitted).includes('openDispute'));
  assert.equal(allowed(freelancer, submitted).includes('openDispute'), false);
  assert.ok(allowed(freelancer, { state: 2, disputeId: 0n, responseEnd: 200n }).includes('openDispute'));
});
test('Only unmatched counterparty can match the deposit during Evidence phase', () => {
  const milestone = { state: 3, disputeId: 1n, dispute: { phase: 1, opener: client,
    evidenceDeadline: 200n, clientDeposited: true, freelancerDeposited: false } };
  assert.equal(allowed(client, milestone).includes('matchDisputeDeposit'), false);
  assert.ok(allowed(freelancer, milestone).includes('matchDisputeDeposit'));
  milestone.dispute.freelancerDeposited = true;
  assert.equal(allowed(freelancer, milestone).includes('matchDisputeDeposit'), false);
  milestone.dispute.phase = 2;
  milestone.dispute.freelancerDeposited = false;
  assert.equal(allowed(freelancer, milestone).includes('matchDisputeDeposit'), false);
});
test('Ready randomness allows immediate advancement in every pending entropy phase', () => {
  for (const phase of [2, 4, 7]) {
    const milestone = { state: 3, disputeId: 1n, dispute: { phase, requestEnd: 200n, randomnessReady: true } };
    assert.ok(allowed(client, milestone).includes('advanceDispute'), `phase ${phase}`);
    milestone.dispute.randomnessReady = false;
    assert.equal(allowed(client, milestone).includes('advanceDispute'), false);
  }
});
