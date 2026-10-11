import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const prefix = 'phase4-reopen-registry-standalone-artifact';
const wrapperPath = 'scripts/registry-web-build.mjs';

function run(args) {
  return spawnSync(process.execPath, [wrapperPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
}

test('versioned registry artifact wrapper uses the registry stage and a non-writing evidence-prefix dry run', () => {
  const wrapper = readFileSync(wrapperPath, 'utf8');
  assert.match(wrapper, /from '\.\/registry-production-artifact-stage\.mjs'/);
  assert.doesNotMatch(wrapper, /from '\.\/production-artifact-stage\.mjs'/);

  const result = run(['--target', 'artifact-test', '--evidence-prefix', prefix, '--dry-run']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.target, 'artifact-test');
  assert.equal(plan.evidencePrefix, prefix);
  assert.equal(plan.report, `docs/${prefix}.json`);
  assert.equal(plan.buildLog, `docs/${prefix}-build.txt`);
  assert.equal(plan.compilationStarted, false);
  assert.equal(plan.filesWritten, false);
});

test('versioned registry wrapper rejects unsafe or non-artifact evidence prefixes', () => {
  const unsafePrefix = run(['--target', 'artifact-test', '--evidence-prefix', '../phase4-reopen-registry']);
  assert.notEqual(unsafePrefix.status, 0);
  assert.match(`${unsafePrefix.stdout}\n${unsafePrefix.stderr}`, /Evidence prefix must match/);

  const publicPrefix = run(['--target', 'public', '--evidence-prefix', prefix]);
  assert.notEqual(publicPrefix.status, 0);
  assert.match(`${publicPrefix.stdout}\n${publicPrefix.stderr}`, /only supported for the isolated artifact-test target/);
});

test('versioned registry wrapper continues to refuse public compilation without approved inputs', () => {
  const result = run(['--target', 'public']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /No approved production adapter\/configuration exists/);
});
