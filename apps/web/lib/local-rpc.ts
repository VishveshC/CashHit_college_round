import {decodeFunctionData,erc20Abi,isAddress,zeroAddress} from 'viem';
import {escrowAbi,randomnessAbi} from './chain.ts';
export function createLocalRpcHandler(deps:any){return async(request:Request)=>{
 const out=(data:any,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
 if(!deps.local)return out({error:'Not found'},404);
 if(request.headers.get('origin')!=='http://localhost:3000')return out({error:'Forbidden'},403);
 try{
  if(Number(request.headers.get('content-length')||0)>16384)return out({error:'Request too large'},413);
  const text=await request.text();if(text.length>16384)return out({error:'Request too large'},413);
  const body=JSON.parse(text),method=body.method,params=body.params;
  if(typeof method!=='string'||!Array.isArray(params))throw new Error('Invalid request');
  const c=deps.config;const accounts=[...new Set([c.roles.client,c.roles.freelancer,c.roles.treasury,...c.roles.arbiters].map((a:string)=>a.toLowerCase()))];
  const known=(a:any)=>typeof a==='string'&&accounts.includes(a.toLowerCase());
  if(method==='eth_accounts'||method==='eth_requestAccounts')return out({result:accounts});
  if(method==='eth_chainId')return out({result:'0x7a69'});
  if(method==='personal_sign'||method==='eth_sign'){
   const signer=method==='personal_sign'?params[1]:params[0],data=method==='personal_sign'?params[0]:params[1];
   if(!known(signer)||typeof data!=='string'||!/^0x[0-9a-fA-F]+$/.test(data)||data.length>8192)throw new Error('Invalid signing request');
  }else if(method==='eth_sendTransaction'){
   const tx=params[0];if(!tx||params.length!==1||!known(tx.from)||!isAddress(tx.to)||typeof tx.data!=='string'||BigInt(tx.value||'0')!==0n)throw new Error('Invalid transaction');
   const token=c.tokens.find((t:any)=>t.address.toLowerCase()===tx.to.toLowerCase());
   if(token){const d:any=decodeFunctionData({abi:erc20Abi,data:tx.data});if(d.functionName!=='approve'||d.args[0].toLowerCase()!==c.escrow.toLowerCase()||d.args[1]<1n||d.args[1]>10n**19n)throw new Error('Exact bounded escrow approval required');}
   else if(tx.to.toLowerCase()===c.escrow.toLowerCase()){
    const d=decodeFunctionData({abi:escrowAbi,data:tx.data});
    if(d.functionName==='addArbiter'||d.functionName==='removeArbiter'){
     // Expose these selectors only to the configured local treasury; the escrow still enforces its on-chain owner.
     const arbiter=d.args?.[0];
     if(tx.from.toLowerCase()!==c.roles.treasury.toLowerCase()||typeof arbiter!=='string'||!isAddress(arbiter)||arbiter.toLowerCase()===zeroAddress.toLowerCase())throw new Error('Treasury registry action required');
    }else{
     const allowed=['createJob','acceptJob','cancelProposedJob','cancelExpiredProposal','cancelUnfundedJob','fundJob','submitMilestone','approveMilestone','rejectMilestone','resubmitMilestone','releaseAfterSilence','refundAfterMissedDeadline','refundAfterRejectionWindow','openDispute','matchDisputeDeposit','submitEvidence','advanceDispute','commitVote','revealVote','withdraw'];
     if(!allowed.includes(d.functionName))throw new Error('Unsupported contract action');
    }
   }else throw new Error('Unsupported transaction target');
   if(tx.chainId!==undefined&&BigInt(tx.chainId)!==31337n)throw new Error('Wrong chain');
  }else throw new Error('Unsupported method');
  return out({result:await deps.rpc(method,params)});
 }catch{return out({error:'Invalid local request'},400);}
 };}
