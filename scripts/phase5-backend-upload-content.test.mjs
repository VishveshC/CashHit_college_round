import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRouteHandlers } from "../apps/web/lib/server/routes.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(ROOT, "apps", "web");
const appRequire = createRequire(path.join(WEB_ROOT, "package.json"));
const { PrismaClient } = appRequire("@prisma/client");
const ORIGIN = "http://localhost:3000";
const FREELANCER = "0x2222222222222222222222222222222222222222";
const JOB_ID = "51";
const NOW = 1_800_000_000_000;
const SESSION = `phase5-upload-${randomBytes(12).toString("hex")}`;
const CSRF = `phase5-csrf-${randomBytes(12).toString("hex")}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
let db;
let storageDir;
let handlers;

function pdfBytes({ catalogEntries = "", extraObjects = [], trailerEntries = "" } = {}) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalogEntries} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    ...extraObjects,
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
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerEntries} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function requestForFile(bytes, name = "evidence.pdf") {
  const form = new FormData();
  form.set("kind", "submission");
  form.set("milestoneIndex", "0");
  form.set("file", new Blob([bytes], { type: "application/pdf" }), name);
  const headers = new Headers({
    Origin: ORIGIN,
    Cookie: `__Host-fw-session=${SESSION}`,
    "X-CSRF-Token": CSRF,
  });
  return new Request(new URL(`/api/jobs/${JOB_ID}/files`, ORIGIN), { method: "POST", headers, body: form });
}

async function upload(bytes, name) {
  return handlers.fileUploadPOST(requestForFile(bytes, name), JOB_ID);
}

test("Phase 5 backend: bounded passive-PDF upload policy", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fairwork-phase5-upload-"));
  const databasePath = path.join(tempDir, "phase5.sqlite");
  storageDir = path.join(tempDir, "storage");
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
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$connect();
  await db.authSession.create({ data: {
    id: `session-${randomBytes(8).toString("hex")}`,
    wallet: FREELANCER.toLowerCase(),
    sessionTokenHash: sha(SESSION),
    csrfTokenHash: sha(CSRF),
    expiresAt: new Date(NOW + 60 * 60_000),
    createdAt: new Date(NOW),
    revokedAt: null,
  } });
  handlers = createRouteHandlers({
    db,
    chain: {
      async getPublicConfig() { return { chainId: 31337, domain: "localhost:3000", uri: ORIGIN }; },
      async readJobAccess(jobId, wallet) {
        return { jobId: String(jobId), client: false, freelancer: wallet.toLowerCase() === FREELANCER.toLowerCase(), isCurrentArbiter: false, unresolved: false };
      },
      async readDisputeAccess() { return null; },
      async readJobSnapshot() { return { job: { milestoneCount: 1 }, milestones: [{ state: 0, disputeId: 0n, submissions: [] }] }; },
      async readChainEvents() { return []; },
    },
    now: () => NOW,
    storageDir,
    masterKey: Buffer.alloc(32, 0x43),
    sessionSecret: Buffer.alloc(32, 0x54),
    rateLimit: async () => true,
    origin: ORIGIN,
  });

  try {
    await t.test("a valid passive PDF remains uploadable", async () => {
      const response = await upload(pdfBytes(), "passive.pdf");
      assert.equal(response.status, 200, "the conservative active-content policy must retain ordinary passive PDF support");
    });

    await t.test("rejects decoded OpenAction plus JavaScript PDF names", async () => {
      const response = await upload(pdfBytes({
        catalogEntries: "/O#70enAction 5 0 R",
        extraObjects: ["<< /S /J#61vaScript /JS (app.alert\\(1\\)) >>"],
      }), "encoded-active.pdf");
      assert.equal(response.status, 400, "PDF #HH name escapes must not hide an automatic JavaScript action");
    });

    await t.test("rejects an otherwise readable PDF carrying an object stream", async () => {
      const objectStream = "7 0 << /Hidden /Payload >>";
      const response = await upload(pdfBytes({
        extraObjects: [`<< /Type /ObjStm /N 1 /First 4 /Length ${Buffer.byteLength(objectStream, "ascii")} >>\nstream\n${objectStream}\nendstream`],
      }), "object-stream.pdf");
      assert.equal(response.status, 400, "object streams can conceal active objects from a token-level safety check");
    });

    await t.test("rejects encrypted PDFs whose content cannot be inspected", async () => {
      const response = await upload(pdfBytes({
        extraObjects: ["<< /Filter /Standard /V 1 /R 2 /O <00000000000000000000000000000000> /U <00000000000000000000000000000000> /P -4 >>"],
        trailerEntries: "/Encrypt 5 0 R /ID [<00000000000000000000000000000000> <00000000000000000000000000000000>]",
      }), "encrypted.pdf");
      assert.equal(response.status, 400, "encrypted content cannot be inspected by the bounded passive-PDF filter");
    });

    await t.test("rejects direct OpenAction and embedded-file markers", async () => {
      const response = await upload(pdfBytes({
        catalogEntries: "/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> /Names << /EmbeddedFiles << >> >>",
      }), "direct-active.pdf");
      assert.equal(response.status, 400, "unencoded automatic actions and embedded content remain blocked");
    });
  } finally {
    await db.$disconnect();
    await rm(tempDir, { recursive: true, force: true });
  }
});
