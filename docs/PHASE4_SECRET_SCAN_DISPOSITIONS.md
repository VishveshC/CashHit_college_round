# Final source-scan false positives

The first final source scan returned exit 1 with five `generic-api-key` findings. Its actual output is retained in [phase4-secret-source-public-address-findings.txt](phase4-secret-source-public-address-findings.txt). All five values are public contract addresses from the pinned deployment and the verified local receipt events, not authentication credentials.

| Proof file | Line | Public deployed asset address |
|---|---|---|
| phase4-browser-payment-chain-proof.json | 28 | 0x5FbDB2315678afecb367f032d93F642f64180aa3 |
| phase4-browser-payment-chain-proof.json | 107 | 0x5FbDB2315678afecb367f032d93F642f64180aa3 |
| phase4-browser-wbtc-chain-proof.json | 41 | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 |
| phase4-browser-wbtc-chain-proof.json | 120 | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 |
| phase4-browser-wbtc-chain-proof.json | 164 | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 |

A49 permits only the generic-api-key rule to ignore a finding when BOTH the exact one of these two proof paths and the anchored whole-line field containing either exact address match. It does not disable a rule, ignore either whole file, exempt arbitrary addresses, or change the client scan. [Official Gitleaks configuration documentation](https://github.com/gitleaks/gitleaks#configuration) describes the AND condition and line-targeted matching.

After the first exemption, the scanner reported three literal public-address fixtures in the frozen regression itself: `scripts/phase4-secret-allowlist.test.mjs` lines 18 and 22 contain the same public MockUSDC address; line 19 contains the same public MockWBTC address. The [second raw scan](phase4-secret-source-frozen-fixture-findings.txt) is preserved. The original frozen test was not edited. A separate rule-specific exemption requires BOTH that single exact source-test path and one of the three complete immutable assertion lines; surrounding whitespace is allowed because the scanner trims lines. All values remain exact public addresses.

Each of the two three-case frozen scanner suites was run before its respective configuration change: one positive case failed and two negative cases passed. All six final cases pass. They verify exact proof lines and the original source assertions, rejection of the same fixture under an unrelated path, and rejection of a runtime-generated secret-like replacement value in an otherwise exempted path. Actual outputs: [proof-field RED](phase4-secret-allowlist-red.txt), [source-fixture RED](phase4-secret-fixture-scope-red.txt), [final six-case GREEN](phase4-secret-boundaries-green-final.txt), [proof-field manifest](phase4-secret-allowlist-frozen-tests.json), [source-fixture manifest](phase4-secret-fixture-scope-frozen-tests.json).

The final source output is [phase4-secret-source-final.txt](phase4-secret-source-final.txt). The actual built-client output uses default rules without an allowlist: [phase4-client-gitleaks-final.txt](phase4-client-gitleaks-final.txt). There are zero Git commits, so a history audit is unavailable; the [actual count](phase4-git-history-count-final.txt) is not a passing history scan.
