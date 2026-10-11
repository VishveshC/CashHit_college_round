import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { privateCommitment } from "../apps/web/lib/server/security.ts";
import { createRouteHandlers } from "../apps/web/lib/server/routes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(ROOT, "apps", "web");
const appRequire = createRequire(path.join(WEB_ROOT, "package.json"));
const { PrismaClient } = appRequire("@prisma/client");
const ORIGIN = "http://localhost:3000";
const CLIENT = "0x1111111111111111111111111111111111111111";
const FREELANCER = "0x2222222222222222222222222222222222222222";
const JOB_ID = "53";
const DISPUTE_ID = "8";
const NOW = 1_800_000_000_000;
const DEADLINE = 1_800_000_000n;
const REF = `0x${"ab".repeat(32)}`;
const wallets = new Map();
const sha = (value) => createHash("sha256").update(value).digest("hex");

function makeRecord(text, saltByte) {
  const salt = `0x${saltByte.repeat(32)}`;
  return { text, salt, reference: REF, commitment: privateCommitment("EVIDENCE", text, salt) };
}

function eventFor(wallet, record, version) {
  return {
    source: "chain",
    name: "EvidenceCommitted",
    blockNumber: 101n,
    transactionIndex: 0,
    logIndex: version,
    args: {
      disputeId: BigInt(DISPUTE_ID),
      party: wallet,
      version,
      evidenceHash: record.commitment,
      opaqueReference: record.reference,
      submittedAt: DEADLINE - 1n,
    },
  };
}

test("Phase 5 backend: evidence references remain isolated across both dispute parties", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fairwork-phase5-evidence-collision-"));
  const databasePath = path.join(tempDir, "phase5.sqlite");
  const storageDir = path.join(tempDir, "storage");
  await mkdir(storageDir, { recursive: true });
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const prismaCli = path.join(WEB_ROOT, "node_modules", "prisma", "build", "index.js");
  const schemaPath = path.join(WEB_ROOT, "prisma", "schema.prisma");
  const setup = spawnSync(process.execPath, [prismaCli, "db", "push", "--schema", schemaPath, "--skip-generate"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "debug" },
  });
  assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$connect();

  async function addSession(wallet) {
    const token = `phase5-${wallet.slice(-4)}-${randomBytes(8).toString("hex")}`;
    const csrf = `csrf-${randomBytes(12).toString("hex")}`;
    await db.authSession.create({ data: {
      id: `session-${randomBytes(8).toString("hex")}`,
      wallet: wallet.toLowerCase(),
      sessionTokenHash: sha(token),
      csrfTokenHash: sha(csrf),
      expiresAt: new Date(NOW + 60 * 60_000),
      createdAt: new Date(NOW),
      revokedAt: null,
    } });
    wallets.set(wallet.toLowerCase(), { token, csrf });
  }

  await addSession(CLIENT);
  await addSession(FREELANCER);
  const clientRecord = makeRecord("Client text under the shared public reference", "a1");
  const freelancerRecord = makeRecord("Freelancer text under the same public reference", "b2");
  const eventList = [eventFor(CLIENT, clientRecord, 1), eventFor(FREELANCER, freelancerRecord, 1)];
  const snapshot = {
    now: DEADLINE - 1n,
    job: { client: CLIENT, freelancer: FREELANCER, milestoneCount: 1, state: 2 },
    milestones: [{ state: 3, disputeId: BigInt(DISPUTE_ID), dispute: { jobId: BigInt(JOB_ID), milestoneIndex: 0n, phase: 1, evidenceDeadline: DEADLINE }, submissions: [] }],
  };
  const handlers = createRouteHandlers({
    db,
    chain: {
      async getPublicConfig() { return { chainId: 31337, domain: "localhost:3000", uri: ORIGIN }; },
      async readJobAccess(jobId, wallet) {
        return { jobId: String(jobId), client: wallet.toLowerCase() === CLIENT.toLowerCase(), freelancer: wallet.toLowerCase() === FREELANCER.toLowerCase(), isCurrentArbiter: false, unresolved: true, snapshot };
      },
      async readDisputeAccess(disputeId, wallet) {
        return { jobId: JOB_ID, disputeId: String(disputeId), client: wallet.toLowerCase() === CLIENT.toLowerCase(), freelancer: wallet.toLowerCase() === FREELANCER.toLowerCase(), isCurrentArbiter: false, unresolved: true, dispute: snapshot.milestones[0].dispute, snapshot };
      },
      async readJobSnapshot() { return snapshot; },
      async readChainEvents() { return structuredClone(eventList); },
    },
    now: () => NOW,
    storageDir,
    masterKey: Buffer.alloc(32, 0x43),
    sessionSecret: Buffer.alloc(32, 0x54),
    rateLimit: async () => true,
    origin: ORIGIN,
  });

  function requestFor(wallet, record) {
    const { token, csrf } = wallets.get(wallet.toLowerCase());
    const headers = new Headers({ Origin: ORIGIN, Cookie: `__Host-fw-session=${token}`, "X-CSRF-Token": csrf, "Content-Type": "application/json" });
    return new Request(new URL(`/api/disputes/${DISPUTE_ID}/evidence`, ORIGIN), { method: "POST", headers, body: JSON.stringify(record) });
  }

  try {
    await t.test("both parties can persist distinct exact commitments that share an opaque reference", async () => {
      const clientResponse = await handlers.evidencePOST(requestFor(CLIENT, clientRecord), DISPUTE_ID);
      assert.equal(clientResponse.status, 200, "the first authorized party's event should persist");
      const freelancerResponse = await handlers.evidencePOST(requestFor(FREELANCER, freelancerRecord), DISPUTE_ID);
      assert.equal(freelancerResponse.status, 200, "the other party's separately authorized event must not be blocked by the shared reference");
      assert.equal(await db.privateEvidence.count({ where: { disputeId: DISPUTE_ID } }), 2);
      const rows = await db.privateEvidence.findMany({ where: { disputeId: DISPUTE_ID }, orderBy: { partyWallet: "asc" } });
      assert.deepEqual(rows.map((row) => row.partyWallet), [CLIENT.toLowerCase(), FREELANCER.toLowerCase()]);
      assert.equal(new Set(rows.map((row) => row.evidenceHash)).size, 2);
    });
  } finally {
    await db.$disconnect();
    await rm(tempDir, { recursive: true, force: true });
  }
});
