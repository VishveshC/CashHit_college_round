import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createPublicClient, http, defineChain} from 'viem';
import {readArbiterRegistry} from '../apps/web/lib/client/arbiter-registry.ts';
const configResponse = await fetch('http://localhost:3000/api/config');
assert.equal(configResponse.status, 200);
const config = await configResponse.json();
assert.equal(config.chainId, 31337);
assert.equal(config.rpcUrl, 'http://127.0.0.1:8545');
const abi = JSON.parse(readFileSync('packages/chain/generated/FairworkEscrow.json')).abi;
const engineAbi = JSON.parse(readFileSync('packages/chain/generated/FairworkArbitration.json')).abi;
const client = createPublicClient({chain: defineChain({id:31337,name:'Local proof',nativeCurrency:{name:'Demo',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[config.rpcUrl]}}}),transport:http(config.rpcUrl)});
const registry = await readArbiterRegistry(config);
const panels = [];
for (let id=1;id<=16;id++) {
  for(let round=1;round<=2;round++) panels.push({id,round,members:await client.readContract({address:config.escrow,abi,functionName:'getPanel',args:[BigInt(id),round],blockNumber:registry.blockNumber})});
}
const safe = value => JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?String(item):item));
const beforePath='infra/local/runtime/phase4-reopen-registry-before.json';
if(process.argv.includes('--before')) {
  assert.equal(registry.count,6);
  writeFileSync(beforePath,JSON.stringify(safe({registry,panels}),null,2));
  console.log('Read-only pre-UI registry snapshot recorded: 6 members; 32 recorded panels; no writes.');
} else {
  const before=JSON.parse(readFileSync(beforePath));
  assert.deepEqual(registry.members,before.registry.members);
  assert.deepEqual(safe(panels),before.panels);
  const events=await client.getContractEvents({address:config.arbitration,abi:engineAbi,fromBlock:BigInt(before.registry.blockNumber)+1n,toBlock:registry.blockNumber});
  const changes=events.filter(event=>event.eventName==='ArbiterAdded'||event.eventName==='ArbiterRemoved');
  assert.equal(changes.length,2);
  assert.deepEqual(changes.map(event=>event.eventName),['ArbiterAdded','ArbiterRemoved']);
  assert.equal(changes[0].args.arbiter.toLowerCase(),config.roles.client.toLowerCase());
  assert.equal(changes[1].args.arbiter.toLowerCase(),config.roles.client.toLowerCase());
  const receipts=[];
  for(const event of changes){
    const receipt=await client.getTransactionReceipt({hash:event.transactionHash});
    const transaction=await client.getTransaction({hash:event.transactionHash});
    assert.equal(receipt.status,'success');
    assert.equal(transaction.from.toLowerCase(),registry.owner.toLowerCase());
    assert.equal(transaction.to.toLowerCase(),config.escrow.toLowerCase());
    receipts.push({event:event.eventName,hash:event.transactionHash,status:receipt.status,block:receipt.blockNumber,from:transaction.from,to:transaction.to});
  }
  const output=safe({kind:'read-only proof after two compiled-browser owner registry transactions',beforeBlock:before.registry.blockNumber,afterBlock:registry.blockNumber,memberCountRestoredToSix:registry.count===6,originalMembershipRestored:true,all32RecordedPanelsUnchanged:true,registry,receipts});
  writeFileSync('docs/phase4-reopen-registry-chain-proof.json',JSON.stringify(output,null,2));
  console.log(JSON.stringify(output));
}
