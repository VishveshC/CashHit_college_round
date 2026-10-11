#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireWeb = createRequire(path.join(root, "apps", "web", "package.json"));
const { createPublicClient, decodeEventLog, http, keccak256 } = requireWeb("viem");

const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const deployment = json("infra/local/deployment.json");
const escrowArtifact = json("packages/chain/generated/FairworkEscrow.json");
const arbitrationArtifact = json("packages/chain/generated/FairworkArbitration.json");
const randomnessArtifact = json("packages/chain/generated/MockRandomness.json");
const fromBlock = 526n;
const client = createPublicClient({ transport: http(deployment.rpcUrl) });
const escrow = deployment.escrow;
const arbitration = deployment.arbitration;
const randomness = deployment.randomness;
const escrowAbi = escrowArtifact.abi;
const arbitrationAbi = arbitrationArtifact.abi;
const randomnessAbi = randomnessArtifact.abi;

const tokenEventAbi = [
  {
    type: "event",
    name: "Approval",
    anonymous: false,
    inputs: [
      { indexed: true, name: "owner", type: "address" },
      { indexed: true, name: "spender", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
];

const safe = (value) => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]));
  }
  return value;
};

const pick = (value, fields) => Object.fromEntries(fields.map((field) => [field, safe(value?.[field])]));

const sourceFiles = [
  "contracts/src/FairworkEscrow.sol",
  "contracts/src/FairworkArbitration.sol",
  "contracts/src/interfaces/IRandomness.sol",
  "contracts/src/mocks/MockRandomness.sol",
];
const phase3Hashes = new Map(json("docs/phase3-source-final.json").map((entry) => [entry.file, entry.sha256.toLowerCase()]));
const financialSourceHashes = sourceFiles.map((file) => {
  const currentSha256 = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
  const phase3Sha256 = phase3Hashes.get(file) ?? null;
  return {
    file,
    currentSha256,
    phase3Sha256,
    matchesPhase3: phase3Sha256 === null ? null : currentSha256 === phase3Sha256,
  };
});

const receiptProofFiles = [
  "docs/phase4-browser-payment-chain-proof.json",
  "docs/phase4-browser-wbtc-chain-proof.json",
  "docs/phase4-browser-job29-dispute16-proof.json",
];
const uiReceiptRefs = [];
for (const file of receiptProofFiles) {
  const source = json(file);
  const arrays = [
    ...(Array.isArray(source.receipts) ? [{ name: "receipts", rows: source.receipts }] : []),
    ...(Array.isArray(source.transactionReceipts) ? [{ name: "transactionReceipts", rows: source.transactionReceipts }] : []),
  ];
  for (const { name, rows } of arrays) {
    for (const row of rows) {
      const hash = row.hash ?? row.transactionHash;
      if (typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash)) {
        uiReceiptRefs.push({ source: file, field: name, hash: hash.toLowerCase() });
      }
    }
  }
}

const headBlock = await client.getBlockNumber();
const chainId = await client.getChainId();
const blockTag = { blockNumber: headBlock };
const targetContracts = [
  { name: "escrow", address: escrow, abi: escrowAbi },
  { name: "arbitration", address: arbitration, abi: arbitrationAbi },
  { name: "randomness", address: randomness, abi: randomnessAbi },
  ...deployment.tokens.map((token) => ({ name: token.symbol, address: token.address, abi: tokenEventAbi })),
];

const rawLogs = (await Promise.all(targetContracts.map(async (target) => ({
  target,
  logs: await client.getLogs({
    address: target.address,
    fromBlock,
    toBlock: headBlock,
  }),
})))).flatMap(({ target, logs }) => logs.map((log) => {
  try {
    const decoded = decodeEventLog({ abi: target.abi, data: log.data, topics: log.topics });
    return {
      contract: target.name,
      address: log.address,
      blockNumber: log.blockNumber.toString(),
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      eventName: decoded.eventName,
      args: safe(decoded.args),
    };
  } catch (error) {
    return {
      contract: target.name,
      address: log.address,
      blockNumber: log.blockNumber.toString(),
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      eventName: null,
      decodeError: error instanceof Error ? error.message : String(error),
    };
  }
})).sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex);

const eventTxMap = new Map();
for (const log of rawLogs) {
  const hash = log.transactionHash.toLowerCase();
  const entry = eventTxMap.get(hash) ?? { hash, blockNumber: log.blockNumber, eventNames: [], logCount: 0 };
  if (log.eventName && !entry.eventNames.includes(log.eventName)) entry.eventNames.push(log.eventName);
  entry.logCount += 1;
  eventTxMap.set(hash, entry);
}
const eventTransactions = [...eventTxMap.values()].sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.hash.localeCompare(b.hash));

const relevantHashes = new Map(eventTransactions.map((entry) => [entry.hash, new Set(["chain-event-window"])]));
for (const ref of uiReceiptRefs) {
  const causes = relevantHashes.get(ref.hash) ?? new Set();
  causes.add(ref.source);
  relevantHashes.set(ref.hash, causes);
}
const checkedReceipts = await Promise.all([...relevantHashes.entries()].map(async ([hash, sources]) => {
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return {
      hash,
      sources: [...sources].sort(),
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      inRequestedWindow: receipt.blockNumber >= fromBlock && receipt.blockNumber <= headBlock,
    };
  } catch (error) {
    return {
      hash,
      sources: [...sources].sort(),
      status: "missing-or-unavailable",
      error: error instanceof Error ? error.message : String(error),
      inRequestedWindow: false,
    };
  }
}));

const acceptanceReferenceFile = 'infra/local/runtime/receipt-verification.json';
const acceptanceSource = json(acceptanceReferenceFile);
const acceptanceRows = Array.isArray(acceptanceSource.acceptance?.receipts)
  ? acceptanceSource.acceptance.receipts
  : [];
const acceptanceHashes = acceptanceRows.map((row) => typeof row.hash === 'string' ? row.hash.toLowerCase() : null);
const uniqueAcceptanceHashes = new Set(acceptanceHashes.filter(Boolean));
let acceptanceCursor = 0;
const acceptanceChecks = new Array(acceptanceRows.length);
const checkAcceptanceReceipt = async (row, index) => {
  const hash = typeof row.hash === 'string' ? row.hash.toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    acceptanceChecks[index] = {index, verified: false, error: 'invalid transaction hash in acceptance evidence'};
    return;
  }
  try {
    const receipt = await client.getTransactionReceipt({hash});
    const actualTransactionHash = receipt.transactionHash.toLowerCase();
    const expectedBlockNumber = String(row.expectedBlockNumber ?? '');
    const expectedStatus = String(row.expectedStatus ?? '').toLowerCase();
    acceptanceChecks[index] = {
      index,
      hash,
      acceptanceIds: row.acceptanceIds,
      expectedStatus,
      expectedBlockNumber,
      currentStatus: receipt.status,
      currentBlockNumber: receipt.blockNumber.toString(),
      currentBlockHash: receipt.blockHash,
      transactionHashMatches: actualTransactionHash === hash,
      blockMatchesEvidence: receipt.blockNumber.toString() === expectedBlockNumber,
      statusMatchesEvidence: String(receipt.status).toLowerCase() === expectedStatus,
      presentAtPinnedBlock: receipt.blockNumber <= headBlock,
      verified: actualTransactionHash === hash
        && receipt.blockNumber.toString() === expectedBlockNumber
        && String(receipt.status).toLowerCase() === expectedStatus
        && receipt.blockNumber <= headBlock,
    };
  } catch (error) {
    acceptanceChecks[index] = {
      index,
      hash,
      acceptanceIds: row.acceptanceIds,
      expectedStatus: row.expectedStatus,
      expectedBlockNumber: row.expectedBlockNumber,
      currentStatus: 'missing-or-unavailable',
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
const acceptanceWorkers = Array.from({length: 12}, async () => {
  while (acceptanceCursor < acceptanceRows.length) {
    const index = acceptanceCursor++;
    await checkAcceptanceReceipt(acceptanceRows[index], index);
  }
});
await Promise.all(acceptanceWorkers);
const acceptanceReferenceProof = {
  source: acceptanceReferenceFile,
  sourceHeadBlockNumber: acceptanceSource.headBlockNumber ?? null,
  pinnedCurrentBlockNumber: headBlock.toString(),
  recordedReceiptReferences: acceptanceSource.acceptance?.recordedReceiptReferences ?? acceptanceRows.length,
  uniqueReceiptCountInSource: acceptanceSource.acceptance?.uniqueReceiptCount ?? uniqueAcceptanceHashes.size,
  duplicateReferenceCountInSource: acceptanceSource.acceptance?.duplicateReferenceCount ?? acceptanceRows.length - uniqueAcceptanceHashes.size,
  sourceClaimedAllReceiptsMatch: acceptanceSource.acceptance?.allReceiptsMatchLiveChain ?? null,
  checkedReceiptCount: acceptanceChecks.length,
  uniqueCheckedHashCount: uniqueAcceptanceHashes.size,
  currentChainReceiptSuccessCount: acceptanceChecks.filter((entry) => entry.verified).length,
  missingOrMismatchedCount: acceptanceChecks.filter((entry) => !entry.verified).length,
  allAcceptanceReferencesVerifiedAtPinnedBlock: acceptanceChecks.length === 488
    && uniqueAcceptanceHashes.size === 488
    && acceptanceChecks.every((entry) => entry.verified),
  checks: acceptanceChecks,
};
const receiptByHash = new Map(checkedReceipts.map((receipt) => [receipt.hash, receipt]));
const eventTransactionsWithReceipts = eventTransactions.map((entry) => ({
  ...entry,
  receiptStatus: receiptByHash.get(entry.hash)?.status ?? "missing-or-unavailable",
}));
const eventReceiptFailures = eventTransactionsWithReceipts.filter((entry) => entry.receiptStatus !== "success");
const uniqueProofReferenceHashes = [...new Set(uiReceiptRefs.map((ref) => ref.hash))];
const proofReferenceReceipts = uniqueProofReferenceHashes.map((hash) => receiptByHash.get(hash) ?? {
  hash,
  status: "missing-or-unavailable",
  inRequestedWindow: false,
});

const call = (address, abi, functionName, args = []) => client.readContract({
  address,
  abi,
  functionName,
  args,
  ...blockTag,
});

const jobFields = [
  "client", "freelancer", "token", "state", "totalAmount", "createdAt", "proposalEnd",
  "acceptedAt", "fundingDeadline", "fundedAt", "reviewWindow", "revisionLimit", "milestoneCount",
];
const milestoneFields = [
  "amount", "duration", "acceptanceCriteriaCommitment", "deadline", "graceEnd", "state",
  "submittedAt", "reviewEnd", "rejectedAt", "responseEnd", "rejectionCount", "submissionCount",
  "latestReasonCommitment",
];
const jobs = [];
const jobCountAtSnapshot = Number(await call(escrow, escrowAbi, "jobCount"));
if (!Number.isSafeInteger(jobCountAtSnapshot) || jobCountAtSnapshot < 26) {
  throw new Error(`Unexpected jobCount at pinned block: ${jobCountAtSnapshot}`);
}
const firstReopenJobId = 26;
for (let id = firstReopenJobId; id < jobCountAtSnapshot; id += 1) {
  try {
    const job = await call(escrow, escrowAbi, "getJob", [BigInt(id)]);
    const milestoneCount = Number(job.milestoneCount);
    const milestones = [];
    for (let milestoneIndex = 0; milestoneIndex < milestoneCount; milestoneIndex += 1) {
      const [milestone, disputeId] = await Promise.all([
        call(escrow, escrowAbi, "getMilestone", [BigInt(id), BigInt(milestoneIndex)]),
        call(escrow, escrowAbi, "getMilestoneDispute", [BigInt(id), BigInt(milestoneIndex)]),
      ]);
      milestones.push({
        milestoneIndex,
        ...pick(milestone, milestoneFields),
        disputeId: safe(disputeId),
      });
    }
    jobs.push({ jobId: id, ...pick(job, jobFields), milestones });
  } catch (error) {
    jobs.push({ jobId: id, readError: error instanceof Error ? error.message : String(error) });
  }
}

const disputes = [];
const disputeIds = new Set([16n, 17n]);
for (const job of jobs) {
  for (const milestone of job.milestones ?? []) {
    const id = BigInt(milestone.disputeId ?? 0);
    if (id > 0n) disputeIds.add(id);
  }
}
for (const log of rawLogs) {
  if (log.args?.disputeId !== undefined) {
    const id = BigInt(log.args.disputeId);
    if (id > 0n) disputeIds.add(id);
  }
}
for (const disputeIdValue of [...disputeIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
  const disputeId = Number(disputeIdValue);
  try {
    const dispute = await call(arbitration, arbitrationAbi, "getDispute", [BigInt(disputeId)]);
    const round = Number(dispute.round);
    const panels = {};
    for (const panelRound of [1, 2]) {
      try {
        panels[String(panelRound)] = safe(await call(arbitration, arbitrationAbi, "getPanel", [BigInt(disputeId), panelRound]));
      } catch (error) {
        panels[String(panelRound)] = { readError: error instanceof Error ? error.message : String(error) };
      }
    }
    const activeRequestId = BigInt(dispute.activeRequestId);
    let activeRequestKnown = null;
    if (activeRequestId > 0n) {
      try {
        activeRequestKnown = await call(randomness, randomnessAbi, "requested", [activeRequestId]);
      } catch (error) {
        activeRequestKnown = { readError: error instanceof Error ? error.message : String(error) };
      }
    }
    disputes.push({
      disputeId,
      observedThroughBlock: headBlock.toString(),
      fields: safe(dispute),
      currentRound: round,
      currentRoundPanel: panels[String(round)] ?? null,
      panelsByRound: panels,
      activeRequestKnown,
    });
  } catch (error) {
    disputes.push({ disputeId, readError: error instanceof Error ? error.message : String(error) });
  }
}

const baselineProof = json("docs/phase4-browser-payment-chain-proof.json");
const baselineWithdrawalHash = String(baselineProof.exactWithdrawal.hash).toLowerCase();
const baselineWithdrawalAmount = String(baselineProof.exactWithdrawal.raw);
const baselineFreelancer = deployment.roles.freelancer.toLowerCase();
const baselineUsdc = deployment.tokens.find((token) => token.symbol === "USDC")?.address.toLowerCase() ?? null;
const baselineWithdrawalEvent = rawLogs.find((log) =>
  log.contract === "escrow" &&
  log.eventName === "WithdrawalCompleted" &&
  log.transactionHash.toLowerCase() === baselineWithdrawalHash,
) ?? null;
const baselineArgs = baselineWithdrawalEvent?.args ?? {};
const baselineWithdrawal = {
  transactionHash: baselineWithdrawalHash,
  proofSource: "docs/phase4-browser-payment-chain-proof.json exactWithdrawal",
  jobAssociationSource: "The proof records jobId 31 and exactWithdrawal hash; WithdrawalCompleted itself has no jobId field.",
  event: baselineWithdrawalEvent,
  receipt: receiptByHash.get(baselineWithdrawalHash) ?? null,
  expectedRawAmount: baselineWithdrawalAmount,
  parsedEventAmount: baselineArgs.amount ?? null,
  checks: {
    exactWithdrawalEventFound: baselineWithdrawalEvent !== null,
    amountMatches2500001: String(baselineArgs.amount ?? "") === "2500001" && baselineWithdrawalAmount === "2500001",
    accountMatchesFreelancer: String(baselineArgs.account ?? "").toLowerCase() === baselineFreelancer,
    tokenMatchesUSDC: baselineUsdc !== null && String(baselineArgs.token ?? "").toLowerCase() === baselineUsdc,
    receiptSucceeded: receiptByHash.get(baselineWithdrawalHash)?.status === "success",
  },
};

const codeHashes = {};
for (const [name, address] of [["escrow", escrow], ["arbitration", arbitration], ["randomness", randomness]]) {
  const code = await client.getCode({ address, blockNumber: headBlock });
  codeHashes[name] = {
    address,
    codePresent: Boolean(code && code !== "0x"),
    keccak256: code && code !== "0x" ? keccak256(code) : null,
    deploymentExpected: deployment.codeHashes?.[name] ?? null,
    matchesDeployment: deployment.codeHashes?.[name] ? keccak256(code ?? "0x").toLowerCase() === deployment.codeHashes[name].toLowerCase() : null,
  };
}

const output = {
  generatedAt: new Date().toISOString(),
  evidenceKind: "read-only local-chain snapshot and receipt verification",
  rpcUrl: deployment.rpcUrl,
  chainId,
  expectedChainId: deployment.chainId,
  observedBlock: headBlock.toString(),
  eventWindow: {
    fromBlock: fromBlock.toString(),
    throughBlock: headBlock.toString(),
    queriedContracts: targetContracts.map(({ name, address }) => ({ name, address })),
    logCount: rawLogs.length,
    uniqueEventTransactionCount: eventTransactions.length,
    eventTransactionReceiptSuccessCount: eventTransactionsWithReceipts.filter((receipt) => receipt.receiptStatus === "success").length,
    eventTransactionReceiptFailureOrMissingCount: eventReceiptFailures.length,
    undecodedLogCount: rawLogs.filter((log) => log.eventName === null).length,
    coverageNote: "Includes every event log emitted by the listed escrow, arbitration, randomness, USDC, and WBTC addresses in the pinned block window. Chain logs do not encode UI origin; this is an event/receipt scope, not proof that each transaction came from a particular browser action.",
  },
  jobEnumeration: {
    observedAtBlock: headBlock.toString(),
    onChainJobCount: jobCountAtSnapshot,
    firstIncludedJobId: firstReopenJobId,
    lastIncludedJobId: jobCountAtSnapshot - 1,
    includedJobCount: jobs.length,
    note: "Enumerated job ids 26 through jobCount-1 with jobCount read at the same pinned block used for all contract calls.",
  },
  historicalUiProofReferenceReconciliation: {
    sources: receiptProofFiles,
    uniqueReferencedTransactionCount: uniqueProofReferenceHashes.length,
    currentChainReceiptSuccessCount: proofReferenceReceipts.filter((receipt) => receipt.status === "success").length,
    missingOrUnavailableOnCurrentChainCount: proofReferenceReceipts.filter((receipt) => receipt.status !== "success").length,
    note: "These are references from earlier browser proof files. A missing current-chain receipt means the old transaction is not present on this live chain snapshot; it does not change the separate current event-window result.",
  },
  acceptanceReferenceReceiptProof: acceptanceReferenceProof,
  financialSourceHashes,
  deployedCodeHashes: codeHashes,
  jobs,
  disputes,
  baselineJob31Withdrawal: baselineWithdrawal,
  uiReceiptReferences: uiReceiptRefs.map((ref) => ({
    ...ref,
    currentReceipt: receiptByHash.get(ref.hash) ?? null,
  })),
  eventTransactions: eventTransactionsWithReceipts,
  eventLogs: rawLogs,
};

const outputPath = path.join(root, "docs", "phase4-reopen-chain-proof.json");
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  output: path.relative(root, outputPath),
  chainId,
  observedBlock: headBlock.toString(),
  logs: rawLogs.length,
  eventTransactions: eventTransactions.length,
  eventReceiptsSucceeded: eventTransactionsWithReceipts.filter((receipt) => receipt.receiptStatus === "success").length,
  eventReceiptsMissingOrFailed: eventReceiptFailures.length,
  historicalProofRefsOnCurrentChain: `${proofReferenceReceipts.filter((receipt) => receipt.status === "success").length}/${uniqueProofReferenceHashes.length}`,
  acceptanceReferences: {
    source: acceptanceReferenceFile,
    recorded: acceptanceSource.acceptance?.recordedReceiptReferences ?? acceptanceRows.length,
    checked: acceptanceChecks.length,
    unique: uniqueAcceptanceHashes.size,
    currentChainVerified: acceptanceReferenceProof.currentChainReceiptSuccessCount,
    failedOrMissing: acceptanceReferenceProof.missingOrMismatchedCount,
    allVerifiedAtPinnedBlock: acceptanceReferenceProof.allAcceptanceReferencesVerifiedAtPinnedBlock,
  },
  jobs: jobs.map((job) => ({ jobId: job.jobId, state: job.state ?? null, readError: job.readError ?? null })),
  disputes: disputes.map((dispute) => ({
    disputeId: dispute.disputeId,
    phase: dispute.fields?.phase ?? null,
    round: dispute.fields?.round ?? null,
    activeRequestId: dispute.fields?.activeRequestId ?? null,
    activeRequestKnown: dispute.activeRequestKnown ?? null,
    currentRoundPanel: dispute.currentRoundPanel ?? null,
  })),
  baselineWithdrawalChecks: baselineWithdrawal.checks,
  sourceHashesMatchPhase3: financialSourceHashes.every((entry) => entry.matchesPhase3 === true),
}, null, 2));

if (chainId !== deployment.chainId) process.exitCode = 1;
