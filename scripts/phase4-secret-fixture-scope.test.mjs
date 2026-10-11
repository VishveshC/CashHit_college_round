import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const config=path.resolve('.gitleaks.toml');
const executable=process.env.GITLEAKS_BIN || path.join(process.env.USERPROFILE,'.gitleaks/bin/gitleaks.exe');
const source=readFileSync('scripts/phase4-secret-allowlist.test.mjs','utf8');
const fixtures=source.split(/\r?\n/).filter(line=>line.includes('assert.equal(scan(')&&/0x[0-9a-fA-F]{40}/.test(line));
assert.equal(fixtures.length,3);
function scan(name,text){
 const dir=mkdtempSync(path.join(os.tmpdir(),'fairwork-scanner-fixture-'));
 const scripts=path.join(dir,'scripts'),file=path.join(scripts,name);mkdirSync(scripts);writeFileSync(file,text+'\n');
 try{const result=spawnSync(executable,['dir','--config',config,'--no-banner','--redact',dir],{encoding:'utf8',windowsHide:true});if(result.error)throw result.error;assert.ok(result.status===0||result.status===1,result.stderr);return result.status;}
 finally{unlinkSync(file);rmdirSync(scripts);rmdirSync(dir);}
}
test('A49 only the exact frozen public-address assertions are accepted at their source path',()=>{
 assert.equal(scan('phase4-secret-allowlist.test.mjs',fixtures.join('\n')),0);
});
test('A49 a generated replacement value in that assertion still fails scanning',()=>{
 const changed=fixtures[0].replace(/0x[0-9a-fA-F]{40}/,'0x'+randomBytes(20).toString('hex'));
 assert.equal(scan('phase4-secret-allowlist.test.mjs',changed),1);
});
test('A49 the same public source assertion under another path still fails scanning',()=>{
 assert.equal(scan('unrelated-source.test.mjs',fixtures[0]),1);
});
