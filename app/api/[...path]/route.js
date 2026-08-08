import { handleApi } from '@/lib/platform';

export const runtime = 'nodejs';
const maxJsonBodyBytes = 7 * 1024 * 1024;

async function dispatch(request) {
  try {
    const method = request.method;
    const headers = Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
    const rawBody = ['POST', 'PUT', 'PATCH'].includes(method) ? await request.text() : '';
    if (new TextEncoder().encode(rawBody).byteLength > maxJsonBodyBytes) return Response.json({ error: { code: 'validation_failed', message: 'Request body is too large. Image place analysis accepts at most a 5 MB image; upload raw footage to approved evidence storage and submit only its reference.' } }, { status: 422 });
    const body = rawBody ? JSON.parse(rawBody) : {};
    const output = await handleApi({ method, headers, body }, new URL(request.url));
    return new Response(output.raw ?? JSON.stringify(output.body), { status: output.status, headers: { 'content-type': 'application/json; charset=utf-8', ...output.headers } });
  } catch (error) {
    const validationFailure = error instanceof SyntaxError || error.message?.includes('valid JSON');
    const status = error.status || (validationFailure ? 422 : 500);
    return Response.json({ error: { code: error.code || (validationFailure ? 'validation_failed' : 'internal_error'), message: error.message || 'The service could not complete this request.' } }, { status });
  }
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
