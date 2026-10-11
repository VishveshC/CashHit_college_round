import { invoke } from '../../../../../lib/server/runtime.ts';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ disputeId: string }> };
export async function GET(request: Request, context: Context) { return invoke('evidenceGET', request, (await context.params).disputeId); }
export async function POST(request: Request, context: Context) { return invoke('evidencePOST', request, (await context.params).disputeId); }
