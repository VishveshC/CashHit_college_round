# Phase 5 passive ZAP evidence

ZAP 2.17.0 scanned the compiled local HTTP application without authentication: spider status 100%, passive queue zero, 18 URLs and 11 alert occurrences. Raw evidence: `phase5-zap-alerts.json`, `phase5-zap-urls.json`. Counts: High 0, Medium 9, Low 0, Informational 2. This narrower compiled scan is not a directly comparable replacement for Phase 4's 45-URL development scan or a penetration test.

| Finding | Occurrences | Disposition |
|---|---:|---|
| CSP script-src unsafe-eval | 3 Medium | Accepted only for this explicitly local prototype; unresolved public hardening blocker. |
| CSP script-src unsafe-inline | 3 Medium | Same local-only disposition; nonce/hash policy must be implemented and verified before release. |
| CSP style-src unsafe-inline | 3 Medium | Same local-only disposition; public style policy remains unresolved. |
| Modern Web Application | 2 Informational | Scanner characterization, not a reproduced exploit. No fix claimed. |

The scan did not exercise authenticated private routes, hostile wallet prompts, suspended tabs, adversarial RPC or active attacks. Local HTTP lacks public HTTPS/HSTS assurance. Startup briefly lacked a listening port while ZAP provisioned add-ons; the later version endpoint, completed spider and empty passive queue prove the successful run. Add-on updates were requested disabled; logs show initial add-on provisioning nevertheless occurred. The Java process is stopped at handoff.
