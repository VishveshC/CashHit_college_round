import { test } from "node:test";
import assert from "node:assert/strict";
import { localArbitrationGasLimit } from "../lib/client/local-arbitration-gas.ts";

test("local arbitration gas reserve applies only to demo advanceDispute on chain 31337", () => {
  assert.equal(localArbitrationGasLimit("advanceDispute", "demo", 31337), 2_000_000n);
});

test("local arbitration gas reserve fails closed for other methods, wallets and chains", () => {
  assert.equal(localArbitrationGasLimit("fundJob", "demo", 31337), undefined);
  assert.equal(localArbitrationGasLimit("advanceDispute", "browser", 31337), undefined);
  assert.equal(localArbitrationGasLimit("advanceDispute", "injected", 31337), undefined);
  assert.equal(localArbitrationGasLimit("advanceDispute", "demo", 1), undefined);
  assert.equal(localArbitrationGasLimit("AdvanceDispute", "demo", 31337), undefined);
});
