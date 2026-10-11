import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(ROOT, "apps", "web");
const SCHEMA = path.join(WEB_ROOT, "prisma", "schema.prisma");
const PRISMA_CLI = path.join(WEB_ROOT, "node_modules", "prisma", "build", "index.js");
const MIGRATION_HELPER = path.join(ROOT, "scripts", "phase5-evidence-migration.mjs");
const WEB_NODE_MODULES = path.join(WEB_ROOT, "node_modules");
const CLIENT = createRequire(path.join(WEB_ROOT, "package.json"))("@prisma/client");
const FROZEN_PATHS = [
  SCHEMA,
  MIGRATION_HELPER,
  path.join(WEB_ROOT, "next.config.ts"),
  path.join(ROOT, "scripts", "web-build.mjs"),
  path.join(ROOT, "scripts", "public-build-check.mjs"),
  path.join(WEB_NODE_MODULES, ".prisma", "client", "index.js"),
  path.join(WEB_NODE_MODULES, ".prisma", "client", "index.d.ts"),
];

async function hashes(paths) {
  const entries = await Promise.all(paths.map(async (file) => [
    path.relative(ROOT, file),
    createHash("sha256").update(await readFile(file)).digest("hex"),
  ]));
  return Object.fromEntries(entries);
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result;
}

test("Phase 5 supplemental: isolated migration backup preserves its key and encrypted row", async (t) => {
  const frozenBefore = await hashes(FROZEN_PATHS);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fairwork-backup-key-proof-"));
  const runtime = path.join(tempRoot, "infra", "local", "runtime");
  const databasePath = path.join(runtime, "private.db");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const backup = path.join(runtime, "phase5-migration-backup");
  const masterKey = Buffer.alloc(32, 0x5a);
  const keyHex = masterKey.toString("hex");
  const plaintext = Buffer.from("isolated private backup fixture", "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  let db;

  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, ".fairwork-owned"), "fairwork-phase4-local-runtime-v1", "utf8");
    await writeFile(path.join(runtime, "server-env.json"), JSON.stringify({
      DATABASE_URL: databaseUrl,
      AES_256_GCM_MASTER_KEY: keyHex,
      SESSION_SECRET: "ab".repeat(32),
    }), "utf8");

    const push = run(process.execPath, [PRISMA_CLI, "db", "push", "--schema", SCHEMA, "--skip-generate"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "debug" },
    });
    assert.equal(push.status, 0, `${push.stdout}\n${push.stderr}`);

    db = new CLIENT.PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    await db.privateJobData.create({
      data: { jobId: "17", ciphertext, iv, authTag },
    });
    await db.$disconnect();
    db = undefined;

    const helper = run(process.execPath, [MIGRATION_HELPER, "--before"], {
      cwd: tempRoot,
      env: { ...process.env, NODE_PATH: WEB_NODE_MODULES },
    });
    assert.equal(helper.status, 0, `${helper.stdout}\n${helper.stderr}`);

    const backedUpEnvironment = JSON.parse(await readFile(path.join(backup, "server-env.json"), "utf8"));
    assert.equal(backedUpEnvironment.AES_256_GCM_MASTER_KEY, keyHex, "backup environment preserves the key needed for the isolated ciphertext");
    assert.equal(backedUpEnvironment.DATABASE_URL, databaseUrl, "backup environment remains bound to the isolated database");

    const backedUpDatabaseUrl = `file:${path.join(backup, "private.db").replaceAll("\\", "/")}`;
    db = new CLIENT.PrismaClient({ datasources: { db: { url: backedUpDatabaseUrl } } });
    await db.$connect();
    const savedRow = await db.privateJobData.findUnique({ where: { jobId: "17" } });
    assert.ok(savedRow, "backup database contains the encrypted fixture row");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(backedUpEnvironment.AES_256_GCM_MASTER_KEY, "hex"), savedRow.iv);
    decipher.setAuthTag(savedRow.authTag);
    const recovered = Buffer.concat([decipher.update(savedRow.ciphertext), decipher.final()]);
    assert.deepEqual(recovered, plaintext, "the copied environment key decrypts the backed-up row");
    await db.$disconnect();
    db = undefined;

    t.diagnostic("isolated temporary CWD; copied key decrypts the copied ciphertext row; Prisma generation and production sources remain frozen");
  } finally {
    if (db) await db.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
    assert.deepEqual(await hashes(FROZEN_PATHS), frozenBefore, "schema, helper, build gates, and generated Prisma client stay unchanged");
  }
});
