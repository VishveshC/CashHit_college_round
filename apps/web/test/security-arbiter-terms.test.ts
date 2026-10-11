import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createRouteHandlers } from '../lib/server/routes.ts';
import { decryptJson, encryptJson, privateCommitment } from '../lib/server/security.ts';

const ORIGIN = 'http://localhost:3000';
const JOB_ID = '1';
const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const MASTER_KEY = Buffer.alloc(32, 0x6a);
const CSRF = 'arbiter-terms-test-csrf-token';
const WALLETS = {
  client: '0x1111111111111111111111111111111111111111',
  currentArbiter: '0x2222222222222222222222222222222222222222',
  previousArbiter: '0x3333333333333333333333333333333333333333',
  settledArbiter: '0x4444444444444444444444444444444444444444',
  stranger: '0x5555555555555555555555555555555555555555',
};

const privateTerms = {
  title: 'Replace the entry gate',
  description: 'Remove the damaged gate and fit the agreed replacement.',
  scope: 'Supply and installation are included.',
  deliveryRules: 'Submit completion photos and a short handover note.',
  criteria: ['Gate opens and closes without rubbing.'],
  salts: {
    title: `0x${'a1'.repeat(32)}`,
    description: `0x${'a2'.repeat(32)}`,
    scope: `0x${'a3'.repeat(32)}`,
    deliveryRules: `0x${'a4'.repeat(32)}`,
    'criteria.0': `0x${'a5'.repeat(32)}`,
  },
  commitments: {
    title: privateCommitment('TITLE', 'Replace the entry gate', `0x${'a1'.repeat(32)}`),
    description: privateCommitment('DESCRIPTION', 'Remove the damaged gate and fit the agreed replacement.', `0x${'a2'.repeat(32)}`),
    scope: privateCommitment('SCOPE', 'Supply and installation are included.', `0x${'a3'.repeat(32)}`),
    deliveryRules: privateCommitment('DELIVERY_RULES', 'Submit completion photos and a short handover note.', `0x${'a4'.repeat(32)}`),
    'criteria.0': privateCommitment('ACCEPTANCE_CRITERIA', 'Gate opens and closes without rubbing.', `0x${'a5'.repeat(32)}`),
  },
};

let db: PrismaClient;
let handlers: ReturnType<typeof createRouteHandlers>;
let databasePath: string;
let storageDir: string;
let readCount = 0;

function hashSecret(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function roleFor(wallet: string) {
  const normalized = wallet.toLowerCase();
  if (normalized === WALLETS.client) return { client: true, freelancer: false, isCurrentArbiter: false, unresolved: true };
  if (normalized === WALLETS.currentArbiter) return { client: false, freelancer: false, isCurrentArbiter: true, unresolved: true };
  if (normalized === WALLETS.previousArbiter) return { client: false, freelancer: false, isCurrentArbiter: false, unresolved: true };
  if (normalized === WALLETS.settledArbiter) return { client: false, freelancer: false, isCurrentArbiter: true, unresolved: false };
  return { client: false, freelancer: false, isCurrentArbiter: false, unresolved: false };
}

async function addSession(wallet: string) {
  const token = `session-${wallet.slice(-4)}`;
  await db.authSession.create({
    data: {
      id: `session-${wallet.slice(-4)}`,
      wallet,
      sessionTokenHash: hashSecret(token),
      csrfTokenHash: hashSecret(CSRF),
      expiresAt: new Date(NOW + 30 * 60_000),
      createdAt: new Date(NOW),
    },
  });
  return `__Host-fw-session=${token}`;
}

function request(method: string, walletCookie: string, body?: unknown) {
  const headers = new Headers({ Origin: ORIGIN, Cookie: walletCookie });
  const init: RequestInit = { method, headers };
  if (method !== 'GET') {
    headers.set('X-CSRF-Token', CSRF);
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/jobs/${JOB_ID}`, init);
}

test('Phase 4 current assigned arbiter may read private job description and criteria', async (t) => {
  const root = process.cwd();
  const webRoot = path.join(root, 'apps', 'web');
  databasePath = path.join(webRoot, `security-arbiter-terms-${process.pid}.sqlite`);
  const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
  const prismaCli = path.join(webRoot, 'node_modules', 'prisma', 'build', 'index.js');
  const schemaPath = path.join(webRoot, 'prisma', 'schema.prisma');
  const setup = spawnSync(process.execPath, [prismaCli, 'db', 'push', '--schema', schemaPath, '--skip-generate'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: 'debug' },
  });
  assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);

  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$connect();
  storageDir = path.join(webRoot, `security-arbiter-terms-storage-${process.pid}`);
  await mkdir(storageDir, { recursive: true });

  const snapshot = {
    jobId: JOB_ID,
    job: { milestoneCount: 1 },
    commitments: {
      titleCommitment: privateTerms.commitments.title,
      descriptionCommitment: privateTerms.commitments.description,
      scopeCommitment: privateTerms.commitments.scope,
      deliveryRuleCommitment: privateTerms.commitments.deliveryRules,
    },
    milestones: [{ acceptanceCriteriaCommitment: privateTerms.commitments['criteria.0'] }],
  };

  handlers = createRouteHandlers({
    db,
    chain: {
      async getPublicConfig() { return { chainId: 31337, domain: 'localhost:3000', uri: ORIGIN }; },
      async readJobAccess(jobId: bigint, wallet: string) {
        readCount += 1;
        return { ...roleFor(wallet), closedAt: null, jobId: String(jobId), snapshot };
      },
      async readDisputeAccess(disputeId: bigint, wallet: string) {
        return {
          ...roleFor(wallet),
          closedAt: null,
          jobId: JOB_ID,
          disputeId: String(disputeId),
          dispute: { jobId: BigInt(JOB_ID) },
          snapshot,
        };
      },
      async readJobSnapshot() { return snapshot; },
      async readChainEvents() { return []; },
    },
    now: () => NOW,
    storageDir,
    masterKey: MASTER_KEY,
    sessionSecret: Buffer.alloc(32, 0x5b),
    rateLimit: async () => true,
    origin: ORIGIN,
  });

  try {
    const encrypted = encryptJson(MASTER_KEY, privateTerms, `job:${JOB_ID}:terms:v1`);
    await db.privateJobData.create({
      data: {
        jobId: JOB_ID,
        ...encrypted,
        version: 1,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      },
    });

    const cookies = new Map<string, string>();
    for (const [label, wallet] of Object.entries(WALLETS)) cookies.set(label, await addSession(wallet));

    await t.test('a currently assigned arbiter reads the private description and acceptance criteria and the read is logged', async () => {
      const before = readCount;
      const response = await handlers.jobGET(request('GET', cookies.get('currentArbiter')!), JOB_ID);
      assert.equal(response.status, 200, 'spec §6.1 allows the assigned panel to read private job description and criteria when needed');
      const body = await response.json();
      assert.equal(body.description, privateTerms.description);
      assert.deepEqual(body.criteria, privateTerms.criteria);
      assert.ok(readCount > before, 'authorization must use a fresh chain role snapshot');
      assert.equal(await db.auditEntry.count({ where: {
        jobId: JOB_ID,
        actorWallet: WALLETS.currentArbiter,
        event: 'JOB_TERMS_READ',
      } }), 1, 'arbiter access must create an access audit entry');
    });

    await t.test('previous-panel, settled-panel, and stranger wallets receive the same generic 404', async () => {
      const auditCountBefore = await db.auditEntry.count({ where: { jobId: JOB_ID, event: 'JOB_TERMS_READ' } });
      const replies = await Promise.all(['previousArbiter', 'settledArbiter', 'stranger'].map((label) =>
        handlers.jobGET(request('GET', cookies.get(label)!), JOB_ID)));
      assert.deepEqual(replies.map((reply) => reply.status), [404, 404, 404]);
      assert.deepEqual(await Promise.all(replies.map((reply) => reply.text())), [
        '{"error":{"code":"NOT_FOUND"}}',
        '{"error":{"code":"NOT_FOUND"}}',
        '{"error":{"code":"NOT_FOUND"}}',
      ]);
      assert.equal(await db.auditEntry.count({ where: { jobId: JOB_ID, event: 'JOB_TERMS_READ' } }), auditCountBefore,
        'denied requests must not create a successful read audit entry');
    });

    await t.test('an assigned arbiter remains read-only while a party can still update terms', async () => {
      const denied = await handlers.jobPUT(request('PUT', cookies.get('currentArbiter')!, privateTerms), JOB_ID);
      assert.equal(denied.status, 404, 'arbiter read access must not become party write access');
      const before = await db.privateJobData.findUniqueOrThrow({ where: { jobId: JOB_ID } });
      const allowed = await handlers.jobPUT(request('PUT', cookies.get('client')!, privateTerms), JOB_ID);
      assert.equal(allowed.status, 200);
      const after = await db.privateJobData.findUniqueOrThrow({ where: { jobId: JOB_ID } });
      assert.deepEqual(
        decryptJson(MASTER_KEY, { ciphertext: Buffer.from(after.ciphertext), iv: Buffer.from(after.iv), authTag: Buffer.from(after.authTag) }, `job:${JOB_ID}:terms:v1`),
        privateTerms,
      );
      assert.notEqual(Buffer.from(after.ciphertext).toString('hex'), Buffer.from(before.ciphertext).toString('hex'),
        'authorized party update should re-encrypt the private row');
    });
  } finally {
    await db.$disconnect();
    await rm(storageDir, { recursive: true, force: true });
    await Promise.all([databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`].map((file) => rm(file, { force: true })));
  }
});
