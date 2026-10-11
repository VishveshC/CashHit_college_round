import { invoke } from '../../../../lib/server/runtime.ts';
export const dynamic = 'force-dynamic';
export function POST(request: Request) { return invoke('loginPOST', request); }
