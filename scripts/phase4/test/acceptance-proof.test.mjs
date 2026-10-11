import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("applicable acceptance evidence is produced by fresh local-chain scenarios", () => {
  const source = readFileSync("scripts/phase4/demo.mjs", "utf8");
  assert.equal(/phase[23]-tests-final\.txt|requirePass\(/.test(source), false,
    "saved Forge logs cannot be presented as this run's acceptance proof");
  assert.match(source, /runAcceptanceScenarios\(/,
    "the demo must execute fresh-chain acceptance scenarios before reporting progress");
});

test("acceptance proof validation requires successful receipts and observed assertions", async () => {
  const { assertAcceptanceProof } = await import("../acceptance.mjs");
  const valid = {
    source: "fresh-local-anvil",
    chainId: 31337,
    transactions: [{ hash: `0x${"a1".repeat(32)}`, blockNumber: "12", status: "success" }],
    assertions: [{ name: "job is closed", expected: "Closed", actual: "Closed", passed: true }],
  };
  assert.doesNotThrow(() => assertAcceptanceProof(valid));
  assert.throws(() => assertAcceptanceProof({ ...valid, source: "saved-forge-log" }), /fresh local chain/i);
  assert.throws(() => assertAcceptanceProof({ ...valid, transactions: [] }), /receipt/i);
  assert.throws(() => assertAcceptanceProof({
    ...valid,
    assertions: [{ name: "job is closed", expected: "Closed", actual: "Funded", passed: false }],
  }), /assertion/i);
});
