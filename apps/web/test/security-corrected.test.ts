import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { SiweMessage } from "siwe";
import { encodeAbiParameters, keccak256, pad, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRouteHandlers } from "../lib/server/routes.ts";

/*
 * Phase 4 security boundary, injected only when constructing the route factory:
 *   db: ephemeral SQLite PrismaClient
 *   chain: getPublicConfig/readJobAccess/readDisputeAccess/readJobSnapshot/readChainEvents
 *   now: epoch milliseconds; storageDir; masterKey (32 bytes); sessionSecret (>=32 bytes)
 *   rateLimit(bucket, key): boolean; origin: canonical local origin
 * No request field or HTTP route can override these dependencies.
 */

const ORIGIN = "http://localhost:3000";
const DOMAIN = "localhost:3000";
const CHAIN_ID = 31337;
const SESSION_COOKIE = "__Host-fw-session";
const CHALLENGE_COOKIE = "__Host-fw-challenge";
const SESSION_TOKEN = "phase4-test-session-token-00000000000000000000000000000000";
const CSRF_TOKEN = "phase4-test-csrf-token-00000000000000000000000000000000";
const CLIENT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const FREELANCER = privateKeyToAccount(`0x${"22".repeat(32)}`);
const ARBITER = privateKeyToAccount(`0x${"33".repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${"44".repeat(32)}`);
const JOB_ID = "1";
const DISPUTE_ID = "1";
const FIXED_NOW = Date.parse("2026-10-11T10:00:00.000Z");
const MASTER_KEY = Buffer.alloc(32, 0x6a);
const SESSION_SECRET = Buffer.alloc(32, 0x5b);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;

let originalDatabaseUrl;
let tempRoot;
let databasePath;
let databaseUrl;
let db;
let clockMs = FIXED_NOW;
let storageDir;
let handlers;
let rateAllowed = true;
let jobAccess = new Map();
let disputeAccess = new Map();
let snapshots = new Map();
let chainEvents = new Map();
let accessReadCount = 0;
let rateLimitCalls = [];
let sessionSerial = 0;

function normalizedWallet(wallet) {
  return wallet.toLowerCase();
}

function hashSecret(value) {
  return createHash("sha256").update(value).digest("hex");
}

function grantJob(jobId, wallet, role, extra = {}) {
  const key = `${jobId}:${normalizedWallet(wallet)}`;
  const prior = jobAccess.get(key) ?? {
    client: false,
    freelancer: false,
    isCurrentArbiter: false,
    unresolved: false,
    closedAt: null,
    jobId: String(jobId),
  };
  if (role === "client") prior.client = true;
  if (role === "freelancer") prior.freelancer = true;
  if (role === "arbiter") prior.isCurrentArbiter = true;
  Object.assign(prior, extra);
  jobAccess.set(key, prior);
  return prior;
}

function grantDispute(disputeId, jobId, wallet, role, extra = {}) {
  const key = `${disputeId}:${normalizedWallet(wallet)}`;
  const prior = {
    ...grantJob(jobId, wallet, role, extra),
    disputeId: String(disputeId),
    jobId: String(jobId),
    dispute: {
      jobId: BigInt(jobId),
      phase: 1,
      evidenceDeadline: BigInt(Math.floor(clockMs / 1000) + 60),
      clientEvidenceCount: 0,
      freelancerEvidenceCount: 0,
    },
    snapshot: snapshots.get(String(jobId)) ?? buildSnapshot(String(jobId)),
  };
  disputeAccess.set(key, prior);
  return prior;
}

function accessFor(map, id, wallet) {
  return map.get(`${id}:${normalizedWallet(wallet)}`) ?? {
    client: false,
    freelancer: false,
    isCurrentArbiter: false,
    unresolved: false,
    closedAt: null,
    jobId: String(id),
  };
}

function prepareEvidenceDispute() {
  const snapshot = structuredClone(snapshots.get(JOB_ID) ?? buildSnapshot(JOB_ID));
  snapshot.milestones[0].state = 3;
  snapshot.milestones[0].disputeId = BigInt(DISPUTE_ID);
  snapshot.milestones[0].dispute = {
    jobId: BigInt(JOB_ID),
    milestoneIndex: 0n,
    client: CLIENT.address,
    freelancer: FREELANCER.address,
    phase: 1,
    evidenceDeadline: BigInt(Math.floor(clockMs / 1000) + 60),
    clientEvidenceCount: 0,
    freelancerEvidenceCount: 0,
  };
  snapshots.set(JOB_ID, snapshot);
  for (const wallet of [CLIENT.address, FREELANCER.address, ARBITER.address]) {
    const access = disputeAccess.get(`${DISPUTE_ID}:${normalizedWallet(wallet)}`);
    if (access) {
      access.unresolved = true;
      access.dispute = snapshot.milestones[0].dispute;
    }
  }
  return snapshot;
}

function prepareRejectionNote(commitment) {
  const snapshot = structuredClone(snapshots.get(JOB_ID) ?? buildSnapshot(JOB_ID));
  snapshot.milestones[0].state = 3;
  snapshot.milestones[0].disputeId = BigInt(DISPUTE_ID);
  snapshot.milestones[0].dispute = {
    jobId: BigInt(JOB_ID),
    milestoneIndex: 0n,
    client: CLIENT.address,
    freelancer: FREELANCER.address,
    phase: 1,
    evidenceDeadline: BigInt(Math.floor(clockMs / 1000) + 60),
    clientEvidenceCount: 0,
    freelancerEvidenceCount: 0,
  };
  snapshot.milestones[0].latestReasonCommitment = commitment;
  snapshot.milestones[0].rejectionCount = 1;
  snapshot.milestones[0].submissionCount = 1;
  snapshot.milestones[0].responseEnd = BigInt(Math.floor(clockMs / 1000) + 60);
  snapshots.set(JOB_ID, snapshot);
}

const FIELD_TAGS = {
  title: "TITLE",
  description: "DESCRIPTION",
  scope: "SCOPE",
  deliveryRules: "DELIVERY_RULES",
  criteria: "ACCEPTANCE_CRITERIA",
  evidence: "EVIDENCE",
  rejectionReason: "REJECTION_REASON",
};

function bytes32Tag(tag) {
  return pad(stringToHex(tag), { size: 32, dir: "right" });
}

function privateCommitment(tag, text, salt) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [bytes32Tag(tag), keccak256(stringToHex(text)), salt],
    ),
  );
}

function makeTerms() {
  const values = {
    title: "Replace the entry gate",
    description: "Remove the damaged gate and fit the agreed replacement.",
    scope: "Supply and installation are included.",
    deliveryRules: "Submit completion photos and a short handover note.",
    criteria: ["Gate opens and closes without rubbing.", "Handover photos show the completed installation."],
  };
  const salts = {
    title: `0x${"a1".repeat(32)}`,
    description: `0x${"a2".repeat(32)}`,
    scope: `0x${"a3".repeat(32)}`,
    deliveryRules: `0x${"a4".repeat(32)}`,
    "criteria.0": `0x${"a5".repeat(32)}`,
    "criteria.1": `0x${"a6".repeat(32)}`,
  };
  const commitments = {
    title: privateCommitment(FIELD_TAGS.title, values.title, salts.title),
    description: privateCommitment(FIELD_TAGS.description, values.description, salts.description),
    scope: privateCommitment(FIELD_TAGS.scope, values.scope, salts.scope),
    deliveryRules: privateCommitment(FIELD_TAGS.deliveryRules, values.deliveryRules, salts.deliveryRules),
    "criteria.0": privateCommitment(FIELD_TAGS.criteria, values.criteria[0], salts["criteria.0"]),
    "criteria.1": privateCommitment(FIELD_TAGS.criteria, values.criteria[1], salts["criteria.1"]),
  };
  return { ...values, salts, commitments };
}

function buildSnapshot(jobId = JOB_ID) {
  const terms = makeTerms();
  return {
    jobId: String(jobId),
    now: BigInt(Math.floor(clockMs / 1000)),
    job: {
      client: CLIENT.address,
      freelancer: FREELANCER.address,
      token: "0x0000000000000000000000000000000000000010",
      state: 2,
      totalAmount: 1000n,
      createdAt: 1n,
      proposalEnd: 2n,
      acceptedAt: 1n,
      fundingDeadline: 2n,
      fundedAt: 1n,
      reviewWindow: 120n,
      revisionLimit: 2,
      milestoneCount: 2,
    },
    commitments: {
      titleCommitment: terms.commitments.title,
      descriptionCommitment: terms.commitments.description,
      scopeCommitment: terms.commitments.scope,
      deliveryRuleCommitment: terms.commitments.deliveryRules,
    },
    milestones: [0, 1].map((index) => ({
      amount: index === 0 ? 600n : 400n,
      duration: 3600n,
      acceptanceCriteriaCommitment: terms.commitments[`criteria.${index}`],
      deadline: 5000n,
      graceEnd: 6000n,
      state: 0,
      submittedAt: 0n,
      reviewEnd: 0n,
      rejectedAt: 0n,
      responseEnd: 0n,
      rejectionCount: 0,
      submissionCount: 0,
      latestReasonCommitment: `0x${"00".repeat(32)}`,
      submissions: [],
      disputeId: 0n,
      dispute: null,
      panels: { 1: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"], 2: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"] },
      history: [],
      votes: {},
    })),
    claimable: 0n,
    lockedEscrow: 1000n,
    disputeDeposits: 0n,
    withdrawn: 0n,
  };
}

function createChainPort() {
  return {
    async getPublicConfig() {
      return {
        chainId: CHAIN_ID,
        rpcUrl: "http://127.0.0.1:8545",
        escrow: "0x0000000000000000000000000000000000000011",
        arbitration: "0x0000000000000000000000000000000000000012",
        randomness: "0x0000000000000000000000000000000000000013",
        startBlock: 0n,
        blockNumber: 100n,
        codeHashes: {
          escrow: `0x${"10".repeat(32)}`,
          arbitration: `0x${"20".repeat(32)}`,
          randomness: `0x${"30".repeat(32)}`,
        },
        tokens: [],
        roles: { client: CLIENT.address, freelancer: FREELANCER.address, treasury: CLIENT.address, arbiters: [ARBITER.address] },
        domain: DOMAIN,
        uri: ORIGIN,
      };
    },
    async readJobAccess(jobId, wallet) {
      accessReadCount += 1;
      return {
        ...structuredClone(accessFor(jobAccess, jobId, wallet)),
        snapshot: structuredClone(snapshots.get(String(jobId)) ?? buildSnapshot(String(jobId))),
      };
    },
    async readDisputeAccess(disputeId, wallet) {
      const access = structuredClone(accessFor(disputeAccess, disputeId, wallet));
      return {
        ...access,
        snapshot: structuredClone(snapshots.get(String(access.jobId)) ?? buildSnapshot(String(access.jobId))),
      };
    },
    async readJobSnapshot(jobId) {
      return structuredClone(snapshots.get(String(jobId)) ?? buildSnapshot(String(jobId)));
    },
    async readChainEvents(jobId) {
      return structuredClone(chainEvents.get(String(jobId)) ?? []);
    },
  };
}

function makeRequest(method, route, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.origin !== null && !headers.has("Origin")) headers.set("Origin", options.origin ?? ORIGIN);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  let body = options.body;
  if (body !== undefined && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  return new Request(new URL(route, ORIGIN), { method, headers, body });
}

function cookiePair(response, requiredName) {
  const raw = response.headers.get("set-cookie") ?? "";
  const pair = raw.split(/,\s*(?=[^;,]+=)/).find((item) => item.trim().startsWith(`${requiredName}=`));
  return pair?.split(";", 1)[0] ?? "";
}

function assertSecureCookie(setCookie, name) {
  assert.match(setCookie, new RegExp(`^${name}=`));
  assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)SameSite=Strict(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/i);
  assert.doesNotMatch(setCookie, /(?:^|;\s*)Domain=/i);
}

function jsonRequest(method, route, body, options = {}) {
  return makeRequest(method, route, { ...options, body });
}

async function responseJson(response) {
  return response.json();
}

function createDependencies() {
  const chain = createChainPort();
  return {
    db,
    chain,
    now: () => clockMs,
    storageDir,
    masterKey: MASTER_KEY,
    sessionSecret: SESSION_SECRET,
    origin: ORIGIN,
    rateLimit: async (bucket, key) => {
      rateLimitCalls.push({ bucket, key });
      return rateAllowed;
    },
  };
}

async function resetDb() {
  await db.auditEntry.deleteMany();
  await db.privateNote.deleteMany();
  await db.privateEvidence.deleteMany();
  await db.privateFile.deleteMany();
  await db.privateJobData.deleteMany();
  await db.authSession.deleteMany();
  await db.authNonce.deleteMany();
}

async function resetState() {
  await resetDb();
  clockMs = FIXED_NOW;
  rateAllowed = true;
  jobAccess = new Map();
  disputeAccess = new Map();
  snapshots = new Map([[JOB_ID, buildSnapshot(JOB_ID)]]);
  chainEvents = new Map();
  accessReadCount = 0;
  rateLimitCalls = [];
  sessionSerial = 0;
  await rm(storageDir, { recursive: true, force: true });
  await mkdir(storageDir, { recursive: true });
  grantJob(JOB_ID, CLIENT.address, "client", { closedAt: null });
  grantJob(JOB_ID, FREELANCER.address, "freelancer", { closedAt: null });
  grantDispute(DISPUTE_ID, JOB_ID, CLIENT.address, "client", { unresolved: true });
  grantDispute(DISPUTE_ID, JOB_ID, FREELANCER.address, "freelancer", { unresolved: true });
  grantDispute(DISPUTE_ID, JOB_ID, ARBITER.address, "arbiter", { unresolved: true });
  handlers = createRouteHandlers(createDependencies());
}

async function addSession(wallet) {
  sessionSerial += 1;
  const sessionToken = `${SESSION_TOKEN}-${sessionSerial}`;
  const csrfToken = `${CSRF_TOKEN}-${sessionSerial}`;
  await db.authSession.create({
    data: {
      id: `test-${normalizedWallet(wallet).slice(2, 10)}`,
      wallet: normalizedWallet(wallet),
      sessionTokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      csrfTokenHash: createHash("sha256").update(csrfToken).digest("hex"),
      expiresAt: new Date(clockMs + 30 * 60 * 1000),
      createdAt: new Date(clockMs),
      revokedAt: null,
    },
  });
  return { cookie: `${SESSION_COOKIE}=${sessionToken}`, csrf: csrfToken };
}

async function makeSignedMessage(account, nonce, overrides = {}) {
  const message = new SiweMessage({
    domain: DOMAIN,
    address: account.address,
    statement: "Sign in to Fairwork local demo.",
    uri: ORIGIN,
    version: "1",
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date(clockMs).toISOString(),
    expirationTime: new Date(clockMs + 5 * 60 * 1000).toISOString(),
    ...overrides,
  }).prepareMessage();
  return { message, signature: await account.signMessage({ message }) };
}

async function issueNonce() {
  const response = await handlers.noncePOST(makeRequest("POST", "/api/auth/nonce", { body: {} }));
  return { response, body: await responseJson(response), challenge: cookiePair(response, CHALLENGE_COOKIE) };
}

async function loginAs(account) {
  const issued = await issueNonce();
  const signed = await makeSignedMessage(account, issued.body.nonce);
  const response = await handlers.loginPOST(
    jsonRequest("POST", "/api/auth/login", signed, { cookie: issued.challenge }),
  );
  return { response, body: await responseJson(response), sessionCookie: cookiePair(response, SESSION_COOKIE) };
}

function assertBytes32(value) {
  assert.match(value, /^0x[0-9a-f]{64}$/i);
}

function evidenceEvent(disputeId = DISPUTE_ID, jobId = JOB_ID, party = FREELANCER.address, text = "Stonework photos show the fitted gate.") {
  const salt = `0x${"e1".repeat(32)}`;
  const commitment = privateCommitment(FIELD_TAGS.evidence, text, salt);
  const reference = `0x${"c7".repeat(32)}`;
  return {
    body: { text, salt, commitment, reference },
    event: {
      source: "chain",
      name: "EvidenceCommitted",
      contract: "0x0000000000000000000000000000000000000012",
      blockNumber: 100n,
      transactionIndex: 0,
      logIndex: 0,
      args: {
        disputeId: BigInt(disputeId),
        party,
        evidenceHash: commitment,
        opaqueReference: reference,
        submittedAt: BigInt(Math.floor(clockMs / 1000)),
      },
    },
  };
}

async function uploadPdf(auth, jobId = JOB_ID, filename = "handover.pdf", bytes = Buffer.from("%PDF-1.7\nprivate deliverable\n%%EOF\n"), milestoneIndex = 0) {
  const form = new FormData();
  form.set("kind", "submission");
  form.set("milestoneIndex", String(milestoneIndex));
  form.set("file", new Blob([bytes], { type: "application/pdf" }), filename);
  return handlers.fileUploadPOST(
    makeRequest("POST", `/api/jobs/${jobId}/files`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      body: form,
    }),
    String(jobId),
  );
}

async function uploadEvidencePdf(auth, disputeId = DISPUTE_ID, filename = "evidence.pdf", bytes = Buffer.from("%PDF-1.7\nprivate evidence\n%%EOF\n"), milestoneIndex = 0) {
  const form = new FormData();
  form.set("kind", "evidence");
  form.set("milestoneIndex", String(milestoneIndex));
  form.set("disputeId", String(disputeId));
  form.set("file", new Blob([bytes], { type: "application/pdf" }), filename);
  return handlers.fileUploadPOST(
    makeRequest("POST", `/api/jobs/${JOB_ID}/files`, {
      cookie: auth.cookie,
      csrf: auth.csrf,
      body: form,
    }),
    JOB_ID,
  );
}

function fileEvidenceEvent(file, disputeId = DISPUTE_ID, jobId = JOB_ID, party = FREELANCER.address) {
  return {
    source: "chain",
    name: "EvidenceCommitted",
    contract: "0x0000000000000000000000000000000000000012",
    blockNumber: 100n,
    transactionIndex: 0,
    logIndex: 1,
    args: {
      disputeId: BigInt(disputeId),
      party,
      evidenceHash: file.hash,
      opaqueReference: file.reference,
      submittedAt: BigInt(Math.floor(clockMs / 1000)),
    },
  };
}

test("Phase 4 backend security behavior", async (t) => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  tempRoot = path.join(process.cwd(), "apps", "web");
  databasePath = path.join(tempRoot, `security-test-${process.pid}.sqlite`);
  databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  process.env.DATABASE_URL = databaseUrl;
  const prismaCli = path.join(process.cwd(), "apps", "web", "node_modules", "prisma", "build", "index.js");
  const schemaPath = path.join(process.cwd(), "apps", "web", "prisma", "schema.prisma");
  const dbPush = spawnSync(process.execPath, [prismaCli, "db", "push", "--schema", schemaPath, "--skip-generate"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "debug" },
  });
  assert.equal(dbPush.status, 0, `${dbPush.stdout}\n${dbPush.stderr}`);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$connect();
  storageDir = path.join(tempRoot, `security-private-storage-${process.pid}`);
  await mkdir(storageDir, { recursive: true });

  try {
    await t.test("W-01: nonce response is origin-bound and has a five-minute browser challenge cookie", async () => {
      await resetState();
      const { response, body, challenge } = await issueNonce();
      assert.equal(response.status, 200);
      assert.equal(body.domain, DOMAIN);
      assert.equal(body.uri, ORIGIN);
      assert.equal(body.chainId, CHAIN_ID);
      assert.ok(new Date(body.expiresAt).getTime() - clockMs <= 5 * 60 * 1000);
      assertSecureCookie(response.headers.get("set-cookie") ?? "", CHALLENGE_COOKIE);
      assert.ok(challenge);
      const challengeValue = challenge.split("=", 2)[1];
      const nonceRow = await db.authNonce.findUnique({ where: { nonceHash: hashSecret(body.nonce) } });
      assert.ok(nonceRow);
      assert.equal(nonceRow.challengeTokenHash, hashSecret(challengeValue));
      assert.notEqual(nonceRow.nonceHash, body.nonce);
      assert.notEqual(nonceRow.challengeTokenHash, challengeValue);
      assert.equal((await handlers.noncePOST(makeRequest("POST", "/api/auth/nonce", { origin: "https://attacker.example", body: {} }))).status, 403);
    });

    await t.test("W-01: SIWE validates domain, URI, chain, signer, expiry, and consumes a nonce once", async () => {
      await resetState();
      const issued = await issueNonce();
      assert.equal(issued.response.status, 200);
      const valid = await makeSignedMessage(CLIENT, issued.body.nonce);
      const login = await handlers.loginPOST(jsonRequest("POST", "/api/auth/login", valid, { cookie: issued.challenge }));
      assert.equal(login.status, 200);
      assertSecureCookie(login.headers.get("set-cookie") ?? "", SESSION_COOKIE);
      const replay = await handlers.loginPOST(jsonRequest("POST", "/api/auth/login", valid, { cookie: issued.challenge }));
      assert.equal(replay.status, 401);

      for (const overrides of [
        { domain: "attacker.example" },
        { uri: "https://localhost:3000" },
        { chainId: 1 },
      ]) {
        const fresh = await issueNonce();
        const bad = await makeSignedMessage(CLIENT, fresh.body.nonce, overrides);
        assert.equal((await handlers.loginPOST(jsonRequest("POST", "/api/auth/login", bad, { cookie: fresh.challenge }))).status, 401);
      }

      const wrongSigner = await issueNonce();
      const signedByWrongWallet = await makeSignedMessage(STRANGER, wrongSigner.body.nonce, { address: CLIENT.address });
      assert.equal((await handlers.loginPOST(jsonRequest("POST", "/api/auth/login", signedByWrongWallet, { cookie: wrongSigner.challenge }))).status, 401);

      const expired = await issueNonce();
      const expiredSignature = await makeSignedMessage(CLIENT, expired.body.nonce);
      clockMs += 5 * 60 * 1000 + 1;
      assert.equal((await handlers.loginPOST(jsonRequest("POST", "/api/auth/login", expiredSignature, { cookie: expired.challenge }))).status, 401);

      await resetState();
      const expiredNonce = await issueNonce();
      const stillValidMessage = await makeSignedMessage(CLIENT, expiredNonce.body.nonce, {
        expirationTime: new Date(clockMs + 30 * 60 * 1000).toISOString(),
      });
      clockMs += 5 * 60 * 1000 + 1;
      assert.equal((await handlers.loginPOST(jsonRequest("POST", "/api/auth/login", stillValidMessage, { cookie: expiredNonce.challenge }))).status, 401, "the nonce and challenge expire independently of the still-valid signed message");
    });

    await t.test("W-02: session is server-side, short-lived, and invalidated by logout", async () => {
      await resetState();
      const login = await loginAs(CLIENT);
      assert.equal(login.response.status, 200);
      assert.equal(login.body.wallet.toLowerCase(), CLIENT.address.toLowerCase());
      assert.ok(new Date(login.body.expiresAt).getTime() - clockMs <= 30 * 60 * 1000);
      assert.ok(login.body.csrfToken);
      assertSecureCookie(login.response.headers.get("set-cookie") ?? "", SESSION_COOKIE);
      const sessionValue = login.sessionCookie.split("=", 2)[1];
      const sessionRow = await db.authSession.findUnique({ where: { sessionTokenHash: hashSecret(sessionValue) } });
      assert.ok(sessionRow);
      assert.notEqual(sessionRow.sessionTokenHash, sessionValue);
      assert.equal(sessionRow.csrfTokenHash, hashSecret(login.body.csrfToken));
      assert.notEqual(sessionRow.csrfTokenHash, login.body.csrfToken);
      const session = await handlers.sessionGET(makeRequest("GET", "/api/auth/session", { cookie: login.sessionCookie }));
      assert.equal(session.status, 200);
      const logout = await handlers.logoutPOST(
        makeRequest("POST", "/api/auth/logout", { cookie: login.sessionCookie, csrf: login.body.csrfToken }),
      );
      assert.equal(logout.status, 200);
      assertSecureCookie(logout.headers.get("set-cookie") ?? "", SESSION_COOKIE);
      assert.equal((await handlers.sessionGET(makeRequest("GET", "/api/auth/session", { cookie: login.sessionCookie }))).status, 401);

      await resetState();
      const expiring = await loginAs(CLIENT);
      assert.equal(expiring.response.status, 200);
      clockMs += 30 * 60 * 1000 + 1;
      assert.equal((await handlers.sessionGET(makeRequest("GET", "/api/auth/session", { cookie: expiring.sessionCookie }))).status, 401);
    });

    await t.test("W-04/P-04/P-07: every private resource uses fresh chain roles and hides unauthorized IDs with 404", async () => {
      await resetState();
      const clientAuth = await addSession(STRANGER.address);
      const before = accessReadCount;
      const job = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: clientAuth.cookie }), JOB_ID);
      assert.equal(job.status, 404);
      const unknown = await handlers.jobGET(makeRequest("GET", "/api/jobs/999", { cookie: clientAuth.cookie }), "999");
      assert.equal(unknown.status, 404);
      assert.deepEqual(await responseJson(job), await responseJson(unknown));
      assert.ok(accessReadCount >= before + 2, "a chain access read occurs for each request");

      const evidence = await handlers.evidenceGET(makeRequest("GET", "/api/disputes/1/evidence", { cookie: clientAuth.cookie }), DISPUTE_ID);
      const missingEvidence = await handlers.evidenceGET(makeRequest("GET", "/api/disputes/999/evidence", { cookie: clientAuth.cookie }), "999");
      assert.equal(evidence.status, 404);
      assert.equal(missingEvidence.status, 404);
      assert.deepEqual(await responseJson(evidence), await responseJson(missingEvidence));

      const evidenceDraft = evidenceEvent();
      chainEvents.set(JOB_ID, [evidenceDraft.event]);
      prepareEvidenceDispute();
      const noteText = "A valid but unauthorized rejection reason.";
      const noteSalt = `0x${"a9".repeat(32)}`;
      const noteCommitment = privateCommitment(FIELD_TAGS.rejectionReason, noteText, noteSalt);
      prepareRejectionNote(noteCommitment);
      const validNote = { kind: "rejection", milestoneIndex: 0, version: 1, text: noteText, salt: noteSalt, commitment: noteCommitment };
      const noteRead = await handlers.noteGET(makeRequest("GET", "/api/jobs/1/notes", { cookie: clientAuth.cookie }), JOB_ID);
      const noteWrite = await handlers.notePOST(jsonRequest("POST", "/api/jobs/1/notes", validNote, { cookie: clientAuth.cookie, csrf: clientAuth.csrf }), JOB_ID);
      const termsWrite = await handlers.jobPUT(jsonRequest("PUT", "/api/jobs/1", makeTerms(), { cookie: clientAuth.cookie, csrf: clientAuth.csrf }), JOB_ID);
      const evidenceWrite = await handlers.evidencePOST(jsonRequest("POST", "/api/disputes/1/evidence", evidenceDraft.body, { cookie: clientAuth.cookie, csrf: clientAuth.csrf }), DISPUTE_ID);
      const fileForm = new FormData();
      fileForm.set("kind", "submission");
      fileForm.set("milestoneIndex", "0");
      fileForm.set("file", new Blob(["%PDF-1.7\nvalid payload\n%%EOF"], { type: "application/pdf" }), "valid.pdf");
      const fileWrite = await handlers.fileUploadPOST(makeRequest("POST", "/api/jobs/1/files", { cookie: clientAuth.cookie, csrf: clientAuth.csrf, body: fileForm }), JOB_ID);
      const fileRead = await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=0", { cookie: clientAuth.cookie }), JOB_ID);
      const fileTicket = await handlers.fileDownloadGET(makeRequest("GET", "/api/files/00000000-0000-4000-8000-000000000001/download", { cookie: clientAuth.cookie }), "00000000-0000-4000-8000-000000000001");
      for (const response of [noteRead, noteWrite, termsWrite, evidenceWrite, fileWrite, fileRead, fileTicket]) {
        assert.equal(response.status, 404);
      }

      const timeline = await handlers.timelineGET(makeRequest("GET", "/api/jobs/1/timeline", { cookie: clientAuth.cookie }), JOB_ID);
      const audit = await handlers.auditGET(makeRequest("GET", "/api/jobs/1/audit", { cookie: clientAuth.cookie }), JOB_ID);
      assert.equal(timeline.status, 404);
      assert.equal(audit.status, 404);
      assert.equal(handlers.jobsGET, undefined, "there is no job enumeration handler");
    });

    await t.test("W-04/P-04: party read permission is rechecked after a role changes", async () => {
      await resetState();
      const terms = makeTerms();
      const auth = await addSession(CLIENT.address);
      const save = await handlers.jobPUT(
        jsonRequest("PUT", "/api/jobs/1", terms, { cookie: auth.cookie, csrf: auth.csrf }),
        JOB_ID,
      );
      assert.equal(save.status, 200);
      const firstRead = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: auth.cookie }), JOB_ID);
      assert.equal(firstRead.status, 200);
      assert.equal((await responseJson(firstRead)).title, terms.title);
      const access = grantJob(JOB_ID, CLIENT.address, "client");
      access.client = CLIENT.address;
      const truthyAddressRole = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: auth.cookie }), JOB_ID);
      assert.equal(truthyAddressRole.status, 404, "a truthy address string is not the normalized boolean client role");
      access.client = false;
      const revokedRead = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: auth.cookie }), JOB_ID);
      assert.equal(revokedRead.status, 404);
    });

    await t.test("W-05/P-03: job terms require A38 salted commitments and remain private at rest", async () => {
      await resetState();
      const auth = await addSession(CLIENT.address);
      const good = makeTerms();
      const save = await handlers.jobPUT(jsonRequest("PUT", "/api/jobs/1", good, { cookie: auth.cookie, csrf: auth.csrf }), JOB_ID);
      assert.equal(save.status, 200);
      const loaded = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: auth.cookie }), JOB_ID);
      assert.equal(loaded.status, 200);
      const responseText = await loaded.text();
      assert.match(responseText, /Replace the entry gate/);
      assert.match(responseText, new RegExp(good.salts.title.slice(2), "i"));

      const tampered = makeTerms();
      tampered.title = "Different private title";
      assert.equal((await handlers.jobPUT(jsonRequest("PUT", "/api/jobs/1", tampered, { cookie: auth.cookie, csrf: auth.csrf }), JOB_ID)).status, 400);
      const malformed = await handlers.jobPUT(jsonRequest("PUT", "/api/jobs/1", { title: "<script>alert(1)</script>" }, { cookie: auth.cookie, csrf: auth.csrf }), JOB_ID);
      assert.equal(malformed.status, 400);
      const dbRow = await db.privateJobData.findUnique({ where: { jobId: JOB_ID } });
      assert.ok(dbRow);
      assert.doesNotMatch(Buffer.from(dbRow.ciphertext).toString("utf8"), /Replace the entry gate/);
      assert.doesNotMatch(JSON.stringify(await db.auditEntry.findMany()), /Replace the entry gate|a1{64}/i);
    });

    await t.test("P-03/P-04/F-12: rejection notes match the on-chain reason and stay private", async () => {
      await resetState();
      const text = "The latch still rubs against the frame at the top corner.";
      const salt = `0x${"b6".repeat(32)}`;
      const commitment = privateCommitment(FIELD_TAGS.rejectionReason, text, salt);
      prepareRejectionNote(commitment);
      const clientAuth = await addSession(CLIENT.address);
      const freelancerAuth = await addSession(FREELANCER.address);
      const arbiterAuth = await addSession(ARBITER.address);
      const note = {
        kind: "rejection",
        milestoneIndex: 0,
        version: 1,
        text,
        salt,
        commitment,
      };
      const wrongParty = await handlers.notePOST(jsonRequest("POST", "/api/jobs/1/notes", note, { cookie: freelancerAuth.cookie, csrf: freelancerAuth.csrf }), JOB_ID);
      assert.equal(wrongParty.status, 404);
      const wrongReason = await handlers.notePOST(jsonRequest("POST", "/api/jobs/1/notes", { ...note, text: "A different reason." }, { cookie: clientAuth.cookie, csrf: clientAuth.csrf }), JOB_ID);
      assert.equal(wrongReason.status, 400);
      const saved = await handlers.notePOST(jsonRequest("POST", "/api/jobs/1/notes", note, { cookie: clientAuth.cookie, csrf: clientAuth.csrf }), JOB_ID);
      assert.equal(saved.status, 200);

      const read = await handlers.noteGET(makeRequest("GET", "/api/jobs/1/notes", { cookie: freelancerAuth.cookie }), JOB_ID);
      assert.equal(read.status, 200);
      const notePayload = await responseJson(read);
      assert.deepEqual(Object.keys(notePayload), ["notes"]);
      assert.equal(notePayload.notes.length, 1);
      assert.match(JSON.stringify(notePayload), /The latch still rubs against the frame/);
      const privateNote = await db.privateNote.findFirst({ where: { jobId: JOB_ID, kind: "rejection" } });
      assert.ok(privateNote);
      assert.doesNotMatch(Buffer.from(privateNote.ciphertext).toString("utf8"), /The latch still rubs/);

      const arbiterRead = await handlers.noteGET(makeRequest("GET", "/api/jobs/1/notes", { cookie: arbiterAuth.cookie }), JOB_ID);
      assert.equal(arbiterRead.status, 200);
      const audit = await handlers.auditGET(makeRequest("GET", "/api/jobs/1/audit", { cookie: clientAuth.cookie }), JOB_ID);
      assert.equal(audit.status, 200);
      assert.match(await audit.clone().text(), /NOTE_READ|PRIVATE_NOTE_READ/);
      assert.doesNotMatch(await audit.clone().text(), /The latch still rubs|b6{64}/i);

      const arbiter = grantDispute(DISPUTE_ID, JOB_ID, ARBITER.address, "arbiter", { unresolved: false });
      arbiter.unresolved = false;
      assert.equal((await handlers.noteGET(makeRequest("GET", "/api/jobs/1/notes", { cookie: arbiterAuth.cookie }), JOB_ID)).status, 404);
    });

    await t.test("W-08: every authenticated write rejects cross-origin or missing CSRF", async () => {
      await resetState();
      const auth = await addSession(CLIENT.address);
      const badOrigin = await handlers.jobPUT(
        jsonRequest("PUT", "/api/jobs/1", makeTerms(), { cookie: auth.cookie, csrf: auth.csrf, origin: "https://attacker.example" }),
        JOB_ID,
      );
      assert.equal(badOrigin.status, 403);
      const noCsrf = await handlers.jobPUT(jsonRequest("PUT", "/api/jobs/1", makeTerms(), { cookie: auth.cookie }), JOB_ID);
      assert.equal(noCsrf.status, 403);
      const badLogout = await handlers.logoutPOST(makeRequest("POST", "/api/auth/logout", { cookie: auth.cookie, csrf: auth.csrf, origin: "https://attacker.example" }));
      assert.equal(badLogout.status, 403);

      const evidence = evidenceEvent();
      const badEvidence = await handlers.evidencePOST(
        jsonRequest("POST", "/api/disputes/1/evidence", evidence.body, { cookie: auth.cookie, csrf: auth.csrf, origin: "https://attacker.example" }),
        DISPUTE_ID,
      );
      assert.equal(badEvidence.status, 403);
      const noteBody = { kind: "rejection", milestoneIndex: 0, version: 1, text: "Reason", salt: `0x${"01".repeat(32)}`, commitment: `0x${"02".repeat(32)}` };
      const badNoteOrigin = await handlers.notePOST(jsonRequest("POST", "/api/jobs/1/notes", noteBody, { cookie: auth.cookie, csrf: auth.csrf, origin: "https://attacker.example" }), JOB_ID);
      assert.equal(badNoteOrigin.status, 403);
      const missingNoteCsrf = await handlers.notePOST(jsonRequest("POST", "/api/jobs/1/notes", noteBody, { cookie: auth.cookie }), JOB_ID);
      assert.equal(missingNoteCsrf.status, 403);
      const upload = new FormData();
      upload.set("kind", "submission");
      upload.set("milestoneIndex", "0");
      upload.set("file", new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" }), "x.pdf");
      const badUpload = await handlers.fileUploadPOST(makeRequest("POST", "/api/jobs/1/files", { cookie: auth.cookie, csrf: auth.csrf, origin: "https://attacker.example", body: upload }), JOB_ID);
      assert.equal(badUpload.status, 403);
    });

    await t.test("W-01/W-04: rate limits fail closed and ignore attacker-supplied forwarding headers", async () => {
      await resetState();
      rateAllowed = false;
      const nonce = await handlers.noncePOST(makeRequest("POST", "/api/auth/nonce", { body: {} }));
      assert.equal(nonce.status, 429);
      assert.equal(rateLimitCalls.filter((call) => call.bucket === "auth").length, 1);
      rateLimitCalls = [];
      await handlers.noncePOST(makeRequest("POST", "/api/auth/nonce", { headers: { "X-Forwarded-For": "203.0.113.11" }, body: {} }));
      const forwardedKey = rateLimitCalls.find((call) => call.bucket === "auth")?.key;
      rateLimitCalls = [];
      await handlers.noncePOST(makeRequest("POST", "/api/auth/nonce", { headers: { "X-Forwarded-For": "198.51.100.27" }, body: {} }));
      const spoofedKey = rateLimitCalls.find((call) => call.bucket === "auth")?.key;
      assert.equal(forwardedKey, spoofedKey, "the factory must not trust an HTTP forwarding header when deriving rate-limit identity");
      const auth = await addSession(CLIENT.address);
      const job = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: auth.cookie }), JOB_ID);
      assert.equal(job.status, 429);
    });

    await t.test("W-10/A38: file upload content-checks, caps size, encrypts at rest, and never exposes a storage URL", async () => {
      await resetState();
      const auth = await addSession(FREELANCER.address);
      const validBytes = Buffer.from("%PDF-1.7\nprivate deliverable body\n%%EOF\n");
      const uploaded = await uploadPdf(auth, JOB_ID, "handover.pdf", validBytes);
      assert.equal(uploaded.status, 200);
      const file = await responseJson(uploaded);
      assert.deepEqual(Object.keys(file).sort(), ["hash", "id", "mime", "reference", "size"]);
      assertBytes32(file.hash);
      assertBytes32(file.reference);
      assert.equal(file.size, validBytes.length);
      assert.equal(file.mime, "application/pdf");
      assert.equal("url" in file, false);

      const storedPaths = await readdir(storageDir, { recursive: true });
      const storedFiles = [];
      for (const entry of storedPaths) {
        const fullPath = path.join(storageDir, entry.toString());
        const bytes = await readFile(fullPath);
        storedFiles.push({ fullPath, bytes });
      }
      assert.equal(storedFiles.length, 1);
      assert.notDeepEqual(storedFiles[0].bytes, validBytes);
      assert.equal(storedFiles[0].bytes.includes(Buffer.from("private deliverable body")), false);
      const webPublic = path.resolve(process.cwd(), "apps", "web", "public");
      assert.equal(storedFiles.some(({ fullPath }) => path.resolve(fullPath).startsWith(`${webPublic}${path.sep}`)), false);

      const clientAuth = await addSession(CLIENT.address);
      const listed = await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=0", { cookie: clientAuth.cookie }), JOB_ID);
      assert.equal(listed.status, 200);
      const listedBody = await responseJson(listed);
      assert.deepEqual(Object.keys(listedBody), ["files"]);
      const listedFiles = listedBody.files;
      const draftFile = listedFiles.find((item) => item.id === file.id);
      assert.ok(draftFile);
      assert.equal(draftFile.bound, false, "a party's local upload stays explicitly unbound until the on-chain file hash and reference match");
      assert.equal(listedFiles.some((item) => "storageKey" in item || "path" in item), false);

      const html = await uploadPdf(auth, JOB_ID, "danger.html.pdf", validBytes);
      assert.equal(html.status, 400);
      const svgForm = new FormData();
      svgForm.set("kind", "submission");
      svgForm.set("milestoneIndex", "0");
      svgForm.set("file", new Blob(["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"], { type: "image/svg+xml" }), "drawing.svg");
      const svg = await handlers.fileUploadPOST(makeRequest("POST", "/api/jobs/1/files", { cookie: auth.cookie, csrf: auth.csrf, body: svgForm }), JOB_ID);
      assert.equal(svg.status, 400);
      const wrongMimeForm = new FormData();
      wrongMimeForm.set("kind", "submission");
      wrongMimeForm.set("milestoneIndex", "0");
      wrongMimeForm.set("file", new Blob([validBytes], { type: "text/plain" }), "wrong-mime.pdf");
      const wrongMime = await handlers.fileUploadPOST(makeRequest("POST", "/api/jobs/1/files", { cookie: auth.cookie, csrf: auth.csrf, body: wrongMimeForm }), JOB_ID);
      assert.equal(wrongMime.status, 400, "declared content type must agree with safely sniffed file bytes and extension");
      const traversal = await uploadPdf(auth, JOB_ID, "../outside.pdf", validBytes);
      assert.equal(traversal.status, 400);

      const large = await uploadPdf(auth, JOB_ID, "large.pdf", Buffer.alloc(MAX_FILE_BYTES + 1, 0x41));
      assert.equal(large.status, 413);
    });

    await t.test("A38: assigned arbiter file access is limited to its unresolved dispute and milestone", async () => {
      await resetState();
      const freelancerAuth = await addSession(FREELANCER.address);
      const arbiterAuth = await addSession(ARBITER.address);
      const clientAuth = await addSession(CLIENT.address);
      const first = await uploadPdf(freelancerAuth, JOB_ID, "milestone-one.pdf", Buffer.from("%PDF-1.7\nfirst milestone\n%%EOF\n"), 0);
      assert.equal(first.status, 200);
      const firstFile = await responseJson(first);
      const second = await uploadPdf(freelancerAuth, JOB_ID, "milestone-two.pdf", Buffer.from("%PDF-1.7\nsecond milestone\n%%EOF\n"), 1);
      assert.equal(second.status, 200);
      const secondFile = await responseJson(second);
      const evidenceUpload = await uploadEvidencePdf(freelancerAuth);
      assert.equal(evidenceUpload.status, 200);
      const evidenceFile = await responseJson(evidenceUpload);
      grantDispute("2", JOB_ID, FREELANCER.address, "freelancer", { unresolved: true });
      const otherCaseEvidenceUpload = await uploadEvidencePdf(freelancerAuth, "2", "other-case.pdf", Buffer.from("%PDF-1.7\nother dispute evidence\n%%EOF\n"), 1);
      assert.equal(otherCaseEvidenceUpload.status, 200);
      const otherCaseEvidenceFile = await responseJson(otherCaseEvidenceUpload);
      chainEvents.set(JOB_ID, [fileEvidenceEvent(evidenceFile), fileEvidenceEvent(otherCaseEvidenceFile, "2")]);
      const disputed = prepareEvidenceDispute();
      disputed.milestones[1].state = 3;
      disputed.milestones[1].disputeId = 2n;
      disputed.milestones[1].dispute = {
        jobId: BigInt(JOB_ID),
        milestoneIndex: 1n,
        client: CLIENT.address,
        freelancer: FREELANCER.address,
        phase: 1,
        evidenceDeadline: BigInt(Math.floor(clockMs / 1000) + 60),
        clientEvidenceCount: 0,
        freelancerEvidenceCount: 0,
      };
      disputed.milestones[0].submissions = [
        { version: 1, deliverableHash: firstFile.hash, opaqueReference: firstFile.reference, submittedAt: BigInt(Math.floor(clockMs / 1000)) },
      ];
      disputed.milestones[0].submissionCount = 1;
      snapshots.set(JOB_ID, disputed);

      const partyList = await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=0", { cookie: clientAuth.cookie }), JOB_ID);
      assert.equal(partyList.status, 200);
      const partyBody = await responseJson(partyList);
      assert.deepEqual(Object.keys(partyBody), ["files"]);
      const partyFiles = partyBody.files;
      assert.ok(partyFiles.some((item) => item.id === firstFile.id));
      assert.ok(partyFiles.some((item) => item.id === evidenceFile.id));

      const mismatchedEvidenceEvent = fileEvidenceEvent(evidenceFile);
      mismatchedEvidenceEvent.args.evidenceHash = `0x${"ee".repeat(32)}`;
      chainEvents.set(JOB_ID, [mismatchedEvidenceEvent]);
      const mismatchedEvidence = await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=0", { cookie: arbiterAuth.cookie }), JOB_ID);
      assert.equal(mismatchedEvidence.status, 200);
      assert.equal((await responseJson(mismatchedEvidence)).files.some((item) => item.id === evidenceFile.id), false, "arbiter evidence file is hidden until both on-chain hash and reference match");

      chainEvents.set(JOB_ID, [fileEvidenceEvent(evidenceFile)]);
      const arbiterList = await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=0", { cookie: arbiterAuth.cookie }), JOB_ID);
      assert.equal(arbiterList.status, 200);
      const arbiterBody = await responseJson(arbiterList);
      assert.deepEqual(Object.keys(arbiterBody), ["files"]);
      const arbiterFiles = arbiterBody.files;
      assert.ok(arbiterFiles.some((item) => item.id === firstFile.id), "current arbiter can inspect the disputed milestone deliverable");
      assert.ok(arbiterFiles.some((item) => item.id === evidenceFile.id), "current arbiter can inspect committed evidence");
      assert.equal(arbiterFiles.some((item) => item.id === secondFile.id), false);

      const arbiterDownload = await handlers.fileDownloadGET(makeRequest("GET", `/api/files/${evidenceFile.id}/download`, { cookie: arbiterAuth.cookie }), evidenceFile.id);
      assert.equal(arbiterDownload.status, 200);
      const arbiterTicketUrl = (await responseJson(arbiterDownload)).url;
      const arbiterTicket = new URL(arbiterTicketUrl, ORIGIN).searchParams.get("ticket");
      const wrongReferenceEvent = fileEvidenceEvent(evidenceFile);
      wrongReferenceEvent.args.opaqueReference = `0x${"dd".repeat(32)}`;
      chainEvents.set(JOB_ID, [wrongReferenceEvent]);
      const wrongRefContent = await handlers.fileContentGET(makeRequest("GET", `/api/files/${evidenceFile.id}/content?ticket=${encodeURIComponent(arbiterTicket)}`, { cookie: arbiterAuth.cookie }), evidenceFile.id);
      assert.equal(wrongRefContent.status, 404, "arbiter content read rechecks exact on-chain hash and reference");

      const submissionDownload = await handlers.fileDownloadGET(makeRequest("GET", `/api/files/${firstFile.id}/download`, { cookie: arbiterAuth.cookie }), firstFile.id);
      assert.equal(submissionDownload.status, 200);
      const submissionTicket = new URL((await responseJson(submissionDownload)).url, ORIGIN).searchParams.get("ticket");
      const snapshotWithWrongSubmissionReference = structuredClone(disputed);
      snapshotWithWrongSubmissionReference.milestones[0].submissions[0].opaqueReference = `0x${"cc".repeat(32)}`;
      snapshots.set(JOB_ID, snapshotWithWrongSubmissionReference);
      const wrongSubmissionContent = await handlers.fileContentGET(makeRequest("GET", `/api/files/${firstFile.id}/content?ticket=${encodeURIComponent(submissionTicket)}`, { cookie: arbiterAuth.cookie }), firstFile.id);
      assert.equal(wrongSubmissionContent.status, 404, "arbiter submission content requires the exact on-chain file hash and reference");
      snapshots.set(JOB_ID, disputed);

      const unrelatedMilestone = await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=1", { cookie: arbiterAuth.cookie }), JOB_ID);
      assert.equal(unrelatedMilestone.status, 404);
      const otherCaseDownload = await handlers.fileDownloadGET(makeRequest("GET", `/api/files/${otherCaseEvidenceFile.id}/download`, { cookie: arbiterAuth.cookie }), otherCaseEvidenceFile.id);
      assert.equal(otherCaseDownload.status, 404, "being assigned to dispute 1 does not authorize a case-specific evidence file for dispute 2 on the same job");
      const stranger = await addSession(STRANGER.address);
      assert.equal((await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=0", { cookie: stranger.cookie }), JOB_ID)).status, 404);
      const assigned = grantDispute(DISPUTE_ID, JOB_ID, ARBITER.address, "arbiter", { unresolved: false });
      assigned.unresolved = false;
      assert.equal((await handlers.fileListGET(makeRequest("GET", "/api/jobs/1/files?milestoneIndex=0", { cookie: arbiterAuth.cookie }), JOB_ID)).status, 404);
    });

    await t.test("W-10/P-04: download tickets expire, bind the session, and recheck chain access at content read", async () => {
      await resetState();
      const clientAuth = await addSession(CLIENT.address);
      const freelancerAuth = await addSession(FREELANCER.address);
      const bytes = Buffer.from("%PDF-1.7\nsealed handover\n%%EOF\n");
      const uploaded = await uploadPdf({ ...freelancerAuth, cookie: freelancerAuth.cookie }, JOB_ID, "handover.pdf", bytes);
      assert.equal(uploaded.status, 200);
      const file = await responseJson(uploaded);
      const download = await handlers.fileDownloadGET(makeRequest("GET", `/api/files/${file.id}/download`, { cookie: clientAuth.cookie }), file.id);
      assert.equal(download.status, 200);
      const ticket = await responseJson(download);
      assert.ok(new Date(ticket.expiresAt).getTime() - clockMs <= 60_000);
      assert.ok(ticket.url);
      assert.doesNotMatch(ticket.url, /private-storage|storageKey|ciphertext/i);
      const ticketUrl = new URL(ticket.url, ORIGIN);
      const token = ticketUrl.searchParams.get("ticket");
      assert.ok(token);

      const content = await handlers.fileContentGET(makeRequest("GET", `/api/files/${file.id}/content?ticket=${encodeURIComponent(token)}`, { cookie: clientAuth.cookie }), file.id);
      assert.equal(content.status, 200);
      assert.equal(content.headers.get("content-disposition")?.toLowerCase().startsWith("attachment;"), true);
      assert.match(content.headers.get("cache-control") ?? "", /no-store/i);
      assert.equal(content.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);

      const otherWallet = await handlers.fileContentGET(makeRequest("GET", `/api/files/${file.id}/content?ticket=${encodeURIComponent(token)}`, { cookie: freelancerAuth.cookie }), file.id);
      assert.equal(otherWallet.status, 404);
      const access = grantJob(JOB_ID, CLIENT.address, "client");
      access.client = false;
      const revoked = await handlers.fileContentGET(makeRequest("GET", `/api/files/${file.id}/content?ticket=${encodeURIComponent(token)}`, { cookie: clientAuth.cookie }), file.id);
      assert.equal(revoked.status, 404);
      access.client = true;
      clockMs += 60_001;
      const expired = await handlers.fileContentGET(makeRequest("GET", `/api/files/${file.id}/content?ticket=${encodeURIComponent(token)}`, { cookie: clientAuth.cookie }), file.id);
      assert.equal(expired.status, 404);
    });

    await t.test("P-04/A39: current assigned arbiter may read unresolved evidence only and every read is audited", async () => {
      await resetState();
      const freelancerAuth = await addSession(FREELANCER.address);
      const arbiterAuth = await addSession(ARBITER.address);
      prepareEvidenceDispute();
      const evidence = evidenceEvent();
      chainEvents.set(JOB_ID, [evidence.event]);
      const submitted = await handlers.evidencePOST(jsonRequest("POST", "/api/disputes/1/evidence", evidence.body, { cookie: freelancerAuth.cookie, csrf: freelancerAuth.csrf }), DISPUTE_ID);
      assert.equal(submitted.status, 200);
      const storedEvidence = await db.privateEvidence.findFirst({ where: { disputeId: DISPUTE_ID, reference: evidence.body.reference } });
      assert.ok(storedEvidence);
      assert.doesNotMatch(Buffer.from(storedEvidence.ciphertext).toString("utf8"), /Stonework photos show the fitted gate/);
      const read = await handlers.evidenceGET(makeRequest("GET", "/api/disputes/1/evidence", { cookie: arbiterAuth.cookie }), DISPUTE_ID);
      assert.equal(read.status, 200);
      const payload = await responseJson(read);
      assert.deepEqual(Object.keys(payload), ["items"]);
      assert.match(JSON.stringify(payload.items), /Stonework photos show the fitted gate/);
      assert.match(JSON.stringify(payload.items), new RegExp(evidence.body.salt.slice(2), "i"));
      const clientAuth = await addSession(CLIENT.address);
      const audit = await handlers.auditGET(makeRequest("GET", "/api/jobs/1/audit", { cookie: clientAuth.cookie }), JOB_ID);
      assert.equal(audit.status, 200);
      const auditJson = await responseJson(audit);
      assert.match(JSON.stringify(auditJson), /EVIDENCE_READ/);
      assert.doesNotMatch(JSON.stringify(auditJson), /Stonework photos|e1{64}|ticket=/i);

      const arbiterJob = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: arbiterAuth.cookie }), JOB_ID);
      assert.equal(arbiterJob.status, 404, "arbiter access is evidence-only");
      const assigned = grantDispute(DISPUTE_ID, JOB_ID, ARBITER.address, "arbiter", { unresolved: false });
      const resolved = await handlers.evidenceGET(makeRequest("GET", "/api/disputes/1/evidence", { cookie: arbiterAuth.cookie }), DISPUTE_ID);
      assert.equal(resolved.status, 404);
      assigned.unresolved = true;
      assigned.isCurrentArbiter = false;
      const unassigned = await handlers.evidenceGET(makeRequest("GET", "/api/disputes/1/evidence", { cookie: arbiterAuth.cookie }), DISPUTE_ID);
      assert.equal(unassigned.status, 404);
    });

    await t.test("W-05/A39: evidence is bound to an existing on-chain commitment and timeline is source-labelled", async () => {
      await resetState();
      const auth = await addSession(FREELANCER.address);
      prepareEvidenceDispute();
      const evidence = evidenceEvent();
      const absent = await handlers.evidencePOST(jsonRequest("POST", "/api/disputes/1/evidence", evidence.body, { cookie: auth.cookie, csrf: auth.csrf }), DISPUTE_ID);
      assert.equal(absent.status, 404);
      chainEvents.set(JOB_ID, [evidence.event]);
      const saved = await handlers.evidencePOST(jsonRequest("POST", "/api/disputes/1/evidence", evidence.body, { cookie: auth.cookie, csrf: auth.csrf }), DISPUTE_ID);
      assert.equal(saved.status, 200);
      const mismatched = await handlers.evidencePOST(jsonRequest("POST", "/api/disputes/1/evidence", { ...evidence.body, text: "changed after commitment" }, { cookie: auth.cookie, csrf: auth.csrf }), DISPUTE_ID);
      assert.equal(mismatched.status, 404);

      const chainEventsUnsorted = [
        { source: "chain", blockNumber: 8n, transactionIndex: 0, logIndex: 2, name: "MilestoneSubmitted", args: { jobId: 1n } },
        { source: "chain", blockNumber: 7n, transactionIndex: 1, logIndex: 0, name: "JobAccepted", args: { jobId: 1n } },
        { source: "chain", blockNumber: 7n, transactionIndex: 0, logIndex: 4, name: "JobCreated", args: { jobId: 1n } },
      ];
      chainEvents.set(JOB_ID, chainEventsUnsorted);
      const authClient = await addSession(CLIENT.address);
      const timeline = await handlers.timelineGET(makeRequest("GET", "/api/jobs/1/timeline", { cookie: authClient.cookie }), JOB_ID);
      assert.equal(timeline.status, 200);
      const timelineBody = await responseJson(timeline);
      assert.deepEqual(timelineBody.chainEvents.map((event) => event.name), ["JobCreated", "JobAccepted", "MilestoneSubmitted"]);
      assert.ok(timelineBody.chainEvents.every((event) => event.source === "chain"));
      assert.ok(Array.isArray(timelineBody.auditEvents));
      assert.doesNotMatch(JSON.stringify(timelineBody), /changed after commitment|e1{64}|ticket=/i);
    });

    await t.test("W-05/W-10: bad JSON, malformed file metadata, and oversized uploads return bounded errors", async () => {
      await resetState();
      const auth = await addSession(CLIENT.address);
      const malformedJson = await handlers.jobPUT(
        new Request(new URL("/api/jobs/1", ORIGIN), {
          method: "PUT",
          headers: { Origin: ORIGIN, Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
          body: "{not-json",
        }),
        JOB_ID,
      );
      assert.equal(malformedJson.status, 400);
      const oversizedJson = new Request(new URL("/api/jobs/1", ORIGIN), {
        method: "PUT",
        headers: { Origin: ORIGIN, Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
        body: JSON.stringify({ description: "x".repeat(MAX_JSON_BYTES + 1) }),
      });
      assert.equal((await handlers.jobPUT(oversizedJson, JOB_ID)).status, 413);
      const form = new FormData();
      form.set("kind", "submission");
      form.set("milestoneIndex", "not-a-number");
      form.set("file", new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" }), "bad.pdf");
      const badMetadata = await handlers.fileUploadPOST(makeRequest("POST", "/api/jobs/1/files", { cookie: auth.cookie, csrf: auth.csrf, body: form }), JOB_ID);
      assert.equal(badMetadata.status, 400);
    });

    await t.test("A36: private route chain failures fail closed and never return cached access", async () => {
      await resetState();
      const auth = await addSession(CLIENT.address);
      const normal = await handlers.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: auth.cookie }), JOB_ID);
      assert.equal(normal.status, 404, "missing private terms stay hidden even for an authorized party");
      const priorCount = accessReadCount;
      const failingChain = createRouteHandlers({
        ...createDependencies(),
        chain: {
          ...createChainPort(),
          async readJobAccess() { throw new Error("pinned bytecode mismatch"); },
        },
      });
      const failClosed = await failingChain.jobGET(makeRequest("GET", "/api/jobs/1", { cookie: auth.cookie }), JOB_ID);
      assert.equal(failClosed.status, 404);
      assert.ok(accessReadCount >= priorCount);
    });
  } finally {
    await db.$disconnect();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await rm(storageDir, { recursive: true, force: true });
    await Promise.all([databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`].map((file) => rm(file, { force: true })));
  }
});

