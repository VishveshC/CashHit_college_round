# Fairwork v3 — local milestone escrow

Fairwork is a chain31337 prototype for two parties agreeing on milestones, locking approved demo tokens, delivering work, reviewing it and withdrawing rightful claims. Its bounded dispute process selects panels, accepts domain-bound commit/reveal votes and ends with a ruling or defined fallback. Settlement credits a claim; the wallet still needs to withdraw before tokens leave escrow.

Phase 4's local implementation and automated verification are recorded in `REQUIREMENTS_TRACE.md` and the evidence files under `docs/`. The complete rendered browser walkthrough remains **UNVERIFIED**. This prototype is local-only: public build/artifact generation fails closed; there are zero public deployments and zero deployment-history entries. Historical README content is preserved in `docs/PHASE0_3_README.md` and earlier phase reports.

## Local scope

- Job creation, acceptance, funding/cancellation, milestone submission/revision/rejection/approval and timeout exits.
- Exact dispute deposits, capped evidence, panel selection, votes, replacement, fresh second panel and fallback.
- Wallet/network checks, role-aware actions, human-readable confirmations, exact token allowance, receipt tracking and chain refetch.
- SIWE sessions, fresh private authorization, encrypted terms/reasons/evidence/files, authenticated downloads and source-labelled audit events.
- Owned local reset/seed, throwaway role switching, bounded clock/mock controls, Attack Lab and eligible private-content retention.

MockUSDC uses6 decimals and MockWBTC uses8; both are freely mintable demo tokens. Calculations use integer raw units. Locked principal, claimable and already-withdrawn tokens are distinct; the wallet ledger is per token, not exclusive to the displayed job.

## Start and stop

Use the pinned Node24.11.1/npm11.19.0 environment and lockfile. Foundry1.8.5 and native Solidity0.8.36 are required; OpenZeppelin5.6.1 and forge-std1.17.0 are pinned. `npm run tool:versions` reports actual versions and missing tools.

```powershell
npm ci
npm run setup:contracts
npm run compile:forge
npm run demo:reset
npm run dev:web
```

Open **http://localhost:3000**, select a printed demo role, sign in and load one printed job ID. There is no private-job listing/search endpoint. Services bind127.0.0.1; SIWE and cookie origin are localhost:3000.

Reset replaces only the marked, ignored runtime and its identity-checked owned processes. It refuses an unowned directory, junction/symlink parent or unrelated listener. It rotates secrets and erases the prior demo database/files; never put user documents in `infra/local/runtime`. Secrets are generated in ignored `server-env.json`, never client config. UI signing uses unlocked throwaway Anvil accounts without private keys in the browser. The roles have no real funds or verified identities.

```powershell
npm run demo:stop
```

Only owned local processes stop. These commands do not commit, push or deploy publicly.

## Verify

```powershell
npm run test:contracts
npm run test:web
npm run test:phase4:tooling
node --test scripts/phase4/test/acceptance-proof.test.mjs scripts/phase4/test/demo.test.mjs
npm run build:web:local
npm run attack-lab
npm run scan:secrets
node --test scripts/phase4-secret-allowlist.test.mjs scripts/phase4-secret-fixture-scope.test.mjs
npm audit --audit-level=high
```

Saved local results: contracts 109/109 across 14 suites (`docs/phase4-contract-regression.txt`); the initial web run 68/68, the post-A46 run 71/71, and the current recovery run 81/81 (`docs/phase4-web-tests-recovery-final.txt`); tooling 22/22 (`docs/phase4-tooling-recovery-final.txt`); and the one-scenario demo repeatability test passed after two resets in 70.311 seconds (`docs/phase4-demo-repeatability-green-final.txt`). A47/A48 receipt recovery, stale private-read guards, exact evidence retries, staged-file binding and fresh-ledger handling are implemented. The separate unknown-receipt test is supplemental green-only evidence; no pre-fix RED is claimed for that assertion. The chain demo seeds Ready, Submitted, Rejected, Disputed and Closed jobs. Acceptance IDs 1 and 3–11 have fresh local-chain evidence; 2 and 12 are not applicable. The post-WBTC RPC check matched all 488 unique acceptance receipts at head block 563, with five Attack Lab reverts verified (`docs/phase4-receipts-final-post-wbtc32.txt`, `docs/phase4-receipt-verification.json`).

The final local web build after the browser label correction passed with exit code 0, as did the private-runtime trace exclusion test (`docs/phase4-web-build-recovery-final.txt`, `docs/phase4-web-trace-recovery-final.txt`). The build log retains a Turbopack whole-project tracing warning for dynamic filesystem access. Fifteen live localhost HTTP security checks pass (`docs/phase4-http-security-smoke.txt`). ZAP's unauthenticated passive scan covered 45 local URLs and recorded 102 alert occurrences, including 27 Medium findings; all six finding types are dispositioned, but this scan is not an active or authenticated penetration test (`docs/PHASE4_ZAP_DISPOSITIONS.md`).

Compiled-browser proof for job 31 covers one client/freelancer agreement path: create, accept, exact 2,500,001-raw-unit USDC approval and funding, text upload, client-authorized download with matching SHA-256, client approval, and freelancer withdrawal. All seven receipts succeeded; the job closed, the milestone released, claimable returned to zero, freelancer withdrawal increased by exactly 2,500,001 raw units, and allowance after funding is zero. The literal script-markup description rendered as text. A second browser path exercised job 29/dispute 16: one original arbiter was replaced; two retained original panel members revealed 5,000 bps each; the ruling settled at 5,000 bps in phase 10 without fallback and closed the job. The verified receipts and assertions are in `docs/phase4-browser-job29-dispute16-proof.json`. Screenshots show private evidence before resolution and its removal after the dispute closes (`docs/phase4-browser-arbiter-evidence.jpg`, `docs/phase4-browser-arbitration-settled.jpg`). A third scoped path exercised job 32 with WBTC: the UI showed its 8-decimal token label; the client approved/funded exactly 2,501 raw units; the freelancer submitted, the client downloaded bytes matching SHA-256, approved, and the freelancer withdrew. All seven receipts succeeded; final job/milestone states are Closed/Released, claimable and allowance are zero, and freelancer withdrawn increased by 2,501 raw units. Role-specific wallet balances updated without manual refresh (`docs/phase4-browser-wbtc-chain-proof.json`, `docs/phase4-browser-wbtc-download-proof.txt`). These are three scoped flows, not complete UI acceptance.

The demo test resets twice: run it before a browser walkthrough. Attack Lab needs a completed reset. Its controlled-chain API tests are separate from live HTTP and browser evidence. `npm run build:public`, the web default build and direct Next configuration fail closed: no production randomness adapter or public artifact exists. The automated checks do not prove every rendered screen or transaction flow; full Tier A browser acceptance is **UNVERIFIED**. A47/A48 implement targeted receipt recovery, exact evidence tuple retries, staged-file binding, wallet-specific fresh-ledger display and stale private-response guards; the current web suite passes 81/81. The separate unknown-receipt test is supplemental green-only evidence without a captured pre-fix RED. Browser checks confirm job 0 loads at 375px with no horizontal overflow; A46 fixes the cookie parsing defect. Job 32's WBTC label and role-ledger changes are now evidenced in the scoped browser proof above; they do not imply full Tier A acceptance.

The contracts' Phase4 regression passes 109/109 tests in 14 suites. Phase3 coverage maps escrow 99.33% lines/86.67% branches and engine 99.09%/74.77%; missing-anchor warnings prevent a completeness claim. Slither has 53 dispositioned target occurrences /40 unique IDs, not zero findings. Read `docs/PHASE3_COVERAGE.md` and `docs/PHASE3_STATIC_ANALYSIS.md` for actual logs and limits.

## Privacy and retention

No real name, phone or email is required. Chain addresses, hashes and events are public/permanent. Short private text uses independent random salts. Private content/files use server-side AES256GCM at rest; this is **not end-to-end encryption**. The server and authorized recipients can read and retain copies.

Every private request rechecks the specific chain role. Parties retain reads after closure; arbiters require the particular unresolved case and lose access at resolution. Files require an exact raw hash/reference match to that case; uploads begin as drafts. HTML/SVG and unsafe file metadata are rejected. Content checks and attachment-only downloads do not constitute a malware-scanning guarantee.

```powershell
node scripts/phase4-retention.mjs <jobId>
node scripts/phase4-retention.mjs <jobId> --request <signed-request.json>
```

Automatic purge requires chain-confirmed Closed state plus90days. Earlier Closed-job deletion requires a fresh party signature bound to origin/chain/escrow/job/intent; a caller wallet field grants no authority. Active jobs remain. Either party may request deletion of shared eligible content; append-only non-content audit metadata and immutable chain history remain. The script documents its canonical signing text.

## Architecture and limitations

Read `docs/PHASE4_ARCHITECTURE.md`, `docs/PHASE4_API.md`, `REQUIREMENTS_TRACE.md`, `DECISIONS.md` and `spec.md`. `docs/PHASE3_MONEY_REVIEW.md` explains payout paths. Actual judge answers and backup-video steps belong in the linked docs; a shot list is not a recording.

Mock randomness is deterministic and publicly controllable for demonstrations. Local dispute windows share the funding duration. Production randomness/retries, timing, pool minimums and configuration remain unresolved. Registry mechanics do not prove identity vetting. Token issuer freezes/runtime drift can block withdrawal while preserving a backed claim. Finite fuzz/invariants are not exhaustive proofs; liveness requires someone to invoke timeout/advance.

Browser checks confirm job 0 loads at a 375px viewport without horizontal overflow. A46 resolved the SIWE cookie parsing defect. A47/A48 are implemented; the current 81-test web gate and final local build/trace checks are recorded above. The scoped job 31 payment, job 29 dispute, and job 32 WBTC flows do not establish full Tier A browser acceptance, which remains **UNVERIFIED**. Public HTTPS/HSTS and production CSP are unverified; local CSP permits inline/eval scripts required by this development environment. Encrypted backup operations and client-side key exchange/recovery are absent. No public/mainnet funds, professional audit or release readiness is claimed.

Tier B offers, listings, chat, bans, amendments and stake/salary/slashing, and Tier C appeals are absent. The originally referenced PDF/spec is unavailable. Public randomness, HTTPS/HSTS and public CSP hardening, encrypted backups, and verified arbiter identities remain unresolved. F-74's backup video is human-owned and has not been recorded. Phase 5's independent adversarial review remains mandatory before submission; no professional audit or release readiness is claimed.

Final source scanning initially flagged five public deployed asset-address fields in the browser receipt proofs. A49 preserves those findings and exempts only the exact two proof paths AND whole-line fields with the two exact addresses, for generic-api-key only. The three immutable public-address assertions in the frozen scanner test receive a separate exact-path/whole-line exemption. Six frozen scanner-boundary cases pass; an unrelated path or secret-like value still fails. The built-client scan has no allowlist. See docs/PHASE4_SECRET_SCAN_DISPOSITIONS.md and docs/phase4-secret-boundaries-green-final.txt.
