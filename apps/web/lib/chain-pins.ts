import {keccak256,isAddress} from 'viem';
export async function verifyDeployment(config:any,client:any){
 if(config.chainId!==31337 || await client.getChainId()!==31337)throw new Error('Unsupported chain; expected31337');
 for(const key of ['escrow','arbitration','randomness']){
  if(!isAddress(config[key])||!/^0x[0-9a-fA-F]{64}$/.test(config.codeHashes?.[key]||''))throw new Error('Invalid deployment pin');
  const code=await client.getBytecode({address:config[key]});
  if(!code||code==='0x'||keccak256(code).toLowerCase()!==config.codeHashes[key].toLowerCase())throw new Error('Deployed code pin mismatch');
 }
}
