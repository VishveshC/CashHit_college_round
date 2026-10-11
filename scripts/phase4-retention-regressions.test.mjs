import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRetention } from "./phase4-retention.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "apps", "web");
const appRequire = createRequire(path.join(webRoot, "package.json"));
const { PrismaClient } = appRequire("@prisma/client");
const { privateKeyToAccount } = appRequire("viem/accounts");
const prismaCli = path.join(webRoot, "node_modules", "prisma", "build", "index.js");
const schemaPath = path.join(webRoot, "prisma", "schema.prisma");
const { createRouteHandlers } = await import("../apps/web/lib/server/routes.ts");
const escrow = "0x1111111111111111111111111111111111111111";
const client = "0x2222222222222222222222222222222222222222";
const freelancerAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const freelancer = freelancerAccount.address;
const manifestClient = "0x4444444444444444444444444444444444444444";
const otherManifestClient = "0x5555555555555555555555555555555555555555";
const nowValue = Date.UTC(2026, 9, 11, 0, 0, 0);
const ninetyDays = 90 * 24 * 60 * 60 * 1000;

let db;
let dbFile;
let dbUrl;
let sequence = 0;
const storageRoots = new Set();

async function storageRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fairwork-retention-regression-"));
  storageRoots.add(directory);
  return directory;
}

function fixture({ roleClient = manifestClient, closedAt = nowValue - ninetyDays } = {}) {
  sequence += 1;
  const jobId = String(900 + sequence);
  const deployment = { chainId: 31337, escrow, roles: { client: roleClient } };
  const calls = [];
  const snapshot = { job: { state: 4, client, freelancer, milestoneCount: 1 }, milestones: [{ state: 0 }] };
  const chain = {
    calls,
    readJobAccess: async (id, wallet) => {
      calls.push({ jobId: String(id), wallet });
      return {
        jobId: String(id),
        client: wallet.toLowerCase() === client.toLowerCase(),
        freelancer: wallet.toLowerCase() === freelancer.toLowerCase(),
        closedAt,
        snapshot,
      };
    },
    getPublicConfig: () => ({ chainId: 31337, domain: "localhost:3000", uri: "http://localhost:3000" }),
    readDisputeAccess: async () => null,
    readJobSnapshot: async () => snapshot,
    readChainEvents: async () => [],
  };
  return { jobId, deployment, chain, now: () => nowValue, closedAt, snapshot };
}

async function addPrivateTerms(jobId) {
  const bytes = Buffer.from([0x11, 0x22, 0x33]);
  await db.privateJobData.create({ data: { jobId, ciphertext: bytes, iv: Buffer.alloc(12, 0x44), authTag: Buffer.alloc(16, 0x55) } });
}

async function addPrivateFile(jobId, storageDir, id) {
  const storageKey = `files/${id}.enc`;
  const filePath = path.join(storageDir, "files", `${id}.enc`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(id), { flag: "wx" });
  await db.privateFile.create({ data: {
    id, jobId, uploaderWallet: client, kind: "submission", milestoneIndex: 0,
    rawHash: `0x${"a".repeat(64)}`, reference: `0x${"b".repeat(64)}`,
    mime: "application/pdf", size: 4, storageKey,
    iv: Buffer.alloc(12, 0x44), authTag: Buffer.alloc(16, 0x55),
  } });
  return filePath;
}

async function privateCounts(jobId) {
  const [terms, files] = await Promise.all([
    db.privateJobData.count({ where: { jobId } }),
    db.privateFile.count({ where: { jobId } }),
  ]);
  return { terms, files };
}

before(async () => {
  dbFile = path.join(webRoot, `phase4-retention-regression-${process.pid}-${randomBytes(6).toString("hex")}.sqlite`);
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
    assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`), "cleanup remains inside the OS temporary directory");
    await rm(resolved, { recursive: true, force: true });
  }
  if (dbFile && path.dirname(path.resolve(dbFile)) === path.resolve(webRoot) && path.basename(dbFile).startsWith(`phase4-retention-regression-${process.pid}-`)) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(dbFile + suffix, { force: true });
  }
});

afterEach(async () => {
  if (!db) return;
  await db.$transaction([db.auditEntry.deleteMany(), db.authSession.deleteMany(), db.privateFile.deleteMany(), db.privateJobData.deleteMany()]);
});

test("automatic retention purges a due agreement even when the manifest client is not its party", async () => {
  const item = fixture({ roleClient: manifestClient });
  const storageDir = await storageRoot();
  await addPrivateTerms(item.jobId);

  const result = await runRetention({ jobId: item.jobId, db, chain: item.chain, now: item.now, storageDir, deployment: item.deployment });

  assert.equal(item.chain.calls[0].wallet, manifestClient, "the configured account is only the access-reader input");
  assert.equal(result.deleted, true);
  assert.deepEqual(await privateCounts(item.jobId), { terms: 0, files: 0 });
});

test("a retry completes after an interrupted private-file unlink", async () => {
  const item = fixture({ roleClient: client });
  const storageDir = await storageRoot();
  await addPrivateTerms(item.jobId);
  const firstPath = await addPrivateFile(item.jobId, storageDir, `file-${item.jobId}-a`);
  const secondPath = await addPrivateFile(item.jobId, storageDir, `file-${item.jobId}-b`);
  let removals = 0;
  const failingRemove = async (filePath) => {
    removals += 1;
    if (removals === 2) throw new Error("simulated interrupted unlink");
    await unlink(filePath);
  };

  await assert.rejects(runRetention({ jobId: item.jobId, db, chain: item.chain, now: item.now, storageDir, deployment: item.deployment, removeFile: failingRemove }), /interrupted/i);
  assert.deepEqual(await privateCounts(item.jobId), { terms: 1, files: 2 }, "database rows stay available for a retry after interrupted file cleanup");
  await assert.rejects(access(firstPath), { code: "ENOENT" });
  await access(secondPath);

  const retry = await runRetention({ jobId: item.jobId, db, chain: item.chain, now: item.now, storageDir, deployment: item.deployment });

  assert.equal(retry.deleted, true);
  assert.deepEqual(await privateCounts(item.jobId), { terms: 0, files: 0 });
  await assert.rejects(access(secondPath), { code: "ENOENT" });
});

test("a signed purge removes an actual uploaded encrypted UUID .enc file", async () => {
  const item = fixture({ roleClient: manifestClient, closedAt: nowValue - 10_000 });
  const storageDir = await storageRoot();
  const sessionToken = `retention-upload-${randomUUID()}`;
  const csrfToken = `retention-csrf-${randomUUID()}`;
  await db.authSession.create({ data: {
    id: randomUUID(), wallet: freelancer.toLowerCase(),
    sessionTokenHash: createHash("sha256").update(sessionToken).digest("hex"),
    csrfTokenHash: createHash("sha256").update(csrfToken).digest("hex"),
    expiresAt: new Date(nowValue + 30 * 60 * 1000), createdAt: new Date(nowValue), revokedAt: null,
  } });
  const handlers = createRouteHandlers({
    db,
    chain: item.chain,
    now: item.now,
    storageDir,
    masterKey: Buffer.alloc(32, 0x6a),
    sessionSecret: Buffer.alloc(32, 0x5b),
    rateLimit: () => true,
    origin: "http://localhost:3000",
  });
  const form = new FormData();
  form.set("kind", "submission");
  form.set("milestoneIndex", "0");
  form.set("file", new Blob(["%PDF-1.7\nprivate deliverable\n%%EOF"], { type: "application/pdf" }), "deliverable.pdf");
  const upload = await handlers.fileUploadPOST(new Request(`http://localhost:3000/api/jobs/${item.jobId}/files`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", Cookie: `__Host-fw-session=${sessionToken}`, "X-CSRF-Token": csrfToken },
    body: form,
  }), item.jobId);
  assert.equal(upload.status, 200, await upload.clone().text());
  const uploaded = await upload.json();
  const fileRow = await db.privateFile.findUnique({ where: { id: uploaded.id } });
  assert.ok(fileRow);
  assert.match(fileRow.storageKey, /^[0-9a-f-]{36}$/i);
  const encryptedPath = path.join(storageDir, `${fileRow.storageKey}.enc`);
  await access(encryptedPath);

  const issuedAt = new Date(nowValue - 60_000).toISOString();
  const expiresAt = new Date(nowValue + 240_000).toISOString();
  const message = [
    "Fairwork private data deletion authorization",
    "Origin: http://localhost:3000",
    "Chain ID: 31337",
    `Escrow: ${escrow}`,
    `Job ID: ${item.jobId}`,
    "Intent: delete private Fairwork data for this closed agreement",
    `Nonce: 0x${randomBytes(32).toString("hex")}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join("\n");
  const request = { message, signature: await freelancerAccount.signMessage({ message }) };
  const result = await runRetention({ jobId: item.jobId, request, db, chain: item.chain, now: item.now, storageDir, deployment: item.deployment });

  assert.equal(result.deleted, true);
  assert.equal(await db.privateFile.count({ where: { jobId: item.jobId } }), 0);
  await assert.rejects(access(encryptedPath), { code: "ENOENT" });
  assert.equal(await db.auditEntry.count({ where: { jobId: item.jobId } }), 1, "retention preserves non-content upload audit metadata");
});
