# Phase 4 reopened backend review

Review date: 2026-10-11. This review rechecked the current private API handlers after Phase 5. It changed no production code, runtime state, service, build output, or generated Prisma client.

## Route authorization evidence

The API wrappers under `apps/web/app/api` pass private requests to the shared handlers in `apps/web/lib/server/routes.ts` through `runtime.invoke`. The inventory contains session/logout, job terms, notes, evidence, file list/upload, file-ticket/content, timeline, and audit routes. `/api/config` is public configuration; the `dev` endpoints are a separate local-only surface.

The shared handler gates require a valid stored session for private reads. Writes additionally require the exact configured Origin and a session-bound CSRF token. Job and dispute permissions come from fresh chain-reader calls. File content reads validate the signed ticket and then recheck the current chain role. Denials use the same generic `404 {"error":{"code":"NOT_FOUND"}}` response.

I added [phase4-reopen-route-authorization.test.mjs](../apps/web/test/phase4-reopen-route-authorization.test.mjs) and froze its SHA-256 before running it in [phase4-reopen-route-authorization-frozen.json](phase4-reopen-route-authorization-frozen.json). The test initializes an isolated temporary SQLite database with `db push --skip-generate`, uses the already generated client, and seeds only synthetic fixture rows. It checks actual-versus-missing ID parity for job terms, evidence, notes, file lists, timeline, audit, download tickets, and content reads. The file checks include a real database row and a correctly signed outsider ticket, so the result does not rely only on a nonexistent file ID. It also checks Origin and CSRF denial on every private write handler.

Command run on Windows with `RUST_LOG=debug`:

```powershell
$env:RUST_LOG='debug'; node --experimental-strip-types --test --test-reporter=spec apps/web/test/phase4-reopen-route-authorization.test.mjs
```

Result: **13 passed, 0 failed**. The test removed its temporary database and storage directory. Prisma emitted only its existing module-type warning. No production database was opened, no generated client was changed, and no local process was started or stopped.

The existing `security-corrected.test.ts` was also run alone with `RUST_LOG=debug`: **17 passed, 0 failed**. That suite already covers SIWE nonce/session behavior, party and current-arbiter reads, job/evidence/file/note writes, upload validation, and request-rate limits. The new matrix adds exact denial parity for real file ticket/content records and checks CORS headers on the private-handler denials.

## CORS and live HTTP limits

No `Access-Control-Allow-*` behavior is configured in the API wrappers, shared runtime, or `next.config.ts`; the configured global headers are CSP, frame/content-type/referrer protections, and Permissions-Policy. The new test confirms that native private-handler denials emit neither `Access-Control-Allow-Origin` nor `Access-Control-Allow-Credentials`.

The existing [Phase 4 HTTP smoke artifact](phase4-http-security-smoke.txt) records 15 checks against a live local Next server. It includes one hostile-origin `OPTIONS` preflight, hostile and missing Origin rejection on the nonce endpoint, anonymous/private-ID hiding, selected job/evidence/file route checks, a ticket-bound content read, and upload rejection. It is prior captured evidence, not a run from this reopened review. A full live HTTP authorization and preflight matrix across every route was not rerun because the root task owns the active GUI/runtime. Therefore the current source and isolated-handler behavior are verified here, while live Next behavior remains represented by the narrower earlier smoke.

## Remaining policy boundary: unbound submission drafts

Party file authorization currently succeeds after `partyJob()` confirms that the caller is a client or freelancer. In that branch, `authorizeFile()` does not require the uploaded hash/reference to appear in the chain. `fileListGET()` labels such a row `bound: false`, but still returns it to both parties. The current UI labels it “Draft” and displays a Download button. The existing ticket/content test uploads a freelancer submission before any chain receipt, then confirms that the client can download and read it.

This is observed behavior, and a current GREEN test encodes it. The reviewed spec and locked decisions do not clearly say whether an uncommitted submission draft is shared with the counterparty. If drafts should stay freelancer-only until the on-chain submission matches the exact hash/reference, this is an authorization defect and the current expectation needs a spec decision plus a frozen RED test before any fix. If parties are intended to share drafts, the current behavior is consistent with that policy. This review does not select either interpretation.

## Backup boundary

The historical ignored `infra/local/runtime/phase5-migration-backup` contains `private.db` and `before.json`, but no `server-env.json`. The live runtime environment file has a later modification time than the backup. The current `scripts/phase5-evidence-migration.mjs` source includes a copy of `server-env.json`, but that source line does not prove the helper was exercised or restore the omitted historical key. The README and A55 already disclose that the old ciphertext backup cannot be recovered after the demo key rotation. A separate isolated helper-path verification is being handled by the build-gate task; this review did not read or print any key value.

## Conclusion and limits

No unauthenticated route access or CORS grant was reproduced in the current handler matrix. The remaining backend question is the intended visibility of unbound submission drafts. Existing live HTTP evidence covers selected endpoints only; it does not establish a full current route matrix or all-path CORS behavior. The historical backup-key loss remains a separate disclosed limitation, and future helper-copy behavior must be judged from the isolated helper test rather than inferred from source.

## 2026-10-11 superseding evidence note (A59/A55)

This dated note supersedes the unbound-draft policy question and pending-helper verification language above for the current reopen. The earlier review body remains intact as historical evidence.

A59 resolves the P-04 named-party draft boundary: the existing authorization intentionally lets both agreement parties read uploaded drafts before chain binding, while assigned arbiters still require a chain-bound current-case file. The final compiled local UI now displays a before-upload disclosure that drafts are shared with both parties. This confirms the disclosed product behavior; it does not change the route permissions or present drafts as chain-submitted work. The isolated 13-check route matrix remains evidence for generic outsider denial parity and private-write Origin/CSRF checks, not a complete live Next route matrix.

The historical A55 ciphertext backup remains unrecoverable because its old encryption key was not copied before the later demo key rotation. The future migration-helper path has now been exercised in an isolated temporary working directory: **1/1 test passed**, and the copied key decrypted the copied ciphertext row. See [the isolated proof](phase4-reopen-backup-key-proof.txt). This verifies future helper behavior only; it does not repair or recover the historical backup.
