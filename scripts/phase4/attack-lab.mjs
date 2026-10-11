import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256 } from "viem";
import { localRuntime, verifyOwnedAnvil, writeAttackLabResult } from "./runtime.mjs";

const ROOT = localRuntime.root;
const RPC_URL = localRuntime.rpcUrl;
const ESCROW = JSON.parse(readFileSync(path.join(ROOT, "contracts/out/FairworkEscrow.sol/FairworkEscrow.json"), "utf8"));
const ARBITRATION = JSON.parse(readFileSync(path.join(ROOT, "contracts/out/FairworkArbitration.sol/FairworkArbitration.json"), "utf8"));
const TOKEN = JSON.parse(readFileSync(path.join(ROOT, "contracts/out/LocalDemoTokens.sol/MockUSDC.json"), "utf8"));

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Local Anvil returned HTTP " + response.status + " for " + method + ".");
  const result = await response.json();
  if (result.error) throw new Error(result.error.message || "Local Anvil RPC call failed.");
  return result.result;
}

async function attemptTransaction({ name, from, to, abi, functionName, args, gas = 300_000n }) {
  const data = encodeFunctionData({ abi, functionName, args });
  let hash;
  try {
    hash = await rpc("eth_sendTransaction", [{
      from,
      to,
      gas: "0x" + gas.toString(16),
      data,
      value: "0x0",
    }]);
  } catch (error) {
    return {
      name,
      result: "rejected_by_rpc",
      observation: error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      const success = BigInt(receipt.status) === 1n;
      return {
        name,
        result: success ? "unexpected_success" : "reverted",
        transactionHash: hash,
        blockNumber: BigInt(receipt.blockNumber).toString(),
        status: receipt.status,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(name + " was submitted but no receipt was observed.");
}

function readManifest() {
  return JSON.parse(readFileSync(path.join(ROOT, "infra/local/deployment.json"), "utf8"));
}

async function verifyManifest(manifest) {
  const chainId = BigInt(await rpc("eth_chainId"));
  if (chainId !== 31337n || manifest.chainId !== 31337) throw new Error("Attack Lab requires the owned chain 31337.");
  for (const name of ["escrow", "arbitration", "randomness"]) {
    const code = await rpc("eth_getCode", [manifest[name], "latest"]);
    if (!code || code === "0x" || keccak256(code) !== manifest.codeHashes[name]) {
      throw new Error("Attack Lab refused a missing or drifted " + name + " code pin.");
    }
  }
}

async function expectRevert(attempt, name) {
  if (attempt.result !== "reverted" && attempt.result !== "rejected_by_rpc") {
    throw new Error(name + " did not fail as intended.");
  }
  return attempt;
}

async function main() {
  await verifyOwnedAnvil();
  const manifest = readManifest();
  await verifyManifest(manifest);
  const accounts = (await rpc("eth_accounts")).map((address) => getAddress(address));
  if (accounts.length < 10) throw new Error("Attack Lab expected the ten throwaway local accounts.");
  const owner = accounts[0];
  const client = accounts[1];
  const outsider = accounts[9];
  const disputeId = BigInt((JSON.parse(readFileSync(path.join(ROOT, "infra/local/runtime/demo-result.json"), "utf8"))
    .jobs.find((job) => job.status === "Disputed") || {}).disputeId || "0");
  if (disputeId === 0n) throw new Error("Attack Lab requires the seeded active dispute.");

  const cases = [];
  const beforeArbiters = BigInt(await rpc("eth_call", [{
    to: manifest.escrow,
    data: encodeFunctionData({ abi: ESCROW.abi, functionName: "arbiterCount" }),
  }, "latest"]));
  cases.push(await expectRevert(await attemptTransaction({
    name: "non-owner cannot add an arbiter",
    from: client, to: manifest.escrow, abi: ESCROW.abi, functionName: "addArbiter",
    args: [outsider],
  }), "non-owner registry write"));
  const afterArbiters = BigInt(await rpc("eth_call", [{
    to: manifest.escrow,
    data: encodeFunctionData({ abi: ESCROW.abi, functionName: "arbiterCount" }),
  }, "latest"]));
  if (afterArbiters !== beforeArbiters) throw new Error("Unauthorized registry write changed the arbiter count.");

  cases.push(await expectRevert(await attemptTransaction({
    name: "direct engine caller cannot spoof the client for evidence",
    from: outsider, to: manifest.arbitration, abi: ARBITRATION.abi,
    functionName: "submitEvidence",
    args: [disputeId, manifest.roles.client, keccak256(new TextEncoder().encode("attack-evidence")), keccak256(new TextEncoder().encode("attack-reference"))],
  }), "engine actor spoof"));

  const readyJob = BigInt(JSON.parse(readFileSync(path.join(ROOT, "infra/local/runtime/demo-result.json"), "utf8"))
    .jobs.find((job) => job.status === "Ready").jobId);
  cases.push(await expectRevert(await attemptTransaction({
    name: "unrelated account cannot submit a party deliverable",
    from: outsider, to: manifest.escrow, abi: ESCROW.abi,
    functionName: "submitMilestone",
    args: [readyJob, 0n, keccak256(new TextEncoder().encode("unrelated-submit")), "0x" + "00".repeat(32)],
  }), "unrelated submission"));
  const readyMilestoneData = await rpc("eth_call", [{
    to: manifest.escrow,
    data: encodeFunctionData({ abi: ESCROW.abi, functionName: "getMilestone", args: [readyJob, 0n] }),
  }, "latest"]);
  const readyMilestone = decodeFunctionResult({
    abi: ESCROW.abi, functionName: "getMilestone", data: readyMilestoneData,
  });
  if (Number(readyMilestone.state) !== 0) throw new Error("Denied submission changed the Ready milestone.");

  const closedJob = BigInt(JSON.parse(readFileSync(path.join(ROOT, "infra/local/runtime/demo-result.json"), "utf8"))
    .jobs.find((job) => job.status === "Closed").jobId);
  cases.push(await expectRevert(await attemptTransaction({
    name: "terminal milestone cannot be approved or paid twice",
    from: client, to: manifest.escrow, abi: ESCROW.abi,
    functionName: "approveMilestone", args: [closedJob, 0n],
  }), "duplicate settlement"));
  cases.push(await expectRevert(await attemptTransaction({
    name: "deployer cannot withdraw locked escrow principal",
    from: owner, to: manifest.escrow, abi: ESCROW.abi,
    functionName: "withdraw", args: [manifest.tokens[0].address],
  }), "owner principal withdrawal"));

  if (cases.some((item) => item.result === "unexpected_success")) {
    throw new Error("At least one Attack Lab transaction unexpectedly succeeded.");
  }
  const result = {
    chainId: 31337,
    deployment: manifest.escrow,
    cases,
    outcome: "PASS",
    limitations: [
      "These are direct Anvil transactions against the deployed contracts; they do not claim production-chain or professional penetration-test coverage.",
      "The unrelated submission was denied before changing state; its target milestone remains Ready.",
      "Private SIWE and resource-denial checks are proven separately in acceptance #11; this five-case contract lab does not cover path traversal, XSS or a broad browser penetration test.",
    ],
  };
  writeAttackLabResult(result);
  console.log("PHASE4_ATTACK_LAB_RESULT=" + JSON.stringify(result));
}

main().catch((error) => {
  console.error("Attack Lab failed: " + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
});
