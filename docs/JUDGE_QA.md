# Judge Q&A — Phase 5 honest answers

1. **What does it solve?** Named parties lock milestone funds and receive rightful claims through review, timeout or arbitration, with private terms off-chain.
2. **Is it deployed for real money?** No. Local chain 31337, mock USDC/WBTC/randomness; zero public deployments. Public artifact creation is blocked.
3. **Can the owner take principal?** Reviewed owner functions cannot redirect principal/claims; ledger and adversarial tests pass. Treasury can receive explicit forfeited dispute deposits under the agreed rules.
4. **Can funds get stuck?** Finite local state models have bounded public exits, including retries/replacement/fallback. Someone must submit timeout transactions; hostile issuers can still prevent token withdrawal.
5. **What is private?** Salted text commitments are public; encrypted text/files stay server-side with fresh wallet/case authorization. Hashes do not hide public payment metadata or prevent every inference. This is not zero-knowledge privacy.
6. **What did the independent review find?** Evidence recovery/reference/retry defects, active/malformed PDF acceptance, private draft/session boundaries, stale signing context, unknown receipt handling and unreadable proposal consent. A50–A56 fix the scoped issues; remaining limitations are disclosed in PHASE5_FINDINGS.md.
7. **What actual checks pass?** Contracts 122, web 89, tooling 22, new backend 21 reported tests; build/trace, 15 HTTP checks, Attack Lab, two-reset demo and 488 receipt references. Core line coverage 99.33%/99.09%, overall 83.27%, with instrumentation warnings.
8. **Why not claim full completion?** Complete Tier A UI/individual P0 proof, public artifact, production VRF/policies/identities, operational backups and a recorded backup video remain missing. Passive ZAP has 9 local CSP Medium alerts, no Highs; this is not release certification.
9. **Can failed private saves and unknown transactions recover?** Exact evidence writes are idempotent, and known hashes can be checked without resending in the same view. Reloads/other tabs/pre-hash loss are not coordinated. Changing private context erases unsaved plaintext; a mined proposal cannot reconstruct it from hashes.
10. **Is the data backed up and the system audited?** No production backup or professional audit. Existing DB rows survived the local index migration. Its executed backup omitted the old key, so later reset prevents private-content recovery from that ciphertext; future helper key copying is unexercised. Three independent Luna Max source reviews are saved, with honest gaps.

