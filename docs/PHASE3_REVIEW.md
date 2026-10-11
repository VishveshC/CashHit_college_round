# Phase 3 independent review

## Pre-implementation test review

**Status: test snapshot cleared for freeze.** This was a read-only review of the frozen seam in `docs/PHASE3_API.md`, A-28–A-35, `docs/PHASE3_STATE_MACHINE.md`, and the Phase 3 test files before implementation. I did not edit source or tests, and did not run the build or tests. The test owner reports `forge build --root contracts` passed; the recorded RED run also confirms the suite compiles before executing.

The tests match the authorized local-only scope: the escrow constructor remains unchanged; engine and demo randomness are immutable; registry snapshots persist across retries; stake, salary, and slashing remain disabled at zero. The RED capture reports 47 failing tests and zero passing against the Phase 2 baseline. `contracts/src/FairworkEscrow.sol` has the same SHA-256 before and after that run (`04D50E1E442F4120E4D11203A90BAED20989CA2605C74E8A5FCEDF2E4DC4E706`); the Phase 3 tests fail because their new API is absent, and the invariant setup fails at its missing registry selector. Existing Phase 1/2 frozen tests and source hashes are recorded unchanged in `docs/phase3-prior-integrity-before.txt`.

The test owner and root incorporated these corrections before the reviewed freeze candidate:

- Reserve dispute ID zero as the unopened sentinel and start real dispute IDs at one.
- Enter the initial pending-randomness phase before exercising the initial retry helper; it only accepts pending draw phases.
- Correct fallback credits for amount 1,001 to client 521 (501 principal plus D=20), and for amount 101 to client 53 (51 principal plus D=2).
- Correct the amount-10,005, 5,001-bps two-vote settlement to freelancer 5,203, client 5,002, and treasury 200. Use an unsorted three-vote vector so a middle-seat shortcut cannot satisfy the median test.
- Compute `_commit` test hashes locally from the exact A-33 encoding and cache the wrong-bps hash before `expectRevert`, so the expected revert applies to `commitVote`, not a preceding view call.
- Import the `IPhase2Read` seam required by accounting tests. Probe reentrancy with a valid nested `createJob`, then exercise both open and matched deposits; this avoids a false positive from the token failing the caller-role check.
- Correct the two-dispute endpoint test to compare the client balance delta after the full-ruling case instead of asserting an absolute zero after the earlier zero-ruling credit.
- Add focused boundaries for E+1 callback rejection, timely entropy consumed after request end, short-pool request failures using all three bounded attempts, empty replacement assignment, displaced noncommitter rights, and the mock word’s request/consumer binding. Add matching-deposit fee-token rollback and settlement while token calls fail.
- Cover median and floored mean ruling, deposits of one and three raw units, below/at/above-half forfeiture paths, missing-deposit deductions including zero and partial caps, treasury aliasing, 0/10,000 vote endpoints, multi-milestone closure, exact-transfer/reentrancy protection, and terminal repeat rejection.

The bounded-exit invariant starts from an actual live Evidence dispute. Its targeted handler exercises the public advance path through successful randomness or three timeouts, no-show replacement, reveal quorum/no-quorum, and the fresh second panel. It checks token balance against locked principal plus claim, deposit, and stake liabilities after each phase advance; it also checks that only parties and treasury receive claims, the dispute terminalizes once, and the exit stays within fixed step/time bounds. The invariant includes a pre-campaign live-state assertion and a post-campaign terminal-state assertion, so it is not vacuous.

I found no remaining concrete blocker in the reviewed snapshot. The test manifest is now recorded in `docs/phase3-frozen-tests.json`; I independently checked every listed frozen-file SHA-256 and all hashes match. **Reviewer clearance: Phase 3 tests and manifest are frozen.** This clearance concerns the test snapshot and RED/freeze gate only; it does not certify implementation behavior. No existing frozen test was removed or loosened to make a new test pass.

## Source review

**Status: source review complete; no material blocker found for the authorized local Phase 3 scope.** I reviewed the final `FairworkEscrow`, `FairworkArbitration`, `IRandomness`, and `MockRandomness` snapshot against `docs/PHASE3_API.md`, `docs/PHASE3_STATE_MACHINE.md`, and A-28–A-35. I changed documentation only. I did not edit source or tests and did not run a build, test, coverage, or analyzer command; gate results below are reported from the saved root/builder outputs.

The reviewed scope is F-30–F-35 and F-45, local-only. Tier B stakes, slashing, and salaries are disabled at zero; public VRF, UI, and privacy backend remain outside this phase.

The engine is deployed from the existing escrow constructor, preserving the constructor call shape. It binds mutations to that escrow and accepts entropy only from its immutable adapter. The adapter and escrow remain chain-31337-only. Registry changes are owner-forwarded; panel, evidence, vote, settlement, and timeout actions follow the API's actor rules. The additive A-31 test confirms wrong-phase vote calls return `InvalidState`, while a wrong seat in a valid vote phase returns `Unauthorized`.

The draw path snapshots eligible candidates before request attempt zero, retains that snapshot over two retries, allocates fresh request IDs, and leaves failed requests pending until bounded timeout/retry processing. A synchronous callback only records a timely word; it cannot advance state or settle. Accepted entropy remains consumable after the request deadline, while a callback first received at or after the deadline is ignored. Initial and second panels require three candidates; replacement fills only vacancies, can leave zero seats, and has one shared replacement window. Panel 2 excludes parties and all Panel 1 selections, including replacements. Two reveals are quorum; three use the median and two use the floored mean.

Settlement computes principal, posted-deposit refunds/forfeitures, and capped missing-deposit deductions before ledger updates. Fallbacks use a 50/50 principal split, refund posted deposits, and do not forfeit them. Settlement changes claims and liabilities without calling the token; withdrawals remain separate. The escrow guards state-changing entrypoints, checks exact incoming token deltas and runtime code hash, and keeps disputed milestones outside the old nondisputed timeout paths. I found no path in the reviewed source that lets an owner or treasury address choose a ruling or claim another account's credit.

The saved gate evidence reports a successful optimized build (29 source units, 32 artifacts, zero compiler errors), 109 tests passed with zero failures or skips, and the public-build guard passing its local-allow/public-demo-deny/missing-production-deny/invalid-target cases. The reported Phase 3 coverage is 99.09% engine lines and 74.77% engine branches; escrow is 99.33% lines and 86.67% branches. Overall reported branches are 69.18%. Coverage is a measurement, not a proof, and the invariant campaign samples a narrower bounded trace set than every possible interleaving. Six frozen-integrity checks are recorded unchanged. Slither's successful JSON parses still contain findings and the escrow/arbitration process exits are nonzero for that reason; every occurrence is dispositioned in `docs/PHASE3_STATIC_ANALYSIS.md`.

**Reviewer recommendation:** accept the implementation for this local-only Phase 3 contract slice, subject to the repository's recorded gates. This is an independent source/test review, not a professional audit, production-readiness finding, wallet/UI verification, or end-to-end privacy claim. The demo adapter is deterministic and is explicitly excluded from public builds.

