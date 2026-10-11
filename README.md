# Fairwork v3 — local milestone escrow

Hackathon prototype coding is complete for the implemented Tier A flow: create, accept, fund, submit, revise, approve, dispute, settle and withdraw. Fresh checks on 2026-10-11 passed 122 contract, 105 web, 24 tooling and 21 backend tests. The GitHub source is published on `main`; historical reports below retain their original no-push/no-deployment status. Exhaustive UI acceptance and production release requirements remain open.

The temporary VM demo was taken offline on 2026-10-11 at the user's request. Its service, synthetic chain, deployment files and tools have been removed. See [deployment history](docs/TEMPORARY_VM_DEMO.md). Production release remains blocked.

Reopened local Phase4 evidence is in [PHASE4_REOPEN_REPORT.md](docs/PHASE4_REOPEN_REPORT.md). Settled disputes show event-derived payouts and readable fallback reasons; agreement creation clears previous private files before showing the new job. Fresh local browser/chain proofs cover USDC, eight-decimal WBTC, revisions, both arbitration rounds, bounded fallback and scoped owner registry management. The registry browser run added and removed one synthetic wallet (6→7→6) without changing any of 32 recorded panels. Its receipts are from blocks 528–529; the 107-transaction/488-reference proof at block 657 was captured after a different fresh reset, while the latest reset is at head 534. Public release remains blocked; isolated artifact-test packaging is not a production deployment.

Phase 5 independent adversarial review is complete, with fixes and current evidence. **Release remains blocked.** This is an Anvil chain-31337 prototype with mock USDC/WBTC and mock randomness: no public deployment, real funds, or professional audit. Three GPT-6 Luna Max reviewers inspected contracts, backend and UI/release behavior. Earlier README snapshots are preserved in `docs/PHASE0_3_README.md` and `docs/PHASE4_README.md`.

Implemented local scope: direct private agreements, freelancer acceptance, exact funding, bounded milestones/revisions, submissions/rejections, deadline exits, disputed settlement through commit/reveal panels and bounded fallback, and pull withdrawals. SIWE protects encrypted private terms, notes, evidence and file downloads. Party/current-arbiter access uses fresh pinned chain state. Roles, raw amounts, deadlines and signing confirmations are displayed. No public job directory or personal identity collection is required.

Phase 5 fixes recover timely committed evidence after its deadline, make private evidence saves idempotent without reference collisions, restrict PDFs to a bounded passive subset, clear private drafts at wallet/session boundaries and across active tabs, revalidate signing context, distinguish unknown receipt outcomes, and show actual proposal terms beside their hashes. Financial contract sources are unchanged; 13 frozen supplemental tests add boundary/bounded-exit proof.

## Setup and verification

Use Node 24.11.1/npm 11.19.0 and pinned tooling in `docs/phase5-tool-versions.txt`; provision Foundry/Slither as documented in earlier setup reports. From this repository:

```powershell
npm ci
npm run setup:contracts
npm run compile
npm run test:contracts
npm run test:web
npm run test:phase4:tooling
npm run test:phase5:backend
npm run demo:reset
npm run dev:web
```

Open `http://localhost:3000`. Select a seeded role, sign the local SIWE confirmation, and open a printed job ID. No real-wallet/private-key import is needed. Reset erases only the marked owned demo database/storage and chain: copy wanted local data first. Generated runtime credentials remain in ignored server storage. `npm run demo:stop` stops the owned development web/chain.

For an optimized local artifact, stop the web writer and run `npm run build:web:local`. `npm run build:public` refuses before compilation; this does **not** prove a clean production artifact. `node scripts/phase5-preview.mjs` starts a compiled verification preview with its separate `phase5-preview-owner.json` record. It is not the development server managed by `demo:stop`; final Phase 5 cleanup stops it separately.

## Current evidence

| Check | Actual result | Evidence |
|---|---|---|
| Contracts, fuzz/invariants | 122 passed, 16 suites | `docs/phase5-contract-tests-final.txt` |
| Web | 105 passed in the latest reopened suite; Phase 5 handoff was 89 | `docs/phase4-reopen-registry-standalone-tests.txt`, `docs/phase5-web-tests-final.txt` |
| Tooling | 22 passed | `docs/phase5-tooling-final.txt` |
| New backend checks | 21 reported tests passed, including parent aggregates and supplemental nonempty migration proof | `docs/phase5-backend-all-final.txt` |
| Optimized local build/output trace | Passed; dynamic tracing warning retained | `docs/phase5-web-build-final.txt`, `docs/phase5-web-trace-final.txt` |
| Coverage | Escrow lines 99.33%, arbitration 99.09%; total 83.27%; branches 86.67%/74.77% | `docs/phase5-coverage-final.txt` |
| Slither | 53 occurrences / 40 unique findings; same findings as Phase 3, documented dispositions | `docs/phase5-slither-final.*.json`, `docs/PHASE5_RELEASE_CHECKLIST.md` |
| Dependency audit | 0 vulnerabilities | `docs/phase5-dependency-audit-final.txt` |
| Attack Lab | 19 contract tests, 17 security tests, 5 deployed attacks rejected/reverted | `docs/phase5-attack-lab-*.txt` |
| Reset repeatability | Two actual resets; scenario passed in 71.892 seconds | `docs/phase5-demo-repeatability-final.txt` |
| Receipt verification | 488 unique references, 0 duplicates, 5 attack reverts; head 532 | `docs/phase5-receipt-verification.json` |
| Live HTTP | 15 passed | `docs/phase5-http-final.txt` |
| ZAP passive scan | 18 URLs, 11 alerts: 0 High, 9 Medium, 0 Low, 2 Informational | `docs/PHASE5_ZAP_DISPOSITIONS.md` |
| Browser corrections | Cross-tab invalidation, wallet-switch draft clearing, readable confirmation | `docs/phase5-browser-*-green.txt`, screenshots |
| F-45 registry UI | Scoped PASS: owner add/remove confirmed, 6→7→6, all 32 recorded panels unchanged; non-owner controls disabled. Mobile view visually reviewed at 375px (document 360px, no captured console warnings/errors). | `docs/phase4-reopen-registry-browser.txt`, `docs/phase4-reopen-registry-chain-proof.json`, `docs/phase4-reopen-registry-mobile.png` |
| Reopened owned services | Web and chain stopped; no listeners on 3000/8545/8080 | `docs/phase4-reopen-registry-services-stopped.txt` |

Secret scans and frozen integrity evidence are linked in `docs/PHASE5_REPORT.md`. Git has zero commits, so there is no historical commit corpus to scan. Frozen original harness defects are preserved with separate corrected successors, documented in both harness-errata reports.

## Limitations and deployment status

Full Tier A UI acceptance, complete individual requirement proof and 100% transition instrumentation are unverified. Coverage has missing-anchor warnings. Earlier Phase 4 payment/arbitration flows remain historical snapshots; the reopened jobs26–37 and registry traces are later scoped evidence, not completion of every UI row. Targeted Phase 5 browser checks preceded the final SIWE/session-context supplemental hardening and Ready state-label correction; the final artifact also receives a fresh smoke inspection.

Tier B offers/listings/amendments/chat and other expanded features are omitted. Production randomness, vetted arbiters, HTTPS/HSTS/CSP hardening, encrypted operational backups and the human-recorded backup video remain absent/incomplete. PDFs use conservative header/EOF/name checks rather than a parser or malware scanner; PDF object graphs and PNG/JPEG structures are not fully validated. Server outages can block private access; hostile token issuers can block withdrawal.

Unknown receipt recovery/send blocking are in-memory and per-view. Reloads, other tabs, and send-response loss before a returned hash remain limitations. Changing wallet/session erases private drafts and follow-ups; a confirmed proposal's plaintext cannot be reconstructed from commitments unless separately retained. Suspended tabs or missing BroadcastChannel prevent immediate cross-tab clearing.

The owned DB migration preserved all seven table counts/digests (`docs/phase5-evidence-migration-proof.json`). A separate isolated migration preserves two nonempty evidence rows. The executed backup omitted the old encryption key, so later reset prevents decrypting its ciphertext; future helper key copying is unexercised. This is not a production backup. Public deployments/history entries are zero; no commit/push occurred. See `docs/PHASE5_REPORT.md`, `docs/PHASE5_RELEASE_CHECKLIST.md`, `REQUIREMENTS_TRACE.md`, `DECISIONS.md`, `PROGRESS.md`, `docs/GAPS.md`, `docs/DEMO_SCRIPT.md`, `docs/BACKUP_VIDEO_SHOT_LIST.md`, and `docs/JUDGE_QA.md`.

