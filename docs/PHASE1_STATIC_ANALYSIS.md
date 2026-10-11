# Phase 1 static-analysis disposition

## Result status

The first, directory-wide Foundry capture (`docs/phase1-slither.txt` and `.json`) is **provisional**. It reports 13 detector results, but its log also contains 26 `Failed to resolved name` warnings, four `Missing inheritance` warnings, and three `Missing params '_msgSender()'` warnings. In this Slither parser, a missing inherited declaration can cause the affected contract's parsed content to be discarded. The first report is not evidence that every compiled production source was analyzed correctly.

The final source-target wrapper run is recorded in `docs/phase1-slither-final.txt`, `docs/phase1-slither-final.escrow.json`, `docs/phase1-slither-final.mocks.json`, and `docs/phase1-static-final-check.txt`. The escrow JSON has `success=true`, `error=null`, 8 contracts analyzed with 102 detectors, and 13 findings. The mock JSON has `success=true`, `error=null`, 10 contracts analyzed with 102 detectors, and zero findings. The final check counted zero unresolved references, missing inheritance, or missing parameters, and verified the actual selected compiler as `0.8.36+commit.8a079791.Windows.msvc`. These reports have none of the parser warning classes seen in the first scan. They cover the escrow source and local demo-token source, respectively, including their imported dependency closures. They do not cover tests, `Phase0CompileHarness`, or later-phase settlement behavior. The 13 detector dispositions below apply to the escrow report.

The final check records escrow Slither exit `4294967295` (Windows representation of -1), while its JSON is successful and the parser warning counters are zero; the mocks process exits 0. This is expected for Slither 0.11.6: its default is `--fail-pedantic`, which returns -1 when any detector finding exists. The 13 escrow findings explain that status; it is not a parser or compiler failure. If a caller needs a zero exit after successful analysis while retaining findings in JSON, pass `--fail-none` (`--no-fail-pedantic`).

The tool record in `docs/phase1-static-tooling.txt` pins Slither 0.11.6 and `crytic-compile` 0.4.2 in the ignored `.tools/slither` environment. The Foundry config pins solc 0.8.36 and OpenZeppelin 5.6.1. The earlier directory scan used one clean Foundry build-info file, `contracts/out/build-info/572894abda9b9b40.json`; its log shows `forge clean`, `forge config --json`, and `forge build --build-info --deny never --skip ./test/** ./script/** --force`. That clean build still had duplicate absolute/relative OpenZeppelin source keys, so the warning was a parser/source-scope issue rather than stale output. The final direct-target logs show CryticCompile reading Foundry configuration and invoking the solc-select-managed compiler using the configured remappings, optimizer (200 runs), and EVM target. The exact selected binary and version are recorded in `docs/phase1-static-final-check.txt`.

## Detector results

| # | Detector and reported location | Disposition |
|---:|---|---|
| 1 | `uninitialized-state`: `FairworkEscrow._milestones` | False positive for Solidity storage semantics. A mapping value of dynamic-array type starts empty; `createJob` appends each validated milestone before the job becomes usable. No constructor initialization is required. |
| 2 | `uninitialized-local`: constructor `runtimeDecimals` | False positive. The successful `try decimals()` branch assigns the return value; the catch branch reverts before the local is read. |
| 3 | `uninitialized-local`: `createJob.totalAmount` | False positive. A local `uint256` is zero-initialized; the bounded loop adds validated amounts and checks the running total. |
| 4 | `calls-loop`: constructor `decimals()` lookup | Intentional bounded external read. The constructor rejects more than three distinct token configs, performs a read-only metadata call once per config, and reverts on failure or mismatch. Deployment assets must still be curated fixed tokens; the call is not a generic token-safety proof. |
| 5 | `timestamp`: `acceptJob` | Required half-open boundary: acceptance is valid only while `acceptedAt < proposalEnd`; the exact expiry is closed. |
| 6 | `timestamp`: `fundJob` | Required half-open boundary: funding is valid only while `fundedAt < fundingDeadline`. The detector also labels `balanceAfter < balanceBefore` as a dangerous timestamp comparison; that expression is a token balance-delta guard, not a timestamp check. |
| 7 | `timestamp`: `cancelExpiredProposal` | Required timeout boundary: anyone may cancel only when `now >= proposalEnd`. |
| 8 | `timestamp`: `cancelUnfundedJob` | Required timeout boundary: anyone may cancel only when `now >= fundingDeadline`. |
| 9 | `timestamp`: `_assertCodehash` | Misclassified comparison. It compares `token.codehash` to the pinned config hash and does not read time. |
| 10 | `timestamp`: `_now64` | Intentional safe-cast guard. It rejects timestamps above `uint64.max` before conversion. It does not use timestamp as a source of randomness or economic ordering. |
| 11 | `cyclomatic-complexity`: constructor, complexity 12 | Informational validation complexity. It validates at most three configured tokens and all immutable protocol bounds; no unbounded runtime loop is involved. |
| 12 | `cyclomatic-complexity`: `createJob`, complexity 12 | Informational validation complexity. It checks at most ten milestones twice (validation then storage) and does not execute an unbounded loop. |
| 13 | `dead-code`: internal `_creditFromEscrow` | Intentional test-fixture seam. It is internal, has no production external selector, and is used only by a derived fixture in `contracts/test` to test positive withdrawals. It is not a production settlement or payout path. |

These are source-level dispositions of the 13 detector results in the escrow report, not waivers. The `timestamp` detector is heuristic and its output includes two clearly unrelated comparisons. The nonzero escrow exit is Slither's default response to reported findings; JSON parsing succeeded and the prior parser warning classes are absent.

## Parser warning investigation

The Foundry build-info's compiler input and output contain duplicate keys for the same OpenZeppelin files: absolute `C:/.../node_modules/...` paths and relative `../node_modules/...` paths. Those aliases receive different AST declaration IDs. The logged missing-inheritance IDs are present in the raw standard-JSON AST (for example, ID 11092 resolves to `IERC5267`, and ID 10861 resolves to `Context`); `IERC20`, `IERC20Metadata`, and the other reported IDs are present as well. This is consistent with a Slither/CryticCompile file-scope or ID association problem after path normalization, rather than missing Solidity source declarations. It explains the affected `Phase0CompileHarness`, `LocalDemoToken`, `MockUSDC`, and `MockWBTC` warnings in the first report. The later source-target scans resolve the parser issue for the escrow and local demo-token targets without suppressing warnings.

The repository also pins the exact npm `solc` JavaScript package at 0.8.36. CryticCompile 0.4.2's standard-JSON adapter invokes solc with `--allow-paths`; solc-js does not support that CLI option, so it was not used. The final direct-target logs show solc invoked with `--combined-json`, even though the wrapper supplies `--solc-standard-json`; single-file targets take CryticCompile's combined-JSON path. Do not describe these final runs as standard-JSON compiler runs. The exact native 0.8.36 solc-select binary was installed into the local compiler cache and verified; repository pins, dependencies, and vendor sources were unchanged.

## Reproduction and remaining limits

The final wrapper runs separate source-target scans from `contracts/`, targeting only the escrow source and local demo-token source and forcing CryticCompile's `solc` framework. The captured command was `npm run analyze:contracts -- --json docs/phase1-slither-final.json`; it produced the two source-specific JSON reports listed above. To repeat the target split without overwriting the saved evidence, use a fresh basename such as `docs/phase1-slither-rerun.json`. The Foundry config selects the pinned compiler and carries its remappings and optimizer settings. Slither's default exit is nonzero when findings exist; preserve that finding-sensitive exit and review the generated JSON reports.

```powershell
npm run analyze:contracts -- --json docs/phase1-slither-rerun.json
```

The bounded source-target results have none of the parser warning classes reported by the initial scan, and the 13 escrow findings are documented above. The original directory-wide capture remains in the evidence history as a provisional parser failure. This is not a whole-repository audit: tests and the Phase0 harness were not analyzed by the final source targets. No audit, no-bugs, all-funds-exit, or production-readiness claim follows from these reports.
