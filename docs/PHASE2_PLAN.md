# Phase 2 plan

Scope: F-10/F-11/F-12/F-13/F-20/F-21/F-22/F-24/F-86, real pull-payment settlement and Closed transition. F-23 is Tier B and excluded despite the phase range shorthand. Disputes remain Phase 3. A-23 through A-27 in spec/DECISIONS record the compatible seam before implementation.

Public seams: the seven milestone mutators, job/milestone/submission/ledger getters, immutable responseWindow; existing create/accept/fund/withdraw/config remain compatible. Test boundary matrices E-1/E/E+1 at delivery/grace/review/response; revisions0/1/5 and independent counters; immutable bounded version history; exact conservation, double settlement and closure; public timeout rightful claims; token failure isolation; stateful nondisputed bounded exits.

Test agent owns new Phase2*.t.sol only, records real RED through interface calls against unchanged Phase1 implementation (unknown selectors revert). Builder owns FairworkEscrow.sol only after RED/freeze authorization. Reviewer read-only and owns PHASE2_REVIEW.md. Parent owns spec/decisions, docs/evidence/tooling/trace. All Phase1 files/evidence remain frozen and must pass unchanged. No persistent deployment/UI/TierB.
