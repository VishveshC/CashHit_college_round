import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function check(name, args, log) {
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(path.join(root, 'docs', log), (run.stdout || '') + (run.stderr || ''));
  if (run.error || run.status !== 0) throw new Error(`${name} failed; inspect docs/${log}`);
  console.log(`PASS ${name}; evidence docs/${log}`);
}
check('contract hostile regression cases (fresh in-process EVM)', ['scripts/forge-test.mjs', '--match-test', 'Reentr|Reentry|TransferFailure|FeeOnTransfer|FalseReturn|Surplus|CannotRepeat|Copy|WrongSalt|Unauthorized|Premature|NoQuorum|OwnerOnly|Principal'], 'phase4-attack-lab-contract.txt');
check('private route attacks (real SQLite and signatures; controlled chain port)', ['--experimental-strip-types', '--test', 'apps/web/test/security-corrected.test.ts'], 'phase4-attack-lab-security.txt');
check('deployed local-chain attacks', ['scripts/phase4/attack-lab.mjs'], 'phase4-attack-lab-deployed.txt');
const result = JSON.parse(readFileSync(path.join(root, 'infra/local/runtime/attack-lab-result.json'), 'utf8'));
if (result.outcome !== 'PASS' || result.cases.some(item => !['reverted', 'rejected_by_rpc'].includes(item.result))) throw new Error('Unexpected deployed attack outcome');
writeFileSync(path.join(root, 'docs/phase4-attack-lab-deployed.json'), JSON.stringify(result, null, 2) + '\n');
console.log('Attack Lab completed. HTTP/browser checks and passive ZAP scan are separate evidence.');
