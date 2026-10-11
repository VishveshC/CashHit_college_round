import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(ROOT, "apps", "web");
const appRequire = createRequire(path.join(WEB_ROOT, "package.json"));
const { PrismaClient } = appRequire("@prisma/client");
const CURRENT_SCHEMA = path.join(WEB_ROOT, "prisma", "schema.prisma");
const PRISMA_CLI = path.join(WEB_ROOT, "node_modules", "prisma", "build", "index.js");
const CLIENT = "0x1111111111111111111111111111111111111111";
const FREELANCER = "0x2222222222222222222222222222222222222222";
const REF_A = `0x${"aa".repeat(32)}`;
const REF_B = `0x${"bb".repeat(32)}`;
const HASH_A = `0x${"01".repeat(32)}`;
const HASH_B = `0x${"02".repeat(32)}`;
const HASH_C = `0x${"03".repeat(32)}`;

function digestRow(row) {
  const normalized = {
    id: row.id,
    jobId: row.jobId,
    disputeId: row.disputeId,
    partyWallet: row.partyWallet,
    evidenceHash: row.evidenceHash,
    reference: row.reference,
    ciphertext: Buffer.from(row.ciphertext).toString("hex"),
    iv: Buffer.from(row.iv).toString("hex"),
    authTag: Buffer.from(row.authTag).toString("hex"),
    createdAt: new Date(row.createdAt).toISOString(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function pushSchema(schemaPath, databaseUrl) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, "db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "debug" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function evidenceRow({ id, partyWallet, evidenceHash, reference, marker, createdAt }) {
  return {
    id,
    jobId: "17",
    disputeId: "29",
    partyWallet: partyWallet.toLowerCase(),
    evidenceHash: evidenceHash.toLowerCase(),
    reference: reference.toLowerCase(),
    ciphertext: Buffer.from(`ciphertext-${marker}`, "utf8"),
    iv: Buffer.alloc(12, marker.charCodeAt(0)),
    authTag: Buffer.alloc(16, marker.charCodeAt(0) + 1),
    createdAt: new Date(createdAt),
  };
}

test("Phase 5 supplemental: evidence index migration preserves existing rows and supports the new identity", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fairwork-phase5-evidence-migration-"));
  const databasePath = path.join(tempDir, "migration.sqlite");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const oldSchemaPath = path.join(tempDir, "schema-old.prisma");
  let db;

  try {
    const currentSchemaText = await readFile(CURRENT_SCHEMA, "utf8");
    const currentKey = "@@unique([disputeId, partyWallet, reference, evidenceHash])";
    assert.equal(currentSchemaText.split(currentKey).length - 1, 1, "current schema contains exactly one evidence identity index");
    const oldSchemaText = currentSchemaText.replace(currentKey, "@@unique([disputeId, reference])");
    await writeFile(oldSchemaPath, oldSchemaText, "utf8");

    pushSchema(oldSchemaPath, databaseUrl);
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    const oldRows = [
      evidenceRow({ id: "legacy-evidence-client", partyWallet: CLIENT, evidenceHash: HASH_A, reference: REF_A, marker: "a", createdAt: "2026-10-10T10:00:00.000Z" }),
      evidenceRow({ id: "legacy-evidence-freelancer", partyWallet: FREELANCER, evidenceHash: HASH_B, reference: REF_B, marker: "b", createdAt: "2026-10-10T10:01:00.000Z" }),
    ];
    await db.privateEvidence.createMany({ data: oldRows });
    const beforeRows = await db.privateEvidence.findMany({ where: { disputeId: "29" }, orderBy: { id: "asc" } });
    assert.equal(beforeRows.length, 2, "old-index database starts with nonempty evidence rows");
    const beforeDigests = beforeRows.map(digestRow);
    await db.$disconnect();
    db = undefined;

    pushSchema(CURRENT_SCHEMA, databaseUrl);
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    const afterRows = await db.privateEvidence.findMany({ where: { disputeId: "29" }, orderBy: { id: "asc" } });
    assert.equal(afterRows.length, beforeRows.length, "migration preserves every pre-existing row");
    assert.deepEqual(afterRows.map((row) => row.id), beforeRows.map((row) => row.id), "migration preserves primary keys");
    assert.deepEqual(afterRows.map(digestRow), beforeDigests, "migration preserves every scalar and ciphertext/IV/tag byte");

    const sharedFromOtherParty = evidenceRow({ id: "new-shared-ref-other-party", partyWallet: FREELANCER, evidenceHash: HASH_C, reference: REF_A, marker: "c", createdAt: "2026-10-10T10:02:00.000Z" });
    const sharedFromSameParty = evidenceRow({ id: "new-shared-ref-same-party", partyWallet: CLIENT, evidenceHash: HASH_C, reference: REF_A, marker: "d", createdAt: "2026-10-10T10:03:00.000Z" });
    await db.privateEvidence.create({ data: sharedFromOtherParty });
    await db.privateEvidence.create({ data: sharedFromSameParty });

    const identity = {
      disputeId: "29",
      partyWallet: sharedFromSameParty.partyWallet,
      reference: sharedFromSameParty.reference,
      evidenceHash: sharedFromSameParty.evidenceHash,
    };
    const retry = await db.privateEvidence.upsert({
      where: { disputeId_partyWallet_reference_evidenceHash: identity },
      create: { ...sharedFromSameParty, id: "duplicate-should-not-be-created" },
      update: {},
    });
    assert.equal(retry.id, sharedFromSameParty.id, "exact identity retry resolves to the preserved row ID");
    assert.equal(await db.privateEvidence.count({ where: { disputeId: "29" } }), 4, "shared references coexist across parties and distinct commitments");
    assert.equal(await db.privateEvidence.count({ where: { disputeId: "29", reference: REF_A.toLowerCase() } }), 3);
    t.diagnostic(`preserved=${afterRows.length} insertedSharedReference=2 finalRows=4 sha256=${beforeDigests.join(",")}`);
  } finally {
    if (db) await db.$disconnect();
    await rm(tempDir, { recursive: true, force: true });
  }
});
