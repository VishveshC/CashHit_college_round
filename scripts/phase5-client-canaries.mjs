import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const env = JSON.parse(readFileSync('infra/local/runtime/server-env.json', 'utf8'));
const secrets = ['AES_256_GCM_MASTER_KEY', 'SESSION_SECRET'].map(key => env[key]);
if (secrets.some(value => typeof value !== 'string' || value.length < 32)) throw Error('Missing canaries');
let files = 0, bytes = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else {
      const data = readFileSync(full); files++; bytes += data.length;
      if (secrets.some(secret => data.includes(Buffer.from(secret)))) throw Error('Runtime secret in client: ' + full);
    }
  }
}
walk('apps/web/.next/static');
const result = { scope: 'Final compiled local client; two current server-secret canaries', files, bytes, matchedSecrets: 0, publicArtifact: 'absent; public build refused' };
writeFileSync('docs/phase5-client-canary-scan.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
