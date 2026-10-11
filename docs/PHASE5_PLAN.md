# Phase 5 execution boundary

User authorized Phase 5 on 2026-10-11. Three independent GPT-6 Luna Max reviewers inspect contracts, backend security, and browser/release behavior against the canonical spec and Hero Prompt. They must distinguish confirmed defects, missing proof, and accepted limitations; assuming ten mistakes is a hostile-review posture, not a quota of invented findings.

Reviewers own new review documents and additive public-interface tests only. Root owns decisions, production fixes, shared chain/build runs, final integration, and reporting. Existing frozen tests and original failure logs remain unchanged. A confirmed defect needs a failing regression captured and hashed before its fix. Any already-green additional check is labeled supplemental proof.

Baseline source hashes are recorded in `phase5-source-baseline.json`; current baseline runs are `phase5-contract-baseline.txt` (109 passes), `phase5-web-baseline.txt` (81 passes), and `phase5-tooling-baseline.txt` (22 passes). These counts do not establish the release checklist.

After the reviews: record behavioral decisions before fixes; run relevant frozen regressions; rerun contract/application/tooling suites and local build; run fresh coverage, Slither, dependency and source/client secret scans; reset/deploy/seed, Attack Lab and receipt verification; inspect the rendered final application and targeted changed flows; verify frozen-file integrity and stop owned local services. Retain unsuccessful outputs rather than overwriting them with success.

Section 11 is the final gate. Full Tier A UI coverage and exact boundary mapping must be evidenced or marked unverified. The public build currently fails closed before producing any artifact; do not claim that this demonstrates a clean public artifact. No public provider integration, deployment, mainnet, Tier B, Git commit or push is authorized by this phase. The required human backup video and missing original source PDF cannot be fabricated.
