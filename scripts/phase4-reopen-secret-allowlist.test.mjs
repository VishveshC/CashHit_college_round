import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const config=path.resolve('.gitleaks.toml');
const executable=process.env.GITLEAKS_BIN || path.join(process.env.USERPROFILE,'.gitleaks/bin/gitleaks.exe');
const tokenKey=['to','ken'].join('');
const prefix=['0','x'].join('');
const publicTokens=[
 ['5FbDB2315678afec','b367f032d93F642f','64180aa3'].join(''),
 ['e7f1725E7734CE28','8F8367e1Bb143E90','bb3F0512'].join(''),
];
const tokenLine=address=>`"${tokenKey}": "${prefix}${address}"`;

function scan(relativePath,line){
 const dir=mkdtempSync(path.join(os.tmpdir(),'fairwork-reopen-scanner-'));
 const file=path.join(dir,...relativePath.split('/'));
 const parent=path.dirname(file);
 mkdirSync(parent,{recursive:true});
 writeFileSync(file,line+'\n');
 try{
  const result=spawnSync(executable,['dir','--config',config,'--no-banner','--redact',dir],{encoding:'utf8',windowsHide:true});
  if(result.error)throw result.error;
  assert.ok(result.status===0||result.status===1,result.stderr);
  return result.status;
 }finally{
  unlinkSync(file);
  if(parent!==dir)rmdirSync(parent);
  rmdirSync(dir);
 }
}

test('A60 allows the two exact public token lines at the two exact reopen proof paths',()=>{
 for(const file of ['docs/phase4-reopen-chain-proof.json','docs/phase4-reopen-chain-proof-prior.json']){
  for(const address of publicTokens)assert.equal(scan(file,tokenLine(address)),0);
 }
});

test('A60 cannot suppress the public addresses at another path',()=>{
 assert.equal(scan('docs/unrelated.json',tokenLine(publicTokens[0])),1);
});

test('A60 cannot suppress an arbitrary secret-like token at the exempted path',()=>{
 for(const file of ['docs/phase4-reopen-chain-proof.json','docs/phase4-reopen-chain-proof-prior.json']){
  assert.equal(scan(file,tokenLine(randomBytes(24).toString('hex'))),1);
 }
});
