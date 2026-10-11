import {devControl} from '../../../../../lib/dev-control-runtime.ts';
export const dynamic='force-dynamic';
export async function POST(request:Request){return devControl(request,'mode');}
