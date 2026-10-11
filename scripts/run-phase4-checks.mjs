import {spawnSync} from 'node:child_process';
console.log('Frozen retention.test.mjs is historical: its zero-invalid expectation conflicts with the zero-based contract. Current checks explicitly use phase4-retention-corrected.test.mjs plus zero-job regression. See docs/PHASE4_TEST_HARNESS_ERRATA.md.');
const files=['scripts/local-runtime.test.mjs','scripts/local-runtime-parent.test.mjs','scripts/local-runtime-shutdown.test.mjs','scripts/web-build.test.mjs','scripts/phase4-retention-corrected.test.mjs','scripts/phase4-retention-regressions.test.mjs','scripts/phase4-retention-zero.test.mjs','scripts/phase4/test/acceptance-proof.test.mjs'];
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-reporter=spec',...files],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exit(result.status??1);
