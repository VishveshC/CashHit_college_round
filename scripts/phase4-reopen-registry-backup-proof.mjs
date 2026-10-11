import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, lstatSync} from 'node:fs';
import {createDecipheriv} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {keccak256, toHex} from 'viem';

const root = process.cwd();
const backup = path.join(root, 'infra/local/runtime/phase4-reopen-before-registry-backup');
const environment = JSON.parse(readFileSync(path.join(backup, 'server-env.json'), 'utf8'));
assert.match(environment.AES_256_GCM_MASTER_KEY, /^[a-f0-9]{64}$/i);
const key = Buffer.from(environment.AES_256_GCM_MASTER_KEY, 'hex');
const db = new DatabaseSync(path.join(backup, 'private.db'), {readOnly: true});
const decrypt = (row, context, ciphertext = row.ciphertext) => {
  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(row.authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};
const counts = {};
try {
  for (const [table, context] of [
    ['PrivateJobData', row => `job:${row.jobId}:terms:v1`],
    ['PrivateNote', row => `note:${row.id}:v1`],
    ['PrivateEvidence', row => `evidence:${row.disputeId}:${row.reference}:v1`],
  ]) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    assert.ok(rows.length > 0, `Expected real synthetic ${table} rows`);
    for (const row of rows) JSON.parse(decrypt(row, context(row)).toString('utf8'));
    counts[table] = rows.length;
  }
  const files = db.prepare('SELECT * FROM PrivateFile').all();
  assert.ok(files.length > 0);
  const storage = path.join(backup, 'storage');
  for (const file of files) {
    const target = path.resolve(storage, `${file.storageKey}.enc`);
    assert.ok(target.startsWith(storage + path.sep));
    assert.ok(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink());
    const plaintext = decrypt(file, `file:${file.id}:v1`, readFileSync(target));
    assert.equal(plaintext.length, file.size);
    assert.equal(keccak256(toHex(plaintext)).toLowerCase(), file.rawHash.toLowerCase());
  }
  counts.PrivateFile = files.length;
} finally { db.close(); }
const result = {
  kind: 'read-only decryption proof of stopped synthetic demo backup before registry reset',
  matchingKeyDecryptsAllRowsAndFiles: true,
  plaintextOrKeyValuesWritten: false,
  counts,
  limits: ['Local ignored backup includes its matching unencrypted environment file.', 'Not an encrypted operational backup, full API/chain restore or production key-recovery procedure.', 'Older Phase5 backup still lacks its historical rotated key.'],
};
writeFileSync(path.join(root, 'docs/phase4-reopen-registry-backup-proof.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
