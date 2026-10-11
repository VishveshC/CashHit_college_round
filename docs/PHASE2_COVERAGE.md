# Phase 2 coverage

Actual command: `$env:FAIRWORK_PHASE = '2'; npm run coverage:contracts -- --fuzz-seed 0x64dc8bbdae7c8843cabae57826d87f498f6bbda34fd8452be034ff3a2d6ba3c4`. Full output is phase2-coverage-final.txt and LCOV is coverage/phase2.lcov (ignored generated output). The separate optimized run is phase2-tests-final.txt. Both final runs report 61 passed, zero failed/skipped.

| Scope | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| FairworkEscrow | 100.00% (312/312) | 97.52% (433/444) | 85.33% (64/75) | 100.00% (31/31) |
| Entire report including unused Phase0/vendor code | 70.74% (423/598) | 74.00% (518/700) | 58.65% (78/133) | 65.26% (62/95) |

These are tool-reported measurements. The coverage run emits many missing-anchor warnings; instrumentation completeness is UNVERIFIED. Escrow lines/statements/functions exceed the 90% target, but branch coverage does not. Passing named transition/boundary tests cover the seven implemented Phase 2 transitions, not every possible caller/state/time combination or future disputes. Full-P0 transition coverage remains unimplemented and unverified. Do not equate a percentage with an audit or absence of defects.

The four named invariant obligations pass: two Phase 1 per-token checks plus Phase 2 conservation and executable bounded exits. Phase 2 Foundry displays two invariants together in one 128-run/8192-call campaign; it should not be described as two independent 8192-call campaigns. The handler uses real production transitions, explicit seed success counts and snapshot drain assertions to avoid vacuous success. Fuzzing remains finite and some randomized handler actions may be no-ops; no exhaustive state proof is claimed.

Foundry also warns that a cached RED invariant failure was ignored after target selectors changed. That historical cache warning is retained in the final log; it is separate from the current successful campaign and was not suppressed. Earlier pre-additional-test logs remain preserved separately.
