import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createRouteHandlers } from '../lib/server/routes.ts';
import { encryptBytes, encryptJson, hashBytes, privateCommitment } from '../lib/server/security.ts';

const ORIGIN = 'http://localhost:3000';
const JOB_ID = '0';
const DISPUTE_ID = '1';
const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const MASTER_KEY = Buffer.alloc(32, 0x6a);
const SESSION_SECRET = Buffer.alloc(32, 0x5b);
const CSRF = 'job-zero-test-csrf-token';
const CLIENT = '0x1111111111111111111111111111111111111111';
const FREELANCER = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
const NOTE_TEXT = 'The replacement gate does not close flush to the frame.';
const NOTE_SALT = `0x${'a5'.repeat(32)}`;
const NOTE_COMMITMENT = privateCommitment('REJECTION_REASON', NOTE_TEXT, NOTE_SALT);
const TERMS = {
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
let storageDir: string;
let databasePath: string;
let existingFileId: string;

function hashSecret(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function snapshot() {
  return {
    jobId: JOB_ID,
    now: BigInt(Math.floor(NOW / 1000)),
    job: { client: CLIENT, freelancer: FREELANCER, state: 2, milestoneCount: 1 },
    commitments: {
      titleCommitment: TERMS.commitments.title,
      descriptionCommitment: TERMS.commitments.description,
      scopeCommitment: TERMS.commitments.scope,
      deliveryRuleCommitment: TERMS.commitments.deliveryRules,
    },
    milestones: [{
      state: 3,
      acceptanceCriteriaCommitment: TERMS.commitments['criteria.0'],
      latestReasonCommitment: NOTE_COMMITMENT,
      rejectionCount: 1,
      disputeId: 0n,
      submissions: [],
    }],
  };
}

function jobAccess(wallet: string) {
  return {
    client: wallet.toLowerCase() === CLIENT,
    freelancer: wallet.toLowerCase() === FREELANCER,
    isCurrentArbiter: false,
    unresolved: false,
    closedAt: null,
    jobId: JOB_ID,
    snapshot: snapshot(),
  };
}

async function addSession(wallet: string, id: string) {
  const token = `job-zero-session-${id}`;
  await db.authSession.create({
    data: {
      id,
      wallet,
      sessionTokenHash: hashSecret(token),
      csrfTokenHash: hashSecret(CSRF),
      expiresAt: new Date(NOW + 30 * 60_000),
      createdAt: new Date(NOW),
    },
  });
  return `__Host-fw-session=${token}`;
}

function request(method: string, url: string, cookie: string, body?: unknown) {
  const headers = new Headers({ Origin: ORIGIN, Cookie: cookie });
  const init: RequestInit = { method, headers };
  if (method !== 'GET') {
    headers.set('X-CSRF-Token', CSRF);
    if (body instanceof FormData) init.body = body;
    else {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(body);
    }
  }
  return new Request(new URL(url, ORIGIN), init);
}

test('Phase 4 job zero remains a valid job identifier across private routes', async (t) => {
  const root = process.cwd();
  const webRoot = path.join(root, 'apps', 'web');
  databasePath = path.join(webRoot, `security-job-zero-${process.pid}.sqlite`);
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
  storageDir = path.join(webRoot, `security-job-zero-storage-${process.pid}`);
  await mkdir(storageDir, { recursive: true });

  const chainSnapshot = snapshot();
  const chainEvents = [{
    source: 'chain', name: 'JobCreated', blockNumber: 1n, transactionIndex: 0, logIndex: 0,
    args: { jobId: 0n, client: CLIENT, freelancer: FREELANCER },
  }];
  handlers = createRouteHandlers({
    db,
    chain: {
      async getPublicConfig() { return { chainId: 31337, domain: 'localhost:3000', uri: ORIGIN }; },
      async readJobAccess(jobId: bigint, wallet: string) { return { ...jobAccess(wallet), jobId: jobId.toString() }; },
      async readDisputeAccess(disputeId: bigint, wallet: string) {
        if (disputeId !== BigInt(DISPUTE_ID)) return { client: false, freelancer: false, isCurrentArbiter: false, unresolved: false, jobId: JOB_ID, disputeId: String(disputeId) };
        return {
          ...jobAccess(wallet),
          disputeId: DISPUTE_ID,
          dispute: { jobId: 0n, milestoneIndex: 0n, phase: 1, evidenceDeadline: BigInt(Math.floor(NOW / 1000) + 60), clientEvidenceCount: 0, freelancerEvidenceCount: 0 },
          snapshot: chainSnapshot,
        };
      },
      async readJobSnapshot() { return chainSnapshot; },
      async readChainEvents(jobId: bigint) { return jobId === 0n ? chainEvents : []; },
    },
    now: () => NOW,
    storageDir,
    masterKey: MASTER_KEY,
    sessionSecret: SESSION_SECRET,
    rateLimit: async () => true,
    origin: ORIGIN,
  });

  try {
    const termsEncrypted = encryptJson(MASTER_KEY, TERMS, `job:${JOB_ID}:terms:v1`);
    await db.privateJobData.create({
      data: { jobId: JOB_ID, ...termsEncrypted, version: 1, createdAt: new Date(NOW), updatedAt: new Date(NOW) },
    });
    const clientCookie = await addSession(CLIENT, 'client-session');
    const freelancerCookie = await addSession(FREELANCER, 'freelancer-session');
    const strangerCookie = await addSession(STRANGER, 'stranger-session');

    const fileBytes = Buffer.from('Job zero confidential deliverable.', 'utf8');
    existingFileId = randomUUID();
    const storageKey = randomUUID();
    const fileEncrypted = encryptBytes(MASTER_KEY, fileBytes, `file:${existingFileId}:v1`);
    await writeFile(path.join(storageDir, `${storageKey}.enc`), fileEncrypted.ciphertext, { flag: 'wx' });
    await db.privateFile.create({
      data: {
        id: existingFileId,
        jobId: JOB_ID,
        uploaderWallet: FREELANCER,
        kind: 'submission',
        milestoneIndex: 0,
        rawHash: hashBytes(fileBytes),
        reference: `0x${'b4'.repeat(32)}`,
        mime: 'text/plain',
        size: fileBytes.length,
        storageKey,
        iv: fileEncrypted.iv,
        authTag: fileEncrypted.authTag,
        createdAt: new Date(NOW),
      },
    });

    await t.test('party GET and commitment-verified PUT accept job ID zero while stranger access is hidden', async () => {
      const partyRead = await handlers.jobGET(request('GET', '/api/jobs/0', clientCookie), JOB_ID);
      const partyWrite = await handlers.jobPUT(request('PUT', '/api/jobs/0', clientCookie, TERMS), JOB_ID);
      const strangerRead = await handlers.jobGET(request('GET', '/api/jobs/0', strangerCookie), JOB_ID);
      const strangerWrite = await handlers.jobPUT(request('PUT', '/api/jobs/0', strangerCookie, TERMS), JOB_ID);
      assert.deepEqual([partyRead.status, partyWrite.status, strangerRead.status, strangerWrite.status], [200, 200, 404, 404]);
      assert.equal((await partyRead.json()).description, TERMS.description);
    });

    await t.test('job-zero rejection notes can be written and read by a party only', async () => {
      const note = { kind: 'rejection', milestoneIndex: 0, version: 1, text: NOTE_TEXT, salt: NOTE_SALT, commitment: NOTE_COMMITMENT };
      const write = await handlers.notePOST(request('POST', '/api/jobs/0/notes', clientCookie, note), JOB_ID);
      const read = await handlers.noteGET(request('GET', '/api/jobs/0/notes', clientCookie), JOB_ID);
      const strangerRead = await handlers.noteGET(request('GET', '/api/jobs/0/notes', strangerCookie), JOB_ID);
      const strangerWrite = await handlers.notePOST(request('POST', '/api/jobs/0/notes', strangerCookie, note), JOB_ID);
      assert.deepEqual([write.status, read.status, strangerRead.status, strangerWrite.status], [200, 200, 404, 404]);
      assert.equal((await read.json()).notes[0].text, NOTE_TEXT);
    });

    await t.test('job-zero file listing, upload, download, and content access work for the party only', async () => {
      const listBefore = await handlers.fileListGET(request('GET', '/api/jobs/0/files?milestoneIndex=0', freelancerCookie), JOB_ID);
      const ticketResponse = await handlers.fileDownloadGET(request('GET', `/api/files/${existingFileId}/download`, freelancerCookie), existingFileId);
      const ticket = ticketResponse.status === 200 ? await ticketResponse.json() : { url: `/api/files/${existingFileId}/content?ticket=invalid` };
      const contentUrl = new URL(ticket.url, ORIGIN);
      const content = await handlers.fileContentGET(request('GET', contentUrl.pathname + contentUrl.search, freelancerCookie), existingFileId);
      const form = new FormData();
      form.set('kind', 'submission');
      form.set('milestoneIndex', '0');
      form.set('file', new File(['New job zero deliverable.'], 'zero.txt', { type: 'text/plain' }));
      const upload = await handlers.fileUploadPOST(request('POST', '/api/jobs/0/files', freelancerCookie, form), JOB_ID);
      const strangerList = await handlers.fileListGET(request('GET', '/api/jobs/0/files?milestoneIndex=0', strangerCookie), JOB_ID);
      const strangerUpload = await handlers.fileUploadPOST(request('POST', '/api/jobs/0/files', strangerCookie, form), JOB_ID);
      const strangerDownload = await handlers.fileDownloadGET(request('GET', `/api/files/${existingFileId}/download`, strangerCookie), existingFileId);
      assert.deepEqual(
        [listBefore.status, ticketResponse.status, content.status, upload.status, strangerList.status, strangerUpload.status, strangerDownload.status],
        [200, 200, 200, 200, 404, 404, 404],
      );
      assert.ok((await listBefore.json()).files.some((item: any) => item.id === existingFileId));
      assert.equal(Buffer.from(await content.arrayBuffer()).toString('utf8'), 'Job zero confidential deliverable.');
    });

    await t.test('job-zero timeline and audit remain party-scoped, and dispute zero stays invalid', async () => {
      const timeline = await handlers.timelineGET(request('GET', '/api/jobs/0/timeline', clientCookie), JOB_ID);
      const audit = await handlers.auditGET(request('GET', '/api/jobs/0/audit', clientCookie), JOB_ID);
      const strangerTimeline = await handlers.timelineGET(request('GET', '/api/jobs/0/timeline', strangerCookie), JOB_ID);
      const strangerAudit = await handlers.auditGET(request('GET', '/api/jobs/0/audit', strangerCookie), JOB_ID);
      const zeroDispute = await handlers.evidenceGET(request('GET', '/api/disputes/0/evidence', clientCookie), '0');
      const firstDispute = await handlers.evidenceGET(request('GET', '/api/disputes/1/evidence', clientCookie), DISPUTE_ID);
      assert.deepEqual(
        [timeline.status, audit.status, strangerTimeline.status, strangerAudit.status, zeroDispute.status, firstDispute.status],
        [200, 200, 404, 404, 404, 200],
      );
      assert.equal((await timeline.json()).chainEvents[0].args.jobId, '0');
    });
  } finally {
    await db.$disconnect();
    await rm(storageDir, { recursive: true, force: true });
    await Promise.all([databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`].map((file) => rm(file, { force: true })));
  }
});
