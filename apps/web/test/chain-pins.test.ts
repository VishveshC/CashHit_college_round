import {test} from 'node:test'; import assert from 'node:assert/strict'; import {keccak256} from 'viem'; import {verifyDeployment} from '../lib/chain-pins.ts';
const a='0x1111111111111111111111111111111111111111',b='0x2222222222222222222222222222222222222222',c='0x3333333333333333333333333333333333333333';
const config={chainId:31337,rpcUrl:'http://127.0.0.1:8545',escrow:a,arbitration:b,randomness:c,codeHashes:{escrow:keccak256('0x6000'),arbitration:keccak256('0x6001'),randomness:keccak256('0x6002')},tokens:[]};
const bytecodes:any={[a]:'0x6000',[b]:'0x6001',[c]:'0x6002'};
const client={getChainId:async()=>31337,getBytecode:async({address}:any)=>bytecodes[address]};
test('F61 fresh deployment validation accepts only matching chain and all3 runtime codehashes',async()=>{await assert.doesNotReject(()=>verifyDeployment(config,client));});
test('F61 supported manifest on unsupported RPC chain fails closed',async()=>{await assert.rejects(()=>verifyDeployment(config,{...client,getChainId:async()=>1}),/chain/i);});
test('F61 manifest cannot authorize a nonlocal chain even if RPC agrees',async()=>{await assert.rejects(()=>verifyDeployment({...config,chainId:1},{...client,getChainId:async()=>1}),/chain/i);});
test('F61 missing deployment and drifted engine code fail pin validation',async()=>{await assert.rejects(()=>verifyDeployment(config,{...client,getBytecode:async()=>undefined}),/code|deploy|pin/i);await assert.rejects(()=>verifyDeployment(config,{...client,getBytecode:async({address}:any)=>address===b?'0x6004':bytecodes[address]}),/code|pin/i);});
