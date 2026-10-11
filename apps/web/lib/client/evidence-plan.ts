type Entry = {kind: 'file'|'text'; hash: string; reference: string};
export function buildEvidenceEntries(input: {textCommitment: string; textReference: string; file?: {hash: string; reference: string}; remaining: number}): Entry[] {
  const bytes32 = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
  if (!bytes32(input.textCommitment) || !bytes32(input.textReference) ||
      (input.file && (!bytes32(input.file.hash) || !bytes32(input.file.reference)))) throw new Error('Valid nonzero bytes32 hash and reference required');
  if (input.file?.reference.toLowerCase() === input.textReference.toLowerCase()) throw new Error('Text and file references must be distinct');
  const required = input.file ? 2 : 1;
  if (!Number.isInteger(input.remaining) || input.remaining < required || input.remaining > 5) throw new Error(`Insufficient or invalid evidence capacity; ${required} slots required`);
  return [...(input.file ? [{kind: 'file' as const, hash: input.file.hash, reference: input.file.reference}] : []),
    {kind: 'text', hash: input.textCommitment, reference: input.textReference}];
}
