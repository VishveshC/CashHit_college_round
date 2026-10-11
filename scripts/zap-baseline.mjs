import { writeFileSync, existsSync } from 'node:fs';
const target = 'http://localhost:3000';
if (!existsSync('infra/local/runtime/zap-owner.json')) throw new Error('Start the owned local ZAP scanner before this check.');
async function api(component, kind, action, params = {}) {
  const url = new URL(`/JSON/${component}/${kind}/${action}/`, 'http://127.0.0.1:8080');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`ZAP API ${component}/${action}: ${response.status}`);
  const result = await response.json();
  if (result.code) throw new Error(`ZAP API ${action}: ${result.code}`);
  return result;
}
const version = await api('core', 'view', 'version');
await api('spider', 'action', 'setOptionMaxDuration', { Integer: 1 });
for (const route of ['/', '/api/config', '/api/auth/session', '/api/jobs/1', '/api/jobs/1/files', '/api/jobs/1/notes', '/api/jobs/1/timeline', '/api/jobs/1/audit', '/api/disputes/1/evidence']) {
  await api('core', 'action', 'accessUrl', { url: target + route, followRedirects: false });
}
const { scan } = await api('spider', 'action', 'scan', { url: target, maxChildren: 20, recurse: true, subtreeOnly: true });
const deadline = Date.now() + 180000;
while (Number((await api('spider', 'view', 'status', { scanId: scan })).status) < 100) {
  if (Date.now() > deadline) throw new Error('ZAP passive baseline spider timed out.');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
while (Number((await api('pscan', 'view', 'recordsToScan')).recordsToScan) > 0) {
  if (Date.now() > deadline) throw new Error('ZAP passive scan queue timed out.');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const { alerts } = await api('core', 'view', 'alerts', { baseurl: target, start: 0, count: 1000 });
const { urls } = await api('core', 'view', 'urls', { baseurl: target });
if (alerts.length >= 1000) throw new Error('ZAP alerts exceeded report cap.');
const counts = {};
for (const alert of alerts) counts[alert.risk] = (counts[alert.risk] || 0) + 1;
writeFileSync('docs/phase4-zap-baseline.json', JSON.stringify({ version: version.version, target, mode: 'unauthenticated spider + passive rules; no active scan', urls, counts, alerts }, null, 2) + '\n');
console.log(`ZAP ${version.version} passive baseline: ${urls.length} URLs, alerts ${JSON.stringify(counts)}. Authenticated pages and active attacks are outside this scan.`);
if (counts.High) process.exitCode = 1;
