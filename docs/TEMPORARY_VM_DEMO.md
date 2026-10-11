# Temporary VM demo — 2026-10-11

Status: removed on 2026-10-11 at the user's request. The hostname block, web service, owned Anvil process, isolated source/tools, temporary installers/scripts/logs, certificate and dedicated service account were removed. Other Caddy sites remain configured. The information below records the former deployment.

User explicitly authorized temporary VM hosting and removal of the password gate. URL: https://fairwork.141.148.199.4.sslip.io . HTTPS is publicly accessible without Basic Auth. Unauthenticated page and configuration requests both succeeded after removal.

This is an isolated synthetic Anvil demo, not a production or mainnet release. VM source: `/opt/fairwork-temp-20261011`. Node24.11.1 and Anvil1.8.5 are installed under `/opt/fairwork-tools-20261011`. None of the frozen local app/test/financial sources were changed. The copied demo received exact-host SIWE/Origin/CSP wiring, a bounded same-origin read-only RPC route, the Unix process-record correction and a compatibility fix accepting omitted empty JSON-RPC params.

Next runs as the unprivileged `fairwork-demo` account through `fairwork-temp.service`, with filesystem restrictions, bound to 127.0.0.1:3105. Anvil is bound to 127.0.0.1:8545 and is never directly proxied. Caddy adds only this hostname and validates before reload; the original configuration is saved as `/etc/caddy/Caddyfile.before-fairwork-20261011`.

Fresh reset and local-target build succeeded on the VM. Live HTTPS checks passed: unauthenticated page401; authenticated page200; configuration200 with expected host/chain31337; chain-read200; admin method rejected400; nonce200. Browser sign-in succeeded and agreement26 loaded Funded/Ready; registry showed6/128. Original seeded private terms remain sealed by design; create a new agreement for private-text/file workflows. Browser proof: `temporary-vm-demo-browser.txt`, `temporary-vm-demo.png`.

All wallets/tokens are synthetic and shared among visitors. No local private database, runtime secret or historical encrypted backup was uploaded. This temporary service is not enabled for boot; the mock chain is a running disposable process. A VM reboot requires restoring/reseeding it, so no restart/persistence guarantee is claimed. Existing VM sites were not replaced. Public production build refusal remains intact.

Stop web: `ssh VM systemctl stop fairwork-temp`. Stop this owned Anvil only: use `/opt/fairwork-tools-20261011/node-v24.11.1-linux-arm64/bin/node scripts/local-stop.mjs` from the isolated clone. Remove only the added hostname block after validating Caddy; do not restore the whole backup over later unrelated edits. Retain runtime/data until deliberately approved for cleanup.
