import {createPublicClient,http,defineChain,keccak256,zeroAddress,type Address} from 'viem';
import escrowJSON from '../../../packages/chain/generated/FairworkEscrow.json' with {type:'json'};
import engineJSON from '../../../packages/chain/generated/FairworkArbitration.json' with {type:'json'};
import randomnessJSON from '../../../packages/chain/generated/MockRandomness.json' with {type:'json'};
import {verifyDeployment} from './chain-pins.ts';
export const escrowAbi:any=escrowJSON.abi, arbitrationAbi:any=engineJSON.abi, randomnessAbi:any=randomnessJSON.abi;
export const abis={escrow:escrowAbi,arbitration:arbitrationAbi,randomness:randomnessAbi};
export type PublicConfig={chainId:number;rpcUrl:string;escrow:Address;arbitration:Address;randomness:Address;startBlock:number|bigint;blockNumber:number|bigint;codeHashes:Record<string,string>;tokens:{address:Address;symbol:string;decimals:number}[];roles:{client:Address;freelancer:Address;treasury:Address;arbiters:Address[]};domain?:string;uri?:string};
export type JobSnapshot=any;
export const localChain=defineChain({id:31337,name:'Fairwork local',nativeCurrency:{name:'Demo Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:['http://127.0.0.1:8545']}}});
export function publicClient(config:PublicConfig){if(config.chainId!==31337||config.rpcUrl!=='http://127.0.0.1:8545')throw new Error('Unsupported local chain configuration');return createPublicClient({chain:localChain,transport:http(config.rpcUrl),pollingInterval:100});}
export async function getPublicConfig():Promise<PublicConfig>{const r=await fetch('/api/config',{cache:'no-store'});if(!r.ok)throw new Error('Run npm run demo:reset before connecting');return r.json();}
export async function readJobSnapshot(jobId:bigint,config:PublicConfig,account?:string):Promise<JobSnapshot>{
 const pc:any=publicClient(config);await verifyDeployment(config,pc);
 const read=(functionName:string,args:any[]=[])=>pc.readContract({address:config.escrow,abi:escrowAbi,functionName,args});
 const job=await read('getJob',[jobId]);const tuple=await read('getJobCommitments',[jobId]);const commitments={titleCommitment:tuple[0],descriptionCommitment:tuple[1],scopeCommitment:tuple[2],deliveryRuleCommitment:tuple[3]};const now=(await pc.getBlock()).timestamp;
 const milestones=[];
 for(let i=0;i<Number(job.milestoneCount);i++){
  const m=await read('getMilestone',[jobId,BigInt(i)]);const submissions=[];
  for(let n=0;n<Number(m.submissionCount);n++)submissions.push(await read('getSubmission',[jobId,BigInt(i),BigInt(n)]));
  const disputeId=await read('getMilestoneDispute',[jobId,BigInt(i)]);let dispute=null;let panels:any={1:[zeroAddress,zeroAddress,zeroAddress],2:[zeroAddress,zeroAddress,zeroAddress]},history:any[]=[],votes:any={};
  if(disputeId>0n){dispute=await read('getDispute',[disputeId]);panels={1:await read('getPanel',[disputeId,1]),2:await read('getPanel',[disputeId,2])};history=await read('getPanel1History',[disputeId]);const round=Number(dispute.round)||1;for(const a of panels[round])if(a!==zeroAddress){const v=await read('getVote',[disputeId,round,a]);votes[a.toLowerCase()]={commitment:v[0],bps:Number(v[1]),revealed:v[2]};}}
  milestones.push({...m,submissions,disputeId,dispute,panels,history,votes});
 }
 const claimable=account?await read('claimable',[job.token,account]):0n;
 const logs:any[]=account?await pc.getContractEvents({address:config.escrow,abi:escrowAbi,eventName:'WithdrawalCompleted',fromBlock:BigInt(config.startBlock),toBlock:'latest'}):[];
 const withdrawn=logs.filter((l:any)=>l.args.account?.toLowerCase()===account?.toLowerCase()&&l.args.token?.toLowerCase()===job.token.toLowerCase()).reduce((s:bigint,l:any)=>s+l.args.amount,0n);
 return {jobId,now,job,commitments,milestones,claimable,withdrawn,lockedEscrow:await read('lockedEscrow',[job.token]),disputeDeposits:await read('disputeDeposits',[job.token])};
}
export async function readChainEvents(jobId:bigint,config:PublicConfig){
 const pc:any=publicClient(config);await verifyDeployment(config,pc);const snapshot=await readJobSnapshot(jobId,config);
 const ids=new Set(snapshot.milestones.filter((m:any)=>m.disputeId>0n).map((m:any)=>String(m.disputeId)));
 const groups=await Promise.all([pc.getContractEvents({address:config.escrow,abi:escrowAbi,fromBlock:BigInt(config.startBlock),toBlock:'latest'}),pc.getContractEvents({address:config.arbitration,abi:arbitrationAbi,fromBlock:BigInt(config.startBlock),toBlock:'latest'})]);
 return groups.flat().filter((l:any)=>String(l.args?.jobId)===String(jobId)||ids.has(String(l.args?.disputeId))).sort((a:any,b:any)=>Number(a.blockNumber-b.blockNumber)||a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex).map((l:any)=>({source:'chain',name:l.eventName,contract:l.address,blockNumber:l.blockNumber,transactionIndex:l.transactionIndex,logIndex:l.logIndex,transactionHash:l.transactionHash,args:l.args}));
}
export function jsonSafe(value:any):any{return JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));}
