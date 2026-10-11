# 1. Plain-English summary

Fairwork now has a local wallet interface, encrypted private terms and files, current-case arbiter access, event and access ledgers, and a deterministic local demo.
The server checks fresh contract roles before private reads and writes. Signing in does not authorize a token transfer.
Transactions show their consequences, wait for a successful receipt, and refresh contract state. Withdrawable credit is separate from money transferred to a wallet.
The demo exercises the applicable acceptance scenarios on a freshly deployed local chain; Attack Lab checks hostile contracts, private routes, and deployed attacks.
No real funds or public deployment are involved. The full release checklist and independent adversarial review belong to Phase 5.
The compiled browser completed exact-payment agreements in six-decimal USDC and eight-decimal WBTC, plus a two-vote dispute with a missing arbiter and replacement timeout. Wallet changes now refresh the new wallet's ledger automatically. Receipt recovery, private-response generations and conservative evidence retries have regression coverage.

# 2. State diagram sync

The contract states and transitions are unchanged from [Phase 3](PHASE3_STATE_MACHINE.md) and [Phase 2](PHASE2_STATE_MACHINE.md). Source hashes are compared against the Phase 3 snapshot in [contract source integrity](phase4-contract-source-integrity.txt).
The new authentication, fresh authorization, revocation, storage and ledger diagrams are in [PHASE4_ARCHITECTURE.md](PHASE4_ARCHITECTURE.md). Terms reads include a current assigned arbiter on this job's unresolved case; files and evidence remain bound to that arbiter's specific case. No new financial state is introduced by the web server.

# 3. How to verify without reading Solidity

1. From the repository root, run `npm ci`, then `npm run demo:reset`. Expect an owned loopback Anvil, chain 31337, public addresses and roles, deployment code hashes, and Ready/Submitted/Rejected/Disputed/Closed seed IDs. This resets only the checked, owned local demo runtime.
2. Run `npm run dev:web` and open `http://localhost:3000`. Select Client and sign in after reviewing the SIWE summary. Expect a private session lasting at most 30 minutes; no token transfer occurs.
3. Follow [the click-through demo](DEMO_SCRIPT.md): create a private agreement, select Freelancer to accept, Client to approve the exact allowance and fund, Freelancer to upload a delivery, then Client to approve. Expect each action to show a summary and a mined receipt; settlement credits a claim rather than transferring tokens immediately.
4. Select Freelancer and withdraw. Expect the claimable amount to decrease and the wallet/token withdrawn total to increase only after the transfer receipt. Open agreement ID `0` to verify the first agreement is addressable.
5. Follow the disputed-case steps in the demo script. Expect current assigned arbiters to read criteria and committed case files; previous or settled panels receive generic 404s. Save local vote salts before changing roles.
6. Run `npm run test:contracts`, `npm run test:web`, and `npm run test:phase4:tooling`. Expect the current counts in section 4. Run `npm run build:web:local`, then `node --test scripts/web-trace.test.mjs`: expect a local build and no private runtime path in actual output traces. With the installed Gitleaks binary, run `node --test scripts/phase4-secret-allowlist.test.mjs scripts/phase4-secret-fixture-scope.test.mjs`: expect all six scanner-boundary cases to pass.
7. Run `npm run attack-lab`, then `node scripts/phase4/verify-receipts.mjs`. Expect all three attack stages to pass, five deployed reverts, and every recorded acceptance receipt verified on chain.
8. Run `npm run build:public`. Expect a deliberate nonzero exit before compilation: public release is blocked. This does not create or prove a clean production artifact. Finish with `npm run demo:stop`.

# 4. Evidence

Actual output files, not example output:

| Check | Observed result | Evidence |
|---|---|---|
| Contract regressions, fuzz and invariant suites | 109 passed, 0 failed, 0 skipped; 14 suites | [current run](phase4-contract-regression.txt) |
| Application tests | 81 passed, 0 failed, 0 skipped | [final run](phase4-web-tests-recovery-final.txt) |
| Runtime/build/retention/acceptance tooling | 22 passed, 0 failed | [current run](phase4-tooling-recovery-final.txt) |
| Two actual reset/deploy/seed runs | 1 repeatability test passed; 70.311 seconds; identical deterministic outputs | [raw final run](phase4-demo-repeatability-green-final.txt) |
| Local Next compile and TypeScript | exit 0, including the final submission-draft metadata correction | [actual final build](phase4-web-build-recovery-final.txt) |
| Public build gate | expected exit 1 before compilation; no public artifact created | [actual denial](phase4-public-build-denied-final.txt) |
| Private runtime excluded from actual Next output traces | 1 passed | [final artifact check](phase4-web-trace-recovery-final.txt) |
| Live HTTP security | 15 passed on the post-A48 compiled preview; previous dev and compiled runs retained | [final HTTP run](phase4-http-recovery-final.txt), [dev](phase4-http-security-smoke.txt) |
| Settled arbiter HTTP revocation | retained original arbiter 6 and replaced original arbiter 4: fresh SIWE; settled evidence 404 exactly matches missing evidence 404 | [actual HTTP results](phase4-http-settled-arbiter-final.txt) |
| Attack Lab | all three stages pass; hostile contracts, isolated real SQLite/signatures, deployed local reverts | [aggregate](phase4-attack-lab-final.txt) and its three referenced raw outputs |
| Acceptance receipt verification | at final chain head 563: 488 unique receipts verified; zero duplicate references; applicable IDs 1,3,4,5,6,7,8,9,10,11; five attack reverts | [final verifier](phase4-receipts-final-post-wbtc32.txt), [report](phase4-receipt-verification.json), [full assertions](phase4-demo-result.json) |
| Compiled-browser USDC agreement 31 | seven successful receipts; exact 2,500,001 raw-unit allowance/funding/withdrawal; downloaded bytes match; Closed/Released, zero claimable and allowance after funding | [live chain proof](phase4-browser-payment-chain-proof.json), [download hash](phase4-browser-download-proof.txt), [withdrawn screen](phase4-browser-withdrawn.jpg) |
| Compiled-browser dispute 16, agreement 29 | two original 5000-bps reveals; one missing arbiter replaced, replacement silent; ruling 5000 without fallback; Closed/Resolved; private evidence disappears for settled arbiter | [public chain proof](phase4-browser-job29-dispute16-proof.json), [authorized evidence view](phase4-browser-arbiter-evidence.jpg), [settled view](phase4-browser-arbitration-settled.jpg) |
| Compiled-browser WBTC agreement 32 | seven successful receipts; exact 2,501 raw-unit allowance/funding/withdrawal; download hash matches; Closed/Released; zero claimable and allowance; automatic wallet-specific ledgers | [live chain proof](phase4-browser-wbtc-chain-proof.json), [download hash](phase4-browser-wbtc-download-proof.txt), [final compiled screen](phase4-browser-final-proof.jpg), [mobile screen](phase4-browser-wbtc-mobile-final.jpg) |
| Dependency audit | zero vulnerabilities reported for the locked dependencies | [audit](phase4-dependency-audit.txt) |
| Actual passive ZAP baseline | 45 URLs; 102 alert occurrences: 0 High, 27 Medium, 2 Low, 73 Informational | [raw output](phase4-zap-baseline.txt), [JSON](phase4-zap-baseline.json), [every alert disposition](PHASE4_ZAP_DISPOSITIONS.md) |
| Current runtime secret canaries in actual built client | zero matches | [canary results](phase4-client-canary-scan.json) |
| Built client Gitleaks | zero leaks reported across 1,682,537 bytes, with default rules and no allowlist | [final output](phase4-client-gitleaks-final.txt) |
| Source Gitleaks | initial five public contract-address false positives retained; exact rule/path/whole-line exemption; final scan output retained | [final output](phase4-secret-source-final.txt), [all dispositions](PHASE4_SECRET_SCAN_DISPOSITIONS.md) |
| Scanner exemption boundaries | 6 passed; unrelated paths and secret-like replacement values still fail scanning | [final GREEN](phase4-secret-boundaries-green-final.txt), [proof-field RED](phase4-secret-allowlist-red.txt), [source-fixture RED](phase4-secret-fixture-scope-red.txt) |
| Frozen-test integrity | 31 manifests and 81 unique frozen files verified unchanged | [integrity check](phase4-frozen-integrity-final.txt) |
| Owned service cleanup | compiled preview, local web and chain stopped; no listeners on 3000, 8545 or 8080 | [actual stop and listener check](phase4-services-stopped-final.txt) |
| Git history | zero commits; history scan unavailable | [actual count](phase4-git-history-count-final.txt) |

Coverage and Slither were not rerun because the four financial/randomness sources are byte-identical. Retained [coverage output](phase3-coverage-final.txt) reports escrow lines 99.33%, branches 86.67%; arbitration lines 99.09%, branches 74.77%; total including dependencies/harnesses 83.27% lines. These percentages do not prove complete transition coverage. Retained [Slither output](phase3-slither-final.txt) and [Phase 3 finding dispositions](PHASE3_STATIC_ANALYSIS.md) cover 53 target occurrences, 40 unique finding IDs; findings are documented rather than represented as zero findings.

[REQUIREMENTS_TRACE.md](../REQUIREMENTS_TRACE.md) lists implementations and named tests for Tier A IDs and explicitly identifies missing proof. Representative new proof names are `F61 fresh deployment validation accepts only matching chain and all3 runtime codehashes`, `P04 evidence attachment separately binds raw file and salted text using two slots`, `F31 text evidence alone consumes one slot; full party evidence cap denies another`, `W25 devRPC blocks external targets native value and unlimited approval`, the W-01 SIWE/replay/expiry cases, current assigned arbiter criteria/read-only/revocation cases, job-zero authorization and retention cases, and `applicable acceptance evidence is produced by fresh local-chain scenarios`. F-50/F-51, F-60 through F-64 and F-70 through F-73 are implemented with the scope and proof limits shown there; no untested ID is silently declared proven.

The original frozen security and retention harnesses contain two disclosed assertion defects. Originals and their RED logs remain immutable; narrowly corrected successors run explicitly. [Harness errata](PHASE4_TEST_HARNESS_ERRATA.md) explains the exact changes and the original current failures, plus one supplemental malformed-receipt test added green-only without a RED claim. A47's five cases and A48's four cases have their own frozen preimplementation failures. Earlier unsuccessful reset/build attempts remain retained, including [the corrected TypeScript failure](phase4-web-build-recovery-typecheck-failure.txt); successful final outputs above supersede them.

# 5. Unverified items, assumptions and residual risks

- Full Tier A execution from the browser, every transition's exact boundary/illegal-path coverage, and the independent hostile review are not proven by a build or aggregate test count. The [trace](../REQUIREMENTS_TRACE.md) and [gap register](GAPS.md) retain their exact unresolved items. Phase 5 is mandatory.
- There is no public/mainnet/testnet deployment or production artifact. The production randomness adapter/configuration, identity/Sybil resistance, HTTPS/HSTS and a production CSP/rate-limit architecture remain absent. Demo RPC, deterministic mock entropy and unlocked throwaway wallets are local only.
- ZAP was an unauthenticated traditional spider plus passive scan, not an active exploit test or authenticated private-UI scan. The 27 Medium CSP alerts are accepted only for the blocked-public local prototype. Two Low timestamp alerts are dependency constants; 73 Informational occurrences are individually grouped and explained in the disposition file. This is not a professional security audit.
- AES protects stored bytes from casual disk reading; the server operator and authorized recipient can see plaintext. Recipients can keep copies. Audit metadata, public hashes, addresses, events and revealed vote salts persist. Encrypted backup/recovery operations and client-side key exchange are not built.
- Allowed PDF/PNG/JPEG checks are bounded metadata/magic checks, not full decoders, malware scanning, or proof that every accepted file is structurally safe. Files are served as authenticated attachments. HTML/SVG/active content, path traversal, oversize inputs and URL-fetch attempts have negative tests.
- Retention is not an atomic transaction across SQLite and the filesystem. Unexpected I/O/database failures may partially purge content; safe revalidation and retry complete deletion while retaining audit metadata. Local reset is restricted to owned checked targets, including Windows handle-release retry, and deliberately erases only disposable demo content.
- Shared local auth/private rate buckets can throttle several demo roles together. Upload limits are per request; a production per-user storage quota is not implemented. No public job directory is supplied. Browser caches clear on wallet/session changes and denied reads, but cannot erase user copies or immutable chain data.
- There are zero Git commits in this repository, so there is no commit history to scan. A source scan and a separate actual-client scan do not imply a historical secret audit. No commit or push was performed.
- Next's broad dynamic filesystem tracing warning remains a packaging/performance limitation; an actual artifact test proves the private runtime exclusion. Coverage anchors/complete transition coverage remain unverified despite high contract line coverage. Token issuer/admin and unusual token behavior remain bounded by the documented allowlist/mock assumptions.
- Contract fuzz checks use 512 cases. The dispute invariant's 128 runs/8192 handler calls include only 128 full sampled traces; later calls are no-ops. This is finite evidence, not exhaustive arbitrary call ordering. Escrow runtime is 23,644 bytes, leaving a 932-byte deployment margin. Permissionless timeout exits still require someone to submit a transaction. Token freezes, issuer behavior and depegs can prevent transfers even while claims remain credited.
- Tier B offers, amendments, stake/slash/salary and listings/ban are omitted by instruction; acceptance IDs 2 and 12 are therefore not applicable. The original referenced PDF and `fairwork_v3_spec.md` are absent. F-74 human backup video is unverified; [shot list](BACKUP_VIDEO_SHOT_LIST.md) is preparation, not a recording.

# 6. Decisions made and human inputs

[DECISIONS.md](../DECISIONS.md) and the preserved spec record A36 through A49 before their respective behavior: local chain/code pins and fresh authority; SIWE/cookie/origin/CSRF lifetimes; typed salted commitments and encrypted case-bound files; event/access ledgers and retention; local-only controls and fail-closed public build; canonical signed deletion; corrected immutable harness successors; zero-based job IDs; Windows owned-runtime handle-release retries; actual-build runtime trace exclusion; standard cookie whitespace; receipt recovery/stale-chain gates and exact evidence retry; private-response generations and definitive receipt outcomes; a narrowly bounded public-address scanner false-positive exemption. The current-arbiter terms and chain-clock evidence corrections are recorded explicitly under A38/A39.
The independent GPT-6 Luna Max subagent review findings were fixed and re-reviewed. No human answer is currently blocking local work; no Phase 5 independent adversarial audit or public release was performed.
The ten honest judge answers are in [JUDGE_QA.md](JUDGE_QA.md). The human-recorded backup video and Phase 5 authorization are the next human inputs; they are not represented as completed.

# 7. Stop

STOP. Say "GO PHASE 5" to continue.
