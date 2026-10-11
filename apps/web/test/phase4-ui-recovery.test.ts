import assert from "node:assert/strict";
import test from "node:test";

import { runContractAction } from "../lib/client/transactions.ts";
import { deriveActionPolicy } from "../lib/client/action-policy.ts";
import { markPrivateFileVerified, stagePrivateFile } from "../lib/client/file-drafts.ts";
import { pendingEvidenceEntries } from "../lib/client/evidence-resume.ts";

const ESCROW = "0x6666666666666666666666666666666666666666";
const CLIENT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const FILE_HASH = `0x${"33".repeat(32)}`;
const FILE_REFERENCE = `0x${"44".repeat(32)}`;
const TEXT_HASH = `0x${"55".repeat(32)}`;
const TEXT_REFERENCE = `0x${"66".repeat(32)}`;
const config = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  escrow: ESCROW,
  arbitration: "0x7777777777777777777777777777777777777777",
  randomness: "0x8888888888888888888888888888888888888888",
  startBlock: 1n,
  codeHashes: {},
  tokens: [{ address: "0x5555555555555555555555555555555555555555", symbol: "USDC", decimals: 6 }],
  roles: { client: CLIENT, freelancer: OTHER, treasury: CLIENT, arbiters: [] },
};

test("a successful receipt preserves its private follow-up before a failing fresh read", async () => {
  const events: string[] = [];
  let savedSalt = "";
  await assert.rejects(runContractAction({
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async () => true,
    send: async () => "0xconfirmed",
    waitForReceipt: async () => { events.push("receipt"); return { status: "success", blockNumber: 7n }; },
    afterReceipt: async (receipt: any) => {
      events.push(`follow-up:${receipt.blockNumber}`);
      savedSalt = `0x${"ab".repeat(32)}`;
    },
    refetchFromChain: async () => { events.push("fresh-read"); throw new Error("RPC timeout"); },
    summary: { action: "create agreement", contractAddress: ESCROW },
  } as any), /confirmed.*chain refresh failed/i);
  assert.equal(savedSalt, `0x${"ab".repeat(32)}`, "the receipt-dependent secret remains available despite the read failure");
  assert.deepEqual(events, ["receipt", "follow-up:7", "fresh-read"]);
});

test("a failed receipt never runs or preserves a private follow-up", async () => {
  let followedUp = false;
  await assert.rejects(runContractAction({
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async () => true,
    send: async () => "0xreverted",
    waitForReceipt: async () => ({ status: "reverted" }),
    afterReceipt: async () => { followedUp = true; },
    refetchFromChain: async () => "must not read",
    summary: { action: "commit evidence", contractAddress: ESCROW },
  } as any), /revert|failed|transaction/i);
  assert.equal(followedUp, false);
});

test("receipt-confirmed stale chain state blocks contract actions until refreshed", () => {
  const stale = deriveActionPolicy({ snapshot: null, account: CLIENT, chainId: 31337, config, chainFresh: false } as any);
  assert.deepEqual(stale.allowedActionIds, [], "create and agreement actions must not use a pre-receipt snapshot");
  assert.match(stale.disabledReasons.createJob ?? "", /refresh|fresh/i);

  const refreshed = deriveActionPolicy({ snapshot: null, account: CLIENT, chainId: 31337, config, chainFresh: true } as any);
  assert.ok(refreshed.allowedActionIds.includes("createJob"));
});

test("an uploaded private file stays a draft until chain verification", () => {
  const existing = { id: "old-file", hash: FILE_HASH, reference: FILE_REFERENCE, bound: true };
  const uploaded = { id: "new-file", hash: TEXT_HASH, reference: TEXT_REFERENCE, size: 41 };
  const before = { 0: [existing] };
  const staged = stagePrivateFile(before, 0, uploaded);

  assert.deepEqual(before[0], [existing], "staging does not mutate the previous milestone view");
  assert.deepEqual(staged[0], [existing, { ...uploaded, bound: false }]);
  assert.deepEqual(markPrivateFileVerified(staged, 0, "new-file")[0], [existing, { ...uploaded, bound: true }]);
});

test("a retry resumes after the exact file hash/reference already confirmed on chain", async () => {
  const plan = [
    { kind: "file" as const, hash: FILE_HASH, reference: FILE_REFERENCE },
    { kind: "text" as const, hash: TEXT_HASH, reference: TEXT_REFERENCE },
  ];
  const sent: typeof plan = [];
  assert.deepEqual(pendingEvidenceEntries(plan, [], "9", CLIENT), plan);

  // The first file receipt succeeded, then the UI's fresh read failed. The next read
  // returns the contract event for that exact party/dispute/hash/reference tuple.
  sent.push(plan[0]);
  const refreshedEvents = [{
    name: "EvidenceCommitted",
    args: { disputeId: 9n, party: CLIENT, evidenceHash: FILE_HASH, opaqueReference: FILE_REFERENCE },
  }];
  const resumed = pendingEvidenceEntries(plan, refreshedEvents, "9", CLIENT);
  assert.deepEqual(resumed, [plan[1]], "the retry continues with text and never resubmits the committed file tuple");
  sent.push(...resumed);
  assert.equal(sent.filter((entry) => entry.kind === "file" && entry.hash === FILE_HASH && entry.reference === FILE_REFERENCE).length, 1);

  const unrelated = [{ ...refreshedEvents[0], args: { ...refreshedEvents[0].args, party: OTHER } }];
  assert.deepEqual(pendingEvidenceEntries(plan, unrelated, "9", CLIENT), plan, "another party's event does not suppress this party's entry");
});
