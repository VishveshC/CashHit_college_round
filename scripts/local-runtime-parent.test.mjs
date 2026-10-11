import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareRuntime } from './local-runtime.mjs';
test('F70 reset rejects a junction parent before touching an external owned-looking runtime', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fw-parent-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'fw-parent-outside-'));
  try {
    const target = path.join(outside, 'local', 'runtime');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, '.fairwork-owned'), 'fairwork-phase4-local-runtime-v1');
    writeFileSync(path.join(target, 'private.db'), 'USER DATA');
    symlinkSync(outside, path.join(root, 'infra'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => prepareRuntime(root), /symlink|junction|parent|outside/i);
    assert.equal(readFileSync(path.join(target, 'private.db'), 'utf8'), 'USER DATA');
  } finally {
    if (process.platform === 'win32') rmdirSync(path.join(root, 'infra')); else unlinkSync(path.join(root, 'infra'));
    rmSync(root, { recursive: true });
    rmSync(outside, { recursive: true });
  }
});

