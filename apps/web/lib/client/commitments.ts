import { encodeAbiParameters, keccak256, pad, toBytes, toHex, type Hex } from "viem";

export type PrivateFieldTag =
  | "TITLE"
  | "DESCRIPTION"
  | "SCOPE"
  | "DELIVERY_RULES"
  | "ACCEPTANCE_CRITERIA"
  | "EVIDENCE"
  | "SUBMISSION"
  | "REJECTION_REASON";

export type PrivateCommitment = { commitment: Hex; salt: Hex };

const fieldTags: ReadonlySet<string> = new Set([
  "TITLE",
  "DESCRIPTION",
  "SCOPE",
  "DELIVERY_RULES",
  "ACCEPTANCE_CRITERIA",
  "EVIDENCE",
  "SUBMISSION",
  "REJECTION_REASON",
]);

function validatePrivateText(plaintext: string): void {
  if (typeof plaintext !== "string" || plaintext.trim().length === 0) {
    throw new Error("Private text is required and cannot be empty.");
  }
  if (new TextEncoder().encode(plaintext).byteLength > 10_000) {
    throw new Error("Private text must be at most 10,000 UTF-8 bytes.");
  }
}

function validateSalt(salt: string): asserts salt is Hex {
  if (!/^0x[0-9a-f]{64}$/i.test(salt)) {
    throw new Error("Salt must be exactly 32 bytes encoded as 0x followed by 64 hex characters.");
  }
}

export function privateCommitmentHash(field: PrivateFieldTag, plaintext: string, salt: string): Hex {
  if (!fieldTags.has(field)) throw new Error("Unsupported private commitment field tag.");
  validatePrivateText(plaintext);
  validateSalt(salt);
  const tag = toHex(pad(toBytes(field), { dir: "right", size: 32 }));
  const plaintextHash = keccak256(toBytes(plaintext));
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [tag, plaintextHash, salt],
    ),
  );
}

export function createPrivateCommitment(field: PrivateFieldTag, plaintext: string): PrivateCommitment {
  validatePrivateText(plaintext);
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) throw new Error("A secure browser random-number source is required.");
  globalThis.crypto.getRandomValues(bytes);
  const salt = toHex(bytes);
  return { salt, commitment: privateCommitmentHash(field, plaintext, salt) };
}
