# Fairwork v3

Phase 3: local escrow, milestone delivery and zero-stake dispute arbitration implemented and tested. Clients create/fund agreements; freelancers accept and submit versioned commitments; clients approve or reject within bounded windows. Public review-silence releases and missed-delivery/rejection-silence refunds credit only the rightful party, and beneficiaries withdraw separately. Clients can dispute submissions, and either party can dispute rejections. Parties post exact deposits and evidence commitments; distinct arbiters commit/reveal votes, with one replacement pass, a fresh second panel and bounded 50/50 fallback. Jobs close after all milestones become terminal. No wallet UI transactions or persistent deployment are claimed; use only throwaway local mocks.

Fairwork is intended to bind a client and freelancer to funded milestone agreements. Delivery, review silence, missed deadlines and bounded panel arbitration determine claimable balances. Beneficiaries withdraw separately. Private work remains off-chain behind wallet authorization and server-side encryption. The contract is the sole payment authority.

## Setup and verification (PowerShell)

Run from this repository root using Node.js v24.11.1 and npm 11.19.0:

```powershell
npm ci
npm run tool:versions
npm run setup:contracts
npm run compile
npm run compile:forge
npm run test:contracts
$env:FAIRWORK_PHASE = '3'
npm run coverage:contracts
node scripts/check-frozen-tests.mjs
node scripts/check-frozen-tests.mjs docs/phase2-frozen-tests.json
node scripts/check-frozen-tests.mjs docs/phase2-additional-frozen-tests.json
node scripts/check-frozen-tests.mjs docs/phase3-frozen-tests.json
node scripts/check-frozen-tests.mjs docs/phase3-additional-frozen-tests.json
node scripts/check-frozen-tests.mjs docs/phase3-public-build-frozen-tests.json
node scripts/public-build-check.test.mjs
npm run scan:secrets
npm run audit:deps
npm run typecheck --workspace @fairwork/web
$env:NEXT_TELEMETRY_DISABLED = '1'
npm run build --workspace @fairwork/web
$env:DATABASE_URL = 'file:./dev.db'
npm run db:validate --workspace @fairwork/web
npm run db:generate --workspace @fairwork/web
```

The contract commands compile escrow and run named behavior tests, 512-case raw-unit fuzzing, two foundation invariant campaigns, one combined Phase 2 conservation/exit campaign and the Phase 3 sampled dispute campaign. Each campaign uses 128 runs and 8192 handler calls. The web commands still compile an inert Next.js page; private routes and authentication are not implemented. Foundry 1.8.5 and Gitleaks 8.30.1 were installed from official release archives under the user profile. On another Windows machine install those exact tools; the wrapper scripts support FORGE_BIN and GITLEAKS_BIN environment overrides. solc-js compilation needs only the locked npm packages and generates escrow, arbitration and mock randomness ABI files under packages/chain/generated without deployment addresses. setup:contracts installs/checks forge-std v1.17.0 at the exact commit and normalized source digest in contracts/dependencies.json; it refuses a modified existing dependency. Prisma requires DATABASE_URL even for schema validation; no database migration exists.

To view the scaffold:

```powershell
$env:NEXT_TELEMETRY_DISABLED = '1'
npm run dev --workspace @fairwork/web
```

Open http://127.0.0.1:3000. The page explicitly says that wallet, funding, delivery and dispute actions are unavailable. The development server binds to localhost. Future server secrets belong in ignored local environment files; .env.example contains blank placeholders only. No credentials are required for this inert page.

## Historical Phase 2 evidence

Phase 2 actual outputs, command steps and requirement/test names are linked from [docs/PHASE2_REPORT.md](docs/PHASE2_REPORT.md). Final optimized and coverage runs each report 61 passing tests, zero failures/skips. Phase 1 tests and the original Phase 2 tests/RED evidence remain byte-identical; the separate exhausted-revision test is also frozen. Source compile succeeded; the final forced Forge build compiles 54 files and reports escrow runtime size 13,195 bytes. Coverage reports escrow 100% lines/functions, 97.52% statements and 85.33% branches; missing-anchor warnings and remaining coverage limits are in docs/PHASE2_COVERAGE.md. Slither reports 19 dispositioned escrow findings and zero demo-mock findings; its nonzero finding exit is preserved. npm audit reports zero vulnerabilities. The final source secret scan result is in docs/phase2-secrets.txt. No professional security audit is implied.

Phase 0 toolchain/web and Phase 1 foundation evidence remain historical in their reports. The web scaffold is unchanged; its earlier browser inspection does not prove escrow UX. Phase 2 does not repeat unrelated web build checks.

Initial dependencies produced five high audit reports. Prisma/client were moved from 6.19.3 to matching 6.12.0; solc was moved from 0.8.37 to 0.8.36, with a scoped patched tmp 0.2.7 override. OpenZeppelin compilation emits warnings about a future keyword; no vendor code was edited. See the logs for initial and final audit output. The package-lock is the exact transitive dependency record.

Not implemented: production VRF, arbiter stakes/slashing/salaries, wallet transactions, SIWE sessions, encrypted private storage, secure uploads, chain tracker, reset/seed, Attack Lab and release acceptance scenarios. The legacy internal credit helper is exposed only by a test harness; real milestone settlement now uses a private job-aware helper without token calls. Token issuer failure can still block withdrawal while preserving the claim. MockUSDC/MockWBTC are DEMO ONLY, anyone can mint, and their constructors require chain 31337. Code hashes and exact balance checks supplement a trusted token allowlist; they cannot universally detect rebasing or proxy/callback semantics. ZAP, production client/history scans, human approval of money paths, the full Phase 5 adversarial review, demo rehearsal and recorded backup remain gaps. Tier B is not authorized.

## Documentation

- spec.md: canonical behavior, Decisions section and preserved requirement IDs.
- DECISIONS.md: D-01 through D-13, plus labelled local assumptions and version choices.
- docs/STATE_MACHINE.md: full target design, historical Phase 1 subset and current Phase 2/event links.
- docs/GAPS.md: document conflicts and recorded resolutions.
- docs/RANDOMNESS_PLAN.md: official provider documentation and retry incompatibility.
- REQUIREMENTS_TRACE.md: Phase 1/2 contract/test mappings, partial safeguards and remaining Tier A gaps.
- docs/PHASE2_CONTRACT_WALKTHROUGH.md: two-sentence explanations of delivery/settlement functions.
- docs/PHASE2_REPORT.md: seven-part Phase 2 report, measured results and all current gaps.
- docs/PHASE2_REVIEW.md, PHASE2_SELF_REVIEW.md and PHASE2_STATIC_ANALYSIS.md: source review and finding dispositions.
- docs/PHASE2_STATE_MACHINE.md: current nondisputed transition model.
- docs/PHASE1_CONTRACT_WALKTHROUGH.md: plain-English function explanations.
- docs/PHASE1_REPORT.md: seven-part Phase 1 report and actual evidence links.
- docs/PHASE1_REVIEW.md and PHASE1_STATIC_ANALYSIS.md: independent foundation review and Slither dispositions.
- docs/PHASE0_REPORT.md: the required seven-part Phase 0 report.
- docs/JUDGE_QA.md: ten judge questions with honest current answers.
- PROGRESS.md: resume point and next gate.
- HERO_PROMPT.md and implementation.md: supplied workflow and reconciled supporting plan.

The original problem PDF and fairwork_v3_spec.md were not supplied; the seven original features cannot be independently reconciled against them. spec.md is canonical per HERO_PROMPT. Phase 4 includes the minimal secure backend and D-11 privacy baseline; Phase 5 is independent review. Marketplace offers remain behind the explicit Tier B gate.

## Limitations

The chain cannot judge work quality. Wallets are pseudonymous; public chain data cannot be deleted. Tokens can depeg or be frozen. Wallet bans do not stop new wallets. Server-side encryption at rest is not end-to-end encryption. This hackathon prototype is not a professional audit or penetration test. No mainnet or public deployment is authorized. Production randomness is blocked until provider-safe retry semantics are reconciled. A six-arbiter pool can reach an early pool-exhaustion fallback after replacements; it cannot always provide a fresh second panel. Phase 3 tests cover those paths; predictable demo entropy does not provide production fairness.


## Static-analysis setup

Slither 0.11.6 was installed into an ignored, isolated Python environment. The exact installed dependency versions are recorded in infra/tools/slither-requirements.txt:

```powershell
python -m venv .tools/slither
.tools/slither/Scripts/python.exe -m pip install -r infra/tools/slither-requirements.txt
npm run analyze:contracts -- --json docs/phase2-slither-rerun.json
node scripts/check-frozen-tests.mjs
```

The wrapper also accepts SLITHER_BIN. Choose a fresh JSON output filename on reruns because Slither refuses to overwrite an existing report; a nonzero finding exit is expected until dispositions are applied. Read docs/PHASE2_STATIC_ANALYSIS.md rather than treating a successful parse as a zero-finding result. Slither defaults to a nonzero exit for findings; the wrapper preserves it. LCOV is generated under ignored coverage/phase2.lcov when FAIRWORK_PHASE=2; its final summary is preserved in docs/phase2-coverage-final.txt. The wrapper analyzes escrow and local mocks separately and appends .escrow/.mocks to the requested JSON basename to avoid the initial Foundry path-alias parser issue. It uses the actual native solc 0.8.36 pin from the Foundry configuration. Automated tests use an in-process Foundry EVM; there is no persistent Anvil deployment or verified address yet.

The immutable responseWindow shares fundingWindow in this compatible local prototype (A-23); independent production configuration is absent. Constructor, ProtocolConfig and JobView remain compatible. MilestoneView appends Phase 2 fields, so clients must use the regenerated ABI. Historical rejection timestamps are only actionable while state is Rejected. F-23 amendments remain excluded Tier B; dispute choices mentioned in F-12/F-22/F-24 are now contract-covered; their UI remains a Phase 4 gap.



## Current Phase 3 verification

See docs/PHASE3_REPORT.md for measured current gates and REQUIREMENTS_TRACE.md for exact requirement/test mappings. The source compile reports 29 source units, 32 artifacts and zero errors, generating escrow, arbitration and mock ABIs with no deployment address. The optimized suite reports 109 passing tests across 14 suites, zero failures/skips. Earlier frozen tests and RED logs remain unchanged; the wrong-phase vote regression was added only after reviewed runtime RED.

The immutable engine owns registry and dispute phases; escrow alone owns liabilities and credits. Index both addresses for events. MockRandomness is DEMO ONLY, predictable, chain-31337-only and has no caller-chosen entropy seed. The explicit build:public entry fails closed because no approved production adapter exists; Phase 4 must integrate the guard into every supported application release entry. This does not claim an arbitrary client build has been inspected for dev tools.

The bounded-exit invariant samples 128 completed traces per run configuration; later handler calls are no-ops. It is not exhaustive arbitrary-order proof, and liveness requires someone to call advance. Local dispute windows share fundingWindow; production configuration and minimum pool enforcement remain absent. Escrow runtime is 23,644 bytes (932 bytes below the EVM limit), with initcode 42,977 bytes. No UI, persistent chain, funds, address, production randomness or professional audit is claimed.

Current documentation: PHASE3_API, PHASE3_STATE_MACHINE, PHASE3_CONTRACT_WALKTHROUGH, PHASE3_REVIEW, PHASE3_MONEY_REVIEW, PHASE3_SELF_REVIEW, PHASE3_STATIC_ANALYSIS and PHASE3_REPORT under docs/. Historical evidence above remains historical.

Actual identity vetting is unverified; docs/ARBITER_VETTING.md documents the required private operational process. Current source scan is a configured Gitleaks directory scan, not Git-history or built-client evidence.

Current coverage: escrow lines99.33%/statements97.07%/branches86.67%/functions98.11%; arbitration99.09%/94.01%/74.77%/100%. Aggregate including dependencies is83.27%/83.68%/69.18%/78.75%; instrumentation missing-anchor warnings prevent a completeness claim. Slither parsed40escrow+13arbitration findings with no parser errors; both demo targets have0. These are 53 per-target occurrences / 40 unique detector IDs, with 13 engine duplicates in the escrow report. Every occurrence has a disposition in docs/PHASE3_STATIC_ANALYSIS.md, and finding-sensitive nonzero exit is retained. Current audit reports0 vulnerabilities.

STOP. Say "GO PHASE 4" to continue.
