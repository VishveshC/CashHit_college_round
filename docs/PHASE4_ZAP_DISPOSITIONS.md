# Actual ZAP passive baseline

ZAP 2.17.0 scanned 45 local URLs using the unauthenticated traditional spider and passive rules. The actual report contains 102 alert occurrences: 0 High, 27 Medium, 2 Low and 73 Informational. This is neither an authenticated scan nor an active penetration test; private screens, stateful arbitration and client-only routes are outside its coverage.

| Rule / finding | Occurrences | Disposition |
|---|---:|---|
| 10055 script-src unsafe-eval | 9 Medium | Accepted only for this localhost development runtime. Production CSP needs nonce/hash based scripts without eval; public builds remain blocked. |
| 10055 script-src unsafe-inline | 9 Medium | Same explicit local CSP limitation. Existing plain-text rendering and authorization are independently tested, but these directives reduce CSP defense. |
| 10055 style-src unsafe-inline | 9 Medium | Local Next/React style allowance; production policy remains unresolved. |
| 10096 Unix timestamp disclosure | 2 Low | Both reported values occur in public bundled dependencies (viem and React), rather than private timestamps or session records. They reveal no private Fairwork object. |
| 10027 suspicious comments | 66 Informational | Reviewed all reported excerpts and URLs: dependency/framework comments, TODOs and examples in development chunks. No runtime secret or private content appears in those excerpts; separate client/source secret scans remain required. |
| 10109 modern web application | 7 Informational | Coverage advisory, not an exploit finding. A traditional unauthenticated spider cannot prove all client/stateful behavior. |

Every occurrence is retained with its URL/evidence in `phase4-zap-baseline.json`; grouped dispositions above cover all six reported finding names. No finding is silently suppressed, and zero High alerts does not establish a safe public release.
