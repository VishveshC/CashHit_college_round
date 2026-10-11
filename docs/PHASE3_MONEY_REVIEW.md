# Phase 3 Money-Path Review

Status: **Source review complete; no material money-path or authorization defect found.** This was a read-only review. I did not run Foundry or rely on test pass output; root will provide the final runtime evidence separately.

Reviewed source snapshot (SHA-256):

- `contracts/src/FairworkEscrow.sol`: `FC28871ECE735EA4BB38D7AED153D4B6D5C874EFA33F43468DDF66D9BF9F4ED0`
- `contracts/src/FairworkArbitration.sol`: `E821E13D67248127665EB076E60A3713AF52CB438040F29920CB347CE596FCB2`
- `contracts/src/mocks/MockRandomness.sol`: `DC24D2F69E135E77AC5A37590203547D0DEF2148D1242715B1F1067BEF9C30A2`
- `contracts/src/interfaces/IRandomness.sol`: `A6762D42031985E1A8388808F640B0684D2AED7683EA0AC9846E0996DDB74C4E`

## Deposit collection and rollback

`openDispute` accepts only a funded milestone in `Submitted` or `Rejected`. The client alone may open from `Submitted` before `reviewEnd`; either named party may open from `Rejected` before `responseEnd`. The milestone amount remains the principal in `lockedEscrow`. The opener's deposit is `max(1, floor(amount * 200 / 10,000))` raw token units. The function marks the milestone disputed, creates its one-time engine record, adds the deposit to `disputeDeposits[token]`, and then transfers. It compares the escrow's before/after token balances with the exact required amount. A failed transfer, changed code hash, or non-exact receipt reverts the entire transaction, including the milestone, engine record, and liability updates. See `FairworkEscrow.sol:391-437`.

`matchDisputeDeposit` delegates party/opener/state/window/duplicate checks to the engine, then applies the same token allowlist, code-hash, exact-delta, and rollback checks. Only the counterparty can post once and only before the evidence deadline. See `FairworkEscrow.sol:440-455` and `FairworkArbitration.sol:257-276`. Both escrow entrypoints are `nonReentrant`.

## Ruling arithmetic and ledger conservation

`_calculateDisputeSettlement` is a private pure helper, so it cannot read or change ledger state. It computes the freelancer share with floor rounding, `floor(amount * bps / 10,000)`, and assigns the remainder to the client. For a non-fallback ruling above 5,000 bps, the client owes one deposit; below 5,000, the freelancer owes one; at exactly 5,000, each owes `floor(D/2)`. A posted deposit supplies that party's forfeiture. If that party did not post, the same amount is deducted from that party's principal credit, capped at that credit. Fallback skips all forfeitures and refunds each posted deposit in full. See `FairworkEscrow.sol:956-994`.

The two conservation identities are explicit in the code: principal credits plus principal deductions sent to treasury equal the milestone amount; deposit refunds plus deposit forfeitures sent to treasury equal the deposits actually posted. `_settleDispute` subtracts that principal from `lockedEscrow[token]`, subtracts only posted deposits from `disputeDeposits[token]`, adds the three credits to the account ledgers, and increments `totalClaimable[token]` by their sum. Thus the claim increase equals the removed principal plus removed posted deposits. All values remain in raw units and all liability maps are per token. `arbiterStakes[token]` has no write path in this P0 slice and remains zero. See `FairworkEscrow.sol:191-202` and `917-954`.

Party/treasury aliases remain additive: the client, freelancer, and treasury entries are each added to `claimable[token][account]`, while `totalClaimable` increases by the aggregate once. No equality or distinct-address assumption is used. The focused test is `test_F34_TreasuryAliasPartyReceivesAdditiveCredits` in `contracts/test/Phase3Accounting.t.sol`.

Settlement performs no token call or token code-hash check. It reads the dispute view from the engine, validates that the job is still funded and the milestone is still disputed, then changes milestone/job state and internal liabilities. The only external read is `getDispute`; there is no ERC-20 `balanceOf`, `transfer`, or `transferFrom` in `_settleDispute`. Withdrawal remains separate: it can withdraw only `claimable[token][msg.sender]` and enforces exact escrow debit and recipient credit. See `FairworkEscrow.sol:916-954` and `814-837`. `test_F34_RulingCanSettleAfterTokenCodeChangesAndAllTokenCallsRevert` exercises the settlement boundary without making a build claim here.

## Terminal state, access control, and owner powers

A ruling can settle only while the job is `Funded` and the milestone is `Disputed`. The function marks it `Resolved`, increments `terminalMilestoneCount`, and closes the job only when that count reaches `milestoneCount`; the state check and one-way milestone state prevent a second settlement. The disputed milestone does not prevent a different funded milestone from settling. See `FairworkEscrow.sol:917-954` and the existing `_settleMilestone` path at `1072-1090`.

Every external state-changing escrow function is protected by `nonReentrant`. The two owner-only functions are `addArbiter` and `removeArbiter`; they change only the bounded registry. Dispute opening, deposit matching, evidence, commit, and reveal pass the real caller to the engine for party/seat checks. `advanceDispute` is permissionless but cannot select a payee: the engine returns only terminal status, ruling basis points, and fallback status, and escrow pays the fixed parties/treasury. See `FairworkEscrow.sol:343-352`, `391-472`, and `519-837`.

The engine's registry, dispute, evidence, vote, and advance mutators require its immutable escrow through `onlyEscrow`. Its only non-escrow mutator is `fulfillRandomness`, which requires the immutable adapter and only records timely entropy. See `FairworkArbitration.sol:147-150`, `167-189`, `205-415`, and `343-356`.

`owner` and `treasury` are immutable constructor values; there is no owner setter, liability rescue, arbitrary credit, payout redirect, deposit withdrawal, or stake withdrawal. The deployer chooses the treasury address once at construction, as specified by A-28/A-32/D-13. The owner can withdraw only a claim payable to that same address as an ordinary claimant under `withdraw`; registry authority does not grant access to anyone else's liabilities. The internal `_creditFromEscrow` helper is not an external payout selector.

One intentional local-only boundary remains: `MockRandomness.requestRandomness` accepts only its immutable engine consumer, but `fulfill(id)` and `setRequestMode(mode)` are public DEMO controls. Any local caller can trigger a known deterministic callback or force future requests to revert, which can change timing or cause the specified timeout fallback; no caller can supply the entropy word. This is not a production randomness or fairness guarantee. The public-build checker rejects packaging the mock for a public target (`scripts/public-build-check.mjs:10`), and production VRF remains blocked by the documented provider/retry conflict. The checker is a release-tool safeguard, not an on-chain production guarantee.

## Remaining scope limits

This review supports the contract accounting and authorization portion of the local Phase 3 slice only. It does not establish the off-chain identity-vetting process (F-45), encrypted/private evidence storage and access control (F-31), production VRF selection or production deployment (F-32), arbiter stake/slash/salary behavior, UI flows, or a professional security audit. These remain explicitly outside the Phase 3 local contract claim under `spec.md:142-153` and A-34.
