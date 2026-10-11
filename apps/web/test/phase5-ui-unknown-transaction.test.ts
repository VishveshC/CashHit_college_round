import assert from "node:assert/strict";
import test from "node:test";

import * as transactionApi from "../lib/client/transactions.ts";

const runContractAction = transactionApi.runContractAction;

test("a receipt timeout after broadcast is unknown, retains the tx hash, and does not refetch", async () => {
  const statuses: string[] = [];
  const outcomes: string[] = [];
  const expectedHash = `0x${"ab".repeat(32)}`;
  let sent = false;
  let observedHash = "";
  let refetchCount = 0;

  await assert.rejects(runContractAction({
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async () => true,
    send: async () => { sent = true; return expectedHash; },
    waitForReceipt: async (hash: string) => {
      observedHash = hash;
      throw new Error("RPC timeout after broadcast");
    },
    onReceiptOutcome: (outcome: string) => outcomes.push(outcome),
    onStatus: (status: string) => statuses.push(status),
    refetchFromChain: async () => { refetchCount += 1; return null; },
    summary: { action: "create agreement proposal" },
  } as any), /RPC timeout after broadcast/);

  assert.equal(sent, true);
  assert.equal(observedHash, expectedHash, "the already-broadcast hash must remain available for reconciliation");
  assert.deepEqual(statuses, ["pending", "unknown"]);
  assert.deepEqual(outcomes, [], "a timeout is not proof of either confirmation or revert");
  assert.equal(refetchCount, 0, "do not treat a timeout as a confirmed receipt and refetch as if finalized");
});

test("an explicit reverted receipt remains a definitive failed transaction", async () => {
  const statuses: string[] = [];
  const outcomes: string[] = [];
  let refetchCount = 0;

  await assert.rejects(runContractAction({
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async () => true,
    send: async () => `0x${"cd".repeat(32)}`,
    waitForReceipt: async () => ({ status: "reverted" }),
    onReceiptOutcome: (outcome: string) => outcomes.push(outcome),
    onStatus: (status: string) => statuses.push(status),
    refetchFromChain: async () => { refetchCount += 1; return null; },
    summary: { action: "create agreement proposal" },
  } as any), /failed or reverted/);

  assert.deepEqual(statuses, ["pending", "failed"]);
  assert.deepEqual(outcomes, ["reverted"]);
  assert.equal(refetchCount, 0);
});

test("only pending and unknown transaction states block a new contract send", () => {
  const blocksNewSend = transactionApi.transactionBlocksNewSend as unknown as (status: string) => boolean;
  assert.equal(typeof blocksNewSend, "function");
  assert.equal(blocksNewSend("pending"), true);
  assert.equal(blocksNewSend("unknown"), true);
  assert.equal(blocksNewSend("failed"), false);
  assert.equal(blocksNewSend("confirmed"), false);
});
