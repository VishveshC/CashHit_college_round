import { invoke } from '../../../../../lib/server/runtime.ts';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ fileId: string }> };
export async function GET(request: Request, context: Context) { return invoke('fileContentGET', request, (await context.params).fileId); }
