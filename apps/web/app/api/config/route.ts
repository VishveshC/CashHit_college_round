import {loadDeployment} from '../../../lib/chain-server.ts';import {publicClient} from '../../../lib/chain.ts';import {verifyDeployment} from '../../../lib/chain-pins.ts';
export const dynamic='force-dynamic';
export async function GET(){try{const c=loadDeployment();await verifyDeployment(c,publicClient(c));return Response.json(c,{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({error:'Local deployment unavailable. Run demo:reset.'},{status:503,headers:{'Cache-Control':'no-store'}});}}
