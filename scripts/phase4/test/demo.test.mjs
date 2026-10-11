import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPublicClient, http, isAddress, keccak256 } from "viem";

const root = process.cwd();
const manifestPath = path.join(root, "infra/local/deployment.json");
const runDemo = () => spawnSync(process.execPath, ["scripts/phase4/demo.mjs"], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});

function resultFrom(output) {
  const line = output.split(/\r?\n/).find((value) => value.startsWith("PHASE4_DEMO_RESULT="));
  assert.ok(line, "demo must print a machine-readable PHASE4_DEMO_RESULT line");
  return JSON.parse(line.slice("PHASE4_DEMO_RESULT=".length));
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function assertManifestShape(manifest) {
  assert.deepEqual(Object.keys(manifest).sort(), [
    "arbitration", "blockNumber", "chainId", "codeHashes", "escrow", "randomness",
    "roles", "rpcUrl", "startBlock", "tokens",
  ].sort());
  assert.equal(manifest.chainId, 31337);
  assert.equal(manifest.rpcUrl, "http://127.0.0.1:8545");
  for (const address of [manifest.escrow, manifest.arbitration, manifest.randomness]) {
    assert.ok(isAddress(address), `expected a valid deployed address, got ${address}`);
  }
  for (const key of ["escrow", "arbitration", "randomness"]) {
    assert.match(manifest.codeHashes[key], /^0x[0-9a-fA-F]{64}$/);
  }
  assert.deepEqual(
    manifest.tokens.map(({ symbol, decimals }) => [symbol, decimals]).sort(),
    [["USDC", 6], ["WBTC", 8]],
  );
  assert.ok(isAddress(manifest.roles.client));
  assert.ok(isAddress(manifest.roles.freelancer));
  assert.ok(isAddress(manifest.roles.treasury));
  assert.equal(manifest.roles.arbiters.length, 6);
  assert.ok(manifest.roles.arbiters.every(isAddress));
  const roleAddresses = [
    manifest.roles.client,
    manifest.roles.freelancer,
    manifest.roles.treasury,
    ...manifest.roles.arbiters,
  ].map((address) => address.toLowerCase());
  assert.equal(new Set(roleAddresses).size, roleAddresses.length, "demo roles must use distinct accounts");
  assert.doesNotMatch(JSON.stringify(manifest), /private.?key|mnemonic|secret/i);
}

async function assertRuntimeCodeHashes(manifest) {
  const client = createPublicClient({ transport: http(manifest.rpcUrl) });
  for (const key of ["escrow", "arbitration", "randomness"]) {
    const code = await client.getCode({ address: manifest[key] });
    assert.ok(code && code !== "0x", `${key} must have runtime bytecode`);
    assert.equal(keccak256(code), manifest.codeHashes[key], `${key} code hash must match deployed bytecode`);
  }
}

test("one command resets, deploys and seeds the repeatable local demo", { timeout: 240_000 }, async () => {
  const first = runDemo();
  assert.equal(first.status, 0, `first demo run failed\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  const firstResult = resultFrom(first.stdout);
  const firstManifest = readManifest();
  assertManifestShape(firstManifest);
  await assertRuntimeCodeHashes(firstManifest);

  const second = runDemo();
  assert.equal(second.status, 0, `second demo run failed\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  const secondResult = resultFrom(second.stdout);
  const secondManifest = readManifest();
  assertManifestShape(secondManifest);
  await assertRuntimeCodeHashes(secondManifest);

  for (const key of ["chainId", "escrow", "arbitration", "randomness", "blockNumber", "startBlock", "codeHashes", "tokens", "roles"]) {
    assert.deepEqual(secondManifest[key], firstManifest[key], `${key} must be stable across clean resets`);
  }
  assert.deepEqual(secondResult.seededJobStates, ["Ready", "Submitted", "Rejected", "Disputed", "Closed"]);
  assert.deepEqual(secondResult.seededJobStates, firstResult.seededJobStates);
  assert.deepEqual(secondResult.acceptanceProgress, firstResult.acceptanceProgress);
  assert.equal(secondResult.acceptanceProgress.length, 12);
  assert.deepEqual(secondResult.acceptanceProgress.map(({ id }) => id), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(secondResult.acceptanceProgress.every(({ id, status }) =>
    status === (id === 2 || id === 12 ? "not_applicable" : "passed"),
  ));
  assert.match(second.stdout, /REPEATABILITY PASS/);
  assert.doesNotMatch(second.stdout, /\b(private.?key|mnemonic|seed phrase)\s*[:=]\s*\S+/i, "demo output must not disclose signing secrets");
});
