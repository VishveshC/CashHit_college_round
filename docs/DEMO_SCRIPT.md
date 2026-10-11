# Local click-through demo

Run `npm run demo:reset`, then `npm run dev:web`. Open http://localhost:3000; use only the printed throwaway demo roles and job IDs. Reset rotates local secrets and erases the prior owned demo content.

1. Select Client and sign the displayed localhost SIWE request. Expected: authenticated wallet and pinned chain/contract information; no real name, email or phone requested.
2. Load the printed Ready job, then inspect Submitted, Rejected, Disputed and Closed jobs. Expected: distinct job/milestone states, raw-unit-derived token formatting and source-labelled events.
3. Create an agreement as Client with private text, one milestone, the printed Freelancer address and MockUSDC. Expected: readable transaction summary, confirmed receipt and encrypted private terms matching the public commitments.
4. Switch to Freelancer and sign in; load the new ID and accept. Expected: only the named freelancer can accept before the proposal deadline.
5. Switch to Client and fund. Expected: exact allowance followed by funding, locked principal and a chain-derived delivery deadline.
6. Switch to Freelancer, upload a small `.txt` deliverable and submit. Expected: confirmed public hash/reference with encrypted file storage and Submitted state.
7. Switch to Client, download the authenticated attachment and approve before review end. Expected: Closed job/Released milestone and a freelancer claim, with no token transfer claimed yet.
8. Switch to Freelancer and withdraw. Expected: wallet-level claim reaches zero and withdrawn tracking increases after a successful receipt.
9. For a dispute, use a new Submitted job as Client to open with the exact deposit; switch to Freelancer to match, then commit evidence. An attachment plus text uses two evidence slots, each with its own confirmed hash/reference.
10. Advance the chain clock to the evidence boundary, request a panel, fulfill its known mock request and advance immediately when entropy is ready. Switch to an assigned arbiter, sign in, read authorized case materials and commit a separately salted vote; reveal only in the proper window, then settle or exercise the bounded fallback.
11. After resolution, refresh as the arbiter. Expected: revoked private case access and cleared private caches; the parties retain their eligible reads until retention deletes off-chain content.
12. Run `npm run attack-lab` for the automated hostile cases and `npm run demo:stop` when done. Expected: attacks revert or fail as intended; only recorded owned processes stop.

This script describes the implemented flow. The report distinguishes browser steps actually performed from command/factory proofs; the existence of this script is not execution evidence.

## Phase 5 changed-flow verification
Current evidence: cross-tab session invalidation clears the first tab; reauthentication reopens an empty draft. Client-to-Freelancer switch also opens an empty draft. Proposal confirmation displays actual plaintext/hash pairs, 2.500001 USDC and 2500001 raw units; the scoped browser proposal was cancelled before wallet send. Unknown receipt tests cover the pipeline and source fence/reconciliation; no browser RPC-timeout reproduction was performed. Prior Phase4 payment/arbitration walkthroughs are historical snapshots; a full Tier A UI matrix is still pending. Current raw evidence and screenshots are in phase5-browser-* and PHASE5_REPORT.md.
