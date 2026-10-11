import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, toBytes,
} from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RPC_URL = "http://127.0.0.1:8545";
const LOCAL_CHAIN = {
  id: 31337,
  name: "Fairwork local Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const ZERO_HASH = `0x${"00".repeat(32)}`;
const MAX_U = 10n ** 18n;
const TOKEN_ABI = artifact(["LocalDemoTokens.sol", "MockUSDC.json"]).abi;
const ESCROW_ARTIFACT = artifact(["FairworkEscrow.sol", "FairworkEscrow.json"]);
const ESCROW_ABI = ESCROW_ARTIFACT.abi;
const RANDOMNESS_ABI = artifact(["MockRandomness.sol", "MockRandomness.json"]).abi;
const FEE_TOKEN_ARTIFACT = artifact(["MockTokens.sol", "ConfigurableFeeToken.json"]);
const STANDARD_TOKEN_ARTIFACT = artifact(["MockTokens.sol", "MockToken.json"]);
const REENTRANT_ARTIFACT = artifact(["MockTokens.sol", "ReentrantToken.json"]);

function artifact(parts) {
  const file = path.join(ROOT, "contracts", "out", ...parts);
  return JSON.parse(readFileSync(file, "utf8"));
}

function localHash(label) {
  return keccak256(toBytes("fairwork-phase4-acceptance:" + label));
}

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function assertAcceptanceProof(proof) {
  assert.equal(proof?.source, "fresh-local-anvil", "acceptance proof must come from a fresh local chain");
  assert.equal(proof.chainId, 31337, "acceptance proof must use local chain 31337");
  assert.ok(Array.isArray(proof.transactions) && proof.transactions.length > 0, "acceptance proof needs mined receipts");
  let successfulReceipts = 0;
  for (const receipt of proof.transactions) {
    assert.match(receipt.hash ?? "", /^0x[0-9a-fA-F]{64}$/, "receipt hash must be a real transaction hash");
    assert.match(receipt.blockNumber ?? "", /^[1-9][0-9]*$/, "receipt must include a mined block number");
    assert.ok(["success", "reverted"].includes(receipt.status), "receipt status must be observed from Anvil");
    if (receipt.status === "success") successfulReceipts += 1;
  }
  assert.ok(successfulReceipts > 0, "acceptance proof needs at least one successful receipt");
  assert.ok(Array.isArray(proof.assertions) && proof.assertions.length > 0, "acceptance proof needs observed assertions");
  for (const item of proof.assertions) {
    assert.equal(typeof item.name, "string");
    assert.ok(item.name.length > 0, "acceptance assertion must be named");
    assert.equal(item.passed, true, "acceptance assertion failed: " + item.name);
    assert.deepEqual(canonical(item.actual), canonical(item.expected), "acceptance assertion mismatch: " + item.name);
  }
  return proof;
}

function recorder() {
  return { transactions: [], assertions: [] };
}

function observed(rec, name, expected, actual) {
  const expectedValue = canonical(expected);
  const actualValue = canonical(actual);
  const passed = JSON.stringify(expectedValue) === JSON.stringify(actualValue);
  rec.assertions.push({ name, expected: expectedValue, actual: actualValue, passed });
  if (!passed) throw new Error("Acceptance assertion failed: " + name + ". Expected " + JSON.stringify(expectedValue) + ", got " + JSON.stringify(actualValue) + ".");
}

function proofFor(rec) {
  return assertAcceptanceProof({ source: "fresh-local-anvil", chainId: 31337, ...rec });
}

function wallet(address) {
  return createWalletClient({
    account: getAddress(address),
    chain: LOCAL_CHAIN,
    transport: http(RPC_URL),
  });
}

async function write(rec, address, abi, functionName, args, from, expectedStatus = "success") {
  const data = encodeFunctionData({ abi, functionName, args });
  const client = wallet(from);
  const hash = await client.sendTransaction({
    account: getAddress(from),
    chain: LOCAL_CHAIN,
    to: getAddress(address),
    data,
    gas: 8_000_000n,
  });
  const receipt = await createPublicClient({ chain: LOCAL_CHAIN, pollingInterval: 50, transport: http(RPC_URL) })
    .waitForTransactionReceipt({ hash, timeout: 60_000 });
  const status = receipt.status === "success" ? "success" : "reverted";
  rec.transactions.push({ hash, blockNumber: receipt.blockNumber.toString(), status });
  if (status !== expectedStatus) {
    throw new Error(`${functionName} expected ${expectedStatus} but mined ${status} in block ${receipt.blockNumber}.`);
  }
  return receipt;
}

function chainClients() {
  return createPublicClient({ chain: LOCAL_CHAIN, pollingInterval: 50, transport: http(RPC_URL) });
}

async function read(publicClient, address, abi, functionName, args = []) {
  return publicClient.readContract({ address: getAddress(address), abi, functionName, args });
}

async function timestamp(publicClient) {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return block.timestamp;
}

async function warpTo(target, publicClient) {
  const current = await timestamp(publicClient);
  if (target <= current) throw new Error(`Refusing a non-forward local clock warp (${target} <= ${current}).`);
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setNextBlockTimestamp", params: [`0x${target.toString(16)}`] }),
    signal: AbortSignal.timeout(3_000),
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error("Owned local Anvil rejected a bounded acceptance-test clock warp.");
  }
}

function jobTerms(client, freelancer, token, reviewWindow, revisionLimit, label, amounts, durations) {
  return {
    jobInput: {
      freelancer: getAddress(freelancer),
      token: getAddress(token),
      titleCommitment: localHash(label + ":title"),
      descriptionCommitment: localHash(label + ":description"),
      scopeCommitment: localHash(label + ":scope"),
      deliveryRuleCommitment: localHash(label + ":rules"),
      reviewWindow,
      revisionLimit,
    },
    milestones: amounts.map((amount, index) => ({
      amount,
      duration: durations[index],
      acceptanceCriteriaCommitment: localHash(label + ":criteria:" + index),
    })),
  };
}

async function propose(rec, ctx, { label, amounts = [1001n], durations = [300n], reviewWindow = 120n, revisionLimit = 1, client = ctx.client, freelancer = ctx.freelancer, token = ctx.token }) {
  const publicClient = chainClients();
  const jobId = await read(publicClient, ctx.escrow, ESCROW_ABI, "jobCount");
  const terms = jobTerms(client, freelancer, token, reviewWindow, revisionLimit, label, amounts, durations);
  await write(rec, ctx.escrow, ESCROW_ABI, "createJob", [terms.jobInput, terms.milestones], client);
  return { jobId, amounts, durations, client: getAddress(client), freelancer: getAddress(freelancer), token: getAddress(token), label };
}

async function acceptAndFund(rec, ctx, job) {
  const publicClient = chainClients();
  const terms = await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [job.jobId]);
  const tokenAmount = job.amounts.reduce((sum, amount) => sum + amount, 0n);
  await write(rec, ctx.escrow, ESCROW_ABI, "acceptJob", [job.jobId], job.freelancer);
  await write(rec, job.token, TOKEN_ABI, "approve", [ctx.escrow, tokenAmount], job.client);
  await write(rec, ctx.escrow, ESCROW_ABI, "fundJob", [job.jobId], job.client);
  const funded = await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [job.jobId]);
  observed(rec, job.label + " funded state", 2, Number(funded.state));
  observed(rec, job.label + " funding clock starts at fund", true,
    (await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [job.jobId, 0n])).deadline === funded.fundedAt + job.durations[0]);
  return { ...job, terms };
}

async function fundedJob(rec, ctx, options) {
  return acceptAndFund(rec, ctx, await propose(rec, ctx, options));
}

async function submit(rec, ctx, job, milestone = 0n, label = "submission", expectedStatus = "success") {
  return write(rec, ctx.escrow, ESCROW_ABI, "submitMilestone", [job.jobId, milestone, localHash(job.label + ":" + label), localHash(job.label + ":reference:" + label)], job.freelancer, expectedStatus);
}

async function submitAgain(rec, ctx, job, milestone, version) {
  return write(rec, ctx.escrow, ESCROW_ABI, "resubmitMilestone", [job.jobId, milestone, localHash(job.label + ":submission:" + version), localHash(job.label + ":reference:" + version)], job.freelancer);
}

async function assertSolvent(rec, publicClient, escrow, token, label) {
  const [balance, locked, claimable, deposits, stakes] = await Promise.all([
    read(publicClient, token, TOKEN_ABI, "balanceOf", [escrow]),
    read(publicClient, escrow, ESCROW_ABI, "lockedEscrow", [token]),
    read(publicClient, escrow, ESCROW_ABI, "totalClaimable", [token]),
    read(publicClient, escrow, ESCROW_ABI, "disputeDeposits", [token]),
    read(publicClient, escrow, ESCROW_ABI, "arbiterStakes", [token]),
  ]);
  observed(rec, label + " solvency", true, balance >= locked + claimable + deposits + stakes);
  return { balance, locked, claimable, deposits, stakes };
}

async function scenario3(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  const unaccepted = await propose(rec, ctx, { label: "a3-expired-proposal", amounts: [1001n], durations: [30n] });
  const beforeFund = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [unaccepted.jobId, 0n]);
  observed(rec, "delivery clock is unset before funding", ["0", "0"], [beforeFund.deadline.toString(), beforeFund.graceEnd.toString()]);
  const unacceptedJob = await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [unaccepted.jobId]);
  await warpTo(unacceptedJob.proposalEnd, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "cancelExpiredProposal", [unaccepted.jobId], ctx.outsider);
  observed(rec, "proposal closes at expiry", 3, Number((await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [unaccepted.jobId])).state));

  const expired = await propose(rec, ctx, { label: "a3-expired-funding", amounts: [1001n], durations: [30n] });
  await write(rec, ctx.escrow, ESCROW_ABI, "acceptJob", [expired.jobId], expired.freelancer);
  await write(rec, expired.token, TOKEN_ABI, "approve", [ctx.escrow, 1001n], expired.client);
  const expiredJob = await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [expired.jobId]);
  const expiredMilestone = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [expired.jobId, 0n]);
  observed(rec, "accepted job still has no delivery clock before funding", ["0", "0"], [expiredMilestone.deadline.toString(), expiredMilestone.graceEnd.toString()]);
  await warpTo(expiredJob.fundingDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "fundJob", [expired.jobId], expired.client, "reverted");
  observed(rec, "funding at its half-open deadline remains unfunded", 1, Number((await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [expired.jobId])).state));
  await write(rec, ctx.escrow, ESCROW_ABI, "cancelUnfundedJob", [expired.jobId], ctx.outsider);
  observed(rec, "any caller cancels at funding deadline", 3, Number((await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [expired.jobId])).state));

  const funded = await propose(rec, ctx, { label: "a3-fund-before-boundary", amounts: [1001n], durations: [31n] });
  await write(rec, ctx.escrow, ESCROW_ABI, "acceptJob", [funded.jobId], funded.freelancer);
  await write(rec, funded.token, TOKEN_ABI, "approve", [ctx.escrow, 1001n], funded.client);
  const funding = await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [funded.jobId]);
  await warpTo(funding.fundingDeadline - 1n, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "fundJob", [funded.jobId], funded.client);
  const jobAfter = await read(publicClient, ctx.escrow, ESCROW_ABI, "getJob", [funded.jobId]);
  const milestoneAfter = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [funded.jobId, 0n]);
  observed(rec, "funding one second before deadline succeeds", 2, Number(jobAfter.state));
  observed(rec, "delivery deadline begins at actual funding timestamp", true, milestoneAfter.deadline === jobAfter.fundedAt + 31n);
  return { id: 3, status: "passed", evidence: proofFor(rec) };
}

async function scenario4(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  const graceSubmission = await fundedJob(rec, ctx, { label: "a4-grace-submission", amounts: [1001n], durations: [10n] });
  const graceView = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [graceSubmission.jobId, 0n]);
  await warpTo(graceView.graceEnd - 1n, publicClient);
  await submit(rec, ctx, graceSubmission, 0n, "at-grace-minus-one");
  observed(rec, "submission is accepted during grace and before its half-open end", 1,
    Number((await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [graceSubmission.jobId, 0n])).state));

  const missed = await fundedJob(rec, ctx, { label: "a4-missed-delivery", amounts: [1001n], durations: [10n] });
  const missedView = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [missed.jobId, 0n]);
  await warpTo(missedView.graceEnd, publicClient);
  await submit(rec, ctx, missed, 0n, "at-grace-end", "reverted");
  await write(rec, ctx.escrow, ESCROW_ABI, "refundAfterMissedDeadline", [missed.jobId, 0n], ctx.outsider);
  const refunded = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [missed.jobId, 0n]);
  observed(rec, "permissionless refund is available at grace end", 5, Number(refunded.state));
  observed(rec, "missed delivery credits the client exactly once", 1001n,
    await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [missed.token, missed.client]));
  return { id: 4, status: "passed", evidence: proofFor(rec) };
}

async function scenario5(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  const early = await fundedJob(rec, ctx, { label: "a5-review-minus-one", amounts: [1001n], durations: [300n], reviewWindow: 30n });
  const earlyFreelancerBefore = await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [early.token, early.freelancer]);
  await submit(rec, ctx, early);
  const earlyView = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [early.jobId, 0n]);
  await warpTo(earlyView.reviewEnd - 1n, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "approveMilestone", [early.jobId, 0n], early.client);
  observed(rec, "approval at review end minus one is allowed", 4,
    Number((await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [early.jobId, 0n])).state));
  observed(rec, "approval before review end credits freelancer once", 1001n,
    (await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [early.token, early.freelancer])) - earlyFreelancerBefore);

  const boundary = await fundedJob(rec, ctx, { label: "a5-review-boundary", amounts: [1001n], durations: [300n], reviewWindow: 30n });
  const boundaryFreelancerBefore = await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [boundary.token, boundary.freelancer]);
  const boundaryClientBefore = await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [boundary.token, boundary.client]);
  await submit(rec, ctx, boundary);
  const view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [boundary.jobId, 0n]);
  await warpTo(view.reviewEnd, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "approveMilestone", [boundary.jobId, 0n], boundary.client, "reverted");
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [boundary.jobId, 0n, localHash("a5-reject-at-end")], boundary.client, "reverted");
  await write(rec, ctx.escrow, ESCROW_ABI, "approveMilestone", [boundary.jobId, 0n], boundary.client, "reverted");
  await write(rec, ctx.escrow, ESCROW_ABI, "releaseAfterSilence", [boundary.jobId, 0n], ctx.outsider);
  const milestone = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [boundary.jobId, 0n]);
  observed(rec, "approval and rejection are closed at review end; timeout releases", 4, Number(milestone.state));
  observed(rec, "review boundary release credits only freelancer", [1001n, 0n], [
    (await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [boundary.token, boundary.freelancer])) - boundaryFreelancerBefore,
    (await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [boundary.token, boundary.client])) - boundaryClientBefore,
  ]);
  return { id: 5, status: "passed", evidence: proofFor(rec) };
}

async function scenario6(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  const independent = await fundedJob(rec, ctx, {
    label: "a6-per-milestone", amounts: [1001n, 1003n], durations: [300n, 300n], revisionLimit: 1,
  });
  await submit(rec, ctx, independent, 0n, "m0-v1");
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [independent.jobId, 0n, localHash("a6-m0-reject-1")], independent.client);
  await submitAgain(rec, ctx, independent, 0n, 2);
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [independent.jobId, 0n, localHash("a6-m0-reject-2")], independent.client, "reverted");
  await submit(rec, ctx, independent, 1n, "m1-v1");
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [independent.jobId, 1n, localHash("a6-m1-reject-1")], independent.client);
  const m0 = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [independent.jobId, 0n]);
  const m1 = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [independent.jobId, 1n]);
  const first = await read(publicClient, ctx.escrow, ESCROW_ABI, "getSubmission", [independent.jobId, 0n, 0n]);
  const second = await read(publicClient, ctx.escrow, ESCROW_ABI, "getSubmission", [independent.jobId, 0n, 1n]);
  observed(rec, "each milestone owns an independent rejection counter", [1, 1], [Number(m0.rejectionCount), Number(m1.rejectionCount)]);
  observed(rec, "resubmission appends immutable history", [1, 2, true], [Number(first.version), Number(second.version), first.deliverableHash !== second.deliverableHash]);

  const zero = await fundedJob(rec, ctx, { label: "a6-limit-zero", amounts: [1001n], durations: [300n], revisionLimit: 0, reviewWindow: 30n });
  await submit(rec, ctx, zero);
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [zero.jobId, 0n, localHash("a6-zero-reject")], zero.client, "reverted");
  const zeroView = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [zero.jobId, 0n]);
  await warpTo(zeroView.reviewEnd, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "releaseAfterSilence", [zero.jobId, 0n], ctx.outsider);
  observed(rec, "revision limit zero still permits review-silence release", 4,
    Number((await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [zero.jobId, 0n])).state));

  const five = await fundedJob(rec, ctx, { label: "a6-limit-five", amounts: [1001n], durations: [300n], revisionLimit: 5, reviewWindow: 120n });
  for (let index = 0; index < 5; index += 1) {
    if (index === 0) await submit(rec, ctx, five, 0n, "limit-five-v1");
    await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [five.jobId, 0n, localHash("a6-five-reject:" + index)], five.client);
    await submitAgain(rec, ctx, five, 0n, index + 2);
  }
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [five.jobId, 0n, localHash("a6-five-over-limit")], five.client, "reverted");
  const fiveView = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [five.jobId, 0n]);
  const history = [];
  for (let index = 0; index < 6; index += 1) {
    history.push(await read(publicClient, ctx.escrow, ESCROW_ABI, "getSubmission", [five.jobId, 0n, BigInt(index)]));
  }
  observed(rec, "revision limit five caps rejection and history at six versions", [5, 6, true], [Number(fiveView.rejectionCount), Number(fiveView.submissionCount), history.every((item, index) => Number(item.version) === index + 1)]);
  await warpTo(fiveView.reviewEnd, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "releaseAfterSilence", [five.jobId, 0n], ctx.outsider);
  observed(rec, "exhausted revision limit exits by auto-release", 4,
    Number((await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [five.jobId, 0n])).state));

  const late = await fundedJob(rec, ctx, { label: "a6-resubmit-after-grace", amounts: [1001n], durations: [10n], reviewWindow: 30n, revisionLimit: 1 });
  const lateInitial = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [late.jobId, 0n]);
  await warpTo(lateInitial.graceEnd - 20n, publicClient);
  await submit(rec, ctx, late, 0n, "near-grace-end");
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [late.jobId, 0n, localHash("a6-late-reject")], late.client);
  const rejected = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [late.jobId, 0n]);
  await warpTo(lateInitial.graceEnd + 1n, publicClient);
  await submitAgain(rec, ctx, late, 0n, 2);
  const resubmitted = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [late.jobId, 0n]);
  observed(rec, "resubmission after original grace remains open before response end", true,
    resubmitted.submittedAt > lateInitial.graceEnd && resubmitted.submittedAt < rejected.responseEnd);
  observed(rec, "resubmission starts a fresh review window", true, resubmitted.reviewEnd === resubmitted.submittedAt + 30n);
  return { id: 6, status: "passed", evidence: proofFor(rec) };
}

async function scenario7(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  const lockedBefore = await read(publicClient, ctx.escrow, ESCROW_ABI, "lockedEscrow", [ctx.token]);
  const job = await fundedJob(rec, ctx, { label: "a7-dispute-stops-rejection-refund", amounts: [1001n], durations: [300n], reviewWindow: 120n, revisionLimit: 1 });
  await submit(rec, ctx, job);
  await write(rec, ctx.escrow, ESCROW_ABI, "rejectMilestone", [job.jobId, 0n, localHash("a7-rejected")], job.client);
  const rejected = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [job.jobId, 0n]);
  const deposit = 20n;
  await write(rec, job.token, TOKEN_ABI, "approve", [ctx.escrow, deposit], job.freelancer);
  await warpTo(rejected.responseEnd - 1n, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "openDispute", [job.jobId, 0n], job.freelancer);
  await warpTo(rejected.responseEnd, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "refundAfterRejectionWindow", [job.jobId, 0n], ctx.outsider, "reverted");
  const current = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestone", [job.jobId, 0n]);
  observed(rec, "dispute opened during response window stops rejection refund", 3, Number(current.state));
  observed(rec, "dispute principal remains locked", lockedBefore + 1001n,
    await read(publicClient, ctx.escrow, ESCROW_ABI, "lockedEscrow", [job.token]));
  observed(rec, "opener deposit remains a tracked liability", deposit,
    await read(publicClient, ctx.escrow, ESCROW_ABI, "disputeDeposits", [job.token]));
  return { id: 7, status: "passed", evidence: proofFor(rec) };
}

async function openDispute(rec, ctx, { label, amount = 1001n, clientOpens = true, matchDeposit = false, evidence = false, token = ctx.token }) {
  const publicClient = chainClients();
  const job = await fundedJob(rec, ctx, { label, amounts: [amount], durations: [300n], reviewWindow: 120n, revisionLimit: 1, token });
  await submit(rec, ctx, job);
  const opener = clientOpens ? job.client : job.freelancer;
  const counterparty = clientOpens ? job.freelancer : job.client;
  const deposit = amount * 200n / 10_000n || 1n;
  await write(rec, job.token, TOKEN_ABI, "approve", [ctx.escrow, deposit], opener);
  const disputeBefore = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestoneDispute", [job.jobId, 0n]);
  observed(rec, label + " has no dispute before opening", 0n, disputeBefore);
  await write(rec, ctx.escrow, ESCROW_ABI, "openDispute", [job.jobId, 0n], opener);
  const actualDisputeId = await read(publicClient, ctx.escrow, ESCROW_ABI, "getMilestoneDispute", [job.jobId, 0n]);
  observed(rec, label + " gets a new dispute id", true, actualDisputeId > 0n);
  if (matchDeposit) {
    await write(rec, job.token, TOKEN_ABI, "approve", [ctx.escrow, deposit], counterparty);
    await write(rec, ctx.escrow, ESCROW_ABI, "matchDisputeDeposit", [actualDisputeId], counterparty);
  }
  if (evidence) {
    for (let index = 0; index < 5; index += 1) {
      await write(rec, ctx.escrow, ESCROW_ABI, "submitEvidence", [actualDisputeId, localHash(label + ":client-evidence:" + index), localHash(label + ":client-ref:" + index)], job.client);
      await write(rec, ctx.escrow, ESCROW_ABI, "submitEvidence", [actualDisputeId, localHash(label + ":freelancer-evidence:" + index), localHash(label + ":freelancer-ref:" + index)], job.freelancer);
    }
  }
  return { ...job, disputeId: actualDisputeId, deposit, opener, counterparty };
}

async function startPanel1(rec, ctx, dispute) {
  const publicClient = chainClients();
  const opened = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [dispute.disputeId]);
  await write(rec, ctx.randomness, RANDOMNESS_ABI, "setRequestMode", [2], ctx.deployer);
  await warpTo(opened.evidenceDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [dispute.disputeId], ctx.outsider);
  const pending = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [dispute.disputeId]);
  observed(rec, dispute.label + " requests first random panel", 2, Number(pending.phase));
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [dispute.disputeId], ctx.outsider);
  const current = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [dispute.disputeId]);
  const panel = await read(publicClient, ctx.escrow, ESCROW_ABI, "getPanel", [dispute.disputeId, 1]);
  const addresses = panel.map((address) => getAddress(address));
  observed(rec, dispute.label + " selects three distinct allowlisted arbiters outside the parties", true,
    new Set(addresses.map((address) => address.toLowerCase())).size === 3 && addresses.every((address) =>
      ctx.arbiters.some((arbiter) => arbiter.toLowerCase() === address.toLowerCase()) &&
      address.toLowerCase() !== dispute.client.toLowerCase() && address.toLowerCase() !== dispute.freelancer.toLowerCase())
      ? true
      : { addresses, registry: ctx.arbiters, client: dispute.client, freelancer: dispute.freelancer });
  observed(rec, dispute.label + " reaches first panel commit", 3, Number(current.phase));
  return { panel: addresses, current };
}

async function commitVotes(rec, ctx, disputeId, panel, bpsValues) {
  for (let index = 0; index < panel.length; index += 1) {
    if (bpsValues[index] === null) continue;
    const existing = await read(chainClients(), ctx.escrow, ESCROW_ABI, "getVote", [disputeId, 1, panel[index]]);
    if (existing[0] !== ZERO_HASH) continue;
    const salt = localHash("vote-salt:" + disputeId + ":" + panel[index]);
    const commitment = await read(chainClients(), ctx.escrow, ESCROW_ABI, "voteCommitment", [disputeId, panel[index], bpsValues[index], salt]);
    await write(rec, ctx.escrow, ESCROW_ABI, "commitVote", [disputeId, commitment], panel[index]);
  }
}

async function revealVotes(rec, ctx, disputeId, panel, bpsValues, count) {
  for (let index = 0; index < count; index += 1) {
    const salt = localHash("vote-salt:" + disputeId + ":" + panel[index]);
    await write(rec, ctx.escrow, ESCROW_ABI, "revealVote", [disputeId, bpsValues[index], salt], panel[index]);
  }
}

async function finishRuling(rec, ctx, dispute, panel, bpsValues, reveals) {
  const publicClient = chainClients();
  await commitVotes(rec, ctx, dispute.disputeId, panel, bpsValues);
  const current = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [dispute.disputeId]);
  await warpTo(current.commitDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [dispute.disputeId], ctx.outsider);
  await revealVotes(rec, ctx, dispute.disputeId, panel, bpsValues, reveals);
  const revealPhase = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [dispute.disputeId]);
  await warpTo(revealPhase.revealDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [dispute.disputeId], ctx.outsider);
  return read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [dispute.disputeId]);
}

async function scenario8(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  await write(rec, ctx.randomness, RANDOMNESS_ABI, "setRequestMode", [2], ctx.deployer);
  const initialDeposits = await read(publicClient, ctx.escrow, ESCROW_ABI, "disputeDeposits", [ctx.token]);
  const beforeMatched = await Promise.all([
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [ctx.token, ctx.client]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [ctx.token, ctx.freelancer]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [ctx.token, ctx.treasury]),
  ]);
  const dispute = await openDispute(rec, ctx, { label: "a8-evidence-matched-deposit-two-vote-mean", matchDeposit: true, evidence: true });
  await write(rec, ctx.escrow, ESCROW_ABI, "submitEvidence", [dispute.disputeId, localHash("a8-evidence-6"), localHash("a8-ref-6")], dispute.client, "reverted");
  await write(rec, ctx.escrow, ESCROW_ABI, "submitEvidence", [dispute.disputeId, localHash("a8-outsider-evidence"), localHash("a8-outsider-ref")], ctx.outsider, "reverted");
  await write(rec, ctx.escrow, ESCROW_ABI, "matchDisputeDeposit", [dispute.disputeId], dispute.counterparty, "reverted");
  const opened = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [dispute.disputeId]);
  observed(rec, "both parties have exactly five evidence items", [5, 5, true, true], [Number(opened.clientEvidenceCount), Number(opened.freelancerEvidenceCount), opened.clientDeposited, opened.freelancerDeposited]);
  const { panel } = await startPanel1(rec, ctx, dispute);
  const ruling = await finishRuling(rec, ctx, dispute, panel, [1000, 9000, 5000], 2);
  observed(rec, "two-vote ruling is the floored arithmetic mean", 5000, Number(ruling.rulingBps));
  observed(rec, "matched deposit dispute settles", 10, Number(ruling.phase));
  observed(rec, "matched dispute removes exactly its two posted deposits", initialDeposits,
    await read(publicClient, ctx.escrow, ESCROW_ABI, "disputeDeposits", [dispute.token]));
  const amounts = await Promise.all([
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [dispute.token, dispute.client]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [dispute.token, dispute.freelancer]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [dispute.token, ctx.treasury]),
  ]);
  observed(rec, "odd principal and matched deposits conserve raw units", [511n, 510n, 20n], amounts.map((value, index) => value - beforeMatched[index]));
  await assertSolvent(rec, publicClient, ctx.escrow, dispute.token, "matched-dispute token");

  const noShow = await openDispute(rec, ctx, { label: "a8-no-show-replacement" });
  const started = await startPanel1(rec, ctx, noShow);
  await commitVotes(rec, ctx, noShow.disputeId, started.panel, [5000, 6000, null]);
  let view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [noShow.disputeId]);
  await warpTo(view.commitDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [noShow.disputeId], ctx.outsider);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [noShow.disputeId]);
  observed(rec, "missing first-panel commitment requests replacement", 4, Number(view.phase));
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [noShow.disputeId], ctx.outsider);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [noShow.disputeId]);
  const replacementPanel = (await read(publicClient, ctx.escrow, ESCROW_ABI, "getPanel", [noShow.disputeId, 1])).map((address) => getAddress(address));
  const history = (await read(publicClient, ctx.escrow, ESCROW_ABI, "getPanel1History", [noShow.disputeId])).map((address) => getAddress(address));
  observed(rec, "replacement is distinct and appended to panel history", true,
    history.length === 4 && new Set(history.map((address) => address.toLowerCase())).size === 4 && replacementPanel.every((address) => history.some((item) => item.toLowerCase() === address.toLowerCase())));
  observed(rec, "replacement member receives a bounded commit window", 5, Number(view.phase));
  await commitVotes(rec, ctx, noShow.disputeId, replacementPanel, [5000, 6000, 7000]);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [noShow.disputeId]);
  await warpTo(view.replacementCommitDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [noShow.disputeId], ctx.outsider);
  await revealVotes(rec, ctx, noShow.disputeId, replacementPanel, [5000, 6000, 7000], 2);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [noShow.disputeId]);
  await warpTo(view.revealDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [noShow.disputeId], ctx.outsider);
  const replacedRuling = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [noShow.disputeId]);
  observed(rec, "replacement panel reaches quorum and settles", [10, 5500], [Number(replacedRuling.phase), Number(replacedRuling.rulingBps)]);

  const secondPanel = await openDispute(rec, ctx, { label: "a8-fresh-second-panel-no-quorum" });
  const beforeFallback = await Promise.all([
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [secondPanel.token, secondPanel.client]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [secondPanel.token, secondPanel.freelancer]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [secondPanel.token, ctx.treasury]),
  ]);
  const first = await startPanel1(rec, ctx, secondPanel);
  await commitVotes(rec, ctx, secondPanel.disputeId, first.panel, [4000, 5000, 6000]);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [secondPanel.disputeId]);
  await warpTo(view.commitDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [secondPanel.disputeId], ctx.outsider);
  await revealVotes(rec, ctx, secondPanel.disputeId, first.panel, [4000, 5000, 6000], 1);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [secondPanel.disputeId]);
  await warpTo(view.revealDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [secondPanel.disputeId], ctx.outsider);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [secondPanel.disputeId]);
  observed(rec, "first panel without quorum starts a fresh draw", 7, Number(view.phase));
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [secondPanel.disputeId], ctx.outsider);
  const panel2View = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [secondPanel.disputeId]);
  const panel2 = (await read(publicClient, ctx.escrow, ESCROW_ABI, "getPanel", [secondPanel.disputeId, 2])).map((address) => getAddress(address));
  const secondHistory = (await read(publicClient, ctx.escrow, ESCROW_ABI, "getPanel1History", [secondPanel.disputeId])).map((address) => getAddress(address));
  observed(rec, "second panel excludes all first-panel history and parties", true,
    panel2.length === 3 && new Set(panel2.map((address) => address.toLowerCase())).size === 3 && panel2.every((address) =>
      !secondHistory.some((item) => item.toLowerCase() === address.toLowerCase()) &&
      address.toLowerCase() !== secondPanel.client.toLowerCase() && address.toLowerCase() !== secondPanel.freelancer.toLowerCase()));
  observed(rec, "second panel enters its own commit phase", 8, Number(panel2View.phase));
  await commitVotes(rec, ctx, secondPanel.disputeId, panel2, [1000, 5000, 9000]);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [secondPanel.disputeId]);
  await warpTo(view.commitDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [secondPanel.disputeId], ctx.outsider);
  await revealVotes(rec, ctx, secondPanel.disputeId, panel2, [1000, 5000, 9000], 1);
  view = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [secondPanel.disputeId]);
  await warpTo(view.revealDeadline, publicClient);
  await write(rec, ctx.escrow, ESCROW_ABI, "advanceDispute", [secondPanel.disputeId], ctx.outsider);
  const fallback = await read(publicClient, ctx.escrow, ESCROW_ABI, "getDispute", [secondPanel.disputeId]);
  observed(rec, "second-panel no-quorum applies documented 50/50 fallback", [10, 5000, true], [Number(fallback.phase), Number(fallback.rulingBps), fallback.fallbackApplied]);
  const fallbackCredits = await Promise.all([
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [secondPanel.token, secondPanel.client]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [secondPanel.token, secondPanel.freelancer]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [secondPanel.token, ctx.treasury]),
  ]);
  observed(rec, "fallback returns deposits and charges no forfeiture fee", [521n, 500n, 0n], fallbackCredits.map((value, index) => value - beforeFallback[index]));
  await assertSolvent(rec, publicClient, ctx.escrow, secondPanel.token, "no-quorum dispute token");
  return { id: 8, status: "passed", evidence: proofFor(rec) };
}

async function settleBpsCase(rec, ctx, bps, token, tokenLabel) {
  const publicClient = chainClients();
  const before = await Promise.all([
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [token, ctx.client]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [token, ctx.freelancer]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [token, ctx.treasury]),
  ]);
  const dispute = await openDispute(rec, ctx, { label: `a9-${tokenLabel}-bps-${bps}`, amount: 1001n, clientOpens: true, token });
  const { panel } = await startPanel1(rec, ctx, dispute);
  const ruling = await finishRuling(rec, ctx, dispute, panel, [bps, bps, bps], 3);
  const totals = await Promise.all([
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [token, dispute.client]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [token, dispute.freelancer]),
    read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [token, ctx.treasury]),
  ]);
  const actual = totals.map((value, index) => value - before[index]);
  observed(rec, `${tokenLabel} ruling uses requested raw basis points`, bps, Number(ruling.rulingBps));
  observed(rec, `${tokenLabel} ruling principal plus deposit conserves every raw unit`, 1021n, actual.reduce((sum, value) => sum + value, 0n));
  const amount = 1001n;
  const deposit = 20n;
  const freelancerPrincipal = amount * BigInt(bps) / 10_000n;
  const clientPrincipal = amount - freelancerPrincipal;
  const clientForfeit = bps > 5000 ? deposit : bps === 5000 ? deposit / 2n : 0n;
  const freelancerForfeitDue = bps < 5000 ? deposit : bps === 5000 ? deposit / 2n : 0n;
  const freelancerPrincipalForfeit = freelancerForfeitDue < freelancerPrincipal ? freelancerForfeitDue : freelancerPrincipal;
  const expected = [
    clientPrincipal + deposit - clientForfeit,
    freelancerPrincipal - freelancerPrincipalForfeit,
    clientForfeit + freelancerPrincipalForfeit,
  ];
  observed(rec, `${tokenLabel} ruling payout follows floor(raw * bps / 10000)`, expected, actual);
  await assertSolvent(rec, publicClient, ctx.escrow, token, tokenLabel + " ruling token");
}

async function scenario9(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  for (const bps of [0, 1, 3333, 5000, 6667, 9999, 10000]) {
    await settleBpsCase(rec, ctx, bps, ctx.token, "six-decimal");
  }
  // The same odd raw-unit arithmetic is exercised with the configured eight-decimal token.
  const wbctBps = [0, 3333, 5000, 10000];
  const wbtc = ctx.wbtc;
  await write(rec, wbtc, TOKEN_ABI, "mint", [ctx.client, 20_000n], ctx.deployer);
  for (const bps of wbctBps) {
    await settleBpsCase(rec, ctx, bps, wbtc, "eight-decimal");
  }
  const eighteenToken = await deployArtifact(rec, ctx, STANDARD_TOKEN_ARTIFACT, ["Eighteen Decimal Test", "E18", 18], "18-decimal token");
  const eighteenEscrow = await deployFixtureEscrow(rec, ctx, eighteenToken, TOKEN_ABI, 18, "18-decimal");
  const eighteenRandomness = await read(publicClient, eighteenEscrow, ESCROW_ABI, "randomness");
  await write(rec, eighteenToken, TOKEN_ABI, "mint", [ctx.client, 20_000n], ctx.deployer);
  const eighteenCtx = { ...ctx, escrow: eighteenEscrow, token: eighteenToken, randomness: getAddress(eighteenRandomness) };
  for (const bps of [0, 3333, 5000, 10000]) {
    await settleBpsCase(rec, eighteenCtx, bps, eighteenToken, "eighteen-decimal");
  }
  await assertSolvent(rec, publicClient, ctx.escrow, ctx.token, "six-decimal total ledger");
  await assertSolvent(rec, publicClient, ctx.escrow, wbtc, "eight-decimal total ledger");
  await assertSolvent(rec, publicClient, eighteenEscrow, eighteenToken, "18-decimal total ledger");
  observed(rec, "18-decimal token keeps odd amount in raw integer units", 1001n,
    (await read(publicClient, eighteenEscrow, ESCROW_ABI, "getMilestone", [0n, 0n])).amount);
  return { id: 9, status: "passed", evidence: proofFor(rec) };
}

async function deployArtifact(rec, ctx, artifactValue, args, label) {
  const deployer = wallet(ctx.deployer);
  const hash = await deployer.deployContract({ abi: artifactValue.abi, bytecode: artifactValue.bytecode.object, args, gas: 15_000_000n });
  const receipt = await chainClients().waitForTransactionReceipt({ hash, timeout: 60_000 });
  const status = receipt.status === "success" ? "success" : "reverted";
  rec.transactions.push({ hash, blockNumber: receipt.blockNumber.toString(), status });
  if (status !== "success" || !receipt.contractAddress) throw new Error("Could not deploy local acceptance fixture " + label + ".");
  return getAddress(receipt.contractAddress);
}

async function deployFixtureEscrow(rec, ctx, token, tokenAbi, decimals, label) {
  const publicClient = chainClients();
  const artifactValue = ESCROW_ARTIFACT;
  const code = await publicClient.getCode({ address: token });
  const actualDecimals = await read(publicClient, token, tokenAbi, "decimals");
  observed(rec, label + " fixture decimals match configured token", decimals, Number(actualDecimals));
  const tuple = [[token, decimals, 1n, MAX_U, ZERO_HASH]];
  const protocol = [60n, 60n, 1n, 31_536_000n, 1n, 31_536_000n];
  const escrow = await deployArtifact(rec, ctx, artifactValue, [tuple, protocol, ctx.treasury], label + " escrow");
  observed(rec, label + " token runtime exists for immutable codehash pin", true, Boolean(code && code !== "0x"));
  for (const arbiter of ctx.arbiters) {
    await write(rec, escrow, ESCROW_ABI, "addArbiter", [arbiter], ctx.deployer);
  }
  return escrow;
}

async function scenario10(ctx) {
  const rec = recorder();
  const publicClient = chainClients();
  const baseline = await assertSolvent(rec, publicClient, ctx.escrow, ctx.token, "before direct surplus");
  await write(rec, ctx.token, TOKEN_ABI, "transfer", [ctx.escrow, 777n], ctx.deployer);
  const surplus = await assertSolvent(rec, publicClient, ctx.escrow, ctx.token, "after direct surplus");
  observed(rec, "direct token transfer adds no ledger liability", [baseline.locked, baseline.claimable, baseline.deposits, baseline.stakes], [surplus.locked, surplus.claimable, surplus.deposits, surplus.stakes]);
  observed(rec, "direct transfer remains unassigned surplus", baseline.balance + 777n, surplus.balance);

  const feeToken = await deployArtifact(rec, ctx, FEE_TOKEN_ARTIFACT, ["Fee Test", "FEE", 6, 100], "fee-on-transfer token");
  const feeEscrow = await deployFixtureEscrow(rec, ctx, feeToken, TOKEN_ABI, 6, "fee-on-transfer");
  await write(rec, feeToken, TOKEN_ABI, "mint", [ctx.client, 5000n], ctx.deployer);
  const feeClientBefore = await read(publicClient, feeToken, TOKEN_ABI, "balanceOf", [ctx.client]);
  const feeJob = await propose(rec, { ...ctx, escrow: feeEscrow, token: feeToken }, { label: "a10-fee-transfer", token: feeToken, amounts: [1001n], durations: [300n] });
  await write(rec, feeEscrow, ESCROW_ABI, "acceptJob", [feeJob.jobId], feeJob.freelancer);
  await write(rec, feeToken, TOKEN_ABI, "approve", [feeEscrow, 1001n], feeJob.client);
  await write(rec, feeToken, FEE_TOKEN_ARTIFACT.abi, "setFeeEnabled", [true], ctx.deployer);
  await write(rec, feeEscrow, ESCROW_ABI, "fundJob", [feeJob.jobId], feeJob.client, "reverted");
  observed(rec, "fee-on-transfer funding rolls back state and liabilities", [1, 0n, 0n, feeClientBefore], [
    Number((await read(publicClient, feeEscrow, ESCROW_ABI, "getJob", [feeJob.jobId])).state),
    await read(publicClient, feeEscrow, ESCROW_ABI, "lockedEscrow", [feeToken]),
    await read(publicClient, feeToken, TOKEN_ABI, "balanceOf", [feeEscrow]),
    await read(publicClient, feeToken, TOKEN_ABI, "balanceOf", [feeJob.client]),
  ]);
  await assertSolvent(rec, publicClient, feeEscrow, feeToken, "fee-token rollback");

  const reentrantToken = await deployArtifact(rec, ctx, REENTRANT_ARTIFACT, [6], "reentrant token");
  const reentrantEscrow = await deployFixtureEscrow(rec, ctx, reentrantToken, TOKEN_ABI, 6, "reentrant");
  const amount = 1001n;
  await write(rec, reentrantToken, TOKEN_ABI, "mint", [reentrantToken, amount], ctx.deployer);
  const rtAbi = REENTRANT_ARTIFACT.abi;
  const clientApproval = encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [reentrantEscrow, amount] });
  await write(rec, reentrantToken, rtAbi, "configureCallback", [reentrantToken, clientApproval, false, false], ctx.deployer);
  await write(rec, reentrantToken, rtAbi, "callConfiguredTarget", [], ctx.deployer);
  const hostileJobId = await read(publicClient, reentrantEscrow, ESCROW_ABI, "jobCount");
  const hostileTerms = jobTerms(reentrantToken, ctx.freelancer, reentrantToken, 30n, 0, "a10-reentrant-withdrawal", [amount], [10n]);
  const createCall = encodeFunctionData({ abi: ESCROW_ABI, functionName: "createJob", args: [hostileTerms.jobInput, hostileTerms.milestones] });
  await write(rec, reentrantToken, rtAbi, "configureCallback", [reentrantEscrow, createCall, false, false], ctx.deployer);
  await write(rec, reentrantToken, rtAbi, "callConfiguredTarget", [], ctx.deployer);
  const hostileJob = { jobId: hostileJobId, amounts: [amount], durations: [10n], client: reentrantToken, freelancer: ctx.freelancer, token: reentrantToken, label: "a10-reentrant-withdrawal" };
  observed(rec, "reentrant token created the job as the client", reentrantToken,
    (await read(publicClient, reentrantEscrow, ESCROW_ABI, "getJob", [hostileJobId])).client);
  await write(rec, reentrantEscrow, ESCROW_ABI, "acceptJob", [hostileJob.jobId], hostileJob.freelancer);
  const fundCall = encodeFunctionData({ abi: ESCROW_ABI, functionName: "fundJob", args: [hostileJob.jobId] });
  await write(rec, reentrantToken, rtAbi, "configureCallback", [reentrantEscrow, fundCall, false, false], ctx.deployer);
  await write(rec, reentrantToken, rtAbi, "callConfiguredTarget", [], ctx.deployer);
  const fundedMilestone = await read(publicClient, reentrantEscrow, ESCROW_ABI, "getMilestone", [hostileJob.jobId, 0n]);
  await warpTo(fundedMilestone.graceEnd, publicClient);
  await write(rec, reentrantEscrow, ESCROW_ABI, "refundAfterMissedDeadline", [hostileJob.jobId, 0n], ctx.outsider);
  const withdrawCall = encodeFunctionData({ abi: ESCROW_ABI, functionName: "withdraw", args: [reentrantToken] });
  await write(rec, reentrantToken, rtAbi, "configureCallback", [reentrantEscrow, withdrawCall, false, true], ctx.deployer);
  await write(rec, reentrantToken, rtAbi, "callConfiguredTarget", [], ctx.deployer);
  observed(rec, "withdrawal callback attempted and reentrant settlement was blocked", [true, false, 0n], [
    await read(publicClient, reentrantToken, rtAbi, "reentryAttempted"),
    await read(publicClient, reentrantToken, rtAbi, "reentrySucceeded"),
    await read(publicClient, reentrantToken, rtAbi, "observedClaimable"),
  ]);
  observed(rec, "effects-first withdrawal clears the contract caller ledger", [0n, 0n], [
    await read(publicClient, reentrantEscrow, ESCROW_ABI, "claimable", [reentrantToken, reentrantToken]),
    await read(publicClient, reentrantEscrow, ESCROW_ABI, "totalClaimable", [reentrantToken]),
  ]);
  await assertSolvent(rec, publicClient, reentrantEscrow, reentrantToken, "reentrant withdrawal");

  for (const mainToken of [ctx.token, ctx.wbtc]) {
    for (const account of [ctx.client, ctx.freelancer, ctx.treasury]) {
      const amountToWithdraw = await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [mainToken, account]);
      if (amountToWithdraw > 0n) await write(rec, ctx.escrow, ESCROW_ABI, "withdraw", [mainToken], account);
    }
    observed(rec, "local acceptance fixture drains each role claim before the interactive seed", 0n,
      await read(publicClient, ctx.escrow, ESCROW_ABI, "totalClaimable", [mainToken]));
  }
  await write(rec, ctx.escrow, ESCROW_ABI, "withdraw", [ctx.token], ctx.freelancer, "reverted");
  observed(rec, "empty or repeated pull withdrawal remains denied", 0n,
    await read(publicClient, ctx.escrow, ESCROW_ABI, "claimable", [ctx.token, ctx.freelancer]));

  const wbtcBalance = await read(publicClient, ctx.wbtc, TOKEN_ABI, "balanceOf", [ctx.escrow]);
  observed(rec, "configured second-token ledger starts solvent", true,
    wbtcBalance >= await read(publicClient, ctx.escrow, ESCROW_ABI, "lockedEscrow", [ctx.wbtc]));
  await assertSolvent(rec, publicClient, ctx.escrow, ctx.token, "main six-decimal escrow");
  await assertSolvent(rec, publicClient, ctx.escrow, ctx.wbtc, "main eight-decimal escrow");
  return { id: 10, status: "passed", evidence: proofFor(rec) };
}

export async function runAcceptanceScenarios(options) {
  const publicClient = chainClients();
  const ctx = {
    escrow: getAddress(options.escrow),
    token: getAddress(options.token),
    wbtc: getAddress(options.wbtc),
    randomness: getAddress(options.randomness),
    deployer: getAddress(options.roles.treasury),
    treasury: getAddress(options.roles.treasury),
    client: getAddress(options.roles.client),
    freelancer: getAddress(options.roles.freelancer),
    outsider: getAddress(options.roles.outsider),
    arbiters: options.roles.arbiters.map((address) => getAddress(address)),
  };
  for (const [token, amount] of [[ctx.token, 10n ** 15n], [ctx.wbtc, 10n ** 15n]]) {
    await write(recorder(), token, TOKEN_ABI, "mint", [ctx.client, amount], ctx.deployer);
  }
  await write(recorder(), ctx.token, TOKEN_ABI, "mint", [ctx.freelancer, 10n ** 15n], ctx.deployer);
  await write(recorder(), ctx.token, TOKEN_ABI, "mint", [ctx.deployer, 10n ** 15n], ctx.deployer);
  const results = [];
  results.push(await scenario3(ctx));
  results.push(await scenario4(ctx));
  results.push(await scenario5(ctx));
  results.push(await scenario6(ctx));
  results.push(await scenario7(ctx));
  results.push(await scenario8(ctx));
  results.push(await scenario9(ctx));
  results.push(await scenario10(ctx));
  return results;
}
