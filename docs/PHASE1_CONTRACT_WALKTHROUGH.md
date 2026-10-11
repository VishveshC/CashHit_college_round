# Phase 1 contract walkthrough

This explains the foundation only. Every amount is an integer in the selected token's raw units; no currency conversion happens. The source is contracts/src/FairworkEscrow.sol. The derived withdrawal harness under contracts/test is never a deployable marketplace API.

- **constructor:** Fixes the treasury, local chain, vetted token addresses/code hashes, raw amount bounds and timing bounds at deployment. It rejects invalid configuration and has no later owner setter that can move principal or claims; whitelist curation is still trusted, and code hashes cannot detect a proxy's implementation or future token rebases.
- **createJob:** Stores a client's immutable agreement with one named freelancer and one to ten independent milestones. Nonzero commitments, distinct parties, vetted token, checked raw amounts and bounded durations/revisions reject malformed jobs, and no token transfer occurs.
- **acceptJob:** Lets only the named freelancer accept before the proposal expires and starts a fresh funding window. An expired proposal, wrong caller or repeated acceptance reverts without changing the agreement.
- **fundJob:** Lets only the client fund an accepted job before its funding deadline and starts all milestone clocks together. The contract guards reentry and requires its token balance to rise by the exact total, rolling back state and transfers if that check fails.
- **cancelExpiredProposal:** Lets anyone close a proposal at or after its proposal deadline. It moves no funds and cannot cancel an accepted or funded job.
- **cancelUnfundedJob:** Lets anyone close an accepted job at or after its funding deadline. It cannot run early or touch a funded job, and it moves no funds.
- **withdraw:** Sends only the caller's existing claim in a selected token back to that caller. It clears the claim before the guarded transfer and checks exact escrow debit and recipient credit; any failed or inexact transfer restores the claim through transaction rollback.
- **getJob:** Reads parties, amounts, states and timing fields for an existing job. It cannot modify balances and rejects an unknown job ID; sequential IDs do not provide privacy or authorization.
- **getMilestone:** Reads one milestone's immutable amount, duration and commitment plus its clocks and state. It rejects an unknown job or out-of-range index and cannot settle anything.
- **getJobCommitments:** Reads the four agreement commitment hashes omitted from the compact creation event. It reveals no plaintext or salt, but hashes and wallets are public and the later private backend must use strong fresh salts.
- **tokenConfig / protocolConfig:** Expose the immutable token whitelist and timing configuration. They have no setter, so users can inspect the rules without granting the owner money powers.
- **ledger getters:** Read locked principal, individual claims and total claim liabilities independently for each token. Direct donations remain surplus and never create a user claim.
- **_creditFromEscrow (internal):** Moves backed locked principal into a recipient's claim without sending tokens. Only the derived test harness exposes this helper in Phase 1, so positive withdrawal tests prove the payment primitive but do not prove a real settlement or terminal milestone.

## Local demo tokens

- **constructor:** `MockUSDC` and `MockWBTC` inherit the local demo token base, whose constructor rejects every chain ID except 31337. This prevents these mintable mocks from being deployed on a public network by mistake.
- **decimals:** `MockUSDC` reports a fixed six decimals and `MockWBTC` reports a fixed eight decimals. These values describe raw-unit formatting only; the token names and symbols do not indicate issuer backing or market value.
- **mint:** Anyone can mint arbitrary raw units to fund a local walkthrough. Mint access is intentionally unrestricted for the demo, so neither mock represents a real stablecoin or bitcoin-backed asset.

Phase 2 must add atomic milestone settlement and bounded exits before this becomes a usable escrow. Funded milestones remain Ready and funds stay locked in the current partial build; use throwaway local mocks only.
