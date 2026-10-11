import { invoke } from '../../../../../lib/server/runtime.ts';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, context: Context) { return invoke('fileListGET', request, (await context.params).jobId); }
export async function POST(request: Request, context: Context) { return invoke('fileUploadPOST', request, (await context.params).jobId); }
