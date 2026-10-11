import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRetention } from "./phase4-retention.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "apps", "web");
const appRequire = createRequire(path.join(webRoot, "package.json"));
const { PrismaClient } = appRequire("@prisma/client");
const { createWalletClient, http } = appRequire("viem");
const { privateKeyToAccount } = appRequire("viem/accounts");
const prismaCli = path.join(webRoot, "node_modules", "prisma", "build", "index.js");
const schemaPath = path.join(webRoot, "prisma", "schema.prisma");
const databaseDir = webRoot;
const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
const escrow = "0x1111111111111111111111111111111111111111";
const chainId = 31337;
const origin = "http://localhost:3000";
const intent = "delete private Fairwork data for this closed agreement";
const fixedNow = Date.UTC(2026, 9, 11, 0, 0, 0);

let db;
let dbFile;
let dbUrl;
const storageRoots = new Set();
let fixtureIndex = 0;

function newAccount() {
  let account;
  while (!account) {
    try { account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`); } catch { /* retry the vanishingly rare invalid scalar */ }
  }
  return account;
}

function walletFor(account) {
  return createWalletClient({
    account,
    chain: { id: chainId, name: "Fairwork retention test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } },
    transport: http(),
  });
}

function requestMessage({ jobId, escrowAddress = escrow, chain = chainId, requestOrigin = origin, nonce, issuedAt, expiresAt }) {
  return [
    "Fairwork private data deletion authorization",
    `Origin: ${requestOrigin}`,
    `Chain ID: ${chain}`,
    `Escrow: ${escrowAddress}`,
    `Job ID: ${jobId}`,
    `Intent: ${intent}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join("\n");
}

async function signedRequest(account, fields, extra = {}) {
  const issuedAt = fields.issuedAt ?? new Date(fixedNow - 60_000).toISOString();
  const expiresAt = fields.expiresAt ?? new Date(fixedNow + 240_000).toISOString();
  const message = requestMessage({
    jobId: fields.jobId,
    escrowAddress: fields.escrowAddress,
    chain: fields.chain,
    requestOrigin: fields.requestOrigin,
    nonce: fields.nonce ?? `0x${randomBytes(32).toString("hex")}`,
    issuedAt,
    expiresAt,
  });
  const signature = await walletFor(account).signMessage({ message });
  return { message, signature, ...extra };
}

async function makeStorageRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fairwork-retention-test-"));
  storageRoots.add(directory);
  return directory;
}

async function seedPrivateRows(jobId, storageDir, options = {}) {
  const storageKey = options.storageKey ?? `files/${jobId}.sealed`;
  const expectedPath = path.resolve(storageDir, storageKey);
  if (!options.omitFile) {
    await mkdir(path.dirname(expectedPath), { recursive: true });
    await writeFile(expectedPath, Buffer.from([0x81, 0x2f, 0xa4, 0x09]), { flag: "wx" });
  }
  const privateBytes = Buffer.from([0x15, 0xb2, 0x0e]);
  const iv = Buffer.alloc(12, 0x3a);
  const authTag = Buffer.alloc(16, 0x5c);
  await db.$transaction([
    db.privateJobData.create({ data: { jobId, ciphertext: privateBytes, iv, authTag } }),
    db.privateNote.create({ data: {
      id: `note-${jobId}`, jobId, kind: "rejection", milestoneIndex: 0, version: 1,
      commitment: `0x${"a".repeat(64)}`, writerWallet: "0x2222222222222222222222222222222222222222",
      ciphertext: privateBytes, iv, authTag,
    } }),
    db.privateEvidence.create({ data: {
      id: `evidence-${jobId}`, jobId, disputeId: `dispute-${jobId}`, partyWallet: "0x2222222222222222222222222222222222222222",
      evidenceHash: `0x${"b".repeat(64)}`, reference: `0x${"c".repeat(64)}`,
      ciphertext: privateBytes, iv, authTag,
    } }),
    db.privateFile.create({ data: {
      id: `file-${jobId}`, jobId, uploaderWallet: "0x2222222222222222222222222222222222222222",
      kind: "submission", milestoneIndex: 0, rawHash: `0x${"d".repeat(64)}`,
      reference: `0x${"e".repeat(64)}`, mime: "application/pdf", size: 4,
      storageKey, iv, authTag,
    } }),
    db.auditEntry.create({ data: {
      id: `audit-${jobId}`, jobId, actorWallet: "0x2222222222222222222222222222222222222222",
      event: "private.read", resourceId: `file-${jobId}`,
    } }),
  ]);
  return { storageKey, expectedPath };
}

function fakeChain({ client, freelancer, state = 4, closedAt }) {
  const calls = [];
  return {
    calls,
    readJobAccess: async (jobId, wallet) => {
      calls.push({ jobId: String(jobId), wallet });
      const lower = wallet.toLowerCase();
      return {
        client: lower === client.address.toLowerCase(),
        freelancer: lower === freelancer.address.toLowerCase(),
        closedAt,
        jobId: String(jobId),
        snapshot: { job: { state, client: client.address, freelancer: freelancer.address } },
      };
    },
  };
}

async function createFixture({ state = 4, closedAt = fixedNow - ninetyDaysMs, now = fixedNow } = {}) {
  fixtureIndex += 1;
  const jobId = String(700 + fixtureIndex);
  const client = newAccount();
  const freelancer = newAccount();
  const outsider = newAccount();
  const storageDir = await makeStorageRoot();
  const chain = fakeChain({ client, freelancer, state, closedAt });
  const deployment = { chainId, escrow, roles: { client: client.address } };
  return {
    jobId, client, freelancer, outsider, storageDir, chain, deployment,
    now: () => now,
    run: (request) => runRetention({ jobId, request, db, chain, now: () => now, storageDir, deployment }),
  };
}

async function counts(jobId) {
  const [terms, notes, evidence, files, audit] = await Promise.all([
    db.privateJobData.count({ where: { jobId } }),
    db.privateNote.count({ where: { jobId } }),
    db.privateEvidence.count({ where: { jobId } }),
    db.privateFile.count({ where: { jobId } }),
    db.auditEntry.count({ where: { jobId } }),
  ]);
  return { terms, notes, evidence, files, audit };
}

before(async () => {
  dbFile = path.join(databaseDir, `phase4-retention-${process.pid}-${randomBytes(6).toString("hex")}.sqlite`);
  dbUrl = `file:${dbFile.replaceAll("\\", "/")}`;
  const prepared = spawnSync(process.execPath, [prismaCli, "db", "push", "--schema", schemaPath, "--skip-generate"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: dbUrl, RUST_LOG: "debug" },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(prepared.status, 0, `Prisma test database setup failed: ${prepared.stderr || prepared.stdout}`);
  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await db.$connect();
});

after(async () => {
  await db?.$disconnect();
  for (const directory of storageRoots) {
    const resolved = path.resolve(directory);
    const tempRoot = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`), "test cleanup must remain under the OS temporary directory");
    await rm(resolved, { recursive: true, force: true });
  }
  if (dbFile && path.dirname(path.resolve(dbFile)) === path.resolve(databaseDir) && path.basename(dbFile).startsWith(`phase4-retention-${process.pid}-`)) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(dbFile + suffix, { force: true });
  }
});

afterEach(async () => {
  if (!db) return;
  await db.$transaction([
    db.auditEntry.deleteMany(),
    db.privateFile.deleteMany(),
    db.privateEvidence.deleteMany(),
    db.privateNote.deleteMany(),
    db.privateJobData.deleteMany(),
  ]);
});

test("automatic retention refuses active jobs without deleting any private rows", async () => {
  const fixture = await createFixture({ state: 3, closedAt: null });
  const { expectedPath } = await seedPrivateRows(fixture.jobId, fixture.storageDir);

  await assert.rejects(fixture.run(), /closed|eligible|retention/i);
  assert.deepEqual(await counts(fixture.jobId), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 });
  await readFile(expectedPath);
});

test("retention requires both Closed state and a chain-derived closure timestamp", async () => {
  for (const chainState of [
    { state: 3, closedAt: fixedNow - ninetyDaysMs * 2 },
    { state: 4, closedAt: null },
  ]) {
    const fixture = await createFixture(chainState);
    const { expectedPath } = await seedPrivateRows(fixture.jobId, fixture.storageDir);
    await assert.rejects(fixture.run(), /closed|closure|eligible|retention/i);
    assert.deepEqual(await counts(fixture.jobId), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 });
    await readFile(expectedPath);
  }
});

test("retention accepts only one nonnegative decimal job ID", async () => {
  const fixture = await createFixture();
  for (const jobId of ["01", "-1", "1e3", "1.0", "1/2", "1\n"]) {
    await assert.rejects(runRetention({ jobId, request: undefined, db, chain: fixture.chain, now: fixture.now, storageDir: fixture.storageDir, deployment: fixture.deployment }), /job|identifier|decimal|positive/i);
  }
  assert.equal(fixture.chain.calls.length, 0, "invalid identifiers fail before reading the chain");
});

test("automatic retention waits until the exact chain-derived 90-day boundary", async () => {
  const justEarly = await createFixture({ closedAt: fixedNow - ninetyDaysMs + 1 });
  const earlyFile = await seedPrivateRows(justEarly.jobId, justEarly.storageDir);
  await assert.rejects(justEarly.run(), /90|eligible|retention/i);
  assert.deepEqual(await counts(justEarly.jobId), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 });
  await readFile(earlyFile.expectedPath);

  const due = await createFixture({ closedAt: fixedNow - ninetyDaysMs });
  const dueFile = await seedPrivateRows(due.jobId, due.storageDir);
  const result = await due.run();
  assert.equal(result.deleted, true);
  assert.deepEqual(await counts(due.jobId), { terms: 0, notes: 0, evidence: 0, files: 0, audit: 1 });
  await assert.rejects(readFile(dueFile.expectedPath), { code: "ENOENT" });
  assert.deepEqual(await counts(justEarly.jobId), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 }, "a purge must be scoped to the explicit job ID");

  const repeated = await due.run();
  assert.equal(repeated.deleted, false, "a completed purge is safe to repeat");
});

test("a fresh EIP-191 request from either chain-named party permits early deletion", async () => {
  for (const signerName of ["client", "freelancer"]) {
    const fixture = await createFixture({ closedAt: fixedNow - 30_000 });
    const { expectedPath } = await seedPrivateRows(fixture.jobId, fixture.storageDir);
    const request = await signedRequest(fixture[signerName], { jobId: fixture.jobId });

    const result = await fixture.run(request);
    assert.equal(result.deleted, true);
    assert.deepEqual(await counts(fixture.jobId), { terms: 0, notes: 0, evidence: 0, files: 0, audit: 1 });
    await assert.rejects(readFile(expectedPath), { code: "ENOENT" });
    assert.ok(fixture.chain.calls.some((call) => call.wallet.toLowerCase() === fixture[signerName].address.toLowerCase()), "chain role must be checked for the recovered signer");
  }
});

test("a caller-supplied wallet cannot impersonate a party and wrong-job signatures are refused", async () => {
  const fixture = await createFixture({ closedAt: fixedNow - 1_000 });
  const file = await seedPrivateRows(fixture.jobId, fixture.storageDir);
  const forged = await signedRequest(fixture.outsider, { jobId: fixture.jobId }, { wallet: fixture.client.address });
  await assert.rejects(fixture.run(forged), /party|signer|signature|authorization/i);
  assert.deepEqual(await counts(fixture.jobId), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 });
  await readFile(file.expectedPath);

  const wrongJob = await signedRequest(fixture.client, { jobId: String(Number(fixture.jobId) + 1) });
  await assert.rejects(fixture.run(wrongJob), /job|message|authorization|signature/i);
  assert.deepEqual(await counts(fixture.jobId), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 });
});

test("signed deletion binds canonical origin, chain, escrow, and a maximum five-minute window", async () => {
  const fixture = await createFixture({ closedAt: fixedNow - 1_000 });
  const file = await seedPrivateRows(fixture.jobId, fixture.storageDir);
  const invalidRequests = [
    await signedRequest(fixture.client, { jobId: fixture.jobId, requestOrigin: "http://127.0.0.1:3000" }),
    await signedRequest(fixture.client, { jobId: fixture.jobId, chain: 1 }),
    await signedRequest(fixture.client, { jobId: fixture.jobId, escrowAddress: "0x2222222222222222222222222222222222222222" }),
    await signedRequest(fixture.client, { jobId: fixture.jobId, issuedAt: new Date(fixedNow - 301_000).toISOString(), expiresAt: new Date(fixedNow + 1_000).toISOString() }),
    await signedRequest(fixture.client, { jobId: fixture.jobId, issuedAt: new Date(fixedNow - 1_000).toISOString(), expiresAt: new Date(fixedNow + 300_001).toISOString() }),
    await signedRequest(fixture.client, { jobId: fixture.jobId, issuedAt: new Date(fixedNow + 1_000).toISOString(), expiresAt: new Date(fixedNow + 60_000).toISOString() }),
    await signedRequest(fixture.client, { jobId: fixture.jobId, issuedAt: new Date(fixedNow - 120_000).toISOString(), expiresAt: new Date(fixedNow - 1_000).toISOString() }),
  ];
  for (const request of invalidRequests) {
    await assert.rejects(fixture.run(request), /origin|chain|escrow|time|expired|valid|authorization|message/i);
  }
  assert.deepEqual(await counts(fixture.jobId), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 });
  await readFile(file.expectedPath);
});

test("every storage path is validated before any file or row is removed", async () => {
  const fixture = await createFixture();
  const validFile = await seedPrivateRows(fixture.jobId, fixture.storageDir);
  const unrelatedJob = String(Number(fixture.jobId) + 10_000);
  const outsideDir = await makeStorageRoot();
  const outsidePath = path.join(outsideDir, "keep.bin");
  await writeFile(outsidePath, Buffer.from("outside sentinel"), { flag: "wx" });
  await seedPrivateRows(unrelatedJob, fixture.storageDir);
  await db.privateFile.create({ data: {
    id: `file-${fixture.jobId}-malformed`, jobId: fixture.jobId,
    uploaderWallet: fixture.client.address, kind: "evidence", milestoneIndex: 0,
    rawHash: `0x${"f".repeat(64)}`, reference: `0x${"1".repeat(64)}`,
    mime: "application/pdf", size: 4, storageKey: `../${path.basename(outsideDir)}/keep.bin`,
    iv: Buffer.alloc(12, 0x3a), authTag: Buffer.alloc(16, 0x5c),
  } });

  await assert.rejects(fixture.run(), /path|storage|boundary|outside|symlink/i);
  await readFile(validFile.expectedPath);
  assert.equal((await readFile(outsidePath)).toString(), "outside sentinel");
  assert.deepEqual(await counts(fixture.jobId), { terms: 1, notes: 1, evidence: 1, files: 2, audit: 1 });
  assert.deepEqual(await counts(unrelatedJob), { terms: 1, notes: 1, evidence: 1, files: 1, audit: 1 });
});

test("a parent directory junction cannot redirect deletion outside private storage", async () => {
  const fixture = await createFixture();
  await seedPrivateRows(fixture.jobId, fixture.storageDir);
  const outsideDir = await makeStorageRoot();
  const outsidePath = path.join(outsideDir, "keep.bin");
  const junctionPath = path.join(fixture.storageDir, "redirect");
  await writeFile(outsidePath, Buffer.from("junction sentinel"), { flag: "wx" });
  await symlink(outsideDir, junctionPath, process.platform === "win32" ? "junction" : "dir");
  try {
    await db.privateFile.create({ data: {
      id: `file-${fixture.jobId}-junction`, jobId: fixture.jobId,
      uploaderWallet: fixture.client.address, kind: "evidence", milestoneIndex: 0,
      rawHash: `0x${"2".repeat(64)}`, reference: `0x${"3".repeat(64)}`,
      mime: "application/pdf", size: 4, storageKey: "redirect/keep.bin",
      iv: Buffer.alloc(12, 0x3a), authTag: Buffer.alloc(16, 0x5c),
    } });
    await assert.rejects(fixture.run(), /path|storage|boundary|outside|symlink|junction/i);
    assert.equal((await readFile(outsidePath)).toString(), "junction sentinel");
    assert.deepEqual(await counts(fixture.jobId), { terms: 1, notes: 1, evidence: 1, files: 2, audit: 1 });
  } finally {
    await unlink(junctionPath);
  }
});
