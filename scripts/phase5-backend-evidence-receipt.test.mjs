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
const STRANGER = "0x3333333333333333333333333333333333333333";
const JOB_ID = "41";
const DISPUTE_ID = "7";
const DEADLINE = 1_800_000_000n;
const MASTER_KEY = Buffer.alloc(32, 0x61);
const SESSION_SECRET = Buffer.alloc(32, 0x72);
const wallets = new Map();
let db;
let databasePath;
let storageDir;
let serverNow = Number(DEADLINE * 1000n) + 10_000;
let chainNow = DEADLINE + 10n;
let phase = 2;
let eventList = [];
let handlers;

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidence(text, saltByte, referenceByte) {
  const salt = `0x${saltByte.repeat(64)}`;
  const reference = `0x${referenceByte.repeat(64)}`;
  return { text, salt, reference, commitment: privateCommitment("EVIDENCE", text, salt) };
}

function evidenceEvent(record, overrides = {}) {
  return {
    source: "chain",
    name: "EvidenceCommitted",
    blockNumber: 99n,
    transactionIndex: 0,
    logIndex: 0,
    args: {
      disputeId: BigInt(DISPUTE_ID),
      party: FREELANCER,
      evidenceHash: record.commitment,
      opaqueReference: record.reference,
      submittedAt: DEADLINE - 1n,
      ...overrides,
    },
  };
}

function snapshot() {
  const dispute = { jobId: BigInt(JOB_ID), milestoneIndex: 0n, phase, evidenceDeadline: DEADLINE };
  return {
    now: chainNow,
    job: { client: CLIENT, freelancer: FREELANCER, milestoneCount: 1, state: 2 },
    milestones: [{ state: 3, disputeId: BigInt(DISPUTE_ID), dispute, submissions: [] }],
  };
}

function accessFor(wallet) {
  const isClient = wallet.toLowerCase() === CLIENT.toLowerCase();
  const isFreelancer = wallet.toLowerCase() === FREELANCER.toLowerCase();
  const currentSnapshot = snapshot();
  return {
    client: isClient,
    freelancer: isFreelancer,
    isCurrentArbiter: false,
    unresolved: phase !== 10,
    jobId: JOB_ID,
    disputeId: DISPUTE_ID,
    dispute: currentSnapshot.milestones[0].dispute,
    snapshot: currentSnapshot,
  };
}

async function addSession(wallet) {
  const token = `phase5-${wallet.slice(-4)}-${randomBytes(8).toString("hex")}`;
  const csrf = `csrf-${randomBytes(12).toString("hex")}`;
  await db.authSession.create({ data: {
    id: `session-${randomBytes(8).toString("hex")}`,
    wallet: wallet.toLowerCase(),
    sessionTokenHash: sha(token),
    csrfTokenHash: sha(csrf),
    expiresAt: new Date(serverNow + 60 * 60_000),
    createdAt: new Date(serverNow),
    revokedAt: null,
  } });
  wallets.set(wallet.toLowerCase(), { token, csrf });
}

function requestFor(wallet, method, route, body) {
  const { token, csrf } = wallets.get(wallet.toLowerCase());
  const headers = new Headers({ Origin: ORIGIN, Cookie: `__Host-fw-session=${token}` });
  const init = { method, headers };
  if (body instanceof FormData) {
    init.body = body;
  } else {
    headers.set("Content-Type", "application/json");
    if (method !== "GET") headers.set("X-CSRF-Token", csrf);
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  return new Request(new URL(route, ORIGIN), init);
}

function dependencies() {
  return {
    db,
    chain: {
      async getPublicConfig() { return { chainId: 31337, domain: "localhost:3000", uri: ORIGIN }; },
      async readJobAccess(jobId, wallet) { return { ...accessFor(wallet), jobId: String(jobId) }; },
      async readDisputeAccess(disputeId, wallet) { return { ...accessFor(wallet), disputeId: String(disputeId) }; },
      async readJobSnapshot() { return snapshot(); },
      async readChainEvents() { return structuredClone(eventList); },
    },
    now: () => serverNow,
    storageDir,
    masterKey: MASTER_KEY,
    sessionSecret: SESSION_SECRET,
    rateLimit: async () => true,
    origin: ORIGIN,
  };
}

async function postEvidence(wallet, record) {
  return handlers.evidencePOST(
    requestFor(wallet, "POST", `/api/disputes/${DISPUTE_ID}/evidence`, record),
    DISPUTE_ID,
  );
}

function makeActivePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Action /S /JavaScript /JS (app.alert\\(\\\"Fairwork upload executed\\\"\\)) >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("Phase 5 backend: receipt-bound evidence persistence and active-file rejection", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fairwork-phase5-backend-"));
  databasePath = path.join(tempDir, "phase5.sqlite");
  storageDir = path.join(tempDir, "storage");
  await mkdir(storageDir, { recursive: true });
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const prismaCli = path.join(WEB_ROOT, "node_modules", "prisma", "build", "index.js");
  const schemaPath = path.join(WEB_ROOT, "prisma", "schema.prisma");
  const setup = spawnSync(process.execPath, [prismaCli, "db", "push", "--schema", schemaPath, "--skip-generate"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$connect();
  await addSession(CLIENT);
  await addSession(FREELANCER);
  await addSession(STRANGER);
  handlers = createRouteHandlers(dependencies());

  try {
    await t.test("a matching pre-deadline receipt can be saved after the evidence window advances", async () => {
      const record = evidence("A receipt-bound note", "a1", "b1");
      phase = 2;
      chainNow = DEADLINE + 10n;
      serverNow = Number(chainNow * 1000n);
      eventList = [evidenceEvent(record)];
      const response = await postEvidence(FREELANCER, record);
      assert.equal(response.status, 200, "a mined EvidenceCommitted event should authorize recovery of its private text and salt after the write window closes");
      assert.equal(await db.privateEvidence.count({ where: { disputeId: DISPUTE_ID, reference: record.reference.toLowerCase() } }), 1);
    });

    await t.test("a matching pre-deadline receipt can be saved after the dispute settles", async () => {
      const record = evidence("A receipt-bound note after ruling", "a2", "b2");
      phase = 10;
      chainNow = DEADLINE + 100n;
      serverNow = Number(chainNow * 1000n);
      eventList = [evidenceEvent(record)];
      const response = await postEvidence(FREELANCER, record);
      assert.equal(response.status, 200, "settlement revokes arbiter reads but must not strand a party's private record for an already committed entry");
      assert.equal(await db.privateEvidence.count({ where: { disputeId: DISPUTE_ID, reference: record.reference.toLowerCase() } }), 1);
    });

    await t.test("late recovery still requires an exact event with a valid pre-deadline timestamp and the authenticated party", async () => {
      phase = 10;
      chainNow = DEADLINE + 100n;
      serverNow = Number(chainNow * 1000n);
      const badTime = evidence("Deadline edge", "a3", "b3");
      eventList = [evidenceEvent(badTime, { submittedAt: DEADLINE })];
      assert.equal((await postEvidence(FREELANCER, badTime)).status, 404, "an event at the half-open deadline is not a valid receipt");

      const missingTime = evidence("Missing timestamp", "a4", "b4");
      eventList = [evidenceEvent(missingTime, { submittedAt: undefined })];
      assert.equal((await postEvidence(FREELANCER, missingTime)).status, 404, "an event without an authoritative submittedAt cannot support late recovery");

      const unrelated = evidence("Wrong event", "a5", "b5");
      eventList = [evidenceEvent(unrelated, { evidenceHash: `0x${"ff".repeat(32)}` })];
      assert.equal((await postEvidence(FREELANCER, unrelated)).status, 404, "a different committed hash must not authorize this private record");

      const wrongParty = evidence("Wrong party", "a6", "b6");
      eventList = [evidenceEvent(wrongParty, { party: CLIENT })];
      assert.equal((await postEvidence(FREELANCER, wrongParty)).status, 404, "another party's event must not authorize this private record");
      assert.equal((await postEvidence(STRANGER, wrongParty)).status, 404, "an unrelated wallet cannot persist evidence for the dispute");
    });

    await t.test("a syntactically valid active JavaScript PDF is rejected during upload", async () => {
      phase = 1;
      chainNow = DEADLINE - 1n;
      serverNow = Number(chainNow * 1000n);
      eventList = [];
      const form = new FormData();
      form.set("kind", "submission");
      form.set("milestoneIndex", "0");
      form.set("file", new Blob([makeActivePdf()], { type: "application/pdf" }), "active.pdf");
      const response = await handlers.fileUploadPOST(requestFor(FREELANCER, "POST", `/api/jobs/${JOB_ID}/files`, form), JOB_ID);
      assert.notEqual(response.status, 200, "PDF acceptance must parse content and reject active JavaScript actions, not just check the %PDF- prefix");
    });
  } finally {
    await db.$disconnect();
    await rm(tempDir, { recursive: true, force: true });
  }
});
