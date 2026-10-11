# Phase 3 fixed public test seams

Local-only A-28 through A-35; all amounts raw units. Old constructor and public read shapes unchanged. Engine and MockRandomness deployed immutably in escrow constructor. New windows equal protocol fundingWindow; depositBps=200. No behavioral source changes before RED/freeze.

## Escrow API

- addArbiter(address), removeArbiter(address): owner only.
- arbiterCount() returns uint256; arbiterAt(uint256) returns address; isArbiter(address) returns bool.
- arbitrationEngine() returns address; randomness() returns address.
- disputeConfig() returns (uint64 evidenceWindow,uint64 commitWindow,uint64 replacementCommitWindow,uint64 revealWindow,uint64 randomnessTimeout,uint16 depositBps).
- openDispute(uint256 jobId,uint256 milestoneIndex) returns uint256 disputeId.
- matchDisputeDeposit(uint256 disputeId).
- submitEvidence(uint256 disputeId,bytes32 evidenceHash,bytes32 opaqueReference).
- advanceDispute(uint256 disputeId): anyone, one bounded phase step or request retry, terminalizes in same transaction on ruling/fallback.
- commitVote(uint256 disputeId,bytes32 commitment).
- revealVote(uint256 disputeId,uint16 bps,bytes32 salt).
- voteCommitment(uint256 disputeId,address arbiter,uint16 bps,bytes32 salt) returns bytes32.
- getMilestoneDispute(uint256 jobId,uint256 milestoneIndex) returns uint256 (0 if unopened; invalid job/index reverts).
- disputeDeposits(address token) returns uint256; arbiterStakes(address token) returns uint256 (always 0 in P0).
- getDispute(uint256 disputeId) returns DisputeView below; unknown reverts InvalidState.
- getPanel(uint256 disputeId,uint8 round) returns address[3], round 1 or 2; unknown/invalid round reverts; unselected round yields zero seats.
- getPanel1History(uint256 disputeId) returns address[], bounded length <=6.
- getVote(uint256 disputeId,uint8 round,address arbiter) returns (bytes32 commitment,uint16 bps,bool revealed); unknown/invalid round reverts, an unvoted address returns defaults.
- getEvidence(uint256 disputeId,address party,uint256 index) returns (bytes32 evidenceHash,bytes32 opaqueReference,uint64 submittedAt); only named party address and valid index, public read metadata.

DisputeView exact ABI order:
```
uint256 jobId;
uint256 milestoneIndex;
address client;
address freelancer;
address token;
uint256 amount;
uint256 depositAmount;
address opener;
uint8 phase;
uint8 round;
uint8 purpose;
uint8 attempt;
uint64 openedAt;
uint64 evidenceDeadline;
uint64 commitDeadline;
uint64 replacementCommitDeadline;
uint64 revealDeadline;
uint64 requestEnd;
uint256 activeRequestId;
bool randomnessReady;
uint16 rulingBps;
bool fallbackApplied;
bool clientDeposited;
bool freelancerDeposited;
uint8 clientEvidenceCount;
uint8 freelancerEvidenceCount;
uint8 fallbackReason;
```
Phase enum values: NotOpen=0, Evidence=1, RandomnessPending1=2, Panel1Commit=3, ReplacementRandomnessPending=4, Panel1ReplacementCommit=5, Panel1Reveal=6, RandomnessPending2=7, Panel2Commit=8, Panel2Reveal=9, Settled=10.
Purpose: InitialPanel=0, Replacement=1, SecondPanel=2. Attempt starts 0, retries 1/2 only; globally unique nonzero requestId. FallbackReason None=0, PoolExhausted=1, RandomnessTimeout=2, NoQuorum=3.

## Adapter boundary

IRandomness.requestRandomness(uint256 requestId) external. Engine.fulfillRandomness(uint256 requestId,uint256 word) external authenticated adapter only, entropy storage only. MockRandomness.fulfill(uint256 requestId) external DEMO ONLY (internally derives deterministic word=uint256(keccak256(abi.encode(block.chainid,address(mock),consumer,requestId)))), routes callback to the consumer registered by requestRandomness; unknown provider request reverts InvalidState. Repeated fulfillment intentionally reaches consumer ignore logic. MockRandomness.setRequestMode(uint8) external DEMO ONLY: 0 normal asynchronous, 1 revert request, 2 synchronously callback the same internally derived word. Engine reserves request binding before external request, so mode2 can only record entropy and never settle/advance. Mode1 leaves bounded timeout/retry/fallback reachable. No caller supplies entropy through escrow or mock APIs. Test-only vm.prank(provider) can exercise the authenticated callback with chosen values. At the first request of each draw, freeze the eligible candidates for that draw and all its retries; later registry edits apply to later draws.

## Custom errors

Keep existing Unauthorized(),InvalidState(),WindowOpen(),WindowClosed(),InvalidCommitment(),InvalidAmount(),InvalidAddress(),ExactTransferRequired(),TokenCodeChanged(address). New errors InvalidArbiter(),ArbiterLimitReached(),EvidenceLimitReached(),InvalidVote(). Escrow and engine use identical selectors for shared errors; no textual revert requirement except hostile token fixtures. Existing Phase 1/2 error precedence stays compatible. New actor entrypoints check real dispute, role, phase/window then content; public advance rejects premature advancement with WindowOpen and invalid/terminal state with InvalidState.

## Event minimum ABI

Engine: ArbiterAdded(address indexed arbiter), ArbiterRemoved(address indexed arbiter); EvidenceCommitted(uint256 indexed disputeId,address indexed party,uint8 version,bytes32 evidenceHash,bytes32 opaqueReference,uint64 submittedAt); PanelRequested(uint256 indexed disputeId,uint256 indexed requestId,uint8 purpose,uint8 attempt,uint64 requestEnd); RandomnessReceived(uint256 indexed disputeId,uint256 indexed requestId); PanelSelected(uint256 indexed disputeId,uint8 round,address[3] panel); PanelPhaseAdvanced(uint256 indexed disputeId,uint8 phase,uint64 deadline); VoteCommitted(uint256 indexed disputeId,uint8 round,address indexed arbiter,bytes32 commitment); VoteRevealed(uint256 indexed disputeId,uint8 round,address indexed arbiter,uint16 bps); DisputeRuled(uint256 indexed disputeId,uint16 bps); DisputeFallbackApplied(uint256 indexed disputeId,uint8 reason).
Escrow: DisputeOpened(uint256 indexed disputeId,uint256 indexed jobId,uint256 indexed milestoneIndex,address opener,uint256 depositAmount,uint64 evidenceDeadline); DisputeDepositMatched(uint256 indexed disputeId,address indexed party,uint256 amount); DisputeSettlementCredited(uint256 indexed disputeId,address indexed token,address indexed account,uint256 amount,uint8 source), source Principal=0 DepositRefund=1 Forfeiture=2; MilestoneResolved(uint256 indexed jobId,uint256 indexed milestoneIndex,uint256 indexed disputeId,uint16 bps,uint256 freelancerCredit,uint256 clientCredit,uint256 treasuryCredit,bool fallbackApplied), credits include principal and refunded deposit, treasury only forfeitures. Compatible ClaimableCredited and final JobClosed remain. Zero credits need not emit; role aliasing such as treasury=client remains additive.

## Engine forwarding guard and pool timing

Externally callable engine addArbiter(address), removeArbiter(address), and submitEvidence(uint256 disputeId,address actor,bytes32 evidenceHash,bytes32 opaqueReference) require the immutable escrow before checking arguments or state. Direct callers cannot impersonate a forwarded party. Other engine mutators also require escrow; fulfillRandomness alone is authenticated to the provider.

Initial/second draw requests enter pending even if the snapshot is short; consuming accepted entropy later applies PoolExhausted when fewer than three candidates exist. Request failure leaves pending and follows retries/RandomnessTimeout irrespective of count. Sparse replacement continues with available/zero seats and one replacement window. PanelRequested attempt records retries and PanelSelected round=2 records the fresh panel; the old full-target extra event names remain future design, not current ABI obligations.

A-29 adapter-request authorization clarification before implementation: MockRandomness records its deploying engine as immutable consumer and requestRandomness(requestId) requires that consumer before argument/state checks. Other callers cannot front-run the consumer's reserved request IDs. There is no consumer/provider setter. Fulfill(id) and request-mode controls remain explicit public DEMO-only controls; they are unsafe for public funds and the release gate rejects their public build.

Dispute IDs begin at 1 and increase monotonically; zero is the unopened milestone sentinel.

A-31 vote-error clarification for additive review regression: an existing dispute outside the permitted commit or reveal phases rejects the respective vote action with InvalidState. Inside a permitted voting phase, a non-current-seat actor rejects with Unauthorized before timing/content checks. This distinguishes unavailable phases from an invalid assigned actor; unknown disputes still reject InvalidState and direct engine callers still fail onlyEscrow first. Payout and timing rules do not change.
