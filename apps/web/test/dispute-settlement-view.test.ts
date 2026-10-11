import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDisputeSettlementView } from "../lib/client/dispute-settlement-view.ts";

const client = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const freelancer = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const treasury = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function settledEvents(disputeId: bigint, values = {
  bps: 5_000,
  fallbackApplied: false,
  freelancerCredit: 1_250_000n,
  clientCredit: 1_250_001n,
  treasuryCredit: 0n,
}) {
  return [
    { name: "DisputeSettlementCredited", args: { disputeId, amount: values.clientCredit, account: client, source: 0 } },
    { name: "DisputeSettlementCredited", args: { disputeId, amount: values.freelancerCredit, account: freelancer, source: 0 } },
    {
      name: "MilestoneResolved",
      args: { jobId: 31n, milestoneIndex: 0n, disputeId, ...values },
    },
  ];
}

test("settled disclosure preserves the authoritative odd-amount median and event credits", () => {
  const result = buildDisputeSettlementView(16n, 10n, settledEvents(16n));

  assert.deepEqual(result, {
    disputeId: 16n,
    rulingBps: 5_000,
    fallbackApplied: false,
    clientCredit: 1_250_001n,
    freelancerCredit: 1_250_000n,
    treasuryCredit: 0n,
    credits: [
      { source: 0, account: client, amount: 1_250_001n },
      { source: 0, account: freelancer, amount: 1_250_000n },
    ],
  });
});

test("no matching resolution or a non-settled on-chain status never discloses a result", () => {
  assert.equal(buildDisputeSettlementView(16n, 10n, []), null);
  assert.equal(buildDisputeSettlementView(16n, 9n, settledEvents(16n)), null);
  assert.equal(buildDisputeSettlementView(16n, 10n, settledEvents(17n)), null);
});

test("matching IDs retain exact large bigint amounts and per-credit source rows", () => {
  const hugeClient = 9_007_199_254_740_993n;
  const hugeFreelancer = 7_000_000_000_000_001n;
  const hugeTreasury = 2_000_000_000_000_003n;
  const values = {
    bps: 2_500,
    fallbackApplied: true,
    freelancerCredit: hugeFreelancer,
    clientCredit: hugeClient,
    treasuryCredit: hugeTreasury,
  };
  const events = [
    { name: "DisputeSettlementCredited", args: { disputeId: 16n, amount: hugeClient, account: client, source: 1 } },
    { name: "DisputeSettlementCredited", args: { disputeId: 16n, amount: hugeFreelancer, account: freelancer, source: 0 } },
    { eventName: "DisputeSettlementCredited", args: { disputeId: 16n, amount: hugeTreasury, account: treasury, source: 2 } },
    { name: "DisputeSettlementCredited", args: { disputeId: 17n, amount: 99n, account: client, source: 0 } },
    { name: "MilestoneResolved", args: { jobId: 31n, milestoneIndex: 0n, disputeId: 16n, ...values } },
  ];

  const result = buildDisputeSettlementView("16", "10", events);
  assert.equal(result?.rulingBps, 2_500);
  assert.equal(result?.fallbackApplied, true);
  assert.equal(result?.clientCredit, hugeClient);
  assert.equal(result?.freelancerCredit, hugeFreelancer);
  assert.equal(result?.treasuryCredit, hugeTreasury);
  assert.deepEqual(result?.credits, [
    { source: 1, account: client, amount: hugeClient },
    { source: 0, account: freelancer, amount: hugeFreelancer },
    { source: 2, account: treasury, amount: hugeTreasury },
  ]);
});

test("duplicate resolutions and inconsistent or malformed credit rows fail closed", () => {
  const resolved = settledEvents(16n).at(-1)!;
  assert.equal(buildDisputeSettlementView(16n, 10n, [...settledEvents(16n), resolved]), null);

  const inconsistent = settledEvents(16n);
  inconsistent[0] = { name: "DisputeSettlementCredited", args: { disputeId: 16n, amount: 1n, account: client, source: 0 } };
  assert.equal(buildDisputeSettlementView(16n, 10n, inconsistent), null);

  const malformed = settledEvents(16n);
  malformed[0] = { name: "DisputeSettlementCredited", args: { disputeId: 16n, amount: -1n, account: client, source: 0 } };
  assert.equal(buildDisputeSettlementView(16n, 10n, malformed), null);
});
