import { spawnSync } from 'node:child_process';
const files = ['scripts/phase5-backend-evidence-receipt-corrected.test.mjs','scripts/phase5-backend-upload-content.test.mjs','scripts/phase5-backend-malformed-pdf.test.mjs','scripts/phase5-backend-evidence-reference-collision.test.mjs','scripts/phase5-backend-evidence-idempotency.test.mjs','scripts/phase5-evidence-migration-preservation.test.mjs'];
const result = spawnSync(process.execPath, ['--experimental-strip-types','--test',...files], {stdio:'inherit',windowsHide:true,env:{...process.env,RUST_LOG:process.platform === 'win32' ? 'debug' : process.env.RUST_LOG}});
if(result.error) throw result.error;
process.exitCode = result.status ?? 1;
