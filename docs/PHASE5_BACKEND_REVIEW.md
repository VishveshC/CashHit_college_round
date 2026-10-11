# Phase 5 backend security review

Review date: 2026-10-11. This was a hostile, source-driven review of `HERO_PROMPT.md`, `spec.md`, `DECISIONS.md`, the API route wrappers, `apps/web/lib/server`, the Prisma schema, chain readers/pins, and `scripts/phase4-retention.mjs`. Production changes were made by the root task, not by this reviewer.

The review reproduced three concrete backend defects before fixes. The current working tree has fixes for all three and the focused frozen native-handler suites pass. The database identity change is verified against freshly provisioned temporary SQLite databases, and a separate synthetic old-index migration test preserved nonempty rows in an isolated database. Preservation of the existing owned local database during its schema migration remains root-owned and is not independently verified here.

## Findings and status

### Evidence saves collided on a public reference — fixed in the current working tree

Severity: P1, high availability/integrity risk for dispute evidence.

Before the fix, `PrivateEvidence` had `@@unique([disputeId, reference])` in `apps/web/prisma/schema.prisma`. The contract stores evidence separately under `dispute.evidence[actor]` and does not require opaque references to be unique across parties or across one party’s entries (`contracts/src/FairworkArbitration.sol:279-297`). A party can therefore submit a valid entry with a reference already used by the other party, or reuse its own reference with a different commitment. Since references and commitments are public, a hostile counterparty can observe a pending reference and submit its own evidence using it.

The route verified the exact dispute, party, commitment, and reference, then inserted by the too-narrow key. The first private save succeeded; the second hit the SQLite uniqueness constraint and became a generic 404. The chain retained both hashes, but the second party’s plaintext and salt were never stored, so an assigned arbiter could not open that evidence. The same failure made a retry after a successful write but lost response return 404.

The pre-fix proofs are frozen in `scripts/phase5-backend-evidence-reference-collision.test.mjs` and `scripts/phase5-backend-evidence-idempotency.test.mjs`. The latter reproduced the cross-party collision, same-party/different-commitment collision, and non-idempotent exact retry; its arbiter and outsider denial checks passed. The current schema key is `(disputeId, partyWallet, reference, evidenceHash)`, and `evidencePOST` upserts that exact identity, returning the existing row ID on retry. Both suites pass after the change. This matches A-55 in `DECISIONS.md:256` and A-38’s requirement to preserve private records for authorized on-chain commitments.

### Receipt-bound evidence could not be saved after the action window — fixed

Severity: P1, because a valid chain commitment could become permanently unreadable to the assigned arbiter.

Before A-50, `evidencePOST` rejected any write unless the current dispute remained in the evidence phase and before the current deadline. A party who had already committed a valid evidence hash on chain could lose its local follow-up if confirmation arrived after the phase advanced or settlement completed. The chain held only the hash/reference; the private plaintext and salt were stranded in the browser.

`evidencePOST` now permits recovery after the window only for a freshly authenticated party and an exact fresh chain event matching dispute, party, hash and reference with a valid `submittedAt` strictly earlier than the original evidence deadline (`apps/web/lib/server/routes.ts:480-510`). Missing timestamps, the exact deadline, unrelated commitments, wrong parties, arbiters and strangers remain denied. The frozen pre-fix log is `docs/phase5-backend-evidence-red-confirmed.txt`; the current receipt suite passes 5/5 with isolated SQLite. A-50 records the intended boundary in `DECISIONS.md:235-237`.

### Active PDF uploads were accepted — fixed with a bounded filter

Severity: P2, because an authorized party could store active document content for another authorized recipient to download and open.

Before A-51, a PDF beginning with `%PDF-` was accepted without checking its contents. A valid PDF fixture with automatic JavaScript action names was accepted by the upload handler. `apps/web/lib/server/routes.ts:618-632` now requires a terminal `%%EOF`, decodes PDF `#HH` name escapes, and rejects selected action, form, embedded-content, object-stream and encryption names. The upload regression suite covers ordinary passive PDF support, encoded and direct active names, `/ObjStm`, and `/Encrypt`; it passes 6/6. The separate malformed-header test reproduces a `%PDF-` prefix followed by arbitrary text with no structure or EOF; it returned 200 before the EOF check and now passes its 400 expectation. A-51 and its scope are recorded at `DECISIONS.md:239-244`.

This is a bounded filter, not a PDF parser, sanitizer or malware scanner. The current check does not validate xref tables, object graphs, stream contents, image structure or full PDF syntax. A malformed or active construct hidden in a form this filter does not recognize may still pass; that behavior was not exhaustively tested. The required EOF marker only rejects the minimal prefix-only malformed fixture. PNG and JPEG validation remains magic-byte based. These are accepted local-subset limitations under A-51, and the implementation must not be described as rejecting all malformed files or as malware-safe.

## Other surfaces reviewed

- **SIWE and sessions:** inspected one-use persisted nonces, challenge/session cookies, signer/domain/URI/chain/expiry checks, server-side session lookup, logout revocation, and CSRF/origin gates. Existing `apps/web/test/security-corrected.test.ts` covers nonce reuse and expiry, cross-account 404 behavior, role changes, CSRF and rate limiting. Cookie-order regressions are in `apps/web/test/security-cookie-order.test.ts`. I did not rerun the full pre-existing web suite in this audit.
- **Authorization and current arbiter isolation:** inspected fresh `readJobAccess`/`readDisputeAccess` calls and the per-route party/current-arbiter checks for job terms, notes, evidence, files, audit and timeline. Existing tests cover cross-account denials, current versus previous/settled arbiters, and read-only arbiter access. The new evidence-identity suite also verifies current arbiters and outsiders still receive 404.
- **Commitments, files and tickets:** inspected typed ABI encoding in `privateCommitment`, exact event binding, AES-256-GCM context, one-megabyte limits, extension/name checks, storage outside the web root, HMAC tickets bound to session/file/wallet/expiry, and fresh authorization at file-content read. No server-side URL fetch path was found. The PDF and malformed-content limits above remain material.
- **Audit and chain trust:** access records are written before private responses are returned. Runtime configuration pins the app to local chain 31337 and `http://127.0.0.1:8545`, and deployment verification checks configured code. The native-handler tests inject a chain reader; they do not simulate compromised or inconsistent JSON-RPC responses, reorgs, or a live local HTTP request through Next.js.
- **Retention:** reviewed the 90-day chain-close gate, named-party signed deletion, path and symlink boundary checks, storage-file identity checks, and database deletion transaction. This review did not execute a concurrent upload/purge race test. The isolated migration test below does not prove preservation of the owned runtime database; root owns that migration and its backup/preservation check. Those limits remain unverified; no retention race is reported as a confirmed defect.

## Verification and limits

All new behavior tests use native route handlers and isolated real SQLite databases; no production database was reset or modified by these tests. With `RUST_LOG=debug` inherited by Prisma on Windows, the five frozen focused suites pass: evidence recovery 5/5, passive-PDF policy 6/6, malformed-PDF rejection 2/2, shared-reference isolation 2/2, and evidence identity/idempotency 5/5 (20 tests total). The no-`RUST_LOG` attempt failed during Prisma schema setup before assertions; it is not counted as a behavior result.

The pre-fix failures and post-fix evidence are indexed by `docs/phase5-backend-aggregate-frozen-manifest.json`. That compatible manifest also preserves the original test-manifest metadata; the older `docs/phase5-backend-frozen-tests.json` was left unchanged. The full application route matrix, public HTTP/CORS behavior, adversarial RPC behavior, and concurrent retention behavior were not executed here, so this review does not claim those surfaces fully verified.

As a GREEN supplemental check, `scripts/phase5-evidence-migration-preservation.test.mjs` built an isolated temporary SQLite database with the old `@@unique([disputeId, reference])` index, inserted two nonempty evidence rows, then applied the current schema with Prisma `db push --skip-generate --accept-data-loss`. The test verified both row IDs and SHA-256 digests over every scalar plus the ciphertext, IV, and authentication-tag bytes were unchanged. It then stored two rows sharing the same reference across parties and a different commitment, and confirmed an exact-identity upsert retry returned the original row ID. This is synthetic migration evidence only; it does not touch or replace root’s check of the owned database.
