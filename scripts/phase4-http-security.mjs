import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = path.join(ROOT, 'apps', 'web');
const ORIGIN = 'http://localhost:3000';
const RPC_URL = 'http://127.0.0.1:8545';
const webRequire = createRequire(path.join(APP_ROOT, 'package.json'));
const { SiweMessage } = webRequire('siwe');
const { getAddress } = webRequire('viem');
const { PrismaClient } = webRequire('@prisma/client');
const checks = [];

async function check(name, operation) {
  await operation();
  checks.push({ name, result: 'passed' });
}

function cookieFrom(response, name) {
  const cookies = response.headers.getSetCookie?.() ??
    (response.headers.get('set-cookie') ?? '').split(/,\s*(?=[^;,]+=)/);
  const entry = cookies.find((value) => value.trim().startsWith(`${name}=`));
  return entry?.trim().split(';', 1)[0] ?? '';
}

function assertProtectedCookie(response, name, expectedMaxAge) {
  const cookies = response.headers.getSetCookie?.() ??
    (response.headers.get('set-cookie') ?? '').split(/,\s*(?=[^;,]+=)/);
  const entry = cookies.find((value) => value.trim().startsWith(`${name}=`))?.trim() ?? '';
  assert.ok(entry, `${name} cookie was not issued`);
  assert.match(entry, /(?:^|;\s*)Path=\/(?:;|$)/i);
  assert.match(entry, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(entry, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(entry, /(?:^|;\s*)SameSite=Strict(?:;|$)/i);
  assert.match(entry, new RegExp(`(?:^|;\\s*)Max-Age=${expectedMaxAge}(?:;|$)`, 'i'));
  assert.doesNotMatch(entry, /(?:^|;\s*)Domain=/i);
}

function assertSecurityHeaders(response, privateResponse = false) {
  assert.equal(response.headers.get('x-content-type-options')?.toLowerCase(), 'nosniff');
  assert.equal(response.headers.get('x-frame-options')?.toLowerCase(), 'deny');
  assert.equal(response.headers.get('referrer-policy')?.toLowerCase(), 'no-referrer');
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/i);
  assert.ok(response.headers.has('permissions-policy'));
  assert.equal(response.headers.get('access-control-allow-origin'), null, 'API must not grant cross-origin access');
  assert.equal(response.headers.get('access-control-allow-credentials'), null, 'API must not grant credentialed CORS');
  if (privateResponse) assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
}

async function http(pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.json);
  }
  return fetch(new URL(pathname, ORIGIN), {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
}

async function rpc(method, params = []) {
  let response;
  try {
    response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error('Local Anvil RPC is unavailable at 127.0.0.1:8545.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error(`Local Anvil RPC rejected ${method}.`);
  }
  return payload.result;
}

async function signIn(address, chainConfig) {
  const nonceResponse = await http('/api/auth/nonce', { method: 'POST', json: {} });
  assert.equal(nonceResponse.status, 200, 'nonce endpoint should accept the canonical local Origin');
  assertSecurityHeaders(nonceResponse, true);
  assertProtectedCookie(nonceResponse, '__Host-fw-challenge', 300);
  const nonceBody = await nonceResponse.json();
  assert.equal(nonceBody.chainId, chainConfig.chainId);
  assert.equal(nonceBody.domain, 'localhost:3000');
  assert.equal(nonceBody.uri, ORIGIN);
  const challengeCookie = cookieFrom(nonceResponse, '__Host-fw-challenge');
  assert.ok(nonceBody.nonce && challengeCookie, 'nonce and bound challenge cookie are required');

  const message = new SiweMessage({
    domain: nonceBody.domain,
    address: getAddress(address),
    statement: 'Sign in to the Fairwork local demo security smoke test.',
    uri: nonceBody.uri,
    version: '1',
    chainId: nonceBody.chainId,
    nonce: nonceBody.nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(),
  }).prepareMessage();
  const messageHex = `0x${Buffer.from(message, 'utf8').toString('hex')}`;
  const signature = await rpc('personal_sign', [messageHex, address]);
  const loginPayload = { message, signature };
  const loginResponse = await http('/api/auth/login', {
    method: 'POST', json: loginPayload, cookie: challengeCookie,
  });
  assert.equal(loginResponse.status, 200, 'SIWE login must verify the local unlocked-account signature');
  assertSecurityHeaders(loginResponse, true);
  assertProtectedCookie(loginResponse, '__Host-fw-session', 1800);
  const sessionCookie = cookieFrom(loginResponse, '__Host-fw-session');
  const session = await loginResponse.json();
  assert.equal(session.wallet.toLowerCase(), address.toLowerCase());
  assert.ok(session.csrfToken, 'authenticated writes require the returned CSRF token');

  const replay = await http('/api/auth/login', {
    method: 'POST', json: loginPayload, cookie: challengeCookie,
  });
  assert.equal(replay.status, 401, 'a consumed SIWE nonce must not authenticate twice');

  return { cookie: sessionCookie, csrf: session.csrfToken, wallet: address };
}

function assertSameGeneric404(first, second) {
  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(first.body, second.body, 'real and nonexistent private IDs must have the same response');
  assert.deepEqual(JSON.parse(first.body), { error: { code: 'NOT_FOUND' } });
}

async function jsonBody(response) {
  return response.json();
}

async function main() {
  const resultPath = path.join(ROOT, 'infra', 'local', 'runtime', 'demo-result.json');
  const demo = JSON.parse(await readFile(resultPath, 'utf8'));
  const jobs = Array.isArray(demo.jobs) ? demo.jobs : [];
  const readyJob = jobs.find((item) => item.status === 'Ready');
  const submittedJob = jobs.find((item) => item.status === 'Submitted');
  const disputedJob = jobs.find((item) => item.status === 'Disputed' && item.disputeId);
  assert.ok(readyJob && submittedJob && disputedJob, 'latest demo result must contain seeded Ready, Submitted, and Disputed jobs');

  const publicConfigResponse = await http('/api/config');
  assert.equal(publicConfigResponse.status, 200, 'public config must load from the live local app');
  assertSecurityHeaders(publicConfigResponse, true);
  const chainConfig = await jsonBody(publicConfigResponse);
  assert.equal(chainConfig.chainId, 31337);
  assert.ok(chainConfig.roles?.client && chainConfig.roles?.freelancer);
  const accounts = await rpc('eth_accounts');
  assert.ok(Array.isArray(accounts) && accounts.length >= 10, 'the owned local Anvil must expose test-only account 9');
  const outsider = accounts[9];
  const roleAddresses = [chainConfig.roles.client, chainConfig.roles.freelancer, chainConfig.roles.treasury, ...(chainConfig.roles.arbiters ?? [])];
  assert.ok(!roleAddresses.some((address) => address.toLowerCase() === outsider.toLowerCase()), 'account 9 must be a non-party, non-arbiter wallet');
  const rpcChainId = await rpc('eth_chainId');
  assert.equal(BigInt(rpcChainId), 31337n);

  await check('live Next app reports pinned local chain and deployment config', async () => {
    assert.equal(chainConfig.chainId, 31337);
    assertSecurityHeaders(publicConfigResponse, true);
  });

  await check('CORS preflight does not receive an allow-origin response', async () => {
    const response = await http('/api/auth/nonce', {
      method: 'OPTIONS',
      origin: 'https://attacker.example',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  });

  await check('nonce route rejects a hostile Origin', async () => {
    const response = await http('/api/auth/nonce', {
      method: 'POST', origin: 'https://attacker.example', json: {},
    });
    assert.equal(response.status, 403);
  });

  await check('nonce route rejects a missing Origin header', async () => {
    const response = await http('/api/auth/nonce', {
      method: 'POST', origin: null, json: {},
    });
    assert.equal(response.status, 403);
  });

  const anonymousExisting = await http(`/api/jobs/${submittedJob.jobId}`);
  const anonymousMissing = await http('/api/jobs/999999999999999999');
  await check('anonymous access reveals no distinction between an existing and missing private job', async () => {
    assert.equal(anonymousExisting.status, 401, 'invalid or missing session is an authentication error');
    assert.equal(anonymousMissing.status, 401);
    assert.equal(await anonymousExisting.clone().text(), await anonymousMissing.clone().text());
    assertSecurityHeaders(anonymousExisting, true);
  });

  const outsiderAuth = await signIn(outsider, chainConfig);
  await check('SIWE challenge, signature, session cookie, and nonce replay are exercised over HTTP', async () => {
    const sessionResponse = await http('/api/auth/session', { cookie: outsiderAuth.cookie });
    assert.equal(sessionResponse.status, 200);
    assertSecurityHeaders(sessionResponse, true);
    const session = await sessionResponse.json();
    assert.equal(session.wallet.toLowerCase(), outsider.toLowerCase());
    assert.ok(session.csrfToken);
  });

  const privateJob = await http(`/api/jobs/${submittedJob.jobId}`, { cookie: outsiderAuth.cookie });
  const missingJob = await http('/api/jobs/999999999999999999', { cookie: outsiderAuth.cookie });
  await check('authenticated stranger gets the same 404 for a real and nonexistent job', async () => {
    assertSameGeneric404({ status: privateJob.status, body: await privateJob.clone().text() },
      { status: missingJob.status, body: await missingJob.clone().text() });
    assertSecurityHeaders(privateJob, true);
  });

  const privateEvidence = await http(`/api/disputes/${disputedJob.disputeId}/evidence`, { cookie: outsiderAuth.cookie });
  const missingEvidence = await http('/api/disputes/999999999999999999/evidence', { cookie: outsiderAuth.cookie });
  await check('authenticated stranger gets the same 404 for a real and nonexistent dispute evidence route', async () => {
    assertSameGeneric404({ status: privateEvidence.status, body: await privateEvidence.clone().text() },
      { status: missingEvidence.status, body: await missingEvidence.clone().text() });
  });

  const privateFileList = await http(`/api/jobs/${submittedJob.jobId}/files?milestoneIndex=0`, { cookie: outsiderAuth.cookie });
  const missingFileList = await http('/api/jobs/999999999999999999/files?milestoneIndex=0', { cookie: outsiderAuth.cookie });
  await check('authenticated stranger gets the same 404 for a real and nonexistent job file list', async () => {
    assertSameGeneric404({ status: privateFileList.status, body: await privateFileList.clone().text() },
      { status: missingFileList.status, body: await missingFileList.clone().text() });
  });

  await check('authenticated writes reject missing CSRF and a hostile Origin over HTTP', async () => {
    const missingCsrf = await http(`/api/jobs/${readyJob.jobId}`, {
      method: 'PUT', cookie: outsiderAuth.cookie, json: {},
    });
    assert.equal(missingCsrf.status, 403);
    const hostileOrigin = await http(`/api/jobs/${readyJob.jobId}`, {
      method: 'PUT', origin: 'https://attacker.example', cookie: outsiderAuth.cookie,
      csrf: outsiderAuth.csrf, json: {},
    });
    assert.equal(hostileOrigin.status, 403);
  });

  const clientAuth = await signIn(chainConfig.roles.client, chainConfig);
  const freelancerAuth = await signIn(chainConfig.roles.freelancer, chainConfig);
  const dbPath = path.join(ROOT, 'infra', 'local', 'runtime', 'private.db');
  const dbUrl = `file:${dbPath.replaceAll('\\', '/')}`;
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await db.$connect();
  try {
    const fileRow = await db.privateFile.findFirst({
      where: { jobId: String(submittedJob.jobId) },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    assert.ok(fileRow?.id, 'demo acceptance must leave a private submission file for the HTTP authorization probe');

    const ownerJob = await http(`/api/jobs/${submittedJob.jobId}`, { cookie: freelancerAuth.cookie });
    await check('a seeded party can read its private job through the live HTTP route', async () => {
      assert.equal(ownerJob.status, 200);
      assertSecurityHeaders(ownerJob, true);
      const body = await ownerJob.clone().json();
      assert.ok(typeof body.description === 'string' && Array.isArray(body.criteria));
    });

    const ownerEvidence = await http(`/api/disputes/${disputedJob.disputeId}/evidence`, { cookie: clientAuth.cookie });
    await check('a seeded party can read committed dispute evidence through the live HTTP route', async () => {
      assert.equal(ownerEvidence.status, 200);
      const body = await ownerEvidence.json();
      assert.ok(Array.isArray(body.items));
    });

    const privateFile = await http(`/api/files/${fileRow.id}/download`, { cookie: outsiderAuth.cookie });
    const missingFileId = '00000000-0000-4000-8000-000000000001';
    const missingFile = await http(`/api/files/${missingFileId}/download`, { cookie: outsiderAuth.cookie });
    await check('authenticated stranger gets the same 404 for a real and nonexistent file', async () => {
      assertSameGeneric404({ status: privateFile.status, body: await privateFile.clone().text() },
        { status: missingFile.status, body: await missingFile.clone().text() });
    });

    const ownerTicket = await http(`/api/files/${fileRow.id}/download`, { cookie: freelancerAuth.cookie });
    assert.equal(ownerTicket.status, 200, 'the seeded party must be able to mint a real short-lived content ticket');
    const ticketBody = await ownerTicket.json();
    const contentPath = new URL(ticketBody.url, ORIGIN).pathname + new URL(ticketBody.url, ORIGIN).search;
    const privateContent = await http(contentPath, { cookie: outsiderAuth.cookie });
    const missingContent = await http(`/api/files/${missingFileId}/content?ticket=invalid`, { cookie: outsiderAuth.cookie });
    await check('download ticket is bound to its authenticated session over HTTP', async () => {
      assertSameGeneric404({ status: privateContent.status, body: await privateContent.clone().text() },
        { status: missingContent.status, body: await missingContent.clone().text() });
    });

    const beforeFiles = await db.privateFile.count({ where: { jobId: String(readyJob.jobId), kind: 'submission' } });
    const svg = new FormData();
    svg.set('kind', 'submission');
    svg.set('milestoneIndex', '0');
    svg.set('file', new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], 'payload.svg', { type: 'image/svg+xml' }));
    const invalidUpload = await http(`/api/jobs/${readyJob.jobId}/files`, {
      method: 'POST', cookie: freelancerAuth.cookie, csrf: freelancerAuth.csrf, body: svg,
    });
    const oversized = new FormData();
    oversized.set('kind', 'submission');
    oversized.set('milestoneIndex', '0');
    oversized.set('file', new File([new Uint8Array(1024 * 1024 + 1)], 'large.txt', { type: 'text/plain' }));
    const oversizedUpload = await http(`/api/jobs/${readyJob.jobId}/files`, {
      method: 'POST', cookie: freelancerAuth.cookie, csrf: freelancerAuth.csrf, body: oversized,
    });
    const afterFiles = await db.privateFile.count({ where: { jobId: String(readyJob.jobId), kind: 'submission' } });
    await check('live upload rejects SVG and over-limit content without storing either file', async () => {
      assert.equal(invalidUpload.status, 400);
      assert.equal(oversizedUpload.status, 413);
      assert.equal(afterFiles, beforeFiles);
      assertSecurityHeaders(invalidUpload, true);
    });
  } finally {
    await db.$disconnect();
  }

  console.log(JSON.stringify({ source: 'live-http-localhost', origin: ORIGIN, chainId: 31337, checks }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unexpected smoke-test failure.';
  console.error(`Phase 4 HTTP security smoke failed: ${message}`);
  process.exitCode = 1;
});
