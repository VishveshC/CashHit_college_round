import assert from "node:assert/strict";
import test from "node:test";

import { runContractAction } from "../lib/client/transactions.ts";

test("transaction context is revalidated after confirmation and before the wallet send", async () => {
  const events: string[] = [];
  let contextCurrent = true;
  let sendCount = 0;

  await assert.rejects(runContractAction({
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async () => {
      events.push("confirmed in UI");
      contextCurrent = false;
      return true;
    },
    validateBeforeSend: () => {
      events.push("validate context");
      if (!contextCurrent) throw new Error("Wallet or agreement changed while confirmation was open.");
    },
    send: async () => {
      sendCount += 1;
      events.push("wallet send");
      return "0xhash";
    },
    waitForReceipt: async () => ({ status: "success" }),
    refetchFromChain: async () => null,
    summary: { action: "fund agreement #31" },
  } as any), /Wallet or agreement changed/);

  assert.deepEqual(events, ["confirmed in UI", "validate context"]);
  assert.equal(sendCount, 0, "stale confirmation must not reach the wallet signer");
});
