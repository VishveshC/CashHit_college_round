import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createPublicClient, createWalletClient, encodeAbiParameters, getAddress, http,
  keccak256, pad, toBytes, toHex, zeroHash,
} from "viem";
import { prepareRuntime } from "../local-runtime.mjs";
import { assertAcceptanceProof, runAcceptanceScenarios } from "./acceptance.mjs";
import {
  assertRuntimeParentsSafe, clearGeneratedDemoResults, localRuntime, startFreshOwnedAnvil,
  writeDemoResult, writeDeploymentManifest,
} from "./runtime.mjs";

const ROOT = localRuntime.root;
const RPC_URL = localRuntime.rpcUrl;
const LOCAL_CHAIN = {
  id: 31337,
  name: "Fairwork local Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const RAW_JOB_AMOUNT = 100_000_000n;
const REVIEW_WINDOW = 120n;
const PROTOCOL = [60n, 60n, 1n, 31_536_000n, 1n, 31_536_000n];
const DEMO_FORMAT_VERSION = 1;
const APP_ROOT = repoPath("apps", "web");
const requireFromWeb = createRequire(repoPath("apps", "web", "package.json"));

function repoPath(...parts) {
  return path.join(ROOT, ...parts);
}

function loadArtifact(relativePath) {
  const artifact = JSON.parse(readFileSync(repoPath("contracts", "out", ...relativePath), "utf8"));
  if (typeof artifact.bytecode?.object !== "string" || !artifact.bytecode.object.startsWith("0x")) {
    throw new Error("Artifact has no creation bytecode: " + relativePath.join("/"));
  }
  if (typeof artifact.deployedBytecode?.object !== "string" || !artifact.deployedBytecode.object.startsWith("0x")) {
    throw new Error("Artifact has no runtime bytecode: " + relativePath.join("/"));
  }
  return artifact;
}

function privateCommitment(field, plaintext, suppliedSalt) {
  const salt = suppliedSalt ?? toHex(randomBytes(32));
  const tag = toHex(pad(toBytes(field), { dir: "right", size: 32 }));
  const plaintextHash = keccak256(toBytes(plaintext));
  const commitment = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [tag, plaintextHash, salt],
  ));
  return { salt, commitment };
}

function opaqueHash(value) {
  return keccak256(toBytes(value));
}

function wallet(account) {
  return createWalletClient({
    account: getAddress(account),
    chain: LOCAL_CHAIN,
    transport: http(RPC_URL),
  });
}

async function waitForHash(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== "success") {
    throw new Error(label + " reverted in block " + receipt.blockNumber + ".");
  }
  return receipt;
}

async function send(publicClient, walletClient, request, label) {
  const hash = await walletClient.writeContract(request);
  return { hash, receipt: await waitForHash(publicClient, hash, label) };
}

async function deploy(publicClient, deployer, artifact, args, label) {
  const hash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  const receipt = await waitForHash(publicClient, hash, label);
  if (!receipt.contractAddress) throw new Error(label + " receipt did not include a contract address.");
  return { address: getAddress(receipt.contractAddress), hash, receipt };
}

async function createAndFundJob(args) {
  const { publicClient, escrow, token, clientWallet, freelancerWallet, client, freelancer, index, status } = args;
  const terms = {
    title: status + " demo agreement " + (index + 1),
    description: "Private walkthrough description for " + status.toLowerCase() + " job " + (index + 1) + ".",
    scope: "Deliver one bounded demo artifact for " + status.toLowerCase() + " job " + (index + 1) + ".",
    deliveryRules: "Submit the deliverable commitment before the chain deadline.",
    criteria: ["The " + status.toLowerCase() + " milestone has the expected on-chain transition."],
  };
  const title = privateCommitment("TITLE", terms.title);
  const description = privateCommitment("DESCRIPTION", terms.description);
  const scope = privateCommitment("SCOPE", terms.scope);
  const deliveryRules = privateCommitment("DELIVERY_RULES", terms.deliveryRules);
  const criteria = privateCommitment("ACCEPTANCE_CRITERIA", terms.criteria[0]);
  const jobInput = {
    freelancer,
    token,
    titleCommitment: title.commitment,
    descriptionCommitment: description.commitment,
    scopeCommitment: scope.commitment,
    deliveryRuleCommitment: deliveryRules.commitment,
    reviewWindow: REVIEW_WINDOW,
    revisionLimit: 1,
  };
  const milestoneInput = {
    amount: RAW_JOB_AMOUNT,
    duration: 300n,
    acceptanceCriteriaCommitment: criteria.commitment,
  };
  const before = await publicClient.readContract({
    address: escrow, abi: ESCROW.abi, functionName: "jobCount",
  });
  const created = await send(publicClient, clientWallet, {
    address: escrow, abi: ESCROW.abi, functionName: "createJob",
    args: [jobInput, [milestoneInput]],
  }, "create " + status + " job");
  const after = await publicClient.readContract({
    address: escrow, abi: ESCROW.abi, functionName: "jobCount",
  });
  if (after !== before + 1n) throw new Error("Escrow job ID did not increment exactly once.");
  const accepted = await send(publicClient, freelancerWallet, {
    address: escrow, abi: ESCROW.abi, functionName: "acceptJob", args: [before],
  }, "accept demo job");
  const approved = await send(publicClient, clientWallet, {
    address: token, abi: TOKEN, functionName: "approve", args: [escrow, RAW_JOB_AMOUNT],
  }, "approve exact funding amount");
  const funded = await send(publicClient, clientWallet, {
    address: escrow, abi: ESCROW.abi, functionName: "fundJob", args: [before],
  }, "fund demo job");
  return {
    jobId: before.toString(),
    status,
    terms,
    commitments: {
      title: title.commitment,
      description: description.commitment,
      scope: scope.commitment,
      deliveryRules: deliveryRules.commitment,
      "criteria.0": criteria.commitment,
    },
    salts: {
      title: title.salt,
      description: description.salt,
      scope: scope.salt,
      deliveryRules: deliveryRules.salt,
      "criteria.0": criteria.salt,
    },
    transactions: [created, accepted, approved, funded].map(receiptEvidence),
  };
}

function receiptEvidence(action) {
  return {
    hash: action.hash,
    blockNumber: action.receipt.blockNumber.toString(),
    status: action.receipt.status === "success" ? "success" : "reverted",
  };
}

async function seedJobs(publicClient, escrow, token, client, freelancer, deployer) {
  const clientWallet = wallet(client);
  const freelancerWallet = wallet(freelancer);
  await send(publicClient, deployer, {
    address: token, abi: TOKEN, functionName: "mint",
    args: [client, RAW_JOB_AMOUNT * 5n + RAW_JOB_AMOUNT / 50n],
  }, "mint throwaway local USDC");

  const jobs = [];
  for (const [index, status] of ["Ready", "Submitted", "Rejected", "Disputed", "Closed"].entries()) {
    const job = await createAndFundJob({
      publicClient, escrow, token, clientWallet, freelancerWallet, client, freelancer, index, status,
    });
    jobs.push(job);
    const jobId = BigInt(job.jobId);
    if (status !== "Ready") {
      const submitted = await send(publicClient, freelancerWallet, {
        address: escrow, abi: ESCROW.abi, functionName: "submitMilestone",
        args: [
          jobId, 0n,
          opaqueHash("fairwork-demo-deliverable:" + index),
          opaqueHash("fairwork-demo-submission-reference:" + index),
        ],
      }, "submit " + status + " demo job");
      job.transactions.push(receiptEvidence(submitted));
    }
    if (status === "Rejected") {
      const rejected = await send(publicClient, clientWallet, {
        address: escrow, abi: ESCROW.abi, functionName: "rejectMilestone",
        args: [jobId, 0n, opaqueHash("fairwork-demo-rejection:" + index)],
      }, "reject demo milestone with private reason commitment");
      job.transactions.push(receiptEvidence(rejected));
    }
    if (status === "Disputed") {
      await send(publicClient, clientWallet, {
        address: token, abi: TOKEN, functionName: "approve",
        args: [escrow, RAW_JOB_AMOUNT / 50n],
      }, "approve exact dispute deposit");
      const disputed = await send(publicClient, clientWallet, {
        address: escrow, abi: ESCROW.abi, functionName: "openDispute", args: [jobId, 0n],
      }, "open demo dispute");
      job.transactions.push(receiptEvidence(disputed));
      const disputeId = await publicClient.readContract({
        address: escrow, abi: ESCROW.abi, functionName: "getMilestoneDispute", args: [jobId, 0n],
      });
      job.disputeId = disputeId.toString();
    }
    if (status === "Closed") {
      const approved = await send(publicClient, clientWallet, {
        address: escrow, abi: ESCROW.abi, functionName: "approveMilestone", args: [jobId, 0n],
      }, "approve closed demo milestone");
      job.transactions.push(receiptEvidence(approved));
      const withdrawn = await send(publicClient, freelancerWallet, {
        address: escrow, abi: ESCROW.abi, functionName: "withdraw", args: [token],
      }, "withdraw closed demo job proceeds");
      job.transactions.push(receiptEvidence(withdrawn));
      let secondWithdrawalSucceeded = false;
      try {
        await publicClient.simulateContract({
          account: freelancerWallet.account,
          address: escrow,
          abi: ESCROW.abi,
          functionName: "withdraw",
          args: [token],
        });
        secondWithdrawalSucceeded = true;
      } catch {
        // The wallet has already withdrawn its sole claimable balance.
      }
      if (secondWithdrawalSucceeded) throw new Error("Closed demo job unexpectedly retained a second freelancer withdrawal.");
      const closedClaimable = await publicClient.readContract({
        address: escrow, abi: ESCROW.abi, functionName: "claimable", args: [token, freelancer],
      });
      const totalClaimable = await publicClient.readContract({
        address: escrow, abi: ESCROW.abi, functionName: "totalClaimable", args: [token],
      });
      if (closedClaimable !== 0n || totalClaimable !== 0n) {
        throw new Error("Final seed withdrawal did not drain the local USDC claim ledger.");
      }
    }
  }
  return jobs;
}

function enumName(value, names, kind) {
  const name = names[Number(value)];
  if (!name) throw new Error("Unexpected " + kind + " enum value " + value + ".");
  return name;
}

async function readCodeHash(publicClient, address, label) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(label + " has no deployed runtime bytecode.");
  return keccak256(code);
}

async function deployAndSeed(accounts) {
  const publicClient = createPublicClient({ chain: LOCAL_CHAIN, pollingInterval: 50, transport: http(RPC_URL) });
  const [deployerAddress, clientAddress, freelancerAddress, ...arbiterAddresses] =
    accounts.map((account) => getAddress(account));
  const deployer = wallet(deployerAddress);
  const artifacts = {
    escrow: loadArtifact(["FairworkEscrow.sol", "FairworkEscrow.json"]),
    usdc: loadArtifact(["LocalDemoTokens.sol", "MockUSDC.json"]),
    wbtc: loadArtifact(["LocalDemoTokens.sol", "MockWBTC.json"]),
  };
  const escrowRuntimeBytes = (artifacts.escrow.deployedBytecode.object.length - 2) / 2;
  if (escrowRuntimeBytes > 24_576) {
    throw new Error("Escrow artifact runtime is " + escrowRuntimeBytes + " bytes, above EIP-170; ask the shared build owner to rebuild.");
  }
  const usdc = await deploy(publicClient, deployer, artifacts.usdc, [], "deploy local USDC mock");
  const wbtc = await deploy(publicClient, deployer, artifacts.wbtc, [], "deploy local WBTC mock");
  const tokenConfigs = [
    [usdc.address, 6, 1n, 10n ** 18n, zeroHash],
    [wbtc.address, 8, 1n, 10n ** 18n, zeroHash],
  ];
  const escrowDeployment = await deploy(
    publicClient, deployer, artifacts.escrow, [tokenConfigs, PROTOCOL, deployerAddress],
    "deploy local escrow and immutable adapters",
  );
  const escrowAddress = escrowDeployment.address;
  const arbitrationAddress = getAddress(await publicClient.readContract({
    address: escrowAddress, abi: artifacts.escrow.abi, functionName: "arbitrationEngine",
  }));
  const randomnessAddress = getAddress(await publicClient.readContract({
    address: escrowAddress, abi: artifacts.escrow.abi, functionName: "randomness",
  }));
  for (const arbiter of arbiterAddresses.slice(0, 6)) {
    await send(publicClient, deployer, {
      address: escrowAddress, abi: artifacts.escrow.abi, functionName: "addArbiter", args: [arbiter],
    }, "allowlist local demo arbiter");
  }
  const arbiterCount = await publicClient.readContract({
    address: escrowAddress, abi: artifacts.escrow.abi, functionName: "arbiterCount",
  });
  if (arbiterCount !== 6n) throw new Error("Expected six allowlisted demo arbiters.");

  const manifest = {
    chainId: 31337,
    rpcUrl: RPC_URL,
    escrow: escrowAddress,
    arbitration: arbitrationAddress,
    randomness: randomnessAddress,
    startBlock: escrowDeployment.receipt.blockNumber.toString(),
    blockNumber: (await publicClient.getBlockNumber()).toString(),
    codeHashes: {
      escrow: await readCodeHash(publicClient, escrowAddress, "Escrow"),
      arbitration: await readCodeHash(publicClient, arbitrationAddress, "Arbitration"),
      randomness: await readCodeHash(publicClient, randomnessAddress, "Randomness adapter"),
    },
    tokens: [
      { address: usdc.address, symbol: "USDC", decimals: 6 },
      { address: wbtc.address, symbol: "WBTC", decimals: 8 },
    ],
    roles: {
      client: clientAddress,
      freelancer: freelancerAddress,
      treasury: deployerAddress,
      arbiters: arbiterAddresses.slice(0, 6),
    },
  };
  return {
    manifest,
    publicClient,
    escrowAbi: artifacts.escrow.abi,
    escrow: escrowAddress,
    token: usdc.address,
    wbtc: wbtc.address,
    randomness: randomnessAddress,
    deployer,
    client: clientAddress,
    freelancer: freelancerAddress,
    accounts: accounts.map((account) => getAddress(account)),
    seededJobStates: ["Ready", "Submitted", "Rejected", "Disputed", "Closed"],
  };
}

async function main() {
  assertRuntimeParentsSafe();
  const runtime = await prepareRuntime(ROOT);
  Object.assign(process.env, runtime.env);
  const previousResult = readPreviousResult();
  clearGeneratedDemoResults();
  const anvil = await startFreshOwnedAnvil();
  try {
    const deployed = await deployAndSeed(anvil.accounts);
    const acceptanceScenarios = await runAcceptanceScenarios({
      escrow: deployed.escrow,
      token: deployed.token,
      wbtc: deployed.wbtc,
      randomness: deployed.randomness,
      roles: { ...deployed.manifest.roles, outsider: deployed.accounts[9] },
    });
    const jobs = await seedJobs(
      deployed.publicClient, deployed.escrow, deployed.token,
      deployed.client, deployed.freelancer, deployed.deployer,
    );
    const terminalNames = ["Ready", "Submitted", "Rejected", "Disputed", "Released", "Refunded", "Resolved"];
    const observedStates = [];
    for (const job of jobs) {
      const milestone = await deployed.publicClient.readContract({
        address: deployed.escrow, abi: deployed.escrowAbi, functionName: "getMilestone",
        args: [BigInt(job.jobId), 0n],
      });
      observedStates.push(enumName(milestone.state, terminalNames, "milestone"));
    }
    if (observedStates.join(",") !== "Ready,Submitted,Rejected,Disputed,Released") {
      throw new Error("Unexpected on-chain milestone states: " + observedStates.join(", "));
    }
    const closedJob = await deployed.publicClient.readContract({
      address: deployed.escrow, abi: deployed.escrowAbi, functionName: "getJob",
      args: [BigInt(jobs[4].jobId)],
    });
    if (enumName(closedJob.state, ["Proposed", "AcceptedUnfunded", "Funded", "Cancelled", "Closed"], "job") !== "Closed") {
      throw new Error("The approved demo job did not reach Closed.");
    }
    const manifest = { ...deployed.manifest, blockNumber: (await deployed.publicClient.getBlockNumber()).toString() };
    writeDeploymentManifest(manifest);
    const result = {
      chainId: manifest.chainId,
      seededJobStates: deployed.seededJobStates,
      seededJobs: jobs.map(({ jobId, status, disputeId }) =>
        Object.assign({ jobId, status }, disputeId ? { disputeId } : {})),
      acceptanceProgress: await acceptanceProgress(runtime, manifest, jobs, deployed.publicClient, deployed.escrowAbi, acceptanceScenarios, deployed.accounts[9]),
      manifest: {
        escrow: manifest.escrow,
        arbitration: manifest.arbitration,
        randomness: manifest.randomness,
        codeHashes: manifest.codeHashes,
      },
      roles: manifest.roles,
    };
    const fingerprint = repeatabilityFingerprint(result);
    writeDemoResult({
      formatVersion: DEMO_FORMAT_VERSION,
      fingerprint,
      generatedAt: new Date().toISOString(),
      deployment: manifest,
      jobs: jobs.map(({ jobId, status, disputeId, transactions }) =>
        Object.assign({ jobId, status, transactions }, disputeId ? { disputeId } : {})),
      acceptanceProgress: result.acceptanceProgress,
    });
    console.log("Fairwork Phase 4 demo: deterministic local chain reset, deployment and seed completed.");
    console.log("Chain " + manifest.chainId + " at " + manifest.rpcUrl + "; escrow " + manifest.escrow + ".");
    console.log("Arbitration " + manifest.arbitration + "; randomness DEMO ONLY " + manifest.randomness + ".");
    console.log("Roles: deployer/treasury " + manifest.roles.treasury + ", client " + manifest.roles.client +
      ", freelancer " + manifest.roles.freelancer + ", arbiters " + manifest.roles.arbiters.join(", ") + ".");
    console.log("Tokens: " + manifest.tokens.map((token) =>
      token.symbol + " " + token.address + " (" + token.decimals + " decimals)").join("; ") + ".");
    console.log("Runtime code hashes: escrow " + manifest.codeHashes.escrow +
      "; arbitration " + manifest.codeHashes.arbitration + "; randomness " + manifest.codeHashes.randomness + ".");
    console.log("Seeded jobs: " + jobs.map(({ jobId, status }) => jobId + " " + status).join(", ") + ".");
    if (previousResult?.formatVersion === DEMO_FORMAT_VERSION &&
        JSON.stringify(previousResult.fingerprint) === JSON.stringify(fingerprint)) {
      console.log("REPEATABILITY PASS: this clean reset matches the previous local run.");
    } else {
      console.log("Demo seed complete. Run it again to compare a second clean reset.");
    }
    console.log("PHASE4_DEMO_RESULT=" + JSON.stringify(result));
  } catch (error) {
    const { stopOwnedAnvil } = await import("./runtime.mjs");
    await stopOwnedAnvil().catch(() => undefined);
    clearGeneratedDemoResults();
    throw error;
  }
}

function readPreviousResult() {
  const resultPath = repoPath("infra", "local", "runtime", "demo-result.json");
  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return undefined;
  }
}

function repeatabilityFingerprint(result) {
  return {
    chainId: result.chainId,
    seededJobStates: result.seededJobStates,
    seededJobs: result.seededJobs,
    acceptanceProgress: result.acceptanceProgress,
    manifest: result.manifest,
    roles: result.roles,
  };
}

async function acceptanceProgress(runtime, manifest, jobs, publicClient, escrowAbi, chainScenarios, outsiderAddress) {
  const closedMilestone = await publicClient.readContract({
    address: manifest.escrow, abi: escrowAbi, functionName: "getMilestone",
    args: [BigInt(jobs[4].jobId), 0n],
  });
  const closedJob = await publicClient.readContract({
    address: manifest.escrow, abi: escrowAbi, functionName: "getJob", args: [BigInt(jobs[4].jobId)],
  });
  const freelancerClaimable = await publicClient.readContract({
    address: manifest.escrow, abi: escrowAbi, functionName: "claimable",
    args: [manifest.tokens[0].address, manifest.roles.freelancer],
  });
  if (Number(closedJob.state) !== 4 || freelancerClaimable !== 0n) {
    throw new Error("Acceptance #1 failed: chain did not confirm closed job and completed pull withdrawal.");
  }
  const totalClaimable = await publicClient.readContract({
    address: manifest.escrow, abi: escrowAbi, functionName: "totalClaimable", args: [manifest.tokens[0].address],
  });
  const closedReceiptProof = assertAcceptanceProof({
    source: "fresh-local-anvil",
    chainId: 31337,
    transactions: jobs[4].transactions.slice(-2),
    assertions: [
      { name: "closed seed milestone is Released", expected: 4, actual: Number(closedMilestone.state), passed: Number(closedMilestone.state) === 4 },
      { name: "closed seed job is Closed", expected: 4, actual: Number(closedJob.state), passed: Number(closedJob.state) === 4 },
      { name: "freelancer pull credit is empty after withdrawal", expected: "0", actual: freelancerClaimable.toString(), passed: freelancerClaimable === 0n },
      { name: "local fixture claim ledger is drained before interactive seed", expected: "0", actual: totalClaimable.toString(), passed: totalClaimable === 0n },
    ],
  });
  const byId = new Map(chainScenarios.map((item) => [item.id, item]));
  for (let id = 3; id <= 10; id += 1) {
    if (byId.get(id)?.status !== "passed") throw new Error("Acceptance #" + id + " did not produce fresh local-chain proof.");
  }
  const privacyProbe = await runPrivateApiProbe(runtime, manifest, jobs, publicClient, outsiderAddress);
  return [
    { id: 1, status: "passed", evidence: { jobId: jobs[4].jobId, proof: closedReceiptProof } },
    { id: 2, status: "not_applicable", reason: "Signed offers are Tier B and have no implemented route." },
    ...chainScenarios,
    { id: 11, status: "passed", evidence: privacyProbe },
    { id: 12, status: "not_applicable", reason: "Listings and ban controls are Tier B and have no implemented routes." },
  ];
}

async function runPrivateApiProbe(runtime, manifest, jobs, publicClient, outsiderAddress) {
  const prismaCli = path.join(APP_ROOT, "node_modules", "prisma", "build", "index.js");
  const schema = path.join(APP_ROOT, "prisma", "schema.prisma");
  const env = { ...process.env, ...runtime.env };
  try {
    const dbPush = spawnSync(process.execPath, [prismaCli, "db", "push", "--schema", schema, "--skip-generate"], {
      cwd: ROOT,
      env: { ...env, RUST_LOG: "debug" },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (dbPush.error || dbPush.status !== 0) {
      throw new Error("Could not initialize the owned local private database for the acceptance probe. " +
        String(dbPush.stderr || dbPush.stdout || dbPush.error?.message || "Prisma exited without diagnostics."));
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Could not initialize")) throw error;
    throw new Error("Could not initialize the owned local private database for the acceptance probe.");
  }

  const { PrismaClient } = requireFromWeb("@prisma/client");
  const { SiweMessage } = requireFromWeb("siwe");
  const [{ createRouteHandlers }, chainServer, chainModule, pinsModule] = await Promise.all([
    import("../../apps/web/lib/server/routes.ts"),
    import("../../apps/web/lib/chain-server.ts"),
    import("../../apps/web/lib/chain.ts"),
    import("../../apps/web/lib/chain-pins.ts"),
  ]);
  const db = new PrismaClient({ datasources: { db: { url: runtime.env.DATABASE_URL } } });
  await db.$connect();
  const rateWindows = new Map();
  const rateLimit = (bucket, key) => {
    const currentTime = Date.now();
    const composite = `${bucket}:${key}`;
    const current = rateWindows.get(composite);
    const max = bucket === "auth" ? 30 : 120;
    if (!current || currentTime - current.startedAt >= 60_000) {
      rateWindows.set(composite, { startedAt: currentTime, count: 1 });
      return true;
    }
    if (current.count >= max) return false;
    current.count += 1;
    return true;
  };
  const readPinned = async (reader, ...args) => {
    const config = chainServer.getPublicConfig();
    await pinsModule.verifyDeployment(config, chainModule.publicClient(config));
    return reader(...args);
  };
  const handlers = createRouteHandlers({
    db,
    chain: {
      getPublicConfig: async () => {
        const config = chainServer.getPublicConfig();
        await pinsModule.verifyDeployment(config, chainModule.publicClient(config));
        return config;
      },
      readJobAccess: (...args) => readPinned(chainServer.readJobAccess, ...args),
      readDisputeAccess: (...args) => readPinned(chainServer.readDisputeAccess, ...args),
      readJobSnapshot: (...args) => readPinned(chainServer.readJobSnapshot, ...args),
      readChainEvents: (...args) => readPinned(chainServer.readChainEvents, ...args),
    },
    now: () => Date.now(),
    storageDir: runtime.env.PRIVATE_STORAGE_DIR,
    masterKey: Buffer.from(runtime.env.AES_256_GCM_MASTER_KEY, "hex"),
    sessionSecret: Buffer.from(runtime.env.SESSION_SECRET, "hex"),
    rateLimit,
    origin: runtime.env.APP_ORIGIN,
  });

  try {
    const job = jobs[1];
    const disputedJob = jobs[3];
    const freelancerAuth = await authenticateLocalWallet(handlers, SiweMessage, manifest.roles.freelancer);
    const clientAuth = await authenticateLocalWallet(handlers, SiweMessage, manifest.roles.client);
    const strangerAuth = await authenticateLocalWallet(handlers, SiweMessage, outsiderAddress);

    const termsResponse = await handlers.jobPUT(jsonRequest(`/api/jobs/${job.jobId}`, "PUT", {
      ...job.terms, salts: job.salts, commitments: job.commitments,
    }, freelancerAuth), job.jobId);
    if (termsResponse.status !== 200) throw new Error("Party could not save the committed private terms for the acceptance probe.");
    const ownerTerms = await handlers.jobGET(authRequest(`/api/jobs/${job.jobId}`, freelancerAuth), job.jobId);
    const ownerTermsBody = await ownerTerms.json();
    if (ownerTerms.status !== 200 || ownerTermsBody.title !== job.terms.title) {
      throw new Error("Party could not read the private terms saved through the production handler.");
    }

    const fileBytes = Buffer.from("fairwork-demo-deliverable:1", "utf8");
    const upload = new FormData();
    upload.set("kind", "submission");
    upload.set("milestoneIndex", "0");
    upload.set("file", new File([fileBytes], "deliverable.txt", { type: "text/plain" }));
    const uploadResponse = await handlers.fileUploadPOST(multipartRequest(`/api/jobs/${job.jobId}/files`, upload, freelancerAuth), job.jobId);
    const uploadBody = await uploadResponse.json();
    if (uploadResponse.status !== 200 || typeof uploadBody.id !== "string") {
      throw new Error("Party could not upload the chain-bound private submission file.");
    }
    const ownerDownload = await handlers.fileDownloadGET(authRequest(`/api/files/${uploadBody.id}/download`, freelancerAuth), uploadBody.id);
    if (ownerDownload.status !== 200) throw new Error("Party could not receive a private file download ticket.");
    const ownerDownloadBody = await ownerDownload.json();
    const contentUrl = new URL(ownerDownloadBody.url, runtime.env.APP_ORIGIN);
    const contentResponse = await handlers.fileContentGET(authRequest(contentUrl.pathname + contentUrl.search, freelancerAuth), uploadBody.id);
    const contentBytes = Buffer.from(await contentResponse.arrayBuffer());
    if (contentResponse.status !== 200 || !contentBytes.equals(fileBytes)) {
      throw new Error("Party could not read the encrypted submission file through its authorized ticket.");
    }

    const evidenceText = "The submitted delivery is attached to the seeded local dispute.";
    const evidenceSalt = opaqueHash("phase4-private-api-evidence-salt");
    const evidenceReference = opaqueHash("phase4-private-api-evidence-reference");
    const evidenceCommitment = privateCommitment("EVIDENCE", evidenceText, evidenceSalt).commitment;
    const committedEvidence = await send(publicClient, wallet(manifest.roles.client), {
      address: manifest.escrow, abi: ESCROW.abi, functionName: "submitEvidence",
      args: [BigInt(disputedJob.disputeId), evidenceCommitment, evidenceReference],
    }, "commit evidence for the private API acceptance probe");
    const evidenceWrite = await handlers.evidencePOST(jsonRequest(`/api/disputes/${disputedJob.disputeId}/evidence`, "POST", {
      text: evidenceText,
      salt: evidenceSalt,
      commitment: evidenceCommitment,
      reference: evidenceReference,
    }, clientAuth), disputedJob.disputeId);
    if (evidenceWrite.status !== 200) throw new Error("Party could not save chain-committed private evidence through the production handler.");
    const ownerEvidence = await handlers.evidenceGET(authRequest(`/api/disputes/${disputedJob.disputeId}/evidence`, clientAuth), disputedJob.disputeId);
    const ownerEvidenceBody = await ownerEvidence.json();
    if (ownerEvidence.status !== 200 || ownerEvidenceBody.items?.length !== 1 || ownerEvidenceBody.items[0]?.text !== evidenceText) {
      throw new Error("Party could not read its chain-bound private evidence through the production handler.");
    }

    const privateJobDenied = await handlers.jobGET(authRequest(`/api/jobs/${job.jobId}`, strangerAuth), job.jobId);
    const missingJobDenied = await handlers.jobGET(authRequest("/api/jobs/999999999999999999", strangerAuth), "999999999999999999");
    const privateEvidenceDenied = await handlers.evidenceGET(authRequest(`/api/disputes/${disputedJob.disputeId}/evidence`, strangerAuth), disputedJob.disputeId);
    const missingEvidenceDenied = await handlers.evidenceGET(authRequest("/api/disputes/999999999999999999/evidence", strangerAuth), "999999999999999999");
    const privateFileDenied = await handlers.fileDownloadGET(authRequest(`/api/files/${uploadBody.id}/download`, strangerAuth), uploadBody.id);
    const missingFileId = "00000000-0000-4000-8000-000000000001";
    const missingFileDenied = await handlers.fileDownloadGET(authRequest(`/api/files/${missingFileId}/download`, strangerAuth), missingFileId);
    const denialAssertions = [];
    for (const [label, denied, missing] of [
      ["private job", privateJobDenied, missingJobDenied],
      ["private evidence", privateEvidenceDenied, missingEvidenceDenied],
      ["private file", privateFileDenied, missingFileDenied],
    ]) {
      const deniedBody = await denied.text();
      const missingBody = await missing.text();
      const sameGeneric404 = denied.status === 404 && missing.status === 404 &&
        deniedBody === JSON.stringify({ error: { code: "NOT_FOUND" } }) && missingBody === deniedBody;
      if (!sameGeneric404) {
        throw new Error(`The outsider could distinguish an unavailable ${label} from a nonexistent one.`);
      }
      denialAssertions.push({
        name: `outsider sees the same generic 404 for ${label} and its nonexistent counterpart`,
        expected: [404, 404, true],
        actual: [denied.status, missing.status, sameGeneric404],
        passed: sameGeneric404,
      });
    }
    const signedTicket = contentUrl.searchParams.get("ticket");
    const privateContentDenied = await handlers.fileContentGET(
      authRequest(`/api/files/${uploadBody.id}/content?ticket=${encodeURIComponent(signedTicket)}`, strangerAuth), uploadBody.id,
    );
    const missingContentDenied = await handlers.fileContentGET(
      authRequest(`/api/files/${missingFileId}/content?ticket=invalid`, strangerAuth), missingFileId,
    );
    const privateContentBody = await privateContentDenied.text();
    const missingContentBody = await missingContentDenied.text();
    const sameContent404 = privateContentDenied.status === 404 && missingContentDenied.status === 404 &&
      privateContentBody === JSON.stringify({ error: { code: "NOT_FOUND" } }) && missingContentBody === privateContentBody;
    if (!sameContent404) {
      throw new Error("The outsider could distinguish unavailable file content from nonexistent content.");
    }
    denialAssertions.push({
      name: "outsider sees the same generic 404 for private content and missing content",
      expected: [404, 404, true],
      actual: [privateContentDenied.status, missingContentDenied.status, sameContent404],
      passed: sameContent404,
    });

    const transactions = [
      receiptEvidence({ hash: committedEvidence.hash, receipt: committedEvidence.receipt }),
      job.transactions.at(-1),
      disputedJob.transactions.at(-1),
    ].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
    return assertAcceptanceProof({
      source: "fresh-local-anvil",
      chainId: 31337,
      transactions,
      assertions: [
        { name: "private job data was saved and read by its party", expected: [200, 200, true], actual: [termsResponse.status, ownerTerms.status, ownerTermsBody.title === job.terms.title], passed: true },
        { name: "encrypted submission file was downloaded by its party", expected: [200, 200, true], actual: [uploadResponse.status, contentResponse.status, contentBytes.equals(fileBytes)], passed: true },
        { name: "chain-committed private evidence was saved and read by its party", expected: [200, 200, 1, true], actual: [evidenceWrite.status, ownerEvidence.status, ownerEvidenceBody.items.length, ownerEvidenceBody.items[0].text === evidenceText], passed: true },
        ...denialAssertions,
      ],
    });
  } finally {
    await db.$disconnect();
  }
}

async function authenticateLocalWallet(handlers, SiweMessage, address) {
  const nonceResponse = await handlers.noncePOST(jsonRequest("/api/auth/nonce", "POST", {}, undefined, true));
  if (nonceResponse.status !== 200) throw new Error("Local auth nonce route did not return success.");
  const nonceBody = await nonceResponse.json();
  const challengeCookie = cookieFrom(nonceResponse, "__Host-fw-challenge");
  const message = new SiweMessage({
    domain: "localhost:3000",
    address,
    statement: "Sign in to Fairwork local demo.",
    uri: "http://localhost:3000",
    version: "1",
    chainId: 31337,
    nonce: nonceBody.nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(),
  }).prepareMessage();
  const signature = await anvilRpc("personal_sign", [toHex(toBytes(message)), getAddress(address)]);
  const loginResponse = await handlers.loginPOST(jsonRequest("/api/auth/login", "POST", { message, signature }, {
    cookie: challengeCookie,
  }, true));
  if (loginResponse.status !== 200) throw new Error("Throwaway Anvil wallet could not authenticate through nonce and SIWE.");
  const session = await loginResponse.json();
  const cookie = cookieFrom(loginResponse, "__Host-fw-session");
  if (!session.csrfToken || !cookie) throw new Error("SIWE login did not create its protected local session.");
  return { cookie, csrf: session.csrfToken };
}

async function anvilRpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error("Local Anvil rejected the SIWE signing request.");
  }
  return payload.result;
}

function cookieFrom(response, name) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const prefix = name + "=";
  const entry = cookies.find((item) => item.startsWith(prefix));
  if (!entry) throw new Error("Auth route did not issue the expected protected local cookie.");
  return entry.split(";", 1)[0];
}

function authRequest(pathname, auth) {
  return makeRequest(pathname, "GET", undefined, auth, false);
}

function jsonRequest(pathname, method, body, auth, includeOrigin = true) {
  return makeRequest(pathname, method, JSON.stringify(body), auth, includeOrigin, "application/json");
}

function multipartRequest(pathname, body, auth) {
  return new Request("http://localhost:3000" + pathname, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", Cookie: auth.cookie, "X-CSRF-Token": auth.csrf },
    body,
  });
}

function makeRequest(pathname, method, body, auth, includeOrigin = false, contentType) {
  const headers = new Headers();
  if (includeOrigin) headers.set("Origin", "http://localhost:3000");
  if (auth?.cookie) headers.set("Cookie", auth.cookie);
  if (auth?.csrf) headers.set("X-CSRF-Token", auth.csrf);
  if (contentType) headers.set("Content-Type", contentType);
  return new Request("http://localhost:3000" + pathname, { method, headers, ...(body === undefined ? {} : { body }) });
}

const TOKEN = loadArtifact(["LocalDemoTokens.sol", "MockUSDC.json"]).abi;
const ESCROW = loadArtifact(["FairworkEscrow.sol", "FairworkEscrow.json"]);

main().catch((error) => {
  console.error("Phase 4 demo failed: " + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
});
