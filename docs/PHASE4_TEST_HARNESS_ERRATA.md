# Frozen response-body assertion defect

The immutable `apps/web/test/security.test.ts` reads the same `audit` Response body twice in the F12 private-note test. Fetch Response bodies are one-shot; the second `audit.text()` throws `Body is unusable` before its no-private-content assertion can run. The intentional501 baseline stopped earlier, so this harness defect became visible only after implementation. Root and independent review missed the latent defect before freeze.

The original test and original RED log remain byte-identical. Its current run in `phase4-security-original-harness-error.txt` has15 passing cases and2 reported failures: the defective subtest and its parent aggregate. This is one invalid body-consumption assertion, not two separate backend failures.

`apps/web/test/security-corrected.test.ts` is a separate successor with exactly two replacements: `await audit.text()` becomes `await audit.clone().text()`. All expectations, fixtures, negative cases and other bytes are unchanged; each assertion now consumes its own clone. The original501 RED establishes the unchanged assertions' preimplementation failure. The correction is test-harness maintenance, not a new feature RED or weakened expectation.

The API returns normal one-shot Response objects. A briefly introduced replayable Response accommodation was rejected and removed; it is not part of the implementation. The corrected current suite passes17/17. The default application runner explicitly uses the corrected successor and preserves the original as immutable historical evidence; it does not claim the original suite passes.

## Retention job-zero test correction

The original frozen `scripts/phase4-retention.test.mjs` rejects `"0"` in its identifier vector and names the case `retention accepts only one positive decimal job ID`. That expectation conflicts with the escrow's zero-based `jobCount`: job ID zero is a real first job and must remain addressable for the documented retention rules. The additive real-SQLite regression in `scripts/phase4-retention-zero.test.mjs` failed before the parser correction and now passes.

The frozen original and its hash remain unchanged. `scripts/phase4-retention-corrected.test.mjs` is a separate successor with only two textual changes: remove `"0"` from the malformed-identifier vector and rename that test to `retention accepts only one nonnegative decimal job ID`. The separate additive regression tests due automatic deletion at the exact 90-day boundary, early deletion signed by the chain-named party for job zero, and rejection of malformed identifiers before any chain read. It runs against Prisma SQLite, not a stub database. The original currently has eight passing cases and one invalid failure, retained in `phase4-retention-original-harness-error.txt`; the corrected nine, three retention regressions, and one job-zero case pass. The tooling runner explicitly selects the successor. Historical earlier success does not prove job-zero support.

## Supplemental receipt-status coverage

`apps/web/test/phase4-ui-unknown-receipt.test.ts` is one additional green-only check for malformed receipt status. It was added after the A48 freeze and has no preimplementation RED claim. The four A48 regression cases do have the independent frozen RED in `phase4-ui-private-read-red-root.txt`; this supplemental case is counted separately within the final 81-test runner. No original frozen test was changed to obtain that result.
