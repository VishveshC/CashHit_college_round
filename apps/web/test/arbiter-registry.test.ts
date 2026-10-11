import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRegistryOwner,
  readArbiterRegistry,
  validateArbiterRegistryChange,
} from "../lib/client/arbiter-registry.ts";

const owner = "0x1111111111111111111111111111111111111111" as const;
const first = "0x2222222222222222222222222222222222222222" as const;
const second = "0x3333333333333333333333333333333333333333" as const;
const escrow = "0x4444444444444444444444444444444444444444" as const;
const config = { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", escrow } as any;

function fakeClient(members: readonly string[] = [first, second], options: { owner?: string; count?: bigint } = {}) {
  const calls: Array<{ functionName: string; args: unknown[]; blockNumber?: bigint }> = [];
  const client = {
    getBlockNumber: async () => 901n,
    readContract: async (request: { functionName: string; args?: unknown[]; blockNumber?: bigint }) => {
      calls.push({ functionName: request.functionName, args: request.args ?? [], blockNumber: request.blockNumber });
      if (request.functionName === "owner") return options.owner ?? owner;
      if (request.functionName === "arbiterCount") return options.count ?? BigInt(members.length);
      if (request.functionName === "arbiterAt") return members[Number(request.args?.[0])];
      throw new Error(`Unexpected registry read: ${request.functionName}`);
    },
  };
  return { client, calls };
}

test("registry read verifies the deployment, bounds count, and pins every value to one block", async () => {
  const { client, calls } = fakeClient();
  const verifyCalls: unknown[] = [];
  const snapshot = await readArbiterRegistry(config, {
    client,
    verify: async (receivedConfig, receivedClient) => verifyCalls.push([receivedConfig, receivedClient]),
  });

  assert.deepEqual(verifyCalls, [[config, client]]);
  assert.deepEqual(snapshot, { owner, members: [first, second], count: 2, blockNumber: 901n });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.functionName), ["owner", "arbiterCount", "arbiterAt", "arbiterAt"]);
  assert.ok(calls.every((call) => call.blockNumber === 901n));
});

test("registry read fails closed above the contract limit before enumerating members", async () => {
  const { client, calls } = fakeClient([], { count: 129n });
  await assert.rejects(
    () => readArbiterRegistry(config, { client, verify: async () => {} }),
    /128|limit/i,
  );
  assert.deepEqual(calls.map((call) => call.functionName), ["owner", "arbiterCount"]);
});

test("registry read rejects zero and duplicate members instead of rendering a corrupt roster", async () => {
  for (const members of [
    ["0x0000000000000000000000000000000000000000"],
    [first, first.toUpperCase().replace("0X", "0x")],
  ]) {
    const { client } = fakeClient(members);
    await assert.rejects(() => readArbiterRegistry(config, { client, verify: async () => {} }), /zero|duplicate|invalid/i);
  }
});

test("registry authority follows the on-chain owner and not a treasury-role label", () => {
  assert.equal(isRegistryOwner(owner.toUpperCase().replace("0X", "0x"), owner), true);
  assert.equal(isRegistryOwner(first, owner), false);
  assert.equal(isRegistryOwner(null, owner), false);
});

test("owner can add only a new validated nonzero address below the cap", () => {
  const snapshot = { owner, members: [first], count: 1, blockNumber: 901n };
  assert.equal(validateArbiterRegistryChange("addArbiter", second, owner, snapshot), second);
  for (const invalid of ["", "0x1234", "0x0000000000000000000000000000000000000000", first]) {
    assert.throws(() => validateArbiterRegistryChange("addArbiter", invalid, owner, snapshot), /address|zero|already/i);
  }
  assert.throws(
    () => validateArbiterRegistryChange("addArbiter", second, first, snapshot),
    /owner/i,
  );
  assert.throws(
    () => validateArbiterRegistryChange("addArbiter", second, owner, { ...snapshot, count: 128 }),
    /128|limit/i,
  );
});

test("owner can remove only a current member; non-owner and unknown-member requests fail", () => {
  const snapshot = { owner, members: [first, second], count: 2, blockNumber: 901n };
  assert.equal(validateArbiterRegistryChange("removeArbiter", first, owner, snapshot), first);
  assert.throws(
    () => validateArbiterRegistryChange("removeArbiter", escrow, owner, snapshot),
    /member|registered/i,
  );
  assert.throws(
    () => validateArbiterRegistryChange("removeArbiter", first, second, snapshot),
    /owner/i,
  );
});
