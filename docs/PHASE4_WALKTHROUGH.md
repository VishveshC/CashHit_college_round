# Phase 4 application walkthrough

`readJobSnapshot` verifies the local chain and immutable deployment code hashes, then reads the job, milestone history, disputes and token ledgers. It never infers a payment from a UI label: principal is locked, settlement creates a claim, and withdrawal transfers that claim separately.

`deriveActionPolicy` maps the current wallet, role, state and chain timestamp to available actions. The contract checks the same boundaries again, so a stale countdown cannot authorize a forbidden payment.

`runContractAction` checks the network before showing a readable confirmation and sending the transaction. It waits for a successful receipt before refreshing state, and treats a reverted receipt as failure.

`noncePOST` creates a short-lived nonce bound to a browser challenge; `loginPOST` consumes it once and verifies the SIWE domain, URI, chain and signature. The server stores only hashed session tokens and expires or revokes the session independently of the browser.

`jobPUT`, `notePOST` and `evidencePOST` compare private salted commitments with actual chain records before encrypting content. Private salts remain off-chain and cannot be replaced with a caller-supplied role assertion.

`fileUploadPOST` checks metadata, supported content signatures and size before encrypting to a random private filename. These guards reject active HTML/SVG and ambiguous names but are not a complete file parser or malware scanner.

`fileDownloadGET` issues a short-lived session-bound ticket; `fileContentGET` rechecks the current case role and exact file hash/reference. Downloads are attachments with no-store and nosniff, and an old arbiter loses server access when its assignment or case ends.

`readChainEvents` combines the escrow and immutable arbitration engine logs in block/transaction/log order. The API labels append-only metadata separately, so off-chain access logs cannot masquerade as chain settlement events.

`runRetention` verifies actual Closed state, closure time and either the 90-day interval or a fresh named-party deletion signature. It validates storage boundaries before cleanup and keeps non-content audit metadata; interrupted file cleanup may be partial and must be safely retried.

The local RPC bridge permits only known throwaway accounts and bounded calls to pinned contracts. The build guard refuses public output while the deterministic, publicly controllable demo randomness adapter remains in use.
