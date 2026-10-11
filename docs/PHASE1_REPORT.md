# Phase 1 report

## 1. Plain-English summary

The local escrow foundation now supports direct create, named-freelancer acceptance and exact-token funding. Each milestone starts its independent delivery clock at funding; proposal/funding expiry can be closed by anyone at the exact boundary. Role checks, immutable terms/configuration, raw-unit accounting, surplus isolation and a guarded pull-withdrawal primitive are implemented. DEMO ONLY MockUSDC/MockWBTC reject nonlocal deployment. GPT-6 Luna Max agents independently owned implementation, tests and review. **Funded principal remains locked until Phase 2; this is not a complete escrow or usable marketplace.** No real/public funds, persistent deployment or UI transactions are claimed.

## 2. State diagram sync

[STATE_MACHINE.md](STATE_MACHINE.md) now distinguishes the full target design from the exact implemented Phase 1 diagram and actual event ABI. The callable path is Proposed → AcceptedUnfunded → Funded, or pre-funding Cancelled; milestones remain Ready. Closed, delivery, settlement and dispute transitions are absent. WithdrawalCompleted matches the planned name; compact creation/cancellation events require immutable getter reads per A-22. Constructor configuration events and source/reason metadata for future settlement credits remain design gaps. The test-only internal-credit arrow is labelled as a fixture and cannot be reached through the production contract ABI.

## 3. How to verify without reading Solidity

1. From the repository root run `npm ci` and `npm run setup:contracts`. Expect locked npm installation and `forge-std 1.17.0 ... normalized source SHA-256 verified`; a changed dependency is rejected.
2. Run `npm run compile` and `npm run compile:forge -- --force`. Expect compiler 0.8.36 and zero compiler errors, with the saved vendor/lint warnings. The ABI contains no deployed address.
3. Run `npm run test:contracts -- --fuzz-seed 0x64dc8bbdae7c8843cabae57826d87f498f6bbda34fd8452be034ff3a2d6ba3c4`. Expect 33 passing tests and zero failures/skips, 512 raw-unit fuzz cases and two 128-run/8192-call invariant campaigns. Read the PASS names to check wrong roles, invalid terms, unusual token rollback, exact expiry, no premature withdrawal and terms readback.
4. Run `npm run coverage:contracts` and `node scripts/check-frozen-tests.mjs`. Expect an LCOV file and UNCHANGED for all six frozen records; interpret coverage with [PHASE1_COVERAGE.md](PHASE1_COVERAGE.md), including anchor warnings.
5. Install the isolated pinned Slither requirements using the README commands and run `npm run analyze:contracts -- --json docs/phase1-slither-rerun.json`. Expect separate `.escrow.json` and `.mocks.json` reports, a nonzero finding exit for the escrow's 13 documented findings, and zero parser-resolution warnings. Choose a fresh report basename on each rerun.
6. Run `npm run audit:deps` and `npm run scan:secrets`. Expect zero npm vulnerabilities and no source leaks; this does not inspect a deployed app, all history or a future client bundle. No click-through payment flow exists yet.

## 4. Evidence

These are excerpts from commands actually run in this session; full logs preserve warnings and test names:

```text
npm run compile
solc 0.8.36+commit.8a079791.Emscripten.clang
Compile succeeded: 26 source units, 28 compiled contract/library artifacts, 0 errors.
Generated local foundation ABI; no address or deployment is implied.

npm run compile:forge -- --force
Compiling 52 files with Solc 0.8.36
Solc 0.8.36 finished in 4.06s
Compiler run successful with warnings:

npm run test:contracts -- --fuzz-seed <recorded seed>
[PASS] invariant_F03_EachTokenBalanceCoversItsLiabilities() (runs: 128, calls: 8192, reverts: 0)
[PASS] testFuzz_F01_F03_RawAmountRemainsTokenUnits(uint256,uint8) (runs: 512, μ: 626587, ~: 625767)
[PASS] invariant_F03_LedgerMatchesSeededAndRandomFundedPrincipal() (runs: 128, calls: 8192, reverts: 0)
Ran 5 test suites in 4.76s (6.27s CPU time): 33 tests passed, 0 failed, 0 skipped (33 total tests)

npm run coverage:contracts -- --fuzz-seed <same recorded seed>
Ran 5 test suites in 9.49s (12.65s CPU time): 33 tests passed, 0 failed, 0 skipped (33 total tests)
src/FairworkEscrow.sol: lines 100.00% (192/192); statements 97.19% (277/285); branches 81.40% (35/43); funcs 100.00% (19/19)
Wrote LCOV report.

npm run analyze:contracts -- --json docs/phase1-slither-final.json
src/FairworkEscrow.sol analyzed (8 contracts with 102 detectors), 13 result(s) found
Slither escrow exit: 4294967295
src/mocks/LocalDemoTokens.sol analyzed (10 contracts with 102 detectors), 0 result(s) found
Slither mocks exit: 0

npm run audit:deps
found 0 vulnerabilities
npm run scan:secrets
no leaks found
```

Logs: [solc build](phase1-compile.txt), [forced Forge build](phase1-forge-build-final.txt), [original RED: 0 pass/17 fail](phase1-red.txt), [final tests](phase1-tests-final.txt), [final coverage](phase1-coverage-final.txt), [Slither final](phase1-slither-final.txt), [static compiler/JSON/parser checks](phase1-static-final-check.txt), [npm audit](phase1-audit.txt), [source secrets](phase1-secrets.txt), [frozen integrity](phase1-test-integrity.txt). Slither JSON: [escrow](phase1-slither-final.escrow.json), [mocks](phase1-slither-final.mocks.json). The initial problematic Slither output remains preserved in phase1-slither.txt/json; the direct retry logs are also preserved. Slither nonzero is a findings exit, not a compiler failure; all findings are dispositioned in [PHASE1_STATIC_ANALYSIS.md](PHASE1_STATIC_ANALYSIS.md).

Coverage's project aggregate includes unused Phase 0/OZ paths: 62.97% lines, 66.54% statements, 46.53% branches, 60.24% functions. It is not the escrow-only result. Foundry's missing-anchor warnings remain; reliable instrumentation completeness and full-P0 transition coverage are UNVERIFIED. Normal optimized tests are a separate successful gate.

| Requirement now exercised | Main proving tests |
| --- | --- |
| F-01 contract slice | test_F01_RejectsInvalidPartiesTokensCommitmentsAndBounds; test_F01_AcceptsOneAndTenMilestonesAtTheRawAmountLimits; test_A17_ReadbackPreservesTermsAndProtocolConfigAcrossLifecycle |
| F-02 contract slice | test_F02_F03_EnforceRolesAndFundingOrder; test_A01_F02_ProposalUsesHalfOpenExpiryAndPublicCancellation |
| F-03 foundation | test_F01_F02_F03_CreateAcceptFundStartsIndependentRawUnitClocks; test_F03_RejectsFeeOnTransferAndFalseReturnDepositsWithRollback; both invariant_F03_* tests |
| F-85 contract slice | test_F85_F03_FundingUsesHalfOpenExpiryAndPublicCancellation; test_A01_F85_TimeoutsAreClosedOnlyAtAndAfterEachEnd |
| Applicable partial safeguards | S-01/S-02/S-04/S-05/S-07/S-08/S-10/S-11/S-15/S-17/S-18/S-20/S-21; exact functions and named tests in REQUIREMENTS_TRACE.md |

[REQUIREMENTS_TRACE.md](../REQUIREMENTS_TRACE.md) preserves every Tier A tracking slot and leaves missing/later tests as GAP. A matching number in a grouped source list is not silently treated as a new defined requirement. No UI or full-property completion is inferred.

## 5. Unverified items, assumptions and residual risks

- Funded jobs have no bounded exit, real settlement or Closed transition yet. Positive withdrawal tests use actual funded balances and an internal-credit derived fixture, not a production payout endpoint. Full no-stuck-funds/no-double-settlement/rounding conservation and deposit/stake solvency properties are deferred, not proven.
- The allowlist curator must vet fixed non-rebasing, non-fee, non-callback tokens. Exact deltas/code hashes reject tested bad transfers and runtime drift, but cannot universally detect proxy upgrades, future rebases or every callback. Callback fixtures test guarded rollback/reentry, not automatic callback-token classification. Only harmless local demo assets are intended.
- A token can freeze a recipient or change behavior, preventing withdrawal; rollback preserves the claim but cannot restore issuer liveness. Codehash mismatch also blocks withdrawal deliberately. Direct surplus cannot be withdrawn by an admin.
- The seeded invariant handler caps tracking at 64 jobs and later calls can be no-ops; 8,192 calls must not be read as 8,192 distinct successful transitions. It begins with funded principal in each token and explicitly exercises funding, invalid calls, both expiry paths and surplus, while the original campaign varies call ordering/time.
- Coverage branch result is below 90%; anchor mapping warnings prevent a certified coverage/100%-transition claim even though reported lines/functions reach 100%. Slither's final parser warnings are resolved, but its 13 source-dispositioned findings are not a zero-finding report or professional audit. The initial invalid parser report is explicitly superseded.
- The original 17-test ABI shell RED preceded behavior implementation and frozen baseline files remain byte-identical. Supplemental tests were added after foundation implementation, so they are regression/coverage checks, not separate tests-first cycles. Their initial compilation/setup mistakes (contract-address cast; asserting random calls before Foundry's initial invariant assertion) were corrected while retaining non-vacuity via seeded funded jobs and a seeded full handler step; no frozen baseline test was edited or removed.
- No persistent Anvil deployment/address, wallet UI, exact-allowance UI, refetch behavior, SIWE/private routes, encryption, upload security, indexer, ZAP, public-build dev exclusion, final Attack Lab or Phase 5 adversarial audit is verified. Test fixtures use unlimited approvals only to drive the EVM, not as UI behavior. The web scaffold was unchanged; its Phase 0 browser proof does not prove payments.
- The final source scan briefly flagged two frozen-test SHA-256 lines as generic API keys because their paths contain Token. The values were verified against actual test-file digests; the integrity reporter now prints paths and SHA-256 on separate lines, with no secret rule/path suppression, and the rerun found no leaks. The diagnostic log is preserved in phase1-secrets-findings.txt.
- Source Gitleaks is a working-directory scan. There are no Git commits/history to inspect and no new production client bundle scan; those remain later gates. npm audit covers Node packages, not all tools or code. The original problem PDF and fairwork_v3_spec.md remain missing, so their seven-feature wording cannot be reconciled. The judge Q&A/demo/backup shot list remain later deliverables; humans record the backup.
- Production registry/randomness integration remains Phase 3 and the documented provider/retry incompatibility is unresolved. No Tier B, public build or deployment was added. Wallets are pseudonymous, on-chain records cannot be deleted, the chain cannot judge quality, tokens can depeg/freeze and bans cannot prevent a new wallet. At-rest encryption planned for Phase 4 is not end-to-end encryption. This is a hackathon prototype, not a professional audit or penetration test.

## 6. Decisions made and human needs

A-17 local-only phase boundary, A-18 immutable token/config/codehash trust, A-19 typed bounded immutable inputs/timing, A-20 internal backed ledger/withdrawal fixture, A-21 exact forge-std commit/source digest, and A-22 compact events/getter-based indexing are recorded in DECISIONS.md and spec.md. The checked job counter and WithdrawalCompleted alignment resolved independent review feedback. [PHASE1_REVIEW.md](PHASE1_REVIEW.md) records exploit sketches and scope limits; [PHASE1_CONTRACT_WALKTHROUGH.md](PHASE1_CONTRACT_WALKTHROUGH.md) explains every foundation function in plain English. No unanswered Phase 1 decision blocks the contract gate; human review of actual money paths and the full submission review remain later gates. The only next input needed is phase authorization.

## 7. Stop

STOP. Say "GO PHASE 2" to continue.
