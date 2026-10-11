import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidAnvilOwnerRecord } from "./phase4/runtime.mjs";

const commonRecord = {
  owner: "fairwork-phase4",
  pid: 1234,
  host: "127.0.0.1",
  port: 8545,
  chainId: 31337,
  executable: "/usr/bin/anvil",
  args: ["--host", "127.0.0.1", "--port", "8545", "--chain-id", "31337", "--accounts", "10"],
};

test("Unix Anvil ownership records validate their process start marker", () => {
  assert.equal(isValidAnvilOwnerRecord({ ...commonRecord, processStart: "Sun Oct 11 12:00:00 2026" }, "linux"), true);
  assert.equal(isValidAnvilOwnerRecord(commonRecord, "linux"), false);
  assert.equal(isValidAnvilOwnerRecord({ ...commonRecord, processStart: 123 }, "linux"), false);
});

test("Windows Anvil ownership records continue to validate their creation time", () => {
  assert.equal(isValidAnvilOwnerRecord({ ...commonRecord, createdFileTime: "134052912000000000" }, "win32"), true);
  assert.equal(isValidAnvilOwnerRecord({ ...commonRecord, processStart: "Sun Oct 11 12:00:00 2026" }, "win32"), false);
});
