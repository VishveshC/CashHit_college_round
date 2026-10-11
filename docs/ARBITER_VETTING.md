# Arbiter eligibility process

F-45 / D-09 require human identity review before registry admission. This document defines the process; no real person has been vetted in this local prototype. Local tests use throwaway wallets only and establish owner-only registry mechanics, not identity assurance.

1. A designated operator reviews identity through a private channel, confirms wallet control with a fresh domain-bound signature, and checks conflicts with the intended client/freelancer population. Do not submit private identity details to the chain or public repository.
2. The operator records the review outcome and any expiry/revocation reason in access-controlled off-chain storage. Only an eligible wallet address goes to the immutable owner's addArbiter transaction; failed reviews get no registry admission.
3. The operator verifies the registry transaction receipt and current eligibility before representing admission as complete. The chain caps the pool at 128 and rejects zero/duplicate entries; these checks do not prove one person controls only one wallet.
4. Recheck eligibility and conflicts when circumstances change. Removal affects future draw snapshots, while an already assigned arbiter retains their current voting right; the owner cannot replace a drawn seat or move money by removing it.

The private review/storage/signature application is not implemented. Funding does not enforce the intended production pool minimum locally; short draws use tested fallback semantics. Wallet identities remain pseudonymous, Sybil resistance is operational rather than a chain guarantee, and production selection needs a approved randomness adapter and separate review. Do not infer production approval from this process or the contract tests.
