# Phase 0 report

## 1. Plain-English summary

Fairwork is intended to protect clients and freelancers through funded milestone agreements. Approved ERC-20 tokens are held in escrow; delivery, review deadlines and panel arbitration determine claims. Beneficiaries withdraw separately. Private text and files stay off-chain. Phase 0 records the rules, reconciles conflicts and creates a verified toolchain scaffold. The inert web page explicitly says escrow and wallet actions are unavailable. No contracts are deployed or money-path behavior implemented.

## 2. State diagram sync

spec.md and docs/STATE_MACHINE.md use the same proposed job/milestone/dispute model. Withdrawals change a separate ledger, not terminal milestones. Funded means active, without an extra Active state. There is no implemented state machine yet, so code/diagram runtime correspondence is UNVERIFIED.

## 3. How to verify without reading Solidity

From the repository root:
1. Run `npm ci`, then `npm run tool:versions`: expect the pinned versions in the evidence file. Install Foundry 1.8.5 and Gitleaks 8.30.1 first on another machine; wrapper environment overrides are documented in README.
2. Run `npm run compile` and `npm run compile:forge`: expect zero errors and the documented OpenZeppelin future-keyword warnings. These compile an abstract dependency harness only.
3. Run `npm run scan:secrets` and `npm run audit:deps`: the recorded results are no source leaks and zero dependency vulnerabilities.
4. Run `npm run typecheck --workspace @fairwork/web` and `npm run build --workspace @fairwork/web`: expect a static / route and /_not-found.
5. Set `$env:DATABASE_URL='file:./dev.db'`, then run `npm run db:validate --workspace @fairwork/web` and `npm run db:generate --workspace @fairwork/web`: expect valid schema and client v6.12.0. No database migration or private storage exists.
6. Run `npm run dev --workspace @fairwork/web`, open http://127.0.0.1:3000 and read the unavailable-actions notice. The temporary verification server was stopped after browser inspection.

## 4. Evidence

Actual command excerpts:

```text
npm run compile
solc 0.8.36+commit.8a079791.Emscripten.clang
Compile succeeded: 20 source units, 18 compiled contract/library artifacts, 0 errors.

npm run compile:forge (after forge clean --root contracts)
Compiling 21 files with Solc 0.8.36
Solc 0.8.36 finished in 165.52ms
Compiler run successful with warnings:

npm run scan:secrets
INF no leaks found

npm run audit:deps
found 0 vulnerabilities

npm run typecheck --workspace @fairwork/web
> tsc --noEmit
Exit code: 0

npm run build --workspace @fairwork/web
Next.js 16.4.0 (Turbopack)
Compiled successfully in 218ms
Generating static pages (3/3) in 617ms
Static routes: / and /_not-found
Exit code: 0

npm run db:validate --workspace @fairwork/web
The schema at prisma\schema.prisma is valid
Exit code: 0

npm run db:generate --workspace @fairwork/web
Generated Prisma Client (v6.12.0)
Exit code: 0
```

Full tool versions/checksums/install/audit evidence: docs/phase0-tooling.txt. Web registry/build/schema/browser evidence: docs/phase0-web.txt. There are five warning-6335 diagnostics from OpenZeppelin ECDSA's future-keyword identifier, zero errors. Initial audit findings were fixed through documented version changes and a scoped patched tmp override.

No unit, fuzz, invariant, coverage, Attack Lab, Slither or ZAP result exists. All business requirement/test rows in REQUIREMENTS_TRACE.md remain GAP. S-82 has partial compiler/dependency evidence only, not a behavior test. F-72/F-73 have honest scaffold documentation, not final release acceptance.

## 5. Unverified items, assumptions and residual risks

Original problem PDF and fairwork_v3_spec.md are missing; original seven-feature coverage is not independently verified. Production VRF integration conflicts with D-08 retries and remains blocked (docs/RANDOMNESS_PLAN.md, with linked official documentation). Six eligible demo arbiters cannot always demonstrate replacements followed by a full fresh second panel; recorded exhaustion fallback needs Phase 3 tests. No wallet, escrow, private routes, secure files, encryption, retention, access logging or production-build safeguard is implemented. No deployments or real keys exist. Slither and ZAP were absent and not installed/run; Docker was absent. Source secret scan excludes generated output and dependencies; client-bundle/history secret scans are not verified. Git has no commits, so there is no history to scan. Browser inspection covers only the inert desktop scaffold. Human money-path review, two demo rehearsals, source-brief reconciliation, backup video and final judge Q&A remain future work. The prototype is not professionally audited; chain data cannot be deleted, wallets are pseudonymous, tokens can freeze/depeg and bans do not stop new wallets.

## 6. Decisions made and human needs

D-01–D-13 are retained verbatim, with A-01 onward recording proposal expiry, pool exhaustion, replacement timing, evidence clock, registry behavior, retry identity/bounds, local monetary/duration/reference limits, public vote-salt exception and final stack pins. These are present in spec.md before any affected behavior code.

HERO_PROMPT phase order controls: Phase 4 includes the minimal secure backend and D-11 privacy baseline; Phase 5 is independent review; marketplace offers stay behind the explicit Tier B gate. Foundry/Gitleaks were installed from verified official archives under the user profile, and their folders added to user PATH. No question blocked the local scaffold. Public production readiness is not claimed. The missing source PDF can be supplied later for source reconciliation.

Local Phase 0 scaffold gate: completed with recorded assumptions and compile warnings. Full Tier A/product gate: NOT COMPLETE. Production randomness gate: BLOCKED. No later phase has begun.

## 7. Phase boundary

STOP. Say "GO PHASE 1" to continue.

This stop is explicitly required by HERO_PROMPT.md §12: “Do Phase 0 only” and “Do not begin Phase 1 until told GO PHASE 1.” It is a phase boundary, not a new permission flow inferred from a skill.
