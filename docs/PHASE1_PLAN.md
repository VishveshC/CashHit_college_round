# Phase 1 implementation plan

Requirements: F-01/F-02/F-03/F-85, A-01 and applicable contract-only foundations S-01/S-02/S-04–S-11/S-15/S-18/S-20/S-21/S-30/S-31/S-82/S-84. UI aspects and future funded exits remain gaps.

Public seam: typed constructor token/protocol config; createJob(JobInput,MilestoneInput[]), acceptJob, fundJob, permissionless proposal/funding expiry, withdraw, typed job/milestone and per-token ledger getters. No Tier B, delivery settlement or dispute code.

Tests-first: separate GPT-6 Luna Max test agent writes unit/illegal-action/boundary tests plus a handler-based per-token solvency invariant and raw-amount fuzz tests. It captures RED before the contract agent implements. Tests are not weakened or removed to pass. Positive withdrawal tests use only a derived fixture under contracts/test, backed by genuine test funding.

File ownership:
- contracts/test/**: test agent; isolated hostile tokens and harness.
- contracts/src/FairworkEscrow.sol and src/mocks/**: implementation agent, after red gate.
- spec.md/DECISIONS.md, scripts, foundry config and dependency pin, packages/chain, requirement trace, evidence and phase report: parent.
- Independent security review: read-only third agent, then fixes through the owning implementation agent with added regression tests.

Gate: real direct create/accept/fund tests; wrong caller/state/input and hostile token rollback; E-1/E/E+1 proposal/funding cases; per-token solvency across randomized call ordering; withdrawals cannot expose principal; no admin money path. Compile, tests, invariant/fuzz, coverage, dependency/source secret checks, and attempted Slither analysis produce saved actual command output. No UI/full escrow completion is inferred.
