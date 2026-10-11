import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifests = readdirSync('docs').filter(name => /frozen.*\.json$/.test(name));
const unique = new Map();
for (const name of manifests) {
  const metadata = JSON.parse(readFileSync('docs/' + name, 'utf8').replace(/^\uFEFF/, ''));
  const rows = Array.isArray(metadata) ? metadata : metadata.frozen_files ?? metadata.tests;
  if (!Array.isArray(rows) || !rows.length) throw Error('Invalid freeze manifest: ' + name);
  for (const row of rows) {
    const file = row.file ?? row.path, expected = row.Hash ?? row.sha256;
    if (!file || !/^[a-f0-9]{64}$/i.test(expected)) throw Error('Invalid freeze entry: ' + name);
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected.toLowerCase()) throw Error('Changed frozen file: ' + file);
    unique.set(file, actual);
  }
  console.log('UNCHANGED manifest ' + name);
}
console.log(`PASS ${manifests.length} manifests; ${unique.size} unique frozen files unchanged.`);
const baseline = JSON.parse(readFileSync('docs/phase5-source-baseline.json','utf8'));
const changes = baseline.files.map(row => ({ file: row.path, unchanged: createHash('sha256').update(readFileSync(row.path)).digest('hex') === row.sha256 }));
if (changes.filter(row => row.file.startsWith('contracts/src/')).some(row => !row.unchanged)) throw Error('Financial contract changed during Phase5');
writeFileSync('docs/phase5-source-comparison.json', JSON.stringify({ financialSourcesUnchanged: true, changes }, null, 2));
