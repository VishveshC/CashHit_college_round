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
const JOB_ID = "52";
const NOW = 1_800_000_000_000;
const SESSION = `phase5-malformed-${randomBytes(12).toString("hex")}`;
const CSRF = `phase5-csrf-${randomBytes(12).toString("hex")}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("Phase 5 backend: malformed PDF upload is rejected", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fairwork-phase5-malformed-pdf-"));
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
  await db.authSession.create({ data: {
    id: `session-${randomBytes(8).toString("hex")}`,
    wallet: FREELANCER.toLowerCase(),
    sessionTokenHash: sha(SESSION),
    csrfTokenHash: sha(CSRF),
    expiresAt: new Date(NOW + 60 * 60_000),
    createdAt: new Date(NOW),
    revokedAt: null,
  } });
  const handlers = createRouteHandlers({
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
    await t.test("rejects a file that has a PDF header but no PDF structure", async () => {
      const form = new FormData();
      form.set("kind", "submission");
      form.set("milestoneIndex", "0");
      form.set("file", new Blob(["%PDF-1.7\nthis is not a PDF object, xref table, trailer, or EOF"], { type: "application/pdf" }), "malformed.pdf");
      const headers = new Headers({
        Origin: ORIGIN,
        Cookie: `__Host-fw-session=${SESSION}`,
        "X-CSRF-Token": CSRF,
      });
      const request = new Request(new URL(`/api/jobs/${JOB_ID}/files`, ORIGIN), { method: "POST", headers, body: form });
      const response = await handlers.fileUploadPOST(request, JOB_ID);
      assert.equal(response.status, 400, "A-38 requires malformed content to be rejected; a header prefix alone is not PDF structure validation");
    });
  } finally {
    await db.$disconnect();
    await rm(tempDir, { recursive: true, force: true });
  }
});
