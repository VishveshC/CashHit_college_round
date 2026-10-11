# Phase 3 function walkthrough

Source-verified walkthrough for the local Phase 3 implementation. The old escrow constructor and Phase 1/2 public data shapes remain intact; this walkthrough follows the added API in `PHASE3_API.md` and the current four contract files. The full 109-test run passed, while root-owned coverage and static-analysis gates remain separate.

## Escrow and engine entry points

- **addArbiter(address):** The escrow permits only its owner to add an arbiter and forwards the call to the immutable engine. The engine rejects zero or duplicate addresses and caps the active registry at 128.
- **removeArbiter(address):** The escrow permits only its owner to remove an active arbiter. Swap-pop changes future draw eligibility but leaves request snapshots and already assigned panel rights unchanged.
- **arbiterCount():** This escrow view returns the active registry size. It grants no authority to add or remove arbiters.
- **arbiterAt(uint256):** This escrow view returns the active arbiter at an index. An out-of-range index reverts instead of returning a default address.
- **isArbiter(address):** This escrow view reports current registry membership. Removal does not revoke a seat already assigned by the engine.
- **arbitrationEngine():** This view returns the immutable arbitration engine deployed by the escrow constructor. It is metadata and does not grant access to engine mutations.
- **randomness():** This view returns the immutable DEMO adapter created by the engine. The predictable mock is suitable only for local tests and is excluded from public builds.
- **disputeConfig():** This view returns all five immutable windows and the fixed deposit rate. Each window equals the deployment-time funding window, and the deposit rate is 200 basis points.
- **openDispute(uint256,uint256):** The client may open a Submitted milestone before its review deadline, and either named party may open a Rejected milestone before its response deadline. The escrow computes `D = max(1, floor(amount * 200 / 10000))`, marks the milestone Disputed, and collects an exact token delta; a transfer, codehash, or amount mismatch reverts the whole transaction.
- **matchDisputeDeposit(uint256):** Only the named counterparty may post the one matching deposit before the evidence deadline; the opener cannot match their own deposit. The escrow adds the amount to per-token `disputeDeposits` and requires an exact incoming token delta, with transaction rollback on transfer or codehash failure.
- **submitEvidence(uint256,bytes32,bytes32):** Either named party may add up to five nonzero evidence hashes before the evidence deadline. The engine stores only the hash, opaque reference, and timestamp, so this call neither uploads evidence content nor extends the window.
- **advanceDispute(uint256):** Anyone may advance one due engine step, including a request retry, panel transition, or terminal result. When the engine reports a ruling or fallback, the same escrow call runs ledger settlement in the same transaction.
- **commitVote(uint256,bytes32):** The engine requires an existing dispute in a voting phase, then checks that the caller holds a current seat before checking the window and commitment. A wrong phase returns `InvalidState`, while a non-seat during a valid voting phase returns `Unauthorized`.
- **revealVote(uint256,uint16,bytes32):** The engine accepts a reveal only from a current seat in the corresponding reveal phase and before its deadline. It verifies the stored commitment, one-time reveal status, and 0–10000 bps range before counting the vote.
- **voteCommitment(uint256,address,uint16,bytes32):** This view computes the chain-, escrow-, dispute-, and arbiter-bound digest for wallet preparation. It intentionally hashes a supplied dispute ID without checking whether that dispute exists and does not authorize a vote.

## Escrow read API

- **getMilestoneDispute(uint256,uint256):** The escrow validates that the job and milestone index exist before consulting the engine. It returns zero for an unopened milestone and a permanent nonzero dispute ID after opening.
- **getDispute(uint256):** This view returns the fixed `DisputeView` ABI, including phase clocks, request metadata, deposit flags, evidence counts, ruling, and fallback reason. Unknown dispute IDs revert with `InvalidState` rather than looking like empty disputes.
- **getPanel(uint256,uint8):** This view returns one of the two fixed-size panel arrays. Unselected seats are zero addresses, while an unknown dispute or round outside 1/2 reverts.
- **getPanel1History(uint256):** This view returns the bounded history of initial and replacement Panel 1 assignees. The fresh Panel 2 draw excludes all addresses in that history even if the owner later removes them from the active registry.
- **getVote(uint256,uint8,address):** This view returns the selected arbiter's commitment, revealed bps, and reveal flag for round 1 or 2. A valid round with no vote returns zero/default fields; an unknown dispute or invalid round reverts.
- **getEvidence(uint256,address,uint256):** This public view returns the selected named party's hash, opaque reference, and timestamp at a valid index. The party argument must be the client or freelancer, but reads are not limited to that party as caller.
- **disputeDeposits(address):** This per-token counter records only posted dispute deposits that remain a liability before settlement. It is incremented with each deposit and reduced by the posted deposits settled in the same transaction as claim credits.
- **arbiterStakes(address):** This compatibility view always returns zero in Tier A. No stake, salary, slash, or stake-liability path is enabled.

## Settlement and withdrawal boundary

- **_settleDispute(uint256,uint16,bool):** The escrow partitions principal by the ruling, refunds posted deposits net of applicable forfeiture, and caps an absent party's deduction at that party's principal payout. It removes the matching locked-principal and posted-deposit liabilities and adds account credits to `claimable` and `totalClaimable` without making any token call; aliases such as treasury=client accumulate additively.
- **withdraw(address):** A claimant separately withdraws an already credited balance, and the escrow checks the pinned token codehash around the transfer. If token delivery fails, the withdrawal transaction reverts and its claim remains available for a later attempt.

## Randomness boundary

- **IRandomness.requestRandomness(uint256):** This interface contains only the request call, with the engine reserving its request binding before calling the provider. The deployed mock accepts requests only from its immutable engine consumer, preventing other callers from reserving the engine's IDs.
- **FairworkArbitration.fulfillRandomness(uint256,uint256):** Only the immutable adapter may call the engine callback. It records an eligible active word before `requestEnd`, ignores stale, duplicate, expired, or wrong-phase callbacks, and never selects a panel or touches escrow balances.
- **MockRandomness constructor:** Construction is restricted to local chain 31337 and binds the deploying engine as the immutable consumer. No consumer setter can redirect requests or callbacks.
- **MockRandomness._word(uint256):** This private helper hashes chain ID, adapter address, consumer, and request ID without a caller-provided seed. Its output is deterministic and predictable demo entropy.
- **MockRandomness.requestRandomness(uint256):** Mode 0 records an asynchronous request, mode 1 reverts, and mode 2 calls back synchronously after marking the request known. A failed request is caught by the engine, while a synchronous callback can only store the reserved entropy for a later advance.
- **MockRandomness.fulfill(uint256):** Any local caller may trigger a known request and the mock derives its word internally, so the caller cannot select entropy. Repeated fulfillment is allowed to exercise the engine's duplicate-callback no-op.
- **MockRandomness.setRequestMode(uint8):** This public DEMO ONLY control selects asynchronous, reverting, or synchronous request behavior. It can affect draw availability and must remain excluded from public builds.

## Raw-unit accounting examples (illustrative only, not test output)

These are arithmetic examples from the settlement formula, not test assertions or coverage claims. Let principal `A = 1001` raw units and deposit `D = max(1, floor(A * 200 / 10000)) = 20`, with only the client having posted a deposit.

| Outcome | Freelancer claim | Client claim | Treasury claim | Total |
| --- | ---: | ---: | ---: | ---: |
| Normal 7000 bps | 700 | 301 | 20 | 1021 |
| Normal 3000 bps | 280 | 721 | 20 | 1021 |
| Normal 5000 bps | 490 | 511 | 20 | 1021 |
| Fallback 5000 bps | 500 | 521 | 0 | 1021 |
| Normal 0 bps | 0 | 1021 | 0 | 1021 |

At 0 bps, the absent freelancer deposit cannot create debt because its forfeiture is capped by the freelancer's zero principal payout. When treasury aliases either party, its forfeiture credit adds to that party's existing credit; withdrawal later reduces `claimable` and `totalClaimable` by the amount transferred.

## Engine implementation helpers

- **constructor / onlyEscrow:** The engine fixes its escrow, creates its demo adapter, and copies the validated local duration into each arbitration window. Every forwarded mutation checks that exact escrow address before processing arguments, while the separately authenticated adapter callback only records entropy.
- **openDispute / matchDisputeDeposit:** The engine records a nonzero permanent milestone binding, named parties, opening time and deposit flags supplied by the escrow. It has no token access; the escrow transaction must pay the exact deposit or all engine changes roll back.
- **_beginDraw / _requestAgain / _request:** A new draw snapshots eligible candidates and reserves its request ID, purpose, phase, attempt and deadline before the external request. Retrying keeps the same candidates, and caught provider failure leaves a due public timeout instead of trapping funds.
- **_consumeEntropy / _select:** Accepted entropy picks without replacement from the fixed candidate snapshot, while short full panels fall back and short replacements leave empty seats. Each operation copies at most 128 candidates and assigns at most three seats; no caller chooses the entropy word through the escrow.
- **_markMissingPanel1Commits / _beginReveal:** At the first commit deadline the engine marks at most three uncommitted seats for one replacement draw. The shared replacement deadline always leads to reveal, so noncommitters cannot trigger an endless replacement loop.
- **_applyRuling / _applyFallback:** Valid current-seat reveals determine a floored mean or sorted median, and the engine records one terminal result. Fallback records 5000 with a separate reason/flag; the escrow uses that distinction to refund deposits fully without forfeiture.
- **_eligible / _isPanelMember / _currentRound / _isRandomnessPending:** These helpers enforce party exclusions, bounded Panel 1 history and the active panel/request phase. Current assignments survive later registry removal, while displaced originals and every past Panel 1 assignee cannot gain fresh-panel rights.
- **_voteCommitment / _disputeOrRevert / _milestoneKey / _now64:** The engine computes the exact domain-bound vote digest and permanent job/milestone key, rejects unknown disputes, and bounds timestamp conversion. These helpers grant no voting or payout authority and use checked integer arithmetic.

- **_calculateDisputeSettlement:** This pure helper computes the principal split, posted-deposit refunds and forfeitures, and capped deductions for deposits that were never posted. It uses only checked raw-unit arithmetic, keeping the money calculation separate from the atomic ledger changes without any external call.
- **_emitDisputeCredit:** This helper emits both the explicit credit component and compatible claimable-credit event when a credit is nonzero. It grants no additional balance or authority, so events describe the ledger updates rather than deciding them.
