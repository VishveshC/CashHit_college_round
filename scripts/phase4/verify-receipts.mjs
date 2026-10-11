import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertRuntimeParentsSafe, localRuntime, verifyOwnedAnvil } from "./runtime.mjs";

const ROOT = localRuntime.root;
const RPC_URL = localRuntime.rpcUrl;
const MARKER_TEXT = "fairwork-phase4-local-runtime-v1";

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Local Anvil returned HTTP ${response.status} for ${method}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Local Anvil ${method} failed: ${payload.error.message ?? "unknown RPC error"}`);
  return payload.result;
}

function readJson(...parts) {
  return JSON.parse(readFileSync(path.join(ROOT, ...parts), "utf8"));
}

function proofFor(entry) {
  return entry.id === 1 ? entry.evidence?.proof : entry.evidence;
}

async function verifyReceipts(references) {
  const unique = new Map();
  for (const reference of references) {
    const key = reference.hash.toLowerCase();
    const prior = unique.get(key);
    if (prior) {
      if (prior.expectedStatus !== reference.expectedStatus || prior.expectedBlockNumber !== reference.expectedBlockNumber) {
        throw new Error(`Acceptance receipt ${reference.hash} is recorded with conflicting values.`);
      }
      prior.acceptanceIds = [...new Set([...prior.acceptanceIds, reference.acceptanceId])].sort((a, b) => a - b);
      continue;
    }
    unique.set(key, { ...reference, acceptanceIds: [reference.acceptanceId] });
  }

  const receipts = [...unique.values()];
  for (let offset = 0; offset < receipts.length; offset += 24) {
    const batch = receipts.slice(offset, offset + 24);
    await Promise.all(batch.map(async (item) => {
      const receipt = await rpc("eth_getTransactionReceipt", [item.hash]);
      if (!receipt) throw new Error(`Live Anvil has no receipt for ${item.hash}.`);
      item.actualStatus = receipt.status === "0x1" ? "success" : receipt.status === "0x0" ? "reverted" : "unknown";
      item.actualBlockNumber = BigInt(receipt.blockNumber).toString();
      item.actualTransactionHash = String(receipt.transactionHash).toLowerCase();
      item.verified = item.actualStatus === item.expectedStatus &&
        item.actualBlockNumber === item.expectedBlockNumber && item.actualTransactionHash === item.hash.toLowerCase();
      if (!item.verified) throw new Error(`Live receipt does not match the recorded acceptance proof for ${item.hash}.`);
    }));
  }
  return receipts.map(({ acceptanceIds, acceptanceId, hash, expectedStatus, expectedBlockNumber, actualStatus, actualBlockNumber, actualTransactionHash, verified }) => ({
    acceptanceIds: acceptanceIds ?? [acceptanceId],
    hash,
    expectedStatus,
    expectedBlockNumber,
    actualStatus,
    actualBlockNumber,
    actualTransactionHash,
    verified,
  }));
}

async function main() {
  assertRuntimeParentsSafe();
  await verifyOwnedAnvil();
  const runtimeDir = path.resolve(ROOT, "infra", "local", "runtime");
  const markerPath = path.join(runtimeDir, ".fairwork-owned");
  if (!existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink() || readFileSync(markerPath, "utf8") !== MARKER_TEXT) {
    throw new Error("Receipt verifier requires the marked owned local runtime directory.");
  }
  const demo = readJson("infra", "local", "runtime", "demo-result.json");
  const manifest = readJson("infra", "local", "deployment.json");
  const attackLab = readJson("infra", "local", "runtime", "attack-lab-result.json");
  const chainId = BigInt(await rpc("eth_chainId"));
  if (chainId !== 31337n || manifest.chainId !== 31337 || demo.deployment?.escrow !== manifest.escrow) {
    throw new Error("Acceptance results do not match the owned chain 31337 deployment.");
  }

  const acceptanceReferences = [];
  for (const entry of demo.acceptanceProgress ?? []) {
    if (entry.status !== "passed") continue;
    const proof = proofFor(entry);
    if (!proof || proof.source !== "fresh-local-anvil" || proof.chainId !== 31337) {
      throw new Error(`Acceptance #${entry.id} is missing a fresh-local-chain proof.`);
    }
    for (const tx of proof.transactions ?? []) {
      acceptanceReferences.push({
        acceptanceId: entry.id,
        hash: String(tx.hash ?? "").toLowerCase(),
        expectedStatus: tx.status,
        expectedBlockNumber: String(tx.blockNumber ?? ""),
      });
    }
  }
  if (acceptanceReferences.length === 0) throw new Error("No acceptance receipts were found to verify.");

  const attackReferences = (attackLab.cases ?? []).map((item) => ({
    name: item.name,
    hash: String(item.transactionHash ?? "").toLowerCase(),
    expectedStatus: item.status === "0x0" ? "reverted" : "unexpected",
    expectedBlockNumber: String(item.blockNumber ?? ""),
  }));
  if (attackLab.outcome !== "PASS" || attackReferences.length !== 5) throw new Error("Expected five completed local Attack Lab transactions.");
  const [acceptanceReceipts, attackReceipts] = await Promise.all([
    verifyReceipts(acceptanceReferences),
    verifyReceipts(attackReferences.map((item) => ({ ...item, acceptanceId: 0 }))),
  ]);
  if (attackReceipts.some((item) => item.actualStatus !== "reverted")) throw new Error("A local Attack Lab transaction did not revert on-chain.");

  const report = {
    source: "live-owned-anvil-rpc",
    chainId: Number(chainId),
    deployment: manifest.escrow,
    demoRunFinishedAt: demo.generatedAt,
    verifiedAt: new Date().toISOString(),
    headBlockNumber: BigInt(await rpc("eth_blockNumber")).toString(),
    acceptance: {
      acceptedProgressIds: demo.acceptanceProgress.filter((item) => item.status === "passed").map((item) => item.id),
      recordedReceiptReferences: acceptanceReferences.length,
      uniqueReceiptCount: acceptanceReceipts.length,
      duplicateReferenceCount: acceptanceReferences.length - acceptanceReceipts.length,
      allReceiptsMatchLiveChain: acceptanceReceipts.every((item) => item.verified),
      receipts: acceptanceReceipts,
    },
    attackLab: {
      attemptedCases: attackReferences.length,
      allTransactionsReverted: attackReceipts.length === 5 && attackReceipts.every((item) => item.actualStatus === "reverted"),
      receipts: attackReceipts.map(({ hash, expectedBlockNumber, actualStatus, actualBlockNumber, actualTransactionHash, verified }, index) => ({
        name: attackReferences[index].name, hash, expectedBlockNumber, actualStatus, actualBlockNumber, actualTransactionHash, verified,
      })),
    },
  };
  if (!report.acceptance.allReceiptsMatchLiveChain || !report.attackLab.allTransactionsReverted) {
    throw new Error("Live acceptance or Attack Lab receipt verification failed.");
  }
  const outputPath = path.join(runtimeDir, "receipt-verification.json");
  if (existsSync(outputPath) && lstatSync(outputPath).isSymbolicLink()) throw new Error("Refusing to replace a linked verification report.");
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({
    report: path.relative(ROOT, outputPath),
    chainId: report.chainId,
    demoRunFinishedAt: report.demoRunFinishedAt,
    acceptedProgressIds: report.acceptance.acceptedProgressIds,
    recordedReceiptReferences: report.acceptance.recordedReceiptReferences,
    uniqueReceiptCount: report.acceptance.uniqueReceiptCount,
    duplicateReferenceCount: report.acceptance.duplicateReferenceCount,
    attackLabReverts: report.attackLab.attemptedCases,
    headBlockNumber: report.headBlockNumber,
    verified: true,
  }));
}

main().catch((error) => {
  console.error("Acceptance receipt verification failed: " + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
});
