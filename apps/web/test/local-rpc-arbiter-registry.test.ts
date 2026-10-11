import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData} from 'viem';
import {createLocalRpcHandler} from '../lib/local-rpc.ts';
import {escrowAbi} from '../lib/chain.ts';

const client='0x1111111111111111111111111111111111111111';
const freelancer='0x2222222222222222222222222222222222222222';
const treasury='0x5555555555555555555555555555555555555555';
const arbiter='0x6666666666666666666666666666666666666666';
const candidate='0x7777777777777777777777777777777777777777';
const outsider='0x9999999999999999999999999999999999999999';
const escrow='0x4444444444444444444444444444444444444444';
const zero='0x0000000000000000000000000000000000000000';
const config={
 chainId:31337,rpcUrl:'http://127.0.0.1:8545',escrow,arbitration:escrow,randomness:escrow,
 startBlock:0,blockNumber:0,codeHashes:{escrow:'0x01',arbitration:'0x01',randomness:'0x01'},
 tokens:[],roles:{client,freelancer,treasury,arbiters:[arbiter]},
};
const req=(body:unknown,origin='http://localhost:3000')=>new Request('http://localhost:3000/api/dev/rpc',{
 method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body),
});
const tx=(from:string,method:'addArbiter'|'removeArbiter',address:string)=>({
 from,to:escrow,data:encodeFunctionData({abi:escrowAbi,functionName:method,args:[address]}),value:'0x0',chainId:'0x7a69',
});

test('A61 configured treasury can forward only the add and remove registry transactions',async()=>{
 for(const method of ['addArbiter','removeArbiter'] as const){
  const sent=tx(treasury,method,candidate);let calls=0;
  const handler=createLocalRpcHandler({local:true,config,rpc:async(rpcMethod:string,params:unknown[])=>{
   calls++;assert.equal(rpcMethod,'eth_sendTransaction');assert.deepEqual(params,[sent]);return '0xregistry-receipt';
  }});
  const response=await handler(req({method:'eth_sendTransaction',params:[sent]}));
  assert.equal(response.status,200);assert.equal((await response.json()).result,'0xregistry-receipt');assert.equal(calls,1);
 }
});

test('A61 a known non-owner and an unknown wallet cannot forward either registry transaction',async()=>{
 for(const from of [client,arbiter,outsider])for(const method of ['addArbiter','removeArbiter'] as const){
  let calls=0;const handler=createLocalRpcHandler({local:true,config,rpc:async()=>{calls++;return 'unexpected'}});
  const response=await handler(req({method:'eth_sendTransaction',params:[tx(from,method,candidate)]}));
  assert.equal(response.status,400);assert.equal(calls,0);
 }
});

test('A61 zero-address registry changes and unrelated selectors remain blocked before RPC',async()=>{
 for(const method of ['addArbiter','removeArbiter'] as const){
  let calls=0;const handler=createLocalRpcHandler({local:true,config,rpc:async()=>{calls++;return 'unexpected'}});
  const response=await handler(req({method:'eth_sendTransaction',params:[tx(treasury,method,zero)]}));
  assert.equal(response.status,400);assert.equal(calls,0);
 }
 const ownerData=encodeFunctionData({abi:escrowAbi,functionName:'owner'});
 let calls=0;const handler=createLocalRpcHandler({local:true,config,rpc:async()=>{calls++;return 'unexpected'}});
 const response=await handler(req({method:'eth_sendTransaction',params:[{from:treasury,to:escrow,data:ownerData,value:'0x0'}]}));
 assert.equal(response.status,400);assert.equal(calls,0);
});
