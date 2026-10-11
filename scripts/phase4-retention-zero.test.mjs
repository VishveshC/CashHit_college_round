import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
const escrow = "0x1111111111111111111111111111111111111111";
const chainId = 31337;
const origin = "http://localhost:3000";
const intent = "delete private Fairwork data for this closed agreement";
const fixedNow = Date.UTC(2026, 9, 11, 0, 0, 0);
const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

let db;
let dbFile;
let dbUrl;
let storageDir;

function newAccount(fill) {
  return privateKeyToAccount(`0x${fill.repeat(64)}`);
}

function messageFor(jobId) {
  const issuedAt = new Date(fixedNow - 60_000).toISOString();
  const expiresAt = new Date(fixedNow + 240_000).toISOString();
  return [
    "Fairwork private data deletion authorization",
    `Origin: ${origin}`,
    `Chain ID: ${chainId}`,
    `Escrow: ${escrow}`,
    `Job ID: ${jobId}`,
    `Intent: ${intent}`,
    `Nonce: 0x${randomBytes(32).toString("hex")}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join("\n");
}

async function seedPrivateTerms() {
  await db.privateJobData.create({
    data: {
      jobId: "0",
      ciphertext: Buffer.from([0x15, 0xb2, 0x0e]),
      iv: Buffer.alloc(12, 0x3a),
      authTag: Buffer.alloc(16, 0x5c),
    },
  });
}

function fakeChain(client, freelancer, closedAt) {
  const calls = [];
  return {
    calls,
    async readJobAccess(jobId, wallet) {
      calls.push({ jobId: String(jobId), wallet });
      return {
        jobId: String(jobId),
        client: wallet.toLowerCase() === client.address.toLowerCase(),
        freelancer: wallet.toLowerCase() === freelancer.address.toLowerCase(),
        closedAt,
        snapshot: {
          job: { state: 4, client: client.address, freelancer: freelancer.address },
        },
      };
    },
  };
}

before(async () => {
  dbFile = path.join(webRoot, `phase4-retention-zero-${process.pid}-${randomBytes(6).toString("hex")}.sqlite`);
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
  storageDir = await mkdtemp(path.join(os.tmpdir(), "fairwork-retention-zero-"));
});

after(async () => {
  await db?.$disconnect();
  if (storageDir) {
    const resolved = path.resolve(storageDir);
    const tempRoot = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`), "test cleanup must remain under the OS temporary directory");
    await rm(resolved, { recursive: true, force: true });
  }
  if (dbFile && path.dirname(path.resolve(dbFile)) === path.resolve(webRoot) && path.basename(dbFile).startsWith(`phase4-retention-zero-${process.pid}-`)) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(dbFile + suffix, { force: true });
  }
});

afterEach(async () => {
  if (!db) return;
  await db.$transaction([db.auditEntry.deleteMany(), db.privateFile.deleteMany(), db.privateEvidence.deleteMany(), db.privateNote.deleteMany(), db.privateJobData.deleteMany()]);
});

test("job ID zero supports due automatic and named-party signed retention while malformed IDs stay denied", async () => {
  const client = newAccount("1");
  const freelancer = newAccount("2");
  const deployment = { chainId, escrow, roles: { client: client.address } };
  const now = () => fixedNow;

  const malformedChain = fakeChain(client, freelancer, fixedNow - ninetyDaysMs);
  for (const jobId of ["", "00", "01", "-1", "1e3", "1.0", "1/2", " 0", "0\n"]) {
    await assert.rejects(runRetention({
      jobId,
      db,
      chain: malformedChain,
      now,
      storageDir,
      deployment,
    }), /job|identifier|decimal|positive|nonnegative/i);
  }
  assert.equal(malformedChain.calls.length, 0, "malformed IDs fail before any chain read");

  const dueChain = fakeChain(client, freelancer, fixedNow - ninetyDaysMs);
  await seedPrivateTerms();
  const automatic = await runRetention({ jobId: "0", db, chain: dueChain, now, storageDir, deployment });
  assert.equal(automatic.deleted, true, "job zero is eligible at the chain-derived 90-day boundary");
  assert.deepEqual(dueChain.calls.map(({ jobId }) => jobId), ["0"]);
  assert.equal(await db.privateJobData.count({ where: { jobId: "0" } }), 0);

  const earlyChain = fakeChain(client, freelancer, fixedNow - 1_000);
  await seedPrivateTerms();
  const message = messageFor("0");
  const signature = await freelancer.signMessage({ message });
  const early = await runRetention({
    jobId: "0",
    request: { message, signature },
    db,
    chain: earlyChain,
    now,
    storageDir,
    deployment,
  });
  assert.equal(early.deleted, true, "the chain-named freelancer can authorize early deletion for job zero");
  assert.deepEqual(earlyChain.calls.map(({ jobId }) => jobId), ["0"]);
  assert.equal(earlyChain.calls[0].wallet.toLowerCase(), freelancer.address.toLowerCase());
  assert.equal(await db.privateJobData.count({ where: { jobId: "0" } }), 0);
});
