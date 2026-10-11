import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const config=path.resolve('.gitleaks.toml');
const executable=process.env.GITLEAKS_BIN || path.join(process.env.USERPROFILE,'.gitleaks/bin/gitleaks.exe');
function scan(name,line){
 const dir=mkdtempSync(path.join(os.tmpdir(),'fairwork-scanner-'));
 const docs=path.join(dir,'docs'),file=path.join(docs,name);mkdirSync(docs);writeFileSync(file,line+'\n');
 try{const result=spawnSync(executable,['dir','--config',config,'--no-banner','--redact',dir],{encoding:'utf8',windowsHide:true});if(result.error)throw result.error;assert.ok(result.status===0||result.status===1,result.stderr);return result.status;}
 finally{unlinkSync(file);rmdirSync(docs);rmdirSync(dir);}
}
test('A49 exact public token fields in the two receipt proofs are accepted',()=>{
 assert.equal(scan('phase4-browser-payment-chain-proof.json','"token": "0x5FbDB2315678afecb367f032d93F642f64180aa3",'),0);
 assert.equal(scan('phase4-browser-wbtc-chain-proof.json','"token": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",'),0);
});
test('A49 the public-address exemption cannot suppress another source path',()=>{
 assert.equal(scan('unrelated.json','"token": "0x5FbDB2315678afecb367f032d93F642f64180aa3",'),1);
});
test('A49 a secret-like token in an exempted proof still fails scanning',()=>{
 assert.equal(scan('phase4-browser-payment-chain-proof.json','"token": "'+randomBytes(24).toString('hex')+'",'),1);
});
