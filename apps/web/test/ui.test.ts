import assert from "node:assert/strict";
import test from "node:test";

import { deriveActionPolicy } from "../lib/client/action-policy.ts";
import { formatTokenAmount, parseTokenAmount } from "../lib/client/amounts.ts";
import { createPrivateCommitment, privateCommitmentHash } from "../lib/client/commitments.ts";
import { runContractAction } from "../lib/client/transactions.ts";

const CLIENT = "0x1111111111111111111111111111111111111111" as const;
const FREELANCER = "0x2222222222222222222222222222222222222222" as const;
const ARBITER = "0x3333333333333333333333333333333333333333" as const;
const OTHER_ARBITER = "0x4444444444444444444444444444444444444444" as const;
const TOKEN = "0x5555555555555555555555555555555555555555" as const;
const ESCROW = "0x6666666666666666666666666666666666666666" as const;
const ARBITRATION = "0x7777777777777777777777777777777777777777" as const;
const RANDOMNESS = "0x8888888888888888888888888888888888888888" as const;
const ZERO = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const config = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  escrow: ESCROW,
  arbitration: ARBITRATION,
  randomness: RANDOMNESS,
  startBlock: 1n,
  blockNumber: 2n,
  codeHashes: { escrow: `0x${"aa".repeat(32)}`, arbitration: `0x${"bb".repeat(32)}`, randomness: `0x${"cc".repeat(32)}` },
  tokens: [{ address: TOKEN, symbol: "USDC", decimals: 6 }],
  roles: { client: CLIENT, freelancer: FREELANCER, treasury: CLIENT, arbiters: [ARBITER, OTHER_ARBITER] },
  domain: "localhost:3000",
  uri: "http://localhost:3000",
};

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  const { job: jobOverrides, milestone: milestoneOverrides, ...snapshotOverrides } = overrides;
  const job = {
    client: CLIENT,
    freelancer: FREELANCER,
    token: TOKEN,
    state: 0, // JobState.Proposed
    totalAmount: 2_500_000n,
    createdAt: 1n,
    proposalEnd: 100n,
    acceptedAt: 0n,
    fundingDeadline: 0n,
    fundedAt: 0n,
    reviewWindow: 120n,
    revisionLimit: 2,
    milestoneCount: 1,
  };
  const milestone = {
    amount: 2_500_000n,
    duration: 600n,
    acceptanceCriteriaCommitment: `0x${"12".repeat(32)}`,
    deadline: 0n,
    graceEnd: 0n,
    state: 0, // MilestoneState.Ready
    submittedAt: 0n,
    reviewEnd: 0n,
    rejectedAt: 0n,
    responseEnd: 0n,
    rejectionCount: 0,
    submissionCount: 0,
    latestReasonCommitment: ZERO,
    submissions: [],
    disputeId: 0n,
    dispute: null,
    panels: {
      1: [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
      2: [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
    },
    history: [],
    votes: {},
  };

  return {
    jobId: 1n,
    now: 99n,
    job: { ...job, ...(jobOverrides as object | undefined) },
    commitments: {
      titleCommitment: `0x${"21".repeat(32)}`,
      descriptionCommitment: `0x${"22".repeat(32)}`,
      scopeCommitment: `0x${"23".repeat(32)}`,
      deliveryRuleCommitment: `0x${"24".repeat(32)}`,
    },
    milestones: [{ ...milestone, ...(milestoneOverrides as object | undefined) }],
    claimable: 0n,
    lockedEscrow: 0n,
    disputeDeposits: 0n,
    withdrawn: 0n,
    ...snapshotOverrides,
  };
}

function policy(snapshot: ReturnType<typeof makeSnapshot>, account: string, activeChainId = 31337) {
  return deriveActionPolicy({ snapshot, account, chainId: activeChainId, config });
}

function allowed(result: ReturnType<typeof policy>, actionId: string) {
  return result.allowedActionIds.includes(actionId);
}

test("F-60/F-61/S-60: wrong network disables every contract action", () => {
  const result = policy(makeSnapshot(), FREELANCER, 1);
  assert.equal(result.allowedActionIds.length, 0);
  assert.match(result.disabledReasons.acceptJob, /chain|network|31337/i);
});

test("F-60/S-15/S-21: named freelancer accepts before the half-open end; expiry action opens at the end", () => {
  const beforeEnd = policy(makeSnapshot(), FREELANCER);
  assert.equal(allowed(beforeEnd, "acceptJob"), true);
  assert.equal(allowed(beforeEnd, "fundJob"), false);
  assert.ok(beforeEnd.disabledReasons.fundJob);

  const atEnd = policy(makeSnapshot({ now: 100n }), FREELANCER);
  assert.equal(allowed(atEnd, "acceptJob"), false);
  assert.equal(allowed(atEnd, "cancelExpiredProposal"), true);
});

test("F-60/F-20/S-15/S-21: client approval closes at reviewEnd and permissionless silence release opens there", () => {
  const submitted = makeSnapshot({
    now: 299n,
    job: { state: 2 }, // JobState.Funded
    milestone: { state: 1, reviewEnd: 300n }, // MilestoneState.Submitted
  });
  const duringReview = policy(submitted, CLIENT);
  assert.equal(allowed(duringReview, "approveMilestone"), true);
  assert.equal(allowed(duringReview, "releaseAfterSilence"), false);

  const atReviewEnd = policy({ ...submitted, now: 300n }, CLIENT);
  assert.equal(allowed(atReviewEnd, "approveMilestone"), false);
  assert.equal(allowed(atReviewEnd, "releaseAfterSilence"), true);
});

test("F-33/S-16: commit voting is available only to a current assigned panel member", () => {
  const inCommitPhase = makeSnapshot({
    now: 49n,
    job: { state: 2 },
    milestone: {
      state: 3, // MilestoneState.Disputed
      disputeId: 1n,
      dispute: { phase: 3, round: 1, commitDeadline: 50n }, // Panel 1 commit
      panels: {
        1: [ARBITER, OTHER_ARBITER, ZERO_ADDRESS],
        2: [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
      },
    },
  });
  assert.equal(allowed(policy(inCommitPhase, ARBITER), "commitVote"), true);
  const nonMember = policy(inCommitPhase, FREELANCER);
  assert.equal(allowed(nonMember, "commitVote"), false);
  assert.ok(nonMember.disabledReasons.commitVote);
});

test("F-50: claimable withdrawal remains separate from a terminal milestone", () => {
  const terminal = makeSnapshot({
    job: { state: 2 },
    milestone: { state: 4 }, // MilestoneState.Released
    claimable: 2_500_000n,
  });
  const result = policy(terminal, FREELANCER);
  assert.equal(allowed(result, "withdraw"), true);
  assert.equal(allowed(result, "approveMilestone"), false);
});

test("S-06/X-28: token amount parser uses raw integer units and rejects ambiguous input", () => {
  assert.equal(parseTokenAmount("1.234567", 6), 1_234_567n);
  assert.equal(parseTokenAmount("0.00000001", 8), 1n);
  assert.throws(() => parseTokenAmount("1e6", 6), /amount|decimal|format/i);
  assert.throws(() => parseTokenAmount("-1", 6), /amount|decimal|format/i);
  assert.throws(() => parseTokenAmount("1.0000001", 6), /precision|decimal|amount/i);
  assert.throws(() => parseTokenAmount("0", 6), /positive|zero|amount/i);
});

test("F-50/S-06: formatted amounts preserve all raw digits without floating-point rounding", () => {
  assert.equal(formatTokenAmount(9_007_199_254_740_993n, 6, "USDC"), "9,007,199,254.740993 USDC");
  assert.equal(formatTokenAmount(12_345_600n, 6, "USDC"), "12.3456 USDC");
});

test("P-03/A-38: private commitment matches the typed salted hash vector and validates plaintext", () => {
  const salt = `0x${"11".repeat(32)}`;
  assert.equal(
    privateCommitmentHash("TITLE", "Logo budget $5", salt),
    "0xbb06acef200fcef8685892edcb99cf26aa7e3b3e381cc2691a4ed1b9c28bdc58",
  );
  assert.throws(() => privateCommitmentHash("TITLE", "  ", salt), /text|empty|required/i);
  assert.throws(() => privateCommitmentHash("TITLE", "A title", "0x1234"), /salt|32|length/i);
});

test("P-03/A-38: commitment creation keeps a fresh 32-byte salt available for encrypted private storage", () => {
  const first = createPrivateCommitment("EVIDENCE", "The export is missing the second page.");
  const second = createPrivateCommitment("EVIDENCE", "The export is missing the second page.");
  assert.match(first.salt, /^0x[0-9a-f]{64}$/i);
  assert.match(first.commitment, /^0x[0-9a-f]{64}$/i);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.commitment, second.commitment);
});

test("S-61/S-63: action pipeline rejects a wrong chain before confirmation or wallet send", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runContractAction({
      expectedChainId: 31337,
      activeChainId: 1,
      confirm: async () => { calls.push("confirm"); return true; },
      send: async () => { calls.push("send"); return "0xdead"; },
      waitForReceipt: async () => { calls.push("receipt"); return { status: "success" }; },
      refetchFromChain: async () => { calls.push("refetch"); },
      onStatus: (status: string) => calls.push(status),
      summary: { chainId: 31337, contractAddress: ESCROW, action: "fundJob" },
    }),
    /chain|network|31337/i,
  );
  assert.deepEqual(calls, []);
});

test("S-63: action waits for a successful receipt, then refetches chain state", async () => {
  const calls: string[] = [];
  const summary = {
    chainId: 31337,
    contractAddress: ESCROW,
    parties: [CLIENT, FREELANCER],
    token: { address: TOKEN, symbol: "USDC", raw: "2500000", formatted: "2.5 USDC" },
    terms: ["2 milestones", "2 revisions", "review 120 seconds"],
    effects: ["Lock exactly 2.5 USDC in escrow"],
  };
  const result = await runContractAction({
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async (received: typeof summary) => { calls.push("confirm"); assert.deepEqual(received, summary); return true; },
    send: async () => { calls.push("send"); return "0xabc"; },
    waitForReceipt: async (hash: string) => { calls.push(`receipt:${hash}`); return { status: "success" }; },
    refetchFromChain: async () => { calls.push("refetch"); return "fresh snapshot"; },
    onStatus: (status: string) => calls.push(status),
    summary,
  });
  assert.equal(result.snapshot, "fresh snapshot");
  assert.deepEqual(calls, ["confirm", "send", "pending", "receipt:0xabc", "confirmed", "refetch"]);
});

test("S-63: reverted receipts publish failure and never refetch as a successful action", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runContractAction({
      expectedChainId: 31337,
      activeChainId: 31337,
      confirm: async () => true,
      send: async () => "0xdef",
      waitForReceipt: async () => { calls.push("receipt"); return { status: "reverted" }; },
      refetchFromChain: async () => { calls.push("refetch"); },
      onStatus: (status: string) => calls.push(status),
      summary: { chainId: 31337, contractAddress: ESCROW, action: "approveMilestone" },
    }),
    /revert|failed|transaction/i,
  );
  assert.deepEqual(calls, ["pending", "receipt", "failed"]);
});
