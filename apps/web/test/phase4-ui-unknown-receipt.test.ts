import assert from "node:assert/strict";
import test from "node:test";

import { runContractAction } from "../lib/client/transactions.ts";

test("an unrecognized receipt status fails closed without declaring an evidence transaction reverted", async () => {
  const outcomes: string[] = [];
  await assert.rejects(runContractAction({
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async () => true,
    send: async () => "0xhash",
    waitForReceipt: async () => ({ status: "pending-ish" }),
    onReceiptOutcome: (outcome: string) => outcomes.push(outcome),
    refetchFromChain: async () => null,
    summary: { action: "submit evidence" },
  } as any), /failed or reverted/i);
  assert.deepEqual(outcomes, [], "only an explicit reverted receipt may unlock a retry");
});
