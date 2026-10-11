# Phase 5 independent UI and release review

**Status: public release remains blocked.** The first audit snapshot found three UI boundary defects: unsaved proposal state survives a wallet-role switch, private data is not cleared at the server session expiry, and a transaction confirmation is not revalidated before the wallet send. The first was reproduced in the running UI. Follow-up source review added cross-tab session invalidation and unknown generic transaction receipt handling to the audit; their frozen RED tests are listed below. The initial A-52/A-53 fixes are present in the shared source, but I have not run a fresh compiled-browser pass after those edits.

This review covers the local Fairwork browser UI, its public transaction/private-state helpers, and the documented public-build gate. It did not change production files. Findings below describe the pre-fix source state captured by the RED tests and browser log.

## Findings

### Medium — unsaved private proposal survives a wallet switch

**Exploit.** A Client enters private terms in “Create a private agreement,” closes the form without submitting, and switches to the seeded Freelancer role in the same browser. Reopening the form as Freelancer shows the Client’s unsaved title, and the remaining proposal fields/drafts are held in the same component state. The live repro used `PHASE5_DRAFT_PRIVATE_SENTINEL`; no proposal or transaction was submitted.

**Requirement and source.** HERO_PROMPT.md §3 says private text and secrets are not public and that private access follows the signed wallet; spec.md P-04 requires private data to be authorized by the applicable party. `clearPrivate` clears server-loaded terms, notes, files, evidence, audit events, vote secrets and pending private saves at `apps/web/components/EscrowDashboard.tsx:245-249`, but does not clear the proposal `agreement`, `milestoneDrafts`, `showAgreement`, or `confirmSummary` state declared at lines 157-160. Demo-role changes call `logout()` at lines 442-454, so the role switch reaches that incomplete reset. The browser capture is in `docs/phase5-ui-wallet-switch-red.log`.

**Regression proof.** `apps/web/test/phase5-ui-private-state.test.ts` requires the reset behavior for loaded private values, unsaved proposal fields, milestone drafts, and open private dialogs. It failed because the expected public reset helper is absent. This test is deliberately paired with the actual browser repro, so the helper assertion alone is not being presented as proof of the original defect.

### Medium — private UI cache outlives its 30-minute session

**Exploit.** After the server session expires, private terms and other already-loaded plaintext remain in React state until sign-out, role change, or page teardown. A person using the unattended tab can still read it even though the backend will deny later private API calls. The UI renders the session expiry time but does not use it to invalidate the session or clear the private cache.

**Requirement and source.** spec.md A-37 limits a session to 30 minutes; P-04 requires authorized private access. `Session.expiresAt` is declared at `apps/web/components/EscrowDashboard.tsx:52` and used for session identity (`177-195`) and display (`1154`); the component has no expiry timer or current-time check. `clearPrivate` is only reached through sign-out and wallet/account change in the reviewed paths. The browser session was not kept open for 30 minutes, so this is a source-confirmed cache-lifetime finding, not an elapsed-time reproduction.

**Regression proof.** `apps/web/test/phase5-ui-private-state.test.ts` also requires a session-current predicate to reject a wallet mismatch and the exact expiry boundary. It failed because that predicate is absent.

### Medium — transaction context can change while the confirmation is open

**Exploit.** A user opens a transaction confirmation for one wallet/chain/agreement. The wallet account or network changes while the modal is open. Clicking Continue still enters the captured send closure: the action context is checked before confirmation, while wallet/job freshness is checked only in receipt follow-ups. A stale confirmation can therefore reach the wallet signer after its displayed context stopped matching the active wallet/network.

**Requirement and source.** HERO_PROMPT.md §3 requires human-readable transaction summaries and the canonical `spec.md` §11 S-60–S-66 requires network enforcement and role/state gating. `apps/web/components/EscrowDashboard.tsx:567-604` captures the account/job and checks action policy before calling `runContractAction`; its context predicate is used in receipt/follow-up paths. `apps/web/lib/client/transactions.ts:20-25` checks the chain, awaits confirmation, then calls `send()` without a post-confirmation validator.

**Regression proof.** `apps/web/test/phase5-ui-transaction-context.test.ts` changes the active context while the confirmation resolves and asserts that validation runs before `send`; the pre-fix action sent instead, so the test failed with “Missing expected rejection.”

## Checks reviewed

- **Exact token arithmetic and allowance:** no defect found in the reviewed path. Amount conversion uses integer token units, exact approval uses the computed raw amount, and the confirmation summary includes token address/symbol plus raw and formatted amounts. Existing `apps/web/test/ui.test.ts` includes decimal and large-integer checks. These are scoped green checks, not an independent proof of every confirmation path.
- **Typed commitments and plaintext handling:** the existing commitment helper uses typed/domain-separated commitments with salts; server responses use `cache: "no-store"`. The wallet-switch finding is a client-memory lifetime leak in the proposal form, not evidence of localStorage or a public API leak.
- **Evidence retry after receipt uncertainty:** the existing A-48 tests cover evidence-specific duplicate blocking for an unknown outcome and permit retry only after a definitive revert. This review did not find a regression in that evidence-entry guard. Generic transaction uncertainty is covered separately below; it concerns the general transaction path rather than the evidence-entry guard.
- **Local dev RPC, time warp, mock randomness, and unlocked demo roles:** reviewed paths are explicitly local-build/origin gated. The source public-build gate rejects `--target public` because no approved production adapter/configuration exists. That rejection is a release blocker; it is not a successful public build and does not prove a clean production artifact. Phase 4 records that `npm run build:public` exits before compilation and creates no public artifact (`docs/PHASE4_REPORT.md:24, 47-55, 64-65`).

## Release evidence and gaps

HERO_PROMPT.md §11 requires all applicable Tier A browser flows, failsafes, legal transitions and boundaries, fuzz/invariant coverage, an absent-dev-controls production artifact with a build check, and accurate docs. The current evidence does not meet that gate:

- `docs/PHASE4_REPORT.md:64-65` explicitly leaves full Tier A browser execution, every transition/boundary, and production artifact verification unproven.
- The public build check intentionally fails closed before compilation. No production artifact exists to inspect for wallet switchers, time warp, seed routes, mock randomness, or unlocked demo keys.
- `REQUIREMENTS_TRACE.md` still lists applicable rows such as S-12–S-14 and S-60–S-66 as `GAP / applicability review`; many X threat-review rows are also gap placeholders. A passing local test count does not close those unmapped requirements.
- The retained Phase 4 contract coverage and Slither outputs are supplemental evidence. Their percentages and bounded fuzz/invariant runs do not establish every state transition or every Tier A exit condition; Phase 4 itself labels full browser acceptance unverified.

The new RED run is intentionally limited to the two new test files: 0 passed, 3 failed. Exact output, browser steps/AX text, screenshot capture digest, and frozen-file hashes are recorded in `docs/phase5-ui-tests-red.log`, `docs/phase5-ui-wallet-switch-red.log`, and `docs/phase5-ui-frozen-tests.json`. The screenshot was captured inline by CUA (43,935 bytes, SHA-256 `cb4338910c760ed652b68abe4ff7c40f78431ede38ab4109e0ab79604a4a17e4`); CUA did not expose a workspace file sink, so the manifest records the digest with `local_file: null` rather than claiming a PNG file is present.

## Follow-up review of the A-52/A-53 source changes

The shared source now resets same-tab proposal/private state, closes pending confirmations, invalidates private-read generations, schedules session expiry clearing, clears on a current-session 401, and revalidates account/job/provider-chain plus the fresh action policy before eligible contract writes. The SIWE flow checks account/network before requesting a wallet signature and rejects a returned session that no longer matches the current wallet. These changes address the original same-tab A-52/A-53 findings at source level. The existing RED tests for their helper and transaction-pipeline seams do not exercise the React component, provider event ordering, or a compiled browser after the fixes.

### Medium — signing out in one tab leaves another tab's private view open

**Exploit.** Sign in to the same browser session in two tabs, load private agreement terms in both, then sign out or switch roles in one tab. The server revokes the shared cookie/session, and that tab clears its React state. The other tab has no cross-tab invalidation listener: its local session object still matches its wallet and local expiry, so cached private text remains rendered until that tab's own expiry timer fires or a later private API request receives a 401. A user who takes over the second tab after sign-out can read the still-rendered terms.

**Requirement and source.** DECISIONS.md A-52 requires clearing every private view at wallet/session boundaries. `apps/web/lib/server/routes.ts:407-413` revokes the shared server session and expires the cookie. `EscrowDashboard.logout` clears only its own React instance (`apps/web/components/EscrowDashboard.tsx:418-423`); there is no `BroadcastChannel` or storage listener. The other tab computes `accountMatchesSession` from its local session/wallet/expiry at line 207 and renders cached private terms when that value is true at lines 1214 and 1230.

**Regression proof.** `apps/web/test/phase5-ui-cross-tab-session.test.ts` expects an invalidation subscription to clear the receiving view. It is RED because the public invalidation seam is absent. The test output and hash freeze are `docs/phase5-ui-cross-tab-session-red.log` and `docs/phase5-ui-cross-tab-session-frozen-tests.json`.

### Medium — an unknown generic receipt outcome permits another contract send

**Exploit.** A transaction is broadcast and the wallet returns its hash, but the receipt RPC times out. `runContractAction` currently reports `failed` for the timeout; the component clears `busy`, leaves chain freshness unchanged, and renders neither the failed hash nor an unknown-outcome banner. The user can repeat a still-open proposal form; `createAgreement` generates new random salts/commitments and may create a second proposal if the first transaction actually mined. The evidence-specific A-48 duplicate guard does not cover this generic proposal path.

**Requirement and source.** spec.md S-60–S-66 includes disabling duplicate submit; A-47 requires stale-chain gating after transaction receipts. `apps/web/lib/client/transactions.ts:40` maps the caught wait error to `failed`. `apps/web/components/EscrowDashboard.tsx:623` captures the broadcast hash, `652` clears `busy` on exit, and `1182-1183` renders only `pending` and `confirmed` transaction banners. A receipt timeout never reaches the `confirmed` status callback that marks chain state refreshing.

**Regression proof.** `apps/web/test/phase5-ui-unknown-transaction.test.ts` expects a timeout after a returned hash to produce `pending → unknown`, retain the hash for reconciliation, emit no definitive receipt outcome, and avoid refetch. It also requires a predicate that blocks new sends for `pending` and `unknown` but not `failed` or `confirmed`. The pre-fix run produced 1 pass and 2 failures; a definitive revert remains `pending → failed`. See `docs/phase5-ui-unknown-transaction-red.log` and `docs/phase5-ui-unknown-transaction-frozen-tests.json`.

### A-53 sign-in verification gap to close

The sign-in path validates account/network after the confirmation modal and before `signMessage`, then checks the returned session after posting the signature to `/api/auth/login`. If the wallet changes while the signature prompt is open, the old-wallet signature can still be posted; a mismatched response is then logged out and does not unlock this tab. No persistent exposure was reproduced. Rechecking wallet/network immediately after signing and before posting the login request would close the gap; the current transaction-context test does not exercise this SIWE prompt race.

## Post-fix source review and remaining release limits

The RED logs above preserve the pre-fix state and are historical evidence; they do not mean those exact defects remain in the current source. After the shared UI edits, I reran the five owned Phase 5 test files: **8 passed, 0 failed**. The frozen-test checker reports all four Phase 5 manifests and their frozen files unchanged. The parent reported a successful compiled local build and 88/88 web tests before the final confirmation-summary test was added; I did not repeat the full suite or build, and I did not conduct a post-fix browser run.

The current component now clears proposal drafts and open private dialogs on same-tab wallet/session changes and on session expiry, rejects stale private reads, revalidates account/job/provider chain and fresh action policy after confirmation, and wires cross-tab invalidation for logout/login, direct session revocation, and a current-session 401. The original wallet-switch exposure was reproduced in the browser before the fix. The cross-tab helper and current UI wiring were source-checked; I did not reproduce a second live tab after the fix. A-52's documented suspended-page limitation remains: a hidden or suspended tab may not process its timer or broadcast immediately, while server authorization still applies to subsequent requests.

The generic receipt path now distinguishes a known revert from a post-hash unknown outcome. For the latter, it keeps the original hash and captured follow-up closure, blocks further sends in this view, and offers a read-only “Check original receipt” action. A confirmed check resumes the captured receipt/follow-up path with the original hash and no new wallet send; an explicit revert clears the fence and permits retry. The focused tests passed for this helper behavior and the frozen pre-fix run showed the former misclassification. I did not inject a timeout in the compiled browser. A-54 records two intentional limits: the in-memory fence is lost on reload and does not coordinate with another tab.

There is also an accepted privacy-first recovery limit in A-54: when wallet/session context changes while a receipt is unknown, `clearPrivate()` discards the captured private follow-up closure but preserves the public transaction hash. If that hash later confirms a new agreement, the on-chain commitments cannot reconstruct the erased plaintext or salts, so the proposal's private terms may be unrecoverable unless the user retained a separate copy. This prevents the old wallet's private text from being carried into the new view; it is not full private-data recovery.

A-56 closes the final proposal-confirmation summary gap at source level. The modal now shows each actual title, description, scope, delivery rule, and milestone criterion beside its corresponding typed commitment. The frozen focused test passed and confirms markup-like input stays a literal string for React text rendering; no salt is included. The earlier test failure was a missing helper, not a browser exploit reproduction.

### Low — final proposal confirmation originally showed only hashes (fixed)

**Impact.** A client could enter an unintended title, rule, scope, or acceptance criterion and reach the final wallet prompt without being able to verify the plaintext being committed; the prompt showed only opaque commitment hashes while covering the proposal form. The signature still committed the supplied values correctly, but the last confirmation did not let the client review them in readable form.

**Requirement and source.** HERO_PROMPT.md §3 requires human-readable transaction summaries containing terms. Before the fix, `createAgreement` populated `summary.terms` with the hashes in `commitments`, including each `criteria.N` hash. `ConfirmModal` rendered those values as the final review. The current implementation uses `buildPrivateConfirmationTerms` from `apps/web/lib/client/private-view-policy.ts` and displays the plaintext alongside each hash; React renders these strings as text.

**Regression proof.** `apps/web/test/phase5-ui-confirmation-terms.test.ts` was frozen RED before the helper existed, and is now GREEN. Its manifest/log are `docs/phase5-ui-confirmation-terms-frozen-tests.json` and `docs/phase5-ui-confirmation-terms-red.log`. The test checks title, description, scope, delivery rules, every criterion, matching hashes, and literal markup-like text. It does not claim a compiled-browser exploit reproduction.

Exact-amount review found no defect in the scoped path: token parsing and formatting use integer arithmetic, displayed transaction summaries include both formatted and raw units plus token address, and allowance changes are zeroed before setting the exact required amount. Private commitments follow A-38's tagged ABI hash over plaintext hash and fresh salt. These are scoped source/test checks, not proof of every possible confirmation or token behavior.

The evidence-specific path keeps its retry identity in memory. A receipt timeout leaves the same file/text entry marked submitted and blocks another send; checking a definitive revert resets that exact entry to retryable, while a confirmed receipt records its event before a later click can continue the next item in a file-plus-text submission. The existing evidence regression coverage and current source support “same entry, no duplicate resend” within the live page. The second item is continued by pressing the evidence action again after reconciliation; a reload loses the private entry and the generic in-memory fence, as A-54 discloses.

One remaining transaction edge is outside the A-54 after-hash regression: `runContractAction` marks the broadcast flag only after `send()` returns a hash. If a wallet/RPC accepts a transaction but loses the response before returning its hash, the action is reported `failed` and this UI has no hash to reconcile. That response-loss case was not reproduced or covered by the frozen tests and should remain an explicit limitation unless a safe nonce-based recovery path is added.

Public release is still blocked. The public build gate intentionally exits before compilation because no approved production adapter/configuration exists; that proves fail-closed gating, not a clean public artifact. Phase 4 still leaves complete Tier A browser execution, every boundary/illegal transition, and full fuzz/invariant anchors unverified. The local build and web-test pass do not close those section 11 requirements.

Final root post-fix UI evidence is now available: phase5-browser-cross-tab-green.txt, phase5-browser-wallet-switch-green.txt, phase5-browser-confirmation-green.txt and their rendered screenshots. Subsequent SIWE/session-context supplemental hardening and the Ready label correction have a final compiled build/full89-test run and final job0 smoke inspection, not another full UI walkthrough. No captured final browser console errors/warnings; original pre-fix reproduction remains preserved. This does not close the full Tier A UI acceptance gap.
