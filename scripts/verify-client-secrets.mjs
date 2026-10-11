import {readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const env=JSON.parse(readFileSync(path.join(root,'infra/local/runtime/server-env.json'),'utf8'));
const privateValues=['AES_256_GCM_MASTER_KEY','SESSION_SECRET'].map(key=>env[key]);
if(privateValues.some(value=>typeof value!=='string'||value.length<32))throw new Error('Missing runtime canary material');
const files=[];
function walk(dir){for(const name of readdirSync(dir)){const full=path.join(dir,name);if(statSync(full).isDirectory())walk(full);else files.push(full);}}
walk(path.join(root,'apps/web/.next/static'));
let bytes=0;
for(const file of files){const data=readFileSync(file);bytes+=data.length;for(const secret of privateValues){if(data.includes(Buffer.from(secret)))throw new Error('Server runtime secret found in built client: '+path.relative(root,file));}}
const result={scope:'actual local Next static client assets; two current runtime secret canaries',files:files.length,bytes,matchedSecrets:0,publicArtifact:'absent: public build blocked'};
writeFileSync('docs/phase4-client-canary-scan.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
