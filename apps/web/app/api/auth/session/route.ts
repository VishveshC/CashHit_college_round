import { invoke } from '../../../../lib/server/runtime.ts';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return invoke('sessionGET', request); }
