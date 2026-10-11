# Phase 2 parent self-review

Reviewed source snapshot: 04D50E1E442F4120E4D11203A90BAED20989CA2605C74E8A5FCEDF2E4DC4E706. This is a bounded source review, not a professional audit.

All seven external milestone mutators are nonReentrant. Named-party actions load a real job, check the caller and Funded/milestone state, then reject expired windows; public timeout callers cannot supply a payout recipient. Submit/reject/resubmit validate nonzero commitments and bounded counters. Checked uint64 additions revert atomically on overflow; such failed party actions leave the existing timeout available.

_appendSubmission appends rather than rewriting old versions, increments at most to revisionLimit+1 <= 6, and uses the current timestamp for each fresh reviewEnd. Rejection counts remain independent per milestone. The retained rejectedAt/responseEnd/reason fields are historical after resubmission; current Submitted state rejects rejection-refund attempts.

_settleMilestone is private and called only after a valid transition gate. It changes milestone state, subtracts exactly the principal from lockedEscrow, adds the same amount to the fixed beneficiary and total claims, increments terminal count and closes only at milestoneCount. It contains no loop, token call or codehash check. Released/Refunded state or Closed job blocks repeated settlements; direct token surplus does not feed claim creation. The old internal fixture helper remains without any production external selector.

Withdraw retains effects-before-interaction, caller-only claims, the reentrancy guard, pinned token codehash and exact debit/credit checks. Issuer transfer/runtime failure rolls back a withdrawal and preserves the claim. It can still prevent actual token delivery; settlement independence does not cure issuer failure.

Event source/reason/credit/closure fields match A-27 and the actual generated ABI. State diagrams distinguish current nondisputed behavior from future arbitration. No money-path mismatch found in this snapshot. Independent review identified a missing exhausted-limit silence assertion; a separate additive test now proves it and passes without source changes. Negative-case tests do not exhaust every possible role/state/time combination, and invariants remain finite randomized evidence.
