import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadDeployment, readChainEvents, readDisputeAccess, readJobAccess, readJobSnapshot } from '../chain-server.ts';
import { publicClient } from '../chain.ts';
import { verifyDeployment } from '../chain-pins.ts';
import { createRouteHandlers } from './routes.ts';

const CANONICAL_ORIGIN = 'http://localhost:3000';
const CANONICAL_DOMAIN = 'localhost:3000';
const RPC_URL = 'http://127.0.0.1:8545';
const RATE_WINDOW_MS = 60_000;
type HandlerSet = ReturnType<typeof createRouteHandlers>;

const globalRuntime = globalThis as typeof globalThis & {
  __fairworkPrisma?: PrismaClient;
  __fairworkHandlers?: HandlerSet;
  __fairworkRateBuckets?: Map<string, { startedAt: number; count: number }>;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Server configuration unavailable');
  return value;
}

function runtimeConfig() {
  if (process.env.FAIRWORK_BUILD_TARGET !== 'local' || process.env.NEXT_PUBLIC_FAIRWORK_LOCAL !== '1') throw new Error('Server configuration unavailable');
  const origin = required('APP_ORIGIN');
  const domain = required('SIWE_DOMAIN');
  const uri = required('SIWE_URI');
  const chainId = required('CHAIN_ID');
  const rpcUrl = required('CHAIN_RPC_URL');
  if (origin !== CANONICAL_ORIGIN || domain !== CANONICAL_DOMAIN || uri !== CANONICAL_ORIGIN || chainId !== '31337' || rpcUrl !== RPC_URL) throw new Error('Server configuration unavailable');
  const databaseUrl = required('DATABASE_URL');
  if (!databaseUrl.startsWith('file:')) throw new Error('Server configuration unavailable');
  const databasePath = databaseUrl.slice('file:'.length);
  if (!databasePath || databasePath === ':memory:' || !path.isAbsolute(databasePath)) throw new Error('Server configuration unavailable');
  const storageDir = path.resolve(required('PRIVATE_STORAGE_DIR'));
  const runtimeDir = path.resolve(process.cwd(), '..', '..', 'infra', 'local', 'runtime');
  if (path.resolve(databasePath) !== path.join(runtimeDir, 'private.db') || storageDir !== path.join(runtimeDir, 'storage')) throw new Error('Server configuration unavailable');
  const publicDir = path.resolve(process.cwd(), 'public');
  const webRoot = path.resolve(process.cwd());
  const relativePublic = path.relative(publicDir, storageDir);
  const relativeWeb = path.relative(webRoot, storageDir);
  if (!path.isAbsolute(storageDir) || relativePublic === '' || (!relativePublic.startsWith(`..${path.sep}`) && relativePublic !== '..') || relativeWeb === '' || (!relativeWeb.startsWith(`..${path.sep}`) && relativeWeb !== '..')) throw new Error('Server configuration unavailable');
  const keyText = required('AES_256_GCM_MASTER_KEY');
  const secretText = required('SESSION_SECRET');
  if (!/^[a-f0-9]{64}$/i.test(keyText) || !/^[a-f0-9]{64,}$/i.test(secretText) || secretText.length % 2 !== 0) throw new Error('Server configuration unavailable');
  return { databaseUrl, storageDir, masterKey: Buffer.from(keyText, 'hex'), sessionSecret: Buffer.from(secretText, 'hex'), origin };
}

function rateLimit(bucket: string, key: string): boolean {
  const limits = globalRuntime.__fairworkRateBuckets ??= new Map();
  const now = Date.now();
  for (const [itemKey, item] of limits) if (now - item.startedAt >= RATE_WINDOW_MS) limits.delete(itemKey);
  const combined = `${bucket}:${key}`;
  const current = limits.get(combined);
  const max = bucket === 'auth' ? 30 : 120;
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    limits.set(combined, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= max) return false;
  current.count += 1;
  return true;
}

async function createRuntimeHandlers(): Promise<HandlerSet> {
  const config = runtimeConfig();
  await mkdir(config.storageDir, { recursive: true });
  const db = globalRuntime.__fairworkPrisma ??= new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const chain = {
    async getPublicConfig() {
      const deployment = loadDeployment();
      await verifyDeployment(deployment, publicClient(deployment));
      return deployment;
    },
    readJobAccess,
    readDisputeAccess,
    readJobSnapshot,
    readChainEvents,
  };
  return createRouteHandlers({ db, chain, now: () => Date.now(), storageDir: config.storageDir, masterKey: config.masterKey, sessionSecret: config.sessionSecret, rateLimit, origin: config.origin });
}

export async function invoke(name: keyof HandlerSet, request: Request, id?: string): Promise<Response> {
  try {
    const handlers = globalRuntime.__fairworkHandlers ??= await createRuntimeHandlers();
    const handler = handlers[name] as ((request: Request, id?: string) => Promise<Response>) | undefined;
    if (!handler) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return await handler(request, id);
  } catch {
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
