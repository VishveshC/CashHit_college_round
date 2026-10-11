import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root = process.cwd(), runtime = path.resolve(root, 'infra/local/runtime');
if (readFileSync(path.join(runtime, '.fairwork-owned'), 'utf8') !== 'fairwork-phase4-local-runtime-v1') throw Error('Unowned runtime');
if (existsSync(path.join(runtime, 'web-owner.json'))) throw Error('Stop owned web writer first');
Object.assign(process.env, JSON.parse(readFileSync(path.join(runtime, 'server-env.json'), 'utf8')));
const { PrismaClient } = createRequire(path.join(root, 'apps/web/package.json'))('@prisma/client');
const db = new PrismaClient();
const tables = ['AuthNonce', 'AuthSession', 'PrivateJobData', 'PrivateNote', 'PrivateEvidence', 'PrivateFile', 'AuditEntry'];
const snapshot = {};
for (const table of tables) {
  const rows = await db.$queryRawUnsafe(`SELECT * FROM "${table}" ORDER BY rowid`);
  snapshot[table] = { count: rows.length, digest: createHash('sha256').update(JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex') };
}
await db.$disconnect();
const backup = path.join(runtime, 'phase5-migration-backup');
if (process.argv.includes('--before')) {
  if (existsSync(backup)) throw Error('Preserve existing backup');
  mkdirSync(backup);
  copyFileSync(path.join(runtime, 'server-env.json'), path.join(backup, 'server-env.json'));
  for (const name of ['private.db', 'private.db-wal', 'private.db-shm', 'private.db-journal']) if (existsSync(path.join(runtime, name))) copyFileSync(path.join(runtime, name), path.join(backup, name));
  writeFileSync(path.join(backup, 'before.json'), JSON.stringify(snapshot));
  console.log('Owned SQLite backup saved; seven table counts/digests recorded without plaintext.');
} else {
  const before = JSON.parse(readFileSync(path.join(backup, 'before.json'), 'utf8'));
  if (JSON.stringify(before) !== JSON.stringify(snapshot)) throw Error('Row preservation mismatch');
  writeFileSync(path.join(root, 'docs/phase5-evidence-migration-proof.json'), JSON.stringify({ preserved: true, before, after: snapshot, backup: 'ignored owned runtime/phase5-migration-backup; not a production backup' }, null, 2));
  console.log('PASS: all seven table counts and row digests preserved.');
}
