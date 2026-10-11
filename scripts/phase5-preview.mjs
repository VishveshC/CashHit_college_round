import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
const root = process.cwd(), runtime = path.join(root, 'infra/local/runtime');
const env = JSON.parse(readFileSync(path.join(runtime, 'server-env.json'), 'utf8'));
if (!process.argv.includes('--owner')) {
  const token = 'fw-' + randomBytes(12).toString('hex');
  const log = openSync(path.join(runtime, 'phase5-preview.log'), 'w');
  const child = spawn(process.execPath, [path.join(root, 'scripts/phase5-preview.mjs'), '--owner', token], { cwd: root, env: { ...process.env, ...env }, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  writeFileSync(path.join(runtime, 'phase5-preview-owner.json'), JSON.stringify({ pid: child.pid, token }));
  child.unref(); console.log('Owned compiled local preview launched on 127.0.0.1:3000.');
} else {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3000'], { cwd: path.join(root, 'apps/web'), env: { ...process.env, ...env }, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
}
