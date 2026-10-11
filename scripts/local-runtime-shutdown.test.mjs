import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareRuntime } from './local-runtime.mjs';

function assertOwnedPowerShell(pid, scriptPath, token) {
  const query = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($p){$p | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress}`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true }).trim();
  assert.ok(raw, 'the lock-holder process is still present');
  const info = JSON.parse(raw);
  assert.equal(Number(info.ProcessId), pid);
  assert.ok(info.CommandLine.includes(scriptPath), 'PowerShell command line matches the owned temporary lock script');
  assert.ok(info.CommandLine.includes(token), 'PowerShell command line carries this test’s unique ownership token');
}

async function waitForFile(filePath, child, maxMs = 5000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (existsSync(filePath)) return;
    if (child.exitCode !== null) throw new Error(`The owned lock holder exited early (${child.exitCode}).`);
    await delay(25);
  }
  throw new Error('Timed out waiting for the owned lock holder ready marker.');
}

async function waitForChild(child, maxMs = 5000) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the owned lock holder to release its file.')), maxMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('Windows runtime reset retries an exclusively locked private DB and preserves unrelated runtime data', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fw-runtime-shutdown-'));
  const tempRoot = path.resolve(os.tmpdir());
  const ownedRoot = path.resolve(root);
  const childProcesses = new Set();
  try {
    assert.ok(ownedRoot.startsWith(`${tempRoot}${path.sep}`), 'the test owns only its exact temporary workspace');
    const first = await prepareRuntime(root);
    const runtimeDir = path.resolve(first.runtimeDir);
    assert.equal(runtimeDir, path.join(ownedRoot, 'infra', 'local', 'runtime'));
    const database = path.join(runtimeDir, 'private.db');
    const keepFile = path.join(runtimeDir, 'unrelated-runtime-data.txt');
    writeFileSync(database, 'temporary database held exclusively by this test');
    writeFileSync(keepFile, 'preserve this unrelated runtime file');

    const token = `fw-lock-${process.pid}-${randomBytes(12).toString('hex')}`;
    const scriptPath = path.join(ownedRoot, 'hold-private-db.ps1');
    const readyPath = path.join(ownedRoot, 'lock-ready.txt');
    writeFileSync(scriptPath, [
      'param([string]$DatabasePath, [string]$ReadyPath, [string]$Token)',
      '$stream = $null',
      'try {',
      '  $stream = [System.IO.File]::Open($DatabasePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
      '  [System.IO.File]::WriteAllText($ReadyPath, $Token)',
      '  Start-Sleep -Milliseconds 1200',
      '} finally { if ($null -ne $stream) { $stream.Dispose() } }',
    ].join('\r\n'));

    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      database, readyPath, token,
    ], { windowsHide: true, stdio: 'ignore' });
    childProcesses.add({ child, scriptPath, token });
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    await waitForFile(readyPath, child);
    assert.equal(readFileSync(readyPath, 'utf8'), token);
    assertOwnedPowerShell(child.pid, scriptPath, token);

    const second = await prepareRuntime(root);

    assert.equal(second.runtimeDir, runtimeDir);
    assert.equal(existsSync(database), false, 'the locked database is removed after the owner releases it');
    assert.equal(readFileSync(keepFile, 'utf8'), 'preserve this unrelated runtime file');
  } finally {
    for (const record of childProcesses) {
      const { child, scriptPath, token } = record;
      if (child.exitCode === null && child.pid) {
        try {
          assertOwnedPowerShell(child.pid, scriptPath, token);
          await waitForChild(child, 5000);
        } catch {
          if (child.exitCode === null) {
            assertOwnedPowerShell(child.pid, scriptPath, token);
            child.kill();
            await waitForChild(child, 5000);
          }
        }
      }
    }
    assert.equal(path.resolve(root), ownedRoot);
    rmSync(ownedRoot, { recursive: true, force: true });
  }
});
