import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { encodeAbiParameters, keccak256, pad, stringToHex } from 'viem';
import { createRouteHandlers } from '../lib/server/routes.ts';

const ORIGIN = 'http://localhost:3000';
const WALLET = '0x2222222222222222222222222222222222222222';
const SESSION = 'phase4-regression-session-token-with-enough-entropy';
const CSRF = 'phase4-regression-csrf-token-with-enough-entropy';
const SESSION_COOKIE = '__Host-fw-session';
const DEADLINE = 1_800_000_000;
const TEXT = 'The fitted part matches the signed drawing.';
const SALT = `0x${'a9'.repeat(32)}`;
const COMMITMENT = keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
  [pad(stringToHex('EVIDENCE'), { size: 32, dir: 'right' }), keccak256(stringToHex(TEXT)), SALT],
));
const REFERENCE = `0x${'c7'.repeat(32)}`;
const RAW_HASH = `0x${'b8'.repeat(32)}`;

let db: PrismaClient;
let storageDir: string;
let databasePath: string;
let serverNow = DEADLINE * 1000 - 10_000;
let chainNow = DEADLINE;
let freelancerEvidenceCount = 4;
let eventList: any[] = [];
let handlers: ReturnType<typeof createRouteHandlers>;

function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }

function snapshot() {
  return {
    jobId: '1',
    now: BigInt(chainNow),
    job: { client: '0x1111111111111111111111111111111111111111', freelancer: WALLET, milestoneCount: 1, state: 2 },
    commitments: { titleCommitment: `0x${'01'.repeat(32)}`, descriptionCommitment: `0x${'02'.repeat(32)}`, scopeCommitment: `0x${'03'.repeat(32)}`, deliveryRuleCommitment: `0x${'04'.repeat(32)}` },
    milestones: [{ state: 3, disputeId: 1n, submissions: [], acceptanceCriteriaCommitment: `0x${'05'.repeat(32)}`, dispute: { jobId: 1n, milestoneIndex: 0n, phase: 1, evidenceDeadline: BigInt(DEADLINE), clientEvidenceCount: 0, freelancerEvidenceCount } }],
  };
}

function freshAccess() {
  const currentSnapshot = snapshot();
  return {
    client: false,
    freelancer: true,
    isCurrentArbiter: false,
    unresolved: true,
    closedAt: null,
    jobId: '1',
    disputeId: '1',
    dispute: currentSnapshot.milestones[0].dispute,
    snapshot: currentSnapshot,
  };
}

function makeDependencies() {
  return {
    db,
    chain: {
      async getPublicConfig() { return { chainId: 31337, domain: 'localhost:3000', uri: ORIGIN }; },
      async readJobAccess(jobId: bigint, wallet: string) {
        return { ...freshAccess(), jobId: String(jobId), freelancer: wallet.toLowerCase() === WALLET.toLowerCase() };
      },
      async readDisputeAccess(disputeId: bigint, wallet: string) {
        return { ...freshAccess(), disputeId: String(disputeId), freelancer: wallet.toLowerCase() === WALLET.toLowerCase() };
      },
      async readJobSnapshot() { return snapshot(); },
      async readChainEvents() { return structuredClone(eventList); },
    },
    now: () => serverNow,
    storageDir,
    masterKey: Buffer.alloc(32, 0x6a),
    sessionSecret: Buffer.alloc(32, 0x5b),
    rateLimit: async () => true,
    origin: ORIGIN,
  };
}

function makeRequest(method: string, route: string, body?: unknown) {
  const headers = new Headers({ Origin: ORIGIN, Cookie: `${SESSION_COOKIE}=${SESSION}`, 'X-CSRF-Token': CSRF });
  if (body instanceof FormData) return new Request(new URL(route, ORIGIN), { method, headers, body });
  headers.set('Content-Type', 'application/json');
  return new Request(new URL(route, ORIGIN), { method, headers, body: JSON.stringify(body) });
}

function evidenceEvent() {
  return {
    source: 'chain', name: 'EvidenceCommitted', blockNumber: 1n, transactionIndex: 0, logIndex: 0,
    args: { disputeId: 1n, party: WALLET, evidenceHash: COMMITMENT, opaqueReference: REFERENCE, submittedAt: BigInt(chainNow) },
  };
}

async function postEvidence() {
  return handlers.evidencePOST(makeRequest('POST', '/api/disputes/1/evidence', {
    text: TEXT, salt: SALT, commitment: COMMITMENT, reference: REFERENCE,
  }), '1');
}

async function uploadEvidenceFile() {
  const form = new FormData();
  form.set('kind', 'evidence');
  form.set('milestoneIndex', '0');
  form.set('disputeId', '1');
  form.set('file', new Blob(['%PDF-1.7\nprivate evidence\n%%EOF\n'], { type: 'application/pdf' }), 'evidence.pdf');
  return handlers.fileUploadPOST(makeRequest('POST', '/api/jobs/1/files', form), '1');
}

test('Phase 4 chain-time and evidence-cap regressions', async (t) => {
  const appRoot = process.cwd();
  const webRoot = path.join(appRoot, 'apps', 'web');
  databasePath = path.join(webRoot, `security-regression-${process.pid}.sqlite`);
  const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
  const prismaCli = path.join(webRoot, 'node_modules', 'prisma', 'build', 'index.js');
  const schemaPath = path.join(webRoot, 'prisma', 'schema.prisma');
  const setup = spawnSync(process.execPath, [prismaCli, 'db', 'push', '--schema', schemaPath, '--skip-generate'], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: 'debug' },
  });
  assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$connect();
  storageDir = path.join(webRoot, `security-regression-storage-${process.pid}`);
  await mkdir(storageDir, { recursive: true });
  await db.authSession.create({ data: {
    id: 'regression-session', wallet: WALLET.toLowerCase(), sessionTokenHash: sha(SESSION), csrfTokenHash: sha(CSRF),
    expiresAt: new Date(DEADLINE * 1000 + 60 * 60 * 1000), createdAt: new Date(serverNow), revokedAt: null,
  } });
  eventList = [evidenceEvent()];
  handlers = createRouteHandlers(makeDependencies());

  try {
    await t.test('the fifth already-committed evidence item is still saved privately', async () => {
      chainNow = DEADLINE - 1;
      serverNow = chainNow * 1000;
      freelancerEvidenceCount = 5;
      eventList = [evidenceEvent()];
      const response = await postEvidence();
      assert.equal(response.status, 200, 'a valid on-chain fifth item is representable after its successful receipt');
      assert.equal(await db.privateEvidence.count({ where: { disputeId: '1', reference: REFERENCE } }), 1);
    });

    await t.test('chain evidence deadline denies text and file uploads even while server time is behind', async () => {
      await db.privateEvidence.deleteMany();
      chainNow = DEADLINE;
      serverNow = DEADLINE * 1000 - 10_000;
      freelancerEvidenceCount = 4;
      eventList = [evidenceEvent()];
      const text = await postEvidence();
      const file = await uploadEvidenceFile();
      assert.equal(text.status, 404, 'half-open evidence window is closed at the exact on-chain deadline');
      assert.equal(file.status, 404, 'private server clock cannot extend the contract evidence window');
    });

    await t.test('chain evidence window allows text and file uploads while server time is ahead', async () => {
      await db.privateEvidence.deleteMany();
      chainNow = DEADLINE - 1;
      serverNow = DEADLINE * 1000 + 10_000;
      freelancerEvidenceCount = 4;
      eventList = [evidenceEvent()];
      const text = await postEvidence();
      const file = await uploadEvidenceFile();
      assert.equal(text.status, 200, 'server wall clock cannot shorten the contract evidence window');
      assert.equal(file.status, 200);
    });
  } finally {
    await db.$disconnect();
    await rm(storageDir, { recursive: true, force: true });
    await Promise.all([databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`].map((file) => rm(file, { force: true })));
  }
});
