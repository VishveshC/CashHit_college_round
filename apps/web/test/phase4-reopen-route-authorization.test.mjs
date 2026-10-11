import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRouteHandlers } from '../lib/server/routes.ts';
import { privateCommitment, sha256, signPayload } from '../lib/server/security.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB_ROOT = path.join(ROOT, 'apps', 'web');
const ORIGIN = 'http://localhost:3000';
const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const JOB_ID = '41';
const MISSING_JOB_ID = '42';
const DISPUTE_ID = '77';
const MISSING_DISPUTE_ID = '78';
const FILE_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_FILE_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER = '0x4444444444444444444444444444444444444444';
const FREELANCER = '0x2222222222222222222222222222222222222222';
const SESSION_TOKEN = 'phase4-reopen-outsider-session-token';
const CSRF_TOKEN = 'phase4-reopen-outsider-csrf-token';
const MASTER_KEY = Buffer.alloc(32, 0x6a);
const SESSION_SECRET = Buffer.alloc(32, 0x5b);
const SALT = `0x${'a1'.repeat(32)}`;

const requireWeb = createRequire(path.join(WEB_ROOT, 'package.json'));
const { PrismaClient } = requireWeb('@prisma/client');

function request(method, pathname, { cookie, csrf, origin = ORIGIN, json, body } = {}) {
  const headers = new Headers();
  if (origin !== null) headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  return new Request(new URL(pathname, ORIGIN), { method, headers, ...(body === undefined ? {} : { body }) });
}

function snapshot(jobId) {
  return {
    jobId: String(jobId),
    now: BigInt(Math.floor(NOW / 1000)),
    job: { milestoneCount: 1 },
    commitments: {},
    milestones: [{ state: 3, disputeId: BigInt(DISPUTE_ID), submissions: [] }],
  };
}

function assertPrivateDenial(response, label) {
  assert.equal(response.status, 404, `${label} must hide unauthorized resources`);
  assert.deepEqual(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null, `${label} must not grant CORS`);
  assert.equal(response.headers.get('access-control-allow-credentials'), null, `${label} must not grant credentialed CORS`);
}

async function assertSameGeneric404(actualPromise, missingPromise, label) {
  const [actual, missing] = await Promise.all([actualPromise, missingPromise]);
  assertPrivateDenial(actual, `${label} (real resource)`);
  assertPrivateDenial(missing, `${label} (missing resource)`);
  const [actualBody, missingBody] = await Promise.all([actual.text(), missing.text()]);
  assert.equal(actualBody, '{"error":{"code":"NOT_FOUND"}}');
  assert.equal(actualBody, missingBody, `${label} must not distinguish real and missing IDs`);
}

test('Phase 4 reopened backend: outsider route matrix and generic-ID hiding', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fairwork-phase4-route-matrix-'));
  const databasePath = path.join(tempRoot, 'private.sqlite');
  const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;
  const prismaCli = path.join(WEB_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  const schemaPath = path.join(WEB_ROOT, 'prisma', 'schema.prisma');
  const setup = spawnSync(process.execPath, [prismaCli, 'db', 'push', '--schema', schemaPath, '--skip-generate'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: 'debug' },
    windowsHide: true,
  });
  assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);

  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const storageDir = path.join(tempRoot, 'storage');
  await mkdir(storageDir, { recursive: true });
  await db.$connect();
  try {
    const expiresAt = new Date(NOW + 30 * 60_000);
    const sessionHash = sha256(SESSION_TOKEN);
    await db.authSession.create({ data: {
      id: 'reopen-outsider',
      wallet: STRANGER.toLowerCase(),
      sessionTokenHash: sessionHash,
      csrfTokenHash: sha256(CSRF_TOKEN),
      expiresAt,
      createdAt: new Date(NOW),
      revokedAt: null,
    } });
    await db.privateFile.create({ data: {
      id: FILE_ID,
      jobId: JOB_ID,
      disputeId: null,
      uploaderWallet: FREELANCER.toLowerCase(),
      kind: 'submission',
      milestoneIndex: 0,
      rawHash: `0x${'c3'.repeat(32)}`,
      reference: `0x${'d4'.repeat(32)}`,
      mime: 'application/pdf',
      size: 7,
      storageKey: '33333333-3333-4333-8333-333333333333',
      iv: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      createdAt: new Date(NOW),
    } });

    const handlers = createRouteHandlers({
      db,
      chain: {
        async getPublicConfig() { return { chainId: 31337, domain: 'localhost:3000', uri: ORIGIN }; },
        async readJobAccess(jobId) {
          return { jobId: String(jobId), client: false, freelancer: false, isCurrentArbiter: false, unresolved: false, snapshot: snapshot(jobId) };
        },
        async readDisputeAccess(disputeId) {
          return {
            disputeId: String(disputeId),
            jobId: JOB_ID,
            client: false,
            freelancer: false,
            isCurrentArbiter: false,
            unresolved: false,
            dispute: { jobId: BigInt(JOB_ID), milestoneIndex: 0n, phase: 1, evidenceDeadline: BigInt(Math.floor(NOW / 1000) + 60) },
            snapshot: snapshot(JOB_ID),
          };
        },
        async readJobSnapshot(jobId) {
          if (BigInt(jobId) !== BigInt(JOB_ID)) throw new Error('fixture job not found');
          return snapshot(jobId);
        },
        async readChainEvents() { return []; },
      },
      now: () => NOW,
      storageDir,
      masterKey: MASTER_KEY,
      sessionSecret: SESSION_SECRET,
      rateLimit: async () => true,
      origin: ORIGIN,
    });

    const cookie = `__Host-fw-session=${SESSION_TOKEN}`;
    const auth = { cookie, csrf: CSRF_TOKEN };
    const readMatrix = [
      ['job terms GET', id => handlers.jobGET(request('GET', `/api/jobs/${id}`, auth), id), JOB_ID, MISSING_JOB_ID],
      ['dispute evidence GET', id => handlers.evidenceGET(request('GET', `/api/disputes/${id}/evidence`, auth), id), DISPUTE_ID, MISSING_DISPUTE_ID],
      ['job files GET', id => handlers.fileListGET(request('GET', `/api/jobs/${id}/files?milestoneIndex=0`, auth), id), JOB_ID, MISSING_JOB_ID],
      ['rejection notes GET', id => handlers.noteGET(request('GET', `/api/jobs/${id}/notes`, auth), id), JOB_ID, MISSING_JOB_ID],
      ['timeline GET', id => handlers.timelineGET(request('GET', `/api/jobs/${id}/timeline`, auth), id), JOB_ID, MISSING_JOB_ID],
      ['audit GET', id => handlers.auditGET(request('GET', `/api/jobs/${id}/audit`, auth), id), JOB_ID, MISSING_JOB_ID],
    ];
    for (const [label, call, actualId, missingId] of readMatrix) {
      await t.test(`${label}: authenticated outsider receives indistinguishable 404`, async () => {
        await assertSameGeneric404(call(actualId), call(missingId), label);
      });
    }

    const evidenceText = 'synthetic fixture evidence';
    const evidence = {
      text: evidenceText,
      salt: SALT,
      commitment: privateCommitment('EVIDENCE', evidenceText, SALT),
      reference: `0x${'e5'.repeat(32)}`,
    };
    const note = {
      kind: 'rejection', milestoneIndex: 0, version: 1, text: 'synthetic fixture reason',
      salt: SALT, commitment: `0x${'f6'.repeat(32)}`,
    };
    const upload = () => {
      const form = new FormData();
      form.set('kind', 'submission');
      form.set('milestoneIndex', '0');
      form.set('file', new Blob(['fixture'], { type: 'text/plain' }), 'fixture.txt');
      return form;
    };
    const writeMatrix = [
      ['job terms PUT', id => handlers.jobPUT(request('PUT', `/api/jobs/${id}`, { ...auth, json: {} }), id), JOB_ID, MISSING_JOB_ID],
      ['evidence POST', id => handlers.evidencePOST(request('POST', `/api/disputes/${id}/evidence`, { ...auth, json: evidence }), id), DISPUTE_ID, MISSING_DISPUTE_ID],
      ['rejection note POST', id => handlers.notePOST(request('POST', `/api/jobs/${id}/notes`, { ...auth, json: note }), id), JOB_ID, MISSING_JOB_ID],
      ['file upload POST', id => handlers.fileUploadPOST(request('POST', `/api/jobs/${id}/files`, { ...auth, body: upload() }), id), JOB_ID, MISSING_JOB_ID],
    ];
    for (const [label, call, actualId, missingId] of writeMatrix) {
      await t.test(`${label}: authenticated outsider receives indistinguishable 404`, async () => {
        await assertSameGeneric404(call(actualId), call(missingId), label);
      });
    }

    const ticketFor = (fileId) => signPayload(SESSION_SECRET, {
      fileId,
      sessionHash,
      wallet: STRANGER.toLowerCase(),
      expiresAt: NOW + 30_000,
    });
    await t.test('file ticket and content routes deny a real file exactly like a missing file', async () => {
      await assertSameGeneric404(
        handlers.fileDownloadGET(request('GET', `/api/files/${FILE_ID}/download`, auth), FILE_ID),
        handlers.fileDownloadGET(request('GET', `/api/files/${MISSING_FILE_ID}/download`, auth), MISSING_FILE_ID),
        'file download',
      );
      const realTicket = ticketFor(FILE_ID);
      const missingTicket = ticketFor(MISSING_FILE_ID);
      await assertSameGeneric404(
        handlers.fileContentGET(request('GET', `/api/files/${FILE_ID}/content?ticket=${encodeURIComponent(realTicket)}`, auth), FILE_ID),
        handlers.fileContentGET(request('GET', `/api/files/${MISSING_FILE_ID}/content?ticket=${encodeURIComponent(missingTicket)}`, auth), MISSING_FILE_ID),
        'file content',
      );
    });

    await t.test('each private write checks Origin and CSRF before route-specific work', async () => {
      const originDenied = [
        handlers.logoutPOST(request('POST', '/api/auth/logout', { ...auth, origin: 'https://attacker.example' })),
        handlers.jobPUT(request('PUT', `/api/jobs/${JOB_ID}`, { ...auth, origin: 'https://attacker.example', json: {} }), JOB_ID),
        handlers.evidencePOST(request('POST', `/api/disputes/${DISPUTE_ID}/evidence`, { ...auth, origin: 'https://attacker.example', json: evidence }), DISPUTE_ID),
        handlers.notePOST(request('POST', `/api/jobs/${JOB_ID}/notes`, { ...auth, origin: 'https://attacker.example', json: note }), JOB_ID),
        handlers.fileUploadPOST(request('POST', `/api/jobs/${JOB_ID}/files`, { ...auth, origin: 'https://attacker.example', body: upload() }), JOB_ID),
      ];
      for (const response of await Promise.all(originDenied)) assert.equal(response.status, 403);

      const csrfDenied = [
        handlers.logoutPOST(request('POST', '/api/auth/logout', { cookie })),
        handlers.jobPUT(request('PUT', `/api/jobs/${JOB_ID}`, { cookie, json: {} }), JOB_ID),
        handlers.evidencePOST(request('POST', `/api/disputes/${DISPUTE_ID}/evidence`, { cookie, json: evidence }), DISPUTE_ID),
        handlers.notePOST(request('POST', `/api/jobs/${JOB_ID}/notes`, { cookie, json: note }), JOB_ID),
        handlers.fileUploadPOST(request('POST', `/api/jobs/${JOB_ID}/files`, { cookie, body: upload() }), JOB_ID),
      ];
      for (const response of await Promise.all(csrfDenied)) assert.equal(response.status, 403);
    });
  } finally {
    await db.$disconnect();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
