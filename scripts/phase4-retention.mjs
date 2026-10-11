import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "apps", "web");
const appRequire = createRequire(path.join(webRoot, "package.json"));
const { recoverMessageAddress } = appRequire("viem");
const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * DAY_MS;
const MAX_UINT256 = (1n << 256n) - 1n;
const CANONICAL_ORIGIN = "http://localhost:3000";
const CHAIN_ID = 31337;
const SIGNED_INTENT = "delete private Fairwork data for this closed agreement";
const MESSAGE_TITLE = "Fairwork private data deletion authorization";

function fail(message) {
  throw new Error(message);
}

function validJobId(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX_UINT256;
}

function parseDeletionMessage(message, jobId, deployment, currentTime) {
  if (typeof message !== "string") fail("A signed deletion authorization message is required.");
  const lines = message.split("\n");
  const expectedLabels = ["Origin", "Chain ID", "Escrow", "Job ID", "Intent", "Nonce", "Issued At", "Expires At"];
  if (lines.length !== expectedLabels.length + 1 || lines[0] !== MESSAGE_TITLE) {
    fail("The deletion authorization message is not in canonical form.");
  }
  const values = Object.create(null);
  for (let index = 0; index < expectedLabels.length; index += 1) {
    const prefix = `${expectedLabels[index]}: `;
    if (!lines[index + 1].startsWith(prefix)) fail("The deletion authorization message is not in canonical form.");
    values[expectedLabels[index]] = lines[index + 1].slice(prefix.length);
  }

  if (values.Origin !== CANONICAL_ORIGIN) fail("The signed deletion request must use the canonical localhost origin.");
  if (values["Chain ID"] !== String(CHAIN_ID) || Number(deployment.chainId) !== CHAIN_ID) fail("The signed deletion request must target chain 31337.");
  if (!/^0x[0-9a-f]{40}$/i.test(values.Escrow) || values.Escrow.toLowerCase() !== String(deployment.escrow).toLowerCase()) {
    fail("The signed deletion request must name the deployed escrow contract.");
  }
  if (values["Job ID"] !== jobId) fail("The signed deletion request names a different job.");
  if (values.Intent !== SIGNED_INTENT) fail("The signed deletion intent is not recognized.");
  if (!/^0x[0-9a-f]{64}$/i.test(values.Nonce)) fail("The signed deletion request nonce is invalid.");

  const issuedAt = Date.parse(values["Issued At"]);
  const expiresAt = Date.parse(values["Expires At"]);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
      new Date(issuedAt).toISOString() !== values["Issued At"] ||
      new Date(expiresAt).toISOString() !== values["Expires At"]) {
    fail("The signed deletion request timestamps must use canonical UTC ISO format.");
  }
  if (issuedAt > currentTime) fail("The signed deletion request issue time is in the future.");
  if (expiresAt <= currentTime) fail("The signed deletion request has expired.");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60 * 1000 || currentTime - issuedAt > 5 * 60 * 1000) {
    fail("The signed deletion request is outside its maximum five-minute validity window.");
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function assertNoLinkComponents(absolutePath, includeLeaf = true) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const limit = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") fail("A private storage path is missing; retention stopped before deleting data.");
      throw error;
    }
    if (info.isSymbolicLink()) fail("A private storage path crosses a symbolic link or junction.");
    if (index < limit - 1 && !info.isDirectory()) fail("A private storage parent is not a directory.");
  }
  const canonical = await realpath(resolved);
  if (normalizedPath(canonical) !== normalizedPath(resolved)) fail("A private storage path resolves outside its checked boundary.");
  return resolved;
}

async function inspectSafeFileLeaf(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && index === segments.length - 1) {
        const parent = path.dirname(resolved);
        const canonicalParent = await realpath(parent);
        if (normalizedPath(canonicalParent) !== normalizedPath(parent)) fail("A private storage path resolves outside its checked boundary.");
        return { path: resolved, info: null, exists: false };
      }
      if (error?.code === "ENOENT") fail("A private storage parent is missing; retention stopped before deleting data.");
      throw error;
    }
    if (info.isSymbolicLink()) fail("A private storage path crosses a symbolic link or junction.");
    if (index < segments.length - 1 && !info.isDirectory()) fail("A private storage parent is not a directory.");
    if (index === segments.length - 1 && !info.isFile()) fail("A private storage entry is not a regular file.");
  }
  const canonical = await realpath(resolved);
  if (normalizedPath(canonical) !== normalizedPath(resolved)) fail("A private storage path resolves outside its checked boundary.");
  return { path: resolved, info: await lstat(resolved), exists: true };
}

async function checkedStorageFiles(storageDir, rows) {
  if (typeof storageDir !== "string" || !path.isAbsolute(storageDir)) fail("PRIVATE_STORAGE_DIR must be an absolute path.");
  const rootPath = await assertNoLinkComponents(storageDir, true);
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory()) fail("PRIVATE_STORAGE_DIR must name a directory.");

  const checked = [];
  for (const row of rows) {
    const key = row?.storageKey;
    if (typeof key !== "string" || key.length === 0 || key.includes("\0") || path.isAbsolute(key) || path.win32.isAbsolute(key) || path.posix.isAbsolute(key)) {
      fail("A private file has an invalid storage path.");
    }
    // The upload route stores UUID keys in the database and writes encrypted
    // bytes to `${storageKey}.enc`. Keep relative fixture/legacy keys intact.
    const physicalKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
      ? `${key}.enc`
      : key;
    const segments = physicalKey.split(/[\\/]/);
    if (segments.some((part) => part === "" || part === "." || part === "..")) fail("A private file storage path escapes its boundary.");
    const filePath = path.resolve(rootPath, ...segments);
    const relative = path.relative(rootPath, filePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail("A private file storage path escapes its boundary.");
    }
    const inspected = await inspectSafeFileLeaf(filePath);
    checked.push({ ...inspected, key });
  }
  return checked;
}

function ensureClosedAccess(access, jobId) {
  if (!access || String(access.jobId) !== jobId || String(access.snapshot?.job?.state) !== "4") {
    fail("Private data can be deleted only after the agreement is Closed on the pinned chain.");
  }
  const closedAt = Number(access.closedAt);
  if (!Number.isSafeInteger(closedAt) || closedAt <= 0) fail("The chain does not provide a valid closure timestamp.");
  const client = access.snapshot?.job?.client;
  const freelancer = access.snapshot?.job?.freelancer;
  if (typeof client !== "string" || typeof freelancer !== "string" || !/^0x[0-9a-f]{40}$/i.test(client) || !/^0x[0-9a-f]{40}$/i.test(freelancer)) {
    fail("The pinned chain returned invalid agreement party addresses.");
  }
  return { closedAt, client, freelancer };
}

async function readPrivateRows(db, jobId) {
  const [terms, notes, evidence, files] = await Promise.all([
    db.privateJobData.findMany({ where: { jobId }, select: { jobId: true } }),
    db.privateNote.findMany({ where: { jobId }, select: { id: true } }),
    db.privateEvidence.findMany({ where: { jobId }, select: { id: true } }),
    db.privateFile.findMany({ where: { jobId }, select: { id: true, storageKey: true } }),
  ]);
  return { terms, notes, evidence, files };
}

/**
 * Delete only the encrypted private data for one closed job. All external
 * authorities are injected so tests exercise the same purge logic against a
 * real SQLite database and signed EIP-191 messages.
 */
export async function runRetention({ jobId, request, db, chain, now = Date.now, storageDir, deployment, removeFile = unlink }) {
  if (!validJobId(jobId)) fail("Provide a canonical nonnegative decimal job identifier within uint256.");
  if (!db || !chain?.readJobAccess || !deployment) fail("Retention requires the database, pinned chain reader, and deployment configuration.");
  if (Number(deployment.chainId) !== CHAIN_ID || !/^0x[0-9a-f]{40}$/i.test(String(deployment.escrow ?? ""))) {
    fail("Retention is restricted to the pinned local chain 31337 deployment.");
  }

  const currentTime = Number(now());
  if (!Number.isFinite(currentTime) || currentTime <= 0) fail("The server clock is invalid.");

  let signer;
  if (request !== undefined) {
    parseDeletionMessage(request?.message, jobId, deployment, currentTime);
    if (typeof request.signature !== "string" || !/^0x[0-9a-f]+$/i.test(request.signature)) fail("A valid EIP-191 deletion signature is required.");
    try {
      signer = await recoverMessageAddress({ message: request.message, signature: request.signature });
    } catch {
      fail("The signed deletion request signature is invalid.");
    }
  } else {
    signer = deployment.roles?.client;
    if (typeof signer !== "string" || !/^0x[0-9a-f]{40}$/i.test(signer)) fail("Automatic retention requires the deployment's configured client role.");
  }

  const access = await chain.readJobAccess(BigInt(jobId), signer);
  const { closedAt, client, freelancer } = ensureClosedAccess(access, jobId);
  if (request !== undefined) {
    const isNamedParty = signer.toLowerCase() === client.toLowerCase() || signer.toLowerCase() === freelancer.toLowerCase();
    const accessConfirmsParty = (signer.toLowerCase() === client.toLowerCase() && access.client === true) ||
      (signer.toLowerCase() === freelancer.toLowerCase() && access.freelancer === true);
    if (!isNamedParty || !accessConfirmsParty) fail("Only a named client or freelancer party may sign an early deletion authorization.");
  }

  if (request === undefined && currentTime - closedAt < NINETY_DAYS_MS) {
    fail("Automatic retention is available only 90 days after the chain-derived closure time.");
  }

  const rows = await readPrivateRows(db, jobId);
  if (!rows.terms.length && !rows.notes.length && !rows.evidence.length && !rows.files.length) {
    return { jobId, deleted: false, reason: "already-deleted" };
  }
  const storageFiles = await checkedStorageFiles(storageDir, rows.files);

  // Validate every path before removing any file or database row. A failed
  // boundary check therefore leaves the whole job intact.
  for (const file of storageFiles) {
    if (!file.exists) continue;
    const current = await lstat(file.path);
    if (!current.isFile() || current.dev !== file.info.dev || current.ino !== file.info.ino) {
      fail("A private storage file changed during retention validation.");
    }
  }
  for (const file of storageFiles) {
    const current = await inspectSafeFileLeaf(file.path);
    if (current.exists) {
      if (!file.exists || !current.info.isFile() || current.info.dev !== file.info.dev || current.info.ino !== file.info.ino) {
        fail("A private storage file changed during deletion.");
      }
      await removeFile(file.path);
    }
  }

  await db.$transaction([
    db.privateJobData.deleteMany({ where: { jobId } }),
    db.privateNote.deleteMany({ where: { jobId } }),
    db.privateEvidence.deleteMany({ where: { jobId } }),
    db.privateFile.deleteMany({ where: { jobId } }),
  ]);
  return { jobId, deleted: true, filesDeleted: storageFiles.length };
}

async function loadRuntimeEnvironment() {
  const envPath = process.env.FAIRWORK_SERVER_ENV_FILE || path.join(root, "infra", "local", "runtime", "server-env.json");
  if (!existsSync(envPath)) fail("Local runtime settings are missing; run the local demo setup before retention.");
  const values = JSON.parse(await readFile(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(key)) process.env[key] = value;
  }
  return values;
}

function parseCli(args) {
  if (args.length !== 1 && args.length !== 3) fail("Usage: node --experimental-strip-types scripts/phase4-retention.mjs <jobId> [--request signed-request.json]");
  if (args.length === 1) return { jobId: args[0] };
  if (args[1] !== "--request" && args[1] !== "--request-file") fail("A signed request must be provided with --request.");
  return { jobId: args[0], requestFile: args[2] };
}

async function main() {
  const { jobId, requestFile } = parseCli(process.argv.slice(2));
  let request;
  if (requestFile) {
    const absoluteRequestPath = path.resolve(requestFile);
    const raw = JSON.parse(await readFile(absoluteRequestPath, "utf8"));
    if (!raw || typeof raw.message !== "string" || typeof raw.signature !== "string") fail("The request file must contain message and signature strings.");
    request = { message: raw.message, signature: raw.signature };
  }

  await loadRuntimeEnvironment();
  const { loadDeployment, readJobAccess } = await import("../apps/web/lib/chain-server.ts");
  const deployment = loadDeployment();
  const { PrismaClient } = appRequire("@prisma/client");
  const db = new PrismaClient();
  try {
    await db.$connect();
    const result = await runRetention({
      jobId,
      request,
      db,
      chain: { readJobAccess },
      now: Date.now,
      storageDir: process.env.PRIVATE_STORAGE_DIR,
      deployment,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Retention failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
