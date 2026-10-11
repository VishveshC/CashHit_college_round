import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2] || "docs/phase1-frozen-tests.json", "utf8").replace(/^\uFEFF/, ""));
const records = Array.isArray(manifest) ? manifest : manifest.frozen_files;
if (!Array.isArray(records) || records.length === 0) throw new Error("Invalid or empty frozen-test manifest.");
for (const record of records) {
  const file = record.file ?? record.path;
  const Hash = record.Hash ?? record.sha256;
  if (typeof file !== "string" || typeof Hash !== "string" || !/^[A-Fa-f0-9]{64}$/.test(Hash)) throw new Error("Invalid frozen-test record.");
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
  if (actual !== Hash.toUpperCase()) throw new Error(`Frozen test changed: ${file}`);
  console.log(`UNCHANGED ${file}`);
  console.log(`SHA-256 ${actual}`);
}
