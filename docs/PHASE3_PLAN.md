# Phase 3 plan

Scope F-30/F-31/F-32/F-33/F-34/F-35/F-45 and applicable partial S safeguards; local-only arbitration. Stakes, slashing, salaries, public VRF, UI/privacy backend and Tier B excluded by D-08/D-09. Decisions A-28 through A-35 and fixed seams in PHASE3_API.md precede all behavior edits.

Files planned: contracts/src/FairworkEscrow.sol escrow wiring/deposit/ruling; contracts/src/FairworkArbitration.sol bounded phases/registry/selection; contracts/src/interfaces/IRandomness.sol adapter boundary; contracts/src/mocks/MockRandomness.sol local demo; contracts/test/Phase3*.t.sol plus test-only fixtures; scripts/public-build-check.mjs fail-closed demo release guard; shared generated ABI; spec/DECISIONS/trace/README/PROGRESS and Phase3 evidence/review/state/walkthrough reports.

Tests owner writes public-API negative cases, all timing matrices, full/partial replacement/fresh second panel/no quorum and retry fallback, matched/unmatched deposit forfeiture/fuzz conservation and hostile exact-deposit reentrancy. Real runtime RED against unchanged Phase2 must be saved/frozen before source builder proceeds. Reviewer read-only checks tests before freeze and source after. Parent owns docs/tooling/final gates and self-review. Prior frozen manifests all remain byte-identical. Shared builds sequential. STOP at report, wait GO PHASE4.
