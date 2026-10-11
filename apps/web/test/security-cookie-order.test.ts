import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { SiweMessage } from "siwe";
import { privateKeyToAccount } from "viem/accounts";
import { createRouteHandlers } from "../lib/server/routes.ts";
import { hmacToken, sha256 } from "../lib/server/security.ts";

const ORIGIN = "http://localhost:3000";
const DOMAIN = "localhost:3000";
const CHAIN_ID = 31337;
const SESSION_COOKIE = "__Host-fw-session";
const CHALLENGE_COOKIE = "__Host-fw-challenge";
const FIXED_NOW = Date.parse("2026-10-11T10:00:00.000Z");
const MASTER_KEY = Buffer.alloc(32, 0x6a);
const SESSION_SECRET = Buffer.alloc(32, 0x5b);
const WALLET = privateKeyToAccount(`0x${"11".repeat(32)}`);

test("Phase 4 auth accepts later cookies preceded by semicolon whitespace", async (t) => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const appRoot = path.join(process.cwd(), "apps", "web");
  const databasePath = path.join(appRoot, `security-cookie-order-${process.pid}.sqlite`);
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  process.env.DATABASE_URL = databaseUrl;
  const prismaCli = path.join(appRoot, "node_modules", "prisma", "build", "index.js");
  const schemaPath = path.join(appRoot, "prisma", "schema.prisma");
  const dbPush = spawnSync(process.execPath, [prismaCli, "db", "push", "--schema", schemaPath, "--skip-generate"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "debug" },
  });
  assert.equal(dbPush.status, 0, `${dbPush.stdout}\n${dbPush.stderr}`);

  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const storageDir = path.join(appRoot, `security-cookie-order-storage-${process.pid}`);
  const clockMs = FIXED_NOW;
  await db.$connect();
  await mkdir(storageDir, { recursive: true });

  const handlers = createRouteHandlers({
    db,
    chain: {
      async getPublicConfig() {
        return { chainId: CHAIN_ID, domain: DOMAIN, uri: ORIGIN };
      },
      async readJobAccess(jobId, wallet) { return { jobId: String(jobId), client: false, freelancer: false, isCurrentArbiter: false, unresolved: false, closedAt: null, wallet }; },
      async readDisputeAccess(disputeId, wallet) { return { disputeId: String(disputeId), jobId: "1", client: false, freelancer: false, isCurrentArbiter: false, unresolved: false, closedAt: null, wallet, dispute: { jobId: 1n } }; },
      async readJobSnapshot(jobId) { return { jobId: String(jobId) }; },
      async readChainEvents() { return []; },
    },
    now: () => clockMs,
    storageDir,
    masterKey: MASTER_KEY,
    sessionSecret: SESSION_SECRET,
    rateLimit: async () => true,
    origin: ORIGIN,
  });

  function request(method: string, pathname: string, options: { cookie?: string; csrf?: string; body?: unknown } = {}) {
    const headers = new Headers({ Origin: ORIGIN });
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
    return new Request(new URL(pathname, ORIGIN), { method, headers, ...(body === undefined ? {} : { body }) });
  }

  function cookiePair(response: Response, name: string): string {
    const entries = response.headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ?? "").split(/,\s*(?=[^;,]+=)/);
    return entries.find((entry) => entry.trim().startsWith(`${name}=`))?.trim().split(";", 1)[0] ?? "";
  }

  try {
    await t.test("SIWE login finds the challenge cookie after another cookie", async () => {
      const nonceResponse = await handlers.noncePOST(request("POST", "/api/auth/nonce", { body: {} }));
      assert.equal(nonceResponse.status, 200);
      const nonceBody = await nonceResponse.json();
      const challengePair = cookiePair(nonceResponse, CHALLENGE_COOKIE);
      assert.ok(challengePair, "nonce endpoint must issue the challenge cookie");

      const message = new SiweMessage({
        domain: DOMAIN,
        address: WALLET.address,
        statement: "Sign in to Fairwork local cookie parsing regression.",
        uri: ORIGIN,
        version: "1",
        chainId: CHAIN_ID,
        nonce: nonceBody.nonce,
        issuedAt: new Date(clockMs).toISOString(),
        expirationTime: new Date(clockMs + 5 * 60 * 1000).toISOString(),
      }).prepareMessage();
      const signature = await WALLET.signMessage({ message });
      const cookieHeader = `tracking=keep; ${challengePair}; theme=dark`;
      const login = await handlers.loginPOST(request("POST", "/api/auth/login", {
        cookie: cookieHeader,
        body: { message, signature },
      }));
      assert.equal(login.status, 200, "valid SIWE login must accept a challenge cookie after semicolon whitespace");
      const loginBody = await login.json();
      assert.equal(loginBody.wallet.toLowerCase(), WALLET.address.toLowerCase());
      assert.ok(cookiePair(login, SESSION_COOKIE));
    });

    await t.test("session lookup and CSRF-protected logout find a later session cookie", async () => {
      const token = "cookie-order-session-token-0123456789abcdef";
      const csrf = hmacToken(SESSION_SECRET, "csrf", token);
      const sessionId = "cookie-order-session-fixture";
      await db.authSession.create({
        data: {
          id: sessionId,
          wallet: WALLET.address.toLowerCase(),
          sessionTokenHash: sha256(token),
          csrfTokenHash: sha256(csrf),
          expiresAt: new Date(clockMs + 30 * 60 * 1000),
          createdAt: new Date(clockMs),
          revokedAt: null,
        },
      });
      const cookieHeader = `tracking=keep; ${SESSION_COOKIE}=${encodeURIComponent(token)}; theme=dark`;

      const session = await handlers.sessionGET(request("GET", "/api/auth/session", { cookie: cookieHeader }));
      const logout = await handlers.logoutPOST(request("POST", "/api/auth/logout", { cookie: cookieHeader, csrf }));

      assert.deepEqual(
        { session: session.status, logout: logout.status },
        { session: 200, logout: 200 },
        "session lookup and CSRF-protected logout must find the session cookie after another cookie",
      );
      assert.equal((await db.authSession.findUnique({ where: { id: sessionId } }))?.revokedAt?.getTime(), clockMs);
      assert.match(cookiePair(logout, SESSION_COOKIE), new RegExp(`^${SESSION_COOKIE}=$`));
    });
  } finally {
    await db.$disconnect();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await rm(storageDir, { recursive: true, force: true });
    await Promise.all([databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`].map((file) => rm(file, { force: true })));
  }
});
