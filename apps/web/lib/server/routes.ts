import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SiweMessage } from 'siwe';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, hashBytes, hmacToken, privateCommitment, randomBytes32, randomToken, safeEqualHex, sha256, signPayload, verifyPayload } from './security.ts';

const SESSION_COOKIE = '__Host-fw-session';
const CHALLENGE_COOKIE = '__Host-fw-challenge';
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_FILE_BYTES + 64 * 1024;
const SESSION_MS = 30 * 60 * 1000;
const NONCE_MS = 5 * 60 * 1000;
const TICKET_MS = 60 * 1000;
const BYTES32 = /^0x[a-f0-9]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UINT256_ID = /^(0|[1-9][0-9]{0,77})$/;
const POSITIVE_ID = /^[1-9][0-9]{0,77}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const sessionSchema = z.object({ message: z.string().min(1).max(8192), signature: z.string().regex(/^0x[0-9a-f]{130}$/i) }).strict();
const termsSchema = z.object({
  title: z.string().min(1), description: z.string().min(1), scope: z.string().min(1), deliveryRules: z.string().min(1),
  criteria: z.array(z.string().min(1)).min(1).max(10),
  salts: z.record(z.string(), z.string().regex(BYTES32)),
  commitments: z.record(z.string(), z.string().regex(BYTES32)),
}).strict();
const evidenceSchema = z.object({ text: z.string().min(1), salt: z.string().regex(BYTES32), commitment: z.string().regex(BYTES32), reference: z.string().regex(BYTES32) }).strict();
const noteSchema = z.object({ kind: z.literal('rejection'), milestoneIndex: z.number().int().min(0).max(9), version: z.number().int().min(1).max(5), text: z.string().min(1), salt: z.string().regex(BYTES32), commitment: z.string().regex(BYTES32) }).strict();

type Deps = {
  db: any;
  chain: {
    getPublicConfig: () => Promise<any> | any;
    readJobAccess: (jobId: bigint, wallet: string) => Promise<any>;
    readDisputeAccess: (disputeId: bigint, wallet: string) => Promise<any>;
    readJobSnapshot: (jobId: bigint) => Promise<any>;
    readChainEvents: (jobId: bigint) => Promise<any[]>;
  };
  now: () => number;
  storageDir: string;
  masterKey: Buffer;
  sessionSecret: Buffer;
  rateLimit: (bucket: string, key: string) => Promise<boolean> | boolean;
  origin: string;
};

type Session = { row: any; token: string; tokenHash: string; wallet: string };
type RouteResult = { session?: Session; response?: Response };

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const result = new Headers(headers);
  result.set('Content-Type', 'application/json; charset=utf-8');
  result.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: result });
}

function fail(status: number, code: string): Response {
  return json({ error: { code } }, status);
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  for (const rawItem of cookie.split(';')) {
    const item = rawItem.trim();
    const split = item.indexOf('=');
    if (split < 0 || item.slice(0, split) !== name) continue;
    try { return decodeURIComponent(item.slice(split + 1)); } catch { return null; }
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function expireCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function parseJobId(value: string | undefined): bigint | null {
  if (!value || !UINT256_ID.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= UINT256_MAX ? parsed : null;
  } catch { return null; }
}

function positiveId(value: string | undefined): bigint | null {
  const parsed = parseJobId(value);
  return parsed !== null && parsed > 0n ? parsed : null;
}

function sameHex(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function addressEqual(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isParty(access: any): boolean {
  return access?.client === true || access?.freelancer === true;
}

function actorRole(access: any): 'client' | 'freelancer' | null {
  if (access?.client === true) return 'client';
  if (access?.freelancer === true) return 'freelancer';
  return null;
}

function validText(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= 10_000 && !text.includes('\u0000');
}

async function boundedBody(request: Request, maxBytes: number): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > maxBytes) return { bytes: Buffer.alloc(0), tooLarge: true };
  if (!request.body) return { bytes: Buffer.alloc(0), tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.alloc(0), tooLarge: true };
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), tooLarge: false };
}

async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<{ ok: true; value: any } | { ok: false; status: number }> {
  let body: { bytes: Buffer; tooLarge: boolean };
  try { body = await boundedBody(request, maxBytes); } catch { return { ok: false, status: 400 }; }
  if (body.tooLarge) return { ok: false, status: 413 };
  try { return { ok: true, value: JSON.parse(body.bytes.toString('utf8')) }; } catch { return { ok: false, status: 400 }; }
}

function safeJson(value: any): any {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

function sortEvents(events: any[]): any[] {
  return [...events].sort((a, b) => {
    const block = BigInt(a.blockNumber ?? 0) - BigInt(b.blockNumber ?? 0);
    if (block) return block < 0n ? -1 : 1;
    const tx = Number(a.transactionIndex ?? 0) - Number(b.transactionIndex ?? 0);
    return tx || Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
  });
}

function cleanEvent(event: any): any {
  return safeJson({ ...event, source: 'chain' });
}

function getField(object: any, ...keys: string[]): any {
  for (const key of keys) if (object?.[key] !== undefined) return object[key];
  return undefined;
}

function disputePhase(dispute: any): number {
  const phase = Number(dispute?.phase ?? -1);
  return Number.isFinite(phase) ? phase : -1;
}

function chainNowSeconds(snapshot: any): bigint | null {
  const value = snapshot?.now;
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  return null;
}

function beforeEvidenceDeadline(access: any): boolean {
  const chainNow = chainNowSeconds(access?.snapshot);
  const deadlineValue = access?.dispute?.evidenceDeadline;
  let deadline: bigint;
  try {
    if (typeof deadlineValue === 'bigint') deadline = deadlineValue;
    else if (typeof deadlineValue === 'number' && Number.isSafeInteger(deadlineValue)) deadline = BigInt(deadlineValue);
    else if (typeof deadlineValue === 'string' && /^(0|[1-9][0-9]*)$/.test(deadlineValue)) deadline = BigInt(deadlineValue);
    else return false;
  } catch { return false; }
  return chainNow !== null && deadline > 0n && chainNow < deadline;
}

function eventMatchesEvidence(event: any, disputeId: string, wallet: string, commitment: string, reference: string): boolean {
  const args = event?.args ?? {};
  return event?.name === 'EvidenceCommitted'
    && String(args.disputeId) === disputeId
    && addressEqual(args.party, wallet)
    && sameHex(args.evidenceHash, commitment)
    && sameHex(getField(args, 'opaqueReference', 'reference'), reference);
}

function eventMatchesFileEvidence(event: any, file: any): boolean {
  const args = event?.args ?? {};
  return event?.name === 'EvidenceCommitted'
    && String(args.disputeId) === String(file.disputeId)
    && addressEqual(args.party, file.uploaderWallet)
    && sameHex(args.evidenceHash, file.rawHash)
    && sameHex(getField(args, 'opaqueReference', 'reference'), file.reference);
}

function submissionMatches(snapshot: any, file: any): boolean {
  const milestone = snapshot?.milestones?.[file.milestoneIndex];
  return (milestone?.submissions ?? []).some((submission: any) =>
    sameHex(getField(submission, 'deliverableHash', 'fileHash'), file.rawHash)
    && sameHex(getField(submission, 'opaqueReference', 'reference'), file.reference));
}

function fileBound(file: any, snapshot: any, events: any[]): boolean {
  return file.kind === 'submission'
    ? submissionMatches(snapshot, file)
    : events.some((event) => eventMatchesFileEvidence(event, file));
}

function bytesField(value: any): Buffer { return Buffer.from(value as Uint8Array); }

export function createRouteHandlers(deps: Deps) {
  const { db, chain, now, storageDir, masterKey, sessionSecret, rateLimit, origin } = deps;
  const at = () => new Date(now());

  async function limited(bucket: 'auth' | 'private', sessionHash = 'anonymous'): Promise<boolean> {
    try { return await rateLimit(bucket, bucket === 'auth' ? 'loopback' : `loopback:${sessionHash}`); } catch { return false; }
  }

  async function sessionFor(request: Request): Promise<Session | null> {
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token || token.length > 256) return null;
    const tokenHash = sha256(token);
    try {
      const row = await db.authSession.findUnique({ where: { sessionTokenHash: tokenHash } });
      if (!row || row.revokedAt || new Date(row.expiresAt).getTime() <= now()) return null;
      if (!isAddress(row.wallet)) return null;
      return { row, token, tokenHash, wallet: getAddress(row.wallet).toLowerCase() };
    } catch { return null; }
  }

  async function privateSession(request: Request): Promise<RouteResult> {
    if (!(await limited('private', 'anonymous'))) return { response: fail(429, 'RATE_LIMITED') };
    const session = await sessionFor(request);
    if (!session) return { response: fail(401, 'UNAUTHENTICATED') };
    if (!(await limited('private', session.tokenHash))) return { response: fail(429, 'RATE_LIMITED') };
    return { session };
  }

  async function writeGate(request: Request, authenticated = true): Promise<RouteResult> {
    if (request.headers.get('origin') !== origin) return { response: fail(403, 'BAD_ORIGIN') };
    if (!authenticated) {
      if (!(await limited('auth'))) return { response: fail(429, 'RATE_LIMITED') };
      return {};
    }
    const result = await privateSession(request);
    if (result.response || !result.session) return result;
    const supplied = request.headers.get('x-csrf-token') ?? '';
    if (!supplied || supplied.length > 256 || !safeEqualHex(sha256(supplied), String(result.session.row.csrfTokenHash))) return { response: fail(403, 'CSRF_REQUIRED') };
    return result;
  }

  async function readGate(request: Request): Promise<RouteResult> {
    if (!(await limited('private', 'anonymous'))) return { response: fail(429, 'RATE_LIMITED') };
    const session = await sessionFor(request);
    if (!session) return { response: fail(401, 'UNAUTHENTICATED') };
    if (!(await limited('private', session.tokenHash))) return { response: fail(429, 'RATE_LIMITED') };
    return { session };
  }

  async function partyJob(jobId: bigint, wallet: string): Promise<any | null> {
    try {
      const access = await chain.readJobAccess(jobId, wallet);
      if (access?.client !== true && access?.freelancer !== true) return null;
      if (String(access.jobId ?? jobId) !== String(jobId)) return null;
      return access;
    } catch { return null; }
  }

  async function disputeAccess(disputeId: bigint, wallet: string): Promise<any | null> {
    try {
      const access = await chain.readDisputeAccess(disputeId, wallet);
      if (String(access.disputeId ?? disputeId) !== String(disputeId) || parseJobId(String(access.jobId ?? '')) === null) return null;
      if (!access.dispute || String(access.dispute.jobId) !== String(access.jobId)) return null;
      return access;
    } catch { return null; }
  }

  async function eventsFor(jobId: bigint): Promise<any[]> {
    return await chain.readChainEvents(jobId);
  }

  async function audit(jobId: string, wallet: string, event: string, options: { disputeId?: string | null; resourceId?: string | null } = {}): Promise<void> {
    await db.auditEntry.create({ data: {
      id: randomUUID(), jobId, disputeId: options.disputeId ?? null, actorWallet: wallet.toLowerCase(), event,
      resourceId: options.resourceId ?? null, createdAt: at(),
    } });
  }

  async function authorizeFile(file: any, wallet: string): Promise<{ allowed: boolean; party: boolean; snapshot?: any; events?: any[] }> {
    const linkedJobId = parseJobId(String(file.jobId));
    if (linkedJobId === null) return { allowed: false, party: false };
    const jobId = linkedJobId;
    const access = await partyJob(jobId, wallet);
    if (access) {
      const snapshot = access.snapshot ?? await chain.readJobSnapshot(jobId);
      const events = file.kind === 'evidence' ? await eventsFor(jobId) : [];
      return { allowed: true, party: true, snapshot, events };
    }
    let snapshot: any;
    try { snapshot = await chain.readJobSnapshot(jobId); } catch { return { allowed: false, party: false }; }
    const milestone = snapshot?.milestones?.[file.milestoneIndex];
    const assignedDisputeId = file.kind === 'evidence' ? file.disputeId : milestone?.disputeId;
    if (!assignedDisputeId || !POSITIVE_ID.test(String(assignedDisputeId)) || String(milestone?.disputeId) !== String(assignedDisputeId)) return { allowed: false, party: false };
    const disputeId = BigInt(assignedDisputeId);
    const accessForCase = await disputeAccess(disputeId, wallet);
    if (accessForCase?.isCurrentArbiter !== true || accessForCase?.unresolved !== true || String(accessForCase.jobId) !== String(jobId)) return { allowed: false, party: false };
    snapshot = accessForCase.snapshot ?? snapshot;
    const authorizedMilestone = snapshot?.milestones?.[file.milestoneIndex];
    if (!authorizedMilestone || String(authorizedMilestone.disputeId) !== String(disputeId)) return { allowed: false, party: false };
    const events = file.kind === 'evidence' ? await eventsFor(jobId) : [];
    if (!fileBound(file, snapshot, events)) return { allowed: false, party: false };
    return { allowed: true, party: false, snapshot, events };
  }

  async function authorizedDispute(disputeIdText: string | undefined, wallet: string, requireUnresolved = true): Promise<{ id: bigint; access: any; party: boolean } | null> {
    const id = positiveId(disputeIdText);
    if (!id) return null;
    const access = await disputeAccess(id, wallet);
    if (!access) return null;
    const party = isParty(access);
    const arbiter = access.isCurrentArbiter === true;
    if ((!party && !arbiter) || (requireUnresolved && access.unresolved !== true) || (!party && access.unresolved !== true)) return null;
    return { id, access, party };
  }

  async function noncePOST(request: Request): Promise<Response> {
    const gate = await writeGate(request, false);
    if (gate.response) return gate.response;
    const body = await readJson(request);
    if (!body.ok || !body.value || typeof body.value !== 'object' || Array.isArray(body.value) || Object.keys(body.value).length !== 0) return fail(body.ok ? 400 : body.status, 'INVALID_REQUEST');
    try {
      const config = await chain.getPublicConfig();
      if (Number(config.chainId) !== 31337 || config.domain !== 'localhost:3000' || config.uri !== origin) return fail(503, 'AUTH_UNAVAILABLE');
      const nonce = randomBytes32().slice(2, 34);
      const challenge = randomToken(32);
      const expiresAt = new Date(now() + NONCE_MS);
      await db.authNonce.create({ data: {
        id: randomUUID(), nonceHash: sha256(nonce), challengeTokenHash: sha256(challenge), expiresAt, createdAt: at(), usedAt: null,
      } });
      const response = json({ nonce, expiresAt: expiresAt.toISOString(), domain: config.domain, uri: config.uri, chainId: Number(config.chainId) });
      response.headers.append('Set-Cookie', cookie(CHALLENGE_COOKIE, challenge, NONCE_MS / 1000));
      return response;
    } catch { return fail(503, 'AUTH_UNAVAILABLE'); }
  }

  async function loginPOST(request: Request): Promise<Response> {
    const gate = await writeGate(request, false);
    if (gate.response) return gate.response;
    const parsedBody = await readJson(request, 12 * 1024);
    if (!parsedBody.ok) return fail(parsedBody.status, 'INVALID_REQUEST');
    const parsed = sessionSchema.safeParse(parsedBody.value);
    if (!parsed.success) return fail(400, 'INVALID_REQUEST');
    const challenge = cookieValue(request, CHALLENGE_COOKIE);
    if (!challenge) return fail(401, 'INVALID_LOGIN');
    try {
      const message = new SiweMessage(parsed.data.message);
      const config = await chain.getPublicConfig();
      if (Number(config.chainId) !== 31337 || config.domain !== 'localhost:3000' || config.uri !== origin) return fail(503, 'AUTH_UNAVAILABLE');
      if (message.domain !== config.domain || message.uri !== config.uri || Number(message.chainId) !== 31337 || message.version !== '1' || !isAddress(message.address)) return fail(401, 'INVALID_LOGIN');
      const nonceHash = sha256(message.nonce);
      const row = await db.authNonce.findUnique({ where: { nonceHash } });
      if (!row || row.usedAt || new Date(row.expiresAt).getTime() <= now() || !safeEqualHex(row.challengeTokenHash, sha256(challenge))) return fail(401, 'INVALID_LOGIN');
      const issuedAt = Date.parse(message.issuedAt ?? '');
      if (!Number.isFinite(issuedAt) || issuedAt > now() + 30_000 || now() - issuedAt > NONCE_MS + 30_000) return fail(401, 'INVALID_LOGIN');
      if (message.expirationTime && Date.parse(message.expirationTime) <= now()) return fail(401, 'INVALID_LOGIN');
      const consumed = await db.authNonce.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: at() } }, data: { usedAt: at() } });
      if (consumed.count !== 1) return fail(401, 'INVALID_LOGIN');
      const verification = await message.verify({ signature: parsed.data.signature, domain: config.domain, nonce: message.nonce, time: new Date(now()).toISOString() });
      if (!verification.success || !addressEqual(verification.data.address, message.address)) return fail(401, 'INVALID_LOGIN');
      const wallet = getAddress(message.address).toLowerCase();
      const sessionToken = randomToken(32);
      const csrfToken = hmacToken(sessionSecret, 'csrf', sessionToken);
      const expiresAt = new Date(now() + SESSION_MS);
      await db.authSession.create({ data: {
        id: randomUUID(), wallet, sessionTokenHash: sha256(sessionToken), csrfTokenHash: sha256(csrfToken), expiresAt, createdAt: at(), revokedAt: null,
      } });
      const response = json({ wallet, csrfToken, expiresAt: expiresAt.toISOString() });
      response.headers.append('Set-Cookie', cookie(SESSION_COOKIE, sessionToken, SESSION_MS / 1000));
      response.headers.append('Set-Cookie', expireCookie(CHALLENGE_COOKIE));
      return response;
    } catch { return fail(401, 'INVALID_LOGIN'); }
  }

  async function sessionGET(request: Request): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const csrfToken = hmacToken(sessionSecret, 'csrf', gate.session.token);
    return json({ wallet: gate.session.wallet, csrfToken, expiresAt: new Date(gate.session.row.expiresAt).toISOString() });
  }

  async function logoutPOST(request: Request): Promise<Response> {
    const gate = await writeGate(request, true);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    try { await db.authSession.update({ where: { id: gate.session.row.id }, data: { revokedAt: at() } }); } catch { return fail(401, 'UNAUTHENTICATED'); }
    const response = json({ ok: true });
    response.headers.append('Set-Cookie', expireCookie(SESSION_COOKIE));
    return response;
  }

  async function jobGET(request: Request, jobIdText: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    let access: any;
    try { access = await chain.readJobAccess(jobId, gate.session.wallet); } catch { return fail(404, 'NOT_FOUND'); }
    if (String(access?.jobId ?? jobId) !== String(jobId)) return fail(404, 'NOT_FOUND');
    const party = isParty(access);
    const assignedArbiter = access?.isCurrentArbiter === true && access?.unresolved === true;
    if (!party && !assignedArbiter) return fail(404, 'NOT_FOUND');
    try {
      const row = await db.privateJobData.findUnique({ where: { jobId: String(jobId) } });
      if (!row) return fail(404, 'NOT_FOUND');
      const terms = decryptJson<any>(masterKey, { ciphertext: bytesField(row.ciphertext), iv: bytesField(row.iv), authTag: bytesField(row.authTag) }, `job:${jobId}:terms:v1`);
      await audit(String(jobId), gate.session.wallet, 'JOB_TERMS_READ');
      return json(terms);
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function jobPUT(request: Request, jobIdText: string): Promise<Response> {
    const gate = await writeGate(request, true);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    const access = await partyJob(jobId, gate.session.wallet);
    if (!access) return fail(404, 'NOT_FOUND');
    const raw = await readJson(request);
    if (!raw.ok) return fail(raw.status, raw.status === 413 ? 'TOO_LARGE' : 'INVALID_REQUEST');
    const parsed = termsSchema.safeParse(raw.value);
    if (!parsed.success) return fail(400, 'INVALID_REQUEST');
    const terms = parsed.data;
    if (![terms.title, terms.description, terms.scope, terms.deliveryRules, ...terms.criteria].every(validText)) return fail(400, 'INVALID_REQUEST');
    const criteriaKeys = terms.criteria.map((_v, i) => `criteria.${i}`);
    const expectedKeys = ['title', 'description', 'scope', 'deliveryRules', ...criteriaKeys].sort();
    if (Object.keys(terms.salts).sort().join('|') !== expectedKeys.join('|') || Object.keys(terms.commitments).sort().join('|') !== expectedKeys.join('|')) return fail(400, 'INVALID_REQUEST');
    try {
      const snapshot = access.snapshot ?? await chain.readJobSnapshot(jobId);
      if (!snapshot?.job || Number(snapshot.job.milestoneCount) !== terms.criteria.length || Number(snapshot.milestones?.length) !== terms.criteria.length) return fail(400, 'INVALID_REQUEST');
      const onChain = [
        ['title', 'TITLE', snapshot.commitments?.titleCommitment],
        ['description', 'DESCRIPTION', snapshot.commitments?.descriptionCommitment],
        ['scope', 'SCOPE', snapshot.commitments?.scopeCommitment],
        ['deliveryRules', 'DELIVERY_RULES', snapshot.commitments?.deliveryRuleCommitment],
        ...criteriaKeys.map((key, index) => [key, 'ACCEPTANCE_CRITERIA', snapshot.milestones[index]?.acceptanceCriteriaCommitment]),
      ];
      for (const [field, tag, expected] of onChain as [string, string, string][]) {
        const text = field.startsWith('criteria.') ? terms.criteria[Number(field.split('.')[1])] : (terms as any)[field];
        const computed = privateCommitment(tag, text, (terms.salts as any)[field]);
        if (!sameHex(computed, (terms.commitments as any)[field]) || !sameHex(computed, expected)) return fail(400, 'COMMITMENT_MISMATCH');
      }
      const encrypted = encryptJson(masterKey, terms, `job:${jobId}:terms:v1`);
      await db.privateJobData.upsert({
        where: { jobId: String(jobId) },
        create: { jobId: String(jobId), ...encrypted, version: 1, createdAt: at(), updatedAt: at() },
        update: { ...encrypted, version: 1, updatedAt: at() },
      });
      await audit(String(jobId), gate.session.wallet, 'JOB_TERMS_WRITE');
      return json({ ok: true });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function evidencePOST(request: Request, disputeIdText: string): Promise<Response> {
    const gate = await writeGate(request, true);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const body = await readJson(request);
    if (!body.ok) return fail(body.status, body.status === 413 ? 'TOO_LARGE' : 'INVALID_REQUEST');
    const parsed = evidenceSchema.safeParse(body.value);
    if (!parsed.success || !validText(parsed.data.text)) return fail(400, 'INVALID_REQUEST');
    const access = await authorizedDispute(disputeIdText, gate.session.wallet, false);
    if (!access || !access.party) return fail(404, 'NOT_FOUND');
    const record = parsed.data;
    const computed = privateCommitment('EVIDENCE', record.text, record.salt);
    if (!sameHex(computed, record.commitment)) return fail(404, 'NOT_FOUND');
    try {
      const jobId = BigInt(access.access.jobId);
      const events = await eventsFor(jobId);
      const matchingEvents = events.filter((event) => eventMatchesEvidence(event, String(access.id), gate.session!.wallet, record.commitment, record.reference));
      if (!matchingEvents.length) return fail(404, 'NOT_FOUND');
      const actionWindowOpen = disputePhase(access.access.dispute) === 1 && beforeEvidenceDeadline(access.access);
      if (!actionWindowOpen) {
        const deadline = chainNowSeconds({ now: access.access.dispute?.evidenceDeadline });
        const timelyReceipt = deadline !== null && deadline > 0n && matchingEvents.some((event) => {
          const submittedAt = chainNowSeconds({ now: event.args?.submittedAt });
          return submittedAt !== null && submittedAt > 0n && submittedAt < deadline;
        });
        if (!timelyReceipt) return fail(404, 'NOT_FOUND');
      }
      const encrypted = encryptJson(masterKey, { text: record.text, salt: record.salt, commitment: record.commitment, reference: record.reference }, `evidence:${access.id}:${record.reference}:v1`);
      const identity = { disputeId: String(access.id), partyWallet: gate.session.wallet.toLowerCase(), evidenceHash: record.commitment.toLowerCase(), reference: record.reference.toLowerCase() };
      const saved = await db.privateEvidence.upsert({
        where: { disputeId_partyWallet_reference_evidenceHash: identity },
        create: { id: randomUUID(), jobId: String(jobId), ...identity, ...encrypted, createdAt: at() },
        update: {},
      });
      const id = saved.id;
      await audit(String(jobId), gate.session.wallet, 'EVIDENCE_WRITE', { disputeId: String(access.id), resourceId: id });
      return json({ id });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function evidenceGET(request: Request, disputeIdText: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const access = await authorizedDispute(disputeIdText, gate.session.wallet, false);
    if (!access) return fail(404, 'NOT_FOUND');
    try {
      const rows = await db.privateEvidence.findMany({ where: { disputeId: String(access.id) }, orderBy: { createdAt: 'asc' }, take: 60 });
      const events = await eventsFor(BigInt(access.access.jobId));
      const items = [];
      for (const row of rows) {
        if (!events.some((event) => eventMatchesEvidence(event, String(access.id), row.partyWallet, row.evidenceHash, row.reference))) continue;
        if (!access.party) {
          const caseAccess = await disputeAccess(access.id, gate.session.wallet);
          if (caseAccess?.isCurrentArbiter !== true || caseAccess?.unresolved !== true) return fail(404, 'NOT_FOUND');
        }
        const payload = decryptJson<any>(masterKey, { ciphertext: bytesField(row.ciphertext), iv: bytesField(row.iv), authTag: bytesField(row.authTag) }, `evidence:${access.id}:${row.reference}:v1`);
        items.push({ id: row.id, partyWallet: row.partyWallet, ...payload, createdAt: new Date(row.createdAt).toISOString() });
      }
      await audit(String(access.access.jobId), gate.session.wallet, 'EVIDENCE_READ', { disputeId: String(access.id) });
      return json({ items });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function notePOST(request: Request, jobIdText: string): Promise<Response> {
    const gate = await writeGate(request, true);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    const access = await partyJob(jobId, gate.session.wallet);
    if (!access || access.client !== true) return fail(404, 'NOT_FOUND');
    const body = await readJson(request);
    if (!body.ok) return fail(body.status, body.status === 413 ? 'TOO_LARGE' : 'INVALID_REQUEST');
    const parsed = noteSchema.safeParse(body.value);
    if (!parsed.success || !validText(parsed.data.text)) return fail(400, 'INVALID_REQUEST');
    const note = parsed.data;
    const snapshot = access.snapshot ?? await chain.readJobSnapshot(jobId);
    const milestone = snapshot.milestones?.[note.milestoneIndex];
    if (!milestone || ![2, 3].includes(Number(milestone.state)) || Number(milestone.rejectionCount) !== note.version || note.version < 1 || note.version > 5) return fail(404, 'NOT_FOUND');
    if (!sameHex(privateCommitment('REJECTION_REASON', note.text, note.salt), note.commitment)) return fail(400, 'COMMITMENT_MISMATCH');
    if (!sameHex(note.commitment, milestone.latestReasonCommitment)) return fail(400, 'COMMITMENT_MISMATCH');
    const disputeId = BigInt(milestone.disputeId ?? 0) > 0n ? String(milestone.disputeId) : null;
    try {
      const id = randomUUID();
      const encrypted = encryptJson(masterKey, { text: note.text, salt: note.salt }, `note:${id}:v1`);
      await db.privateNote.create({ data: {
        id, jobId: String(jobId), disputeId, kind: 'rejection', milestoneIndex: note.milestoneIndex,
        version: note.version, commitment: note.commitment.toLowerCase(), writerWallet: gate.session.wallet, ...encrypted, createdAt: at(),
      } });
      await audit(String(jobId), gate.session.wallet, 'NOTE_WRITE', { disputeId, resourceId: id });
      return json({ id });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function noteGET(request: Request, jobIdText: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    let access: any;
    try { access = await chain.readJobAccess(jobId, gate.session.wallet); } catch { return fail(404, 'NOT_FOUND'); }
    const party = isParty(access);
    if (!party && (access?.isCurrentArbiter !== true || access?.unresolved !== true)) return fail(404, 'NOT_FOUND');
    try {
      const rows = await db.privateNote.findMany({ where: { jobId: String(jobId), kind: 'rejection' }, orderBy: [{ milestoneIndex: 'asc' }, { version: 'asc' }], take: 60 });
      const notes = [];
      for (const row of rows) {
        if (!party) {
          const snapshotDisputeId = access.snapshot?.milestones?.[row.milestoneIndex]?.disputeId;
          const noteDisputeId = row.disputeId ?? (BigInt(snapshotDisputeId ?? 0) > 0n ? String(snapshotDisputeId) : null);
          if (!noteDisputeId) continue;
          const caseAccess = await disputeAccess(BigInt(noteDisputeId), gate.session.wallet);
          if (caseAccess?.isCurrentArbiter !== true || caseAccess?.unresolved !== true || String(caseAccess.jobId) !== String(jobId)) continue;
          const caseMilestone = caseAccess.snapshot?.milestones?.[row.milestoneIndex];
          if (!caseMilestone || String(caseMilestone.disputeId) !== String(noteDisputeId)) continue;
        }
        const payload = decryptJson<any>(masterKey, { ciphertext: bytesField(row.ciphertext), iv: bytesField(row.iv), authTag: bytesField(row.authTag) }, `note:${row.id}:v1`);
        notes.push({ id: row.id, kind: row.kind, milestoneIndex: row.milestoneIndex, version: row.version, commitment: row.commitment, ...payload, createdAt: new Date(row.createdAt).toISOString() });
      }
      if (!party && notes.length === 0) return fail(404, 'NOT_FOUND');
      await audit(String(jobId), gate.session.wallet, 'NOTE_READ');
      return json({ notes });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function parseMultipart(request: Request): Promise<{ form?: FormData; status?: number }> {
    const body = await boundedBody(request, MAX_MULTIPART_BYTES);
    if (body.tooLarge) return { status: 413 };
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return { status: 400 };
    try {
      const copy = new Request(request.url, { method: 'POST', headers: request.headers, body: Uint8Array.from(body.bytes) });
      const form = await copy.formData();
      const names = [...form.keys()];
      if (new Set(names).size !== names.length || names.some((name) => !['kind', 'milestoneIndex', 'disputeId', 'file'].includes(name))) return { status: 400 };
      return { form };
    } catch { return { status: 400 }; }
  }

  function sniffFile(fileName: string, declaredMime: string, bytes: Buffer): string | null {
    if (!fileName || fileName.length > 128 || /[\\/]/.test(fileName) || fileName === '.' || fileName === '..' || fileName.includes('..')) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,118}\.(pdf|txt|png|jpe?g)$/i.test(fileName)) return null;
    const parts = fileName.split('.');
    if (parts.length !== 2) return null;
    const extension = parts[1].toLowerCase();
    if (extension === 'pdf' && declaredMime === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
      // A conservative passive subset. This does not parse or sanitize a PDF:
      // encrypted/compressed object dictionaries cannot be inspected here.
      const decodedNames = bytes.toString('latin1').replace(/#([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      if (!/%%EOF[\x00\x09\x0a\x0c\x0d ]*$/.test(decodedNames)) return null;
      const unsafeNames = /\/(?:JavaScript|JS|OpenAction|AA|Launch|RichMedia|EmbeddedFile|EmbeddedFiles|Filespec|FileAttachment|XFA|AcroForm|SubmitForm|ImportData|GoToR|GoToE|Movie|Sound|Rendition|3D|ObjStm|Encrypt)(?=[\x00\x09\x0a\x0c\x0d ()<>\[\]{}\/%]|$)/;
      if (unsafeNames.test(decodedNames)) return null;
      return 'application/pdf';
    }
    if (extension === 'txt' && declaredMime === 'text/plain') {
      try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!text.includes('\u0000') && !/<\s*(?:!doctype\s+html|html|svg|script|iframe)\b/i.test(text)) return 'text/plain'; } catch { return null; }
    }
    if (extension === 'png' && declaredMime === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if ((extension === 'jpg' || extension === 'jpeg') && declaredMime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
    return null;
  }

  async function fileUploadPOST(request: Request, jobIdText: string): Promise<Response> {
    const gate = await writeGate(request, true);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    const access = await partyJob(jobId, gate.session.wallet);
    if (!access) return fail(404, 'NOT_FOUND');
    const parsedForm = await parseMultipart(request);
    if (parsedForm.status) return fail(parsedForm.status, parsedForm.status === 413 ? 'TOO_LARGE' : 'INVALID_REQUEST');
    const form = parsedForm.form!;
    const kind = form.get('kind');
    const milestoneText = form.get('milestoneIndex');
    const fileEntry = form.get('file');
    const milestoneIndex = typeof milestoneText === 'string' && /^(0|[1-9][0-9]?)$/.test(milestoneText) ? Number(milestoneText) : -1;
    if ((kind !== 'submission' && kind !== 'evidence') || milestoneIndex < 0 || milestoneIndex > 9 || !(fileEntry instanceof File)) return fail(400, 'INVALID_REQUEST');
    const snapshot = access.snapshot ?? await chain.readJobSnapshot(jobId);
    if (!snapshot?.milestones?.[milestoneIndex]) return fail(404, 'NOT_FOUND');
    let disputeId: string | null = null;
    if (kind === 'submission') {
      if (access.freelancer !== true) return fail(404, 'NOT_FOUND');
    } else {
      const suppliedDispute = form.get('disputeId');
      const id = typeof suppliedDispute === 'string' ? positiveId(suppliedDispute) : null;
      if (!id) return fail(400, 'INVALID_REQUEST');
      const dispute = await authorizedDispute(String(id), gate.session.wallet);
      if (!dispute || !dispute.party || String(dispute.access.jobId) !== String(jobId)) return fail(404, 'NOT_FOUND');
      const linkedMilestone = dispute.access.dispute.milestoneIndex;
      if (linkedMilestone !== undefined && Number(linkedMilestone) !== milestoneIndex) return fail(404, 'NOT_FOUND');
      if (disputePhase(dispute.access.dispute) !== 1 || !beforeEvidenceDeadline(dispute.access)) return fail(404, 'NOT_FOUND');
      disputeId = String(id);
    }
    if (fileEntry.size > MAX_FILE_BYTES) return fail(413, 'TOO_LARGE');
    let fileBytes: Buffer;
    try { fileBytes = Buffer.from(await fileEntry.arrayBuffer()); } catch { return fail(400, 'INVALID_FILE'); }
    if (fileBytes.length > MAX_FILE_BYTES) return fail(413, 'TOO_LARGE');
    const mime = sniffFile(fileEntry.name, fileEntry.type.toLowerCase(), fileBytes);
    if (!mime) return fail(400, 'INVALID_FILE');
    const rawHash = hashBytes(fileBytes);
    const reference = randomBytes32();
    const id = randomUUID();
    const storageKey = randomUUID();
    const encrypted = encryptBytes(masterKey, fileBytes, `file:${id}:v1`);
    try {
      await mkdir(storageDir, { recursive: true });
      await writeFile(path.join(storageDir, `${storageKey}.enc`), encrypted.ciphertext, { flag: 'wx', mode: 0o600 });
      await db.privateFile.create({ data: {
        id, jobId: String(jobId), disputeId, uploaderWallet: gate.session.wallet, kind, milestoneIndex,
        rawHash: rawHash.toLowerCase(), reference: reference.toLowerCase(), mime, size: fileBytes.length, storageKey,
        iv: encrypted.iv, authTag: encrypted.authTag, createdAt: at(),
      } });
      await audit(String(jobId), gate.session.wallet, 'FILE_UPLOAD', { disputeId, resourceId: id });
      return json({ id, hash: rawHash, reference, size: fileBytes.length, mime });
    } catch {
      return fail(503, 'STORAGE_UNAVAILABLE');
    }
  }

  function fileMetadata(file: any, bound: boolean): any {
    return { id: file.id, hash: file.rawHash, reference: file.reference, kind: file.kind, milestoneIndex: file.milestoneIndex, ...(file.disputeId ? { disputeId: file.disputeId } : {}), mime: file.mime, size: file.size, bound };
  }

  async function fileListGET(request: Request, jobIdText: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    const query = new URL(request.url).searchParams.get('milestoneIndex');
    const milestoneIndex = query === null ? undefined : /^(0|[1-9][0-9]?)$/.test(query) ? Number(query) : -1;
    if (milestoneIndex === -1 || (milestoneIndex !== undefined && milestoneIndex > 9)) return fail(400, 'INVALID_REQUEST');
    try {
      const jobAccess = await chain.readJobAccess(jobId, gate.session.wallet);
      const party = isParty(jobAccess);
      const all = await db.privateFile.findMany({ where: { jobId: String(jobId), ...(milestoneIndex === undefined ? {} : { milestoneIndex }) }, orderBy: { createdAt: 'asc' }, take: 60 });
      let snapshot = jobAccess?.snapshot;
      let events: any[] = [];
      if (!party) {
        if (jobAccess?.isCurrentArbiter !== true || jobAccess?.unresolved !== true) return fail(404, 'NOT_FOUND');
        snapshot ??= await chain.readJobSnapshot(jobId);
        events = await eventsFor(jobId);
      }
      const files = [];
      for (const file of all) {
        if (party) {
          const fileSnapshot = snapshot ?? await chain.readJobSnapshot(jobId);
          const fileEvents = file.kind === 'evidence' ? await eventsFor(jobId) : [];
          files.push(fileMetadata(file, fileBound(file, fileSnapshot, fileEvents)));
          continue;
        }
        const fileDisputeId = file.kind === 'evidence' ? file.disputeId : snapshot?.milestones?.[file.milestoneIndex]?.disputeId;
        if (!fileDisputeId || !POSITIVE_ID.test(String(fileDisputeId))) continue;
        const caseAccess = await disputeAccess(BigInt(fileDisputeId), gate.session.wallet);
        if (caseAccess?.isCurrentArbiter !== true || caseAccess?.unresolved !== true || String(caseAccess.jobId) !== String(jobId)) continue;
        const caseSnapshot = caseAccess.snapshot ?? snapshot;
        if (!caseSnapshot?.milestones?.[file.milestoneIndex] || String(caseSnapshot.milestones[file.milestoneIndex].disputeId) !== String(fileDisputeId)) continue;
        if (!fileBound(file, caseSnapshot, events)) continue;
        files.push(fileMetadata(file, true));
      }
      if (!party && files.length === 0) return fail(404, 'NOT_FOUND');
      await audit(String(jobId), gate.session.wallet, 'FILE_LIST_READ');
      return json({ files });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function fileDownloadGET(request: Request, fileId: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    if (!UUID.test(fileId)) return fail(404, 'NOT_FOUND');
    try {
      const file = await db.privateFile.findUnique({ where: { id: fileId } });
      if (!file) return fail(404, 'NOT_FOUND');
      const authorization = await authorizeFile(file, gate.session.wallet);
      if (!authorization.allowed) return fail(404, 'NOT_FOUND');
      const expiresAt = now() + TICKET_MS;
      const token = signPayload(sessionSecret, { fileId: file.id, sessionHash: gate.session.tokenHash, wallet: gate.session.wallet, expiresAt });
      await audit(String(file.jobId), gate.session.wallet, 'FILE_DOWNLOAD_TICKET', { disputeId: file.disputeId, resourceId: file.id });
      return json({ url: `/api/files/${file.id}/content?ticket=${encodeURIComponent(token)}`, expiresAt: new Date(expiresAt).toISOString() });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function fileContentGET(request: Request, fileId: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    if (!UUID.test(fileId)) return fail(404, 'NOT_FOUND');
    const token = new URL(request.url).searchParams.get('ticket') ?? '';
    const ticket = verifyPayload<{ fileId: string; sessionHash: string; wallet: string; expiresAt: number }>(sessionSecret, token);
    if (!ticket || ticket.fileId !== fileId || ticket.sessionHash !== gate.session.tokenHash || ticket.wallet !== gate.session.wallet || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= now() || ticket.expiresAt > now() + TICKET_MS) return fail(404, 'NOT_FOUND');
    try {
      const file = await db.privateFile.findUnique({ where: { id: fileId } });
      if (!file) return fail(404, 'NOT_FOUND');
      const authorization = await authorizeFile(file, gate.session.wallet);
      if (!authorization.allowed) return fail(404, 'NOT_FOUND');
      if (!UUID.test(file.storageKey)) return fail(404, 'NOT_FOUND');
      const encrypted = await readFile(path.join(storageDir, `${file.storageKey}.enc`));
      const bytes = decryptBytes(masterKey, { ciphertext: encrypted, iv: bytesField(file.iv), authTag: bytesField(file.authTag) }, `file:${file.id}:v1`);
      if (bytes.length !== file.size || !sameHex(hashBytes(bytes), file.rawHash)) return fail(404, 'NOT_FOUND');
      await audit(String(file.jobId), gate.session.wallet, 'FILE_CONTENT_READ', { disputeId: file.disputeId, resourceId: file.id });
      const extension = file.mime === 'application/pdf' ? 'pdf' : file.mime === 'text/plain' ? 'txt' : file.mime === 'image/png' ? 'png' : 'jpg';
      return new Response(Uint8Array.from(bytes), { status: 200, headers: {
        'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="fairwork-${file.id}.${extension}"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function timelineGET(request: Request, jobIdText: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    if (!(await partyJob(jobId, gate.session.wallet))) return fail(404, 'NOT_FOUND');
    try {
      const chainEvents = sortEvents(await eventsFor(jobId)).map(cleanEvent);
      await audit(String(jobId), gate.session.wallet, 'TIMELINE_READ');
      const auditEvents = await db.auditEntry.findMany({ where: { jobId: String(jobId) }, orderBy: { createdAt: 'asc' }, take: 200 });
      return json({ chainEvents, auditEvents: safeJson(auditEvents) });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  async function auditGET(request: Request, jobIdText: string): Promise<Response> {
    const gate = await readGate(request);
    if (gate.response || !gate.session) return gate.response ?? fail(401, 'UNAUTHENTICATED');
    const parsedJobId = parseJobId(jobIdText);
    if (parsedJobId === null) return fail(404, 'NOT_FOUND');
    const jobId = parsedJobId;
    if (!(await partyJob(jobId, gate.session.wallet))) return fail(404, 'NOT_FOUND');
    try {
      await audit(String(jobId), gate.session.wallet, 'AUDIT_READ');
      const entries = await db.auditEntry.findMany({ where: { jobId: String(jobId) }, orderBy: { createdAt: 'desc' }, take: 200 });
      return json({ items: safeJson(entries) });
    } catch { return fail(404, 'NOT_FOUND'); }
  }

  return { noncePOST, loginPOST, sessionGET, logoutPOST, jobGET, jobPUT, evidenceGET, evidencePOST, fileUploadPOST, fileDownloadGET, fileContentGET, fileListGET, timelineGET, auditGET, noteGET, notePOST };
}
