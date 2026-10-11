import assert from "node:assert/strict";
import test from "node:test";

import { applyEvidenceReceiptOutcome } from "../lib/client/evidence-receipt.ts";
import { commitPrivateReadIfCurrent, type PrivateReadContext } from "../lib/client/private-read-guard.ts";
import { runContractAction } from "../lib/client/transactions.ts";

const original: PrivateReadContext = {
  generation: 4,
  jobId: "31",
  wallet: "0x1111111111111111111111111111111111111111",
  session: "session-a",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("late private responses are discarded after wallet, session, job, or generation changes", async () => {
  const changes: PrivateReadContext[] = [
    { ...original, wallet: "0x2222222222222222222222222222222222222222" },
    { ...original, session: "session-b" },
    { ...original, jobId: "32" },
    { ...original, generation: original.generation + 1 },
  ];

  for (const changed of changes) {
    const response = deferred<string>();
    let current: PrivateReadContext | null = original;
    const committed: string[] = [];
    const pending = commitPrivateReadIfCurrent(original, () => current, () => response.promise, (value) => committed.push(value));
    current = changed;
    response.resolve("private response from the old context");

    assert.equal(await pending, false, `must reject changed context ${JSON.stringify(changed)}`);
    assert.deepEqual(committed, [], "old private data must not repopulate the UI cache");
  }
});

test("only the newest same-wallet, same-session, same-job request can update private caches", async () => {
  const firstResponse = deferred<string>();
  const secondResponse = deferred<string>();
  let current: PrivateReadContext | null = original;
  const committed: string[] = [];

  const first = commitPrivateReadIfCurrent(original, () => current, () => firstResponse.promise, (value) => committed.push(value));
  current = { ...original, generation: original.generation + 1 };
  const second = commitPrivateReadIfCurrent(current, () => current, () => secondResponse.promise, (value) => committed.push(value));
  firstResponse.resolve("older read");
  assert.equal(await first, false);
  secondResponse.resolve("newest read");
  assert.equal(await second, true);
  assert.deepEqual(committed, ["newest read"]);
});

test("evidence stays duplicate-blocked while a receipt is unknown and becomes retryable only after a revert", () => {
  const submitted = { submitted: true, receiptConfirmed: false };
  assert.deepEqual(applyEvidenceReceiptOutcome(submitted, "unknown"), submitted);
  assert.deepEqual(applyEvidenceReceiptOutcome(submitted, "reverted"), { submitted: false, receiptConfirmed: false });
  assert.deepEqual(applyEvidenceReceiptOutcome(submitted, "confirmed"), { submitted: true, receiptConfirmed: true });
});

test("transaction pipeline reports only definitive receipt outcomes for evidence recovery", async () => {
  const outcomes: string[] = [];
  const base = {
    expectedChainId: 31337,
    activeChainId: 31337,
    confirm: async () => true,
    send: async () => "0xhash",
    afterReceipt: async () => undefined,
    refetchFromChain: async () => ({ fresh: true }),
    onReceiptOutcome: (outcome: string) => outcomes.push(outcome),
    summary: { action: "submit evidence" },
  };

  await assert.rejects(runContractAction({ ...base, waitForReceipt: async () => ({ status: "reverted" }) } as any), /revert|failed|transaction/i);
  assert.deepEqual(outcomes, ["reverted"]);

  outcomes.length = 0;
  await assert.rejects(runContractAction({ ...base, waitForReceipt: async () => { throw new Error("RPC timeout"); } } as any), /RPC timeout/i);
  assert.deepEqual(outcomes, [], "a timeout does not prove that the transaction reverted");

  outcomes.length = 0;
  await runContractAction({ ...base, waitForReceipt: async () => ({ status: "success" }) } as any);
  assert.deepEqual(outcomes, ["confirmed"]);
});
