import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceEntries } from '../lib/client/evidence-plan.ts';
const textCommitment = `0x${'11'.repeat(32)}`;
const textReference = `0x${'22'.repeat(32)}`;
const file = { hash: `0x${'33'.repeat(32)}`, reference: `0x${'44'.repeat(32)}` };
test('P04 evidence attachment separately binds raw file and salted text using two slots', () => {
  assert.deepEqual(buildEvidenceEntries({ textCommitment, textReference, file, remaining: 2 }), [
    { kind: 'file', hash: file.hash, reference: file.reference },
    { kind: 'text', hash: textCommitment, reference: textReference },
  ]);
  assert.throws(() => buildEvidenceEntries({ textCommitment, textReference, file, remaining: 1 }), /capacity|slots/i);
});
test('F31 text evidence alone consumes one slot; full party evidence cap denies another', () => {
  assert.deepEqual(buildEvidenceEntries({ textCommitment, textReference, remaining: 1 }), [
    { kind: 'text', hash: textCommitment, reference: textReference },
  ]);
  assert.throws(() => buildEvidenceEntries({ textCommitment, textReference, remaining: 0 }), /capacity|slots/i);
});
test('P04 evidence plan rejects malformed hashes, reused references and invalid capacity', () => {
  assert.throws(() => buildEvidenceEntries({ textCommitment: '0x', textReference, remaining: 5 }), /bytes32|hash/i);
  assert.throws(() => buildEvidenceEntries({ textCommitment, textReference, file: { ...file, reference: textReference }, remaining: 5 }), /distinct|reference/i);
  assert.throws(() => buildEvidenceEntries({ textCommitment, textReference, remaining: 6 }), /capacity|slots/i);
});
