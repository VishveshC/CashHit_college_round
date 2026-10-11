import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,rmSync,lstatSync} from 'node:fs';
import path from 'node:path';import {randomBytes} from 'node:crypto';import {execFileSync} from 'node:child_process';
const markerText='fairwork-phase4-local-runtime-v1';
async function removeOwnedTarget(base,dir,name){
 const target=path.resolve(dir,name);
 if(path.dirname(target)!==dir||!['private.db','private.db-journal','private.db-wal','private.db-shm','storage'].includes(name))throw new Error('Refuse removal outside owned runtime');
 const deadline=Date.now()+3000;
 for(;;){
  for(const parent of [base,path.join(base,'infra'),path.join(base,'infra','local'),dir]){
   if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw new Error('Refuse symlink or junction runtime parent');
  }
  if(readFileSync(path.join(dir,'.fairwork-owned'),'utf8')!==markerText)throw new Error('Invalid owned runtime marker');
  if(!existsSync(target))return;
  if(lstatSync(target).isSymbolicLink())throw new Error('Refuse runtime symlink target');
  try{rmSync(target,{recursive:name==='storage',force:true});return;}
  catch(error){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code)||Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,100));}
 }
}
export function stopOwnedWeb(runtimeDir){const file=path.join(runtimeDir,'web-owner.json');if(!existsSync(file))return;const rec=JSON.parse(readFileSync(file,'utf8'));if(!Number.isSafeInteger(rec.pid)||rec.pid<1||!/^fw-[a-f0-9]{24}$/.test(rec.token))throw new Error('Invalid owned web process record');
 if(process.platform==='win32'){
  const text=execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "ProcessId = ${rec.pid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}).trim();
  if(text){const info=JSON.parse(text);if(!info.CommandLine?.includes('web-run.mjs')||!info.CommandLine.includes(rec.token))throw new Error('Refuse stopping process with mismatched ownership');execFileSync('taskkill.exe',['/PID',String(rec.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}
 }else{try{const cmd=readFileSync(`/proc/${rec.pid}/cmdline`,'utf8');if(!cmd.includes('web-run.mjs')||!cmd.includes(rec.token))throw new Error('Refuse mismatched ownership');process.kill(rec.pid,'SIGTERM');}catch(e){if(e.code!=='ENOENT')throw e;}}
 rmSync(file,{force:true});}
export async function prepareRuntime(root=process.cwd()){
 const base=path.resolve(root),dir=path.resolve(base,'infra/local/runtime');if(path.relative(base,dir)!==path.join('infra','local','runtime'))throw new Error('Refuse runtime outside workspace');
 for(const parent of [base,path.join(base,'infra'),path.join(base,'infra','local')]){
  if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw new Error('Refuse symlink or junction runtime parent');
 }
 const marker=path.join(dir,'.fairwork-owned');if(existsSync(dir)){if(lstatSync(dir).isSymbolicLink())throw new Error('Refuse symlink runtime');if(!existsSync(marker)&&readdirSync(dir).length>0)throw new Error('Refuse unowned runtime without marker');if(existsSync(marker)&&readFileSync(marker,'utf8')!==markerText)throw new Error('Invalid owned runtime marker');}
 mkdirSync(dir,{recursive:true});writeFileSync(marker,markerText);stopOwnedWeb(dir);
 for(const name of ['private.db','private.db-journal','private.db-wal','private.db-shm','storage'])await removeOwnedTarget(base,dir,name);
 const storage=path.join(dir,'storage');mkdirSync(storage,{recursive:true});const env={DATABASE_URL:'file:'+path.join(dir,'private.db').replaceAll('\\','/'),PRIVATE_STORAGE_DIR:storage,AES_256_GCM_MASTER_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('hex'),SIWE_DOMAIN:'localhost:3000',SIWE_URI:'http://localhost:3000',APP_ORIGIN:'http://localhost:3000',CHAIN_ID:'31337',CHAIN_RPC_URL:'http://127.0.0.1:8545',FAIRWORK_DEPLOYMENT_FILE:path.resolve(base,'infra/local/deployment.json'),FAIRWORK_BUILD_TARGET:'local',NEXT_PUBLIC_FAIRWORK_LOCAL:'1'};
 writeFileSync(path.join(dir,'server-env.json'),JSON.stringify(env,null,2)+'\n',{mode:0o600});return {runtimeDir:dir,env};
}
