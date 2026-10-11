# Phase 3 coverage report

Coverage snapshot from `docs/phase3-coverage-final.txt` and `coverage/phase3.lcov`. The report ran the 109-test suite across 14 suites with fuzz seed `0x64dc8bbdae7c8843cabae57826d87f498f6bbda34fd8452be034ff3a2d6ba3c4`; all 109 tests passed. Foundry compiled with optimizer and `viaIR` disabled for this coverage run, so these figures describe the instrumented build, not the production-optimized bytecode.

Coverage completeness is **UNVERIFIED**. Foundry emitted repeated `could not find anchor` warnings for source IDs mapped by the build-info artifact to `src/FairworkArbitration.sol`, `src/FairworkEscrow.sol`, and `src/mocks/MockRandomness.sol`; the warnings include line, function, statement, and branch anchors with zero hits. The coverage counts below are the tool's reported mapped counts, but missing anchors mean they may not represent every source instruction, so use the raw log and explicit behavioral tests together.

## Four owned source files

The table reproduces the per-file figures from the coverage summary. An interface declaration has no executable body and no LCOV record, so it is marked N/A instead of 0%.

| Source file | Lines | Statements | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| `contracts/src/FairworkEscrow.sol` | 99.33% (446/449) | 97.07% (597/615) | 86.67% (104/120) | 98.11% (52/53) |
| `contracts/src/FairworkArbitration.sol` | 99.09% (326/329) | 94.01% (424/451) | 74.77% (80/107) | 100.00% (38/38) |
| `contracts/src/interfaces/IRandomness.sol` | N/A | N/A | N/A | N/A |
| `contracts/src/mocks/MockRandomness.sol` | 100.00% (18/18) | 85.00% (17/20) | 57.14% (4/7) | 100.00% (5/5) |

Across the three executable owned files, the reported subtotal is 790/796 lines (99.25%), 1,038/1,086 statements (95.58%), 188/234 branches (80.34%), and 95/96 functions (98.96%). This subtotal excludes the interface declaration and is still subject to the missing-anchor limitation above.

## Aggregate report, including dependencies

The tool's `Total` row includes the four owned files plus other repository contracts, the compile harness, local token fixtures, and imported OpenZeppelin contracts. It is useful as a whole-run inventory but is not the Phase 3 contract subtotal.

| Scope | Lines | Statements | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| All sources included in the report | 83.27% (901/1,082) | 83.68% (1,123/1,342) | 69.18% (202/292) | 78.75% (126/160) |

The aggregate includes, among others, `ERC20`, `SafeERC20`, `ReentrancyGuard`, `ECDSA`, and `EIP712`; untouched cryptography dependencies have zero hits in this test run. It also includes `Phase0CompileHarness` and `LocalDemoTokens`, so the aggregate must not be read as a Phase 3-only quality score.

## Reported uncovered locations

LCOV reports one uncovered escrow function, `disputeConfig()` at line 366, and uncovered escrow lines 366, 378, and 379. Its 16 missed branch outcomes are at lines 397, 404, 485, 548, 657, 667, 740, 822, 864, 912, 922, 978, 1019–1020, 1031, and 1045; these include defensive paths in dispute opening, milestone reads, settlement, and legacy job/token functions.

The engine has no reported wholly uncovered function, but lines 216, 311, and 437 are uncovered: invalid dispute arguments, the commit-phase fallback guard, and an invalid panel round. Its 27 missed branch outcomes are at lines 148, 153–155, 178, 196, 215, 219, 266, 268, 270, 273, 286, 310, 313, 384, 394, 399, 405, 410–411, 450, 461, 463, 586, 595, and 682. These counts include authorization, constructor validation, request/phase deadlines, panel/vote selection, evidence bounds, and defensive timestamp branches.

MockRandomness has no reported uncovered line or function, but three branch outcomes are missed at lines 23, 31, and 49: the wrong-chain constructor guard, zero or duplicate request rejection, and invalid mode rejection. `IRandomness` has no executable body to measure.

The locations identify what this run did not map as covered, not a claim that each source-level condition lacks any test. Some error paths are covered by explicit revert tests even where instrumentation does not attribute a hit, and the missing-anchor warnings prevent treating this report as complete. Conversely, high line or function percentages do not establish complete branch coverage, prove every state-machine transition, or replace the dedicated timing, authorization, accounting, retry, and bounded-exit tests; no blanket percentage threshold is claimed.
