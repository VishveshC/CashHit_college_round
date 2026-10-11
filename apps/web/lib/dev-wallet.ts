import type {PublicConfig} from './chain.ts';
export function createDemoProvider(config:PublicConfig,account:string){
 if(process.env.NEXT_PUBLIC_FAIRWORK_LOCAL!=='1'||config.chainId!==31337)throw new Error('Demo wallet disabled');
 const roles=[config.roles.client,config.roles.freelancer,config.roles.treasury,...config.roles.arbiters].map(a=>a.toLowerCase());
 if(!roles.includes(account.toLowerCase()))throw new Error('Unknown demo role');
 return {request:async({method,params=[]}:{method:string;params?:any[]})=>{
  if(method==='eth_accounts'||method==='eth_requestAccounts')return [account];
  const r=await fetch('/api/dev/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});const data=await r.json();if(!r.ok||data.error)throw new Error(data.error||'Local wallet unavailable');return data.result;
 }};
}
