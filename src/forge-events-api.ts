import { verifyReadCapability } from './forge-capability.ts';
import { validateForgeEvent } from './forge-journal.ts';

interface DurableStub { fetch(request: Request): Promise<Response>; }
interface JournalNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStub;
}
export interface EventBindings {
  FORGE_EVENTS?: JournalNamespace;
  GITFLARE_VIEW_SIGNING_KEY?: string;
  GITFLARE_EVENT_WRITE_TOKEN?: string;
}
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  } });
export async function hasBearer(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const actual = request.headers.get('authorization') ?? '';
  const expected = 'Bearer ' + secret;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}
export async function handleJournalRequest(
  request: Request, env: EventBindings, repo: string,
): Promise<Response> {
  if (!REPO.test(repo)) return json({ code: 'INVALID_REPOSITORY' }, 400);
  if (request.method === 'GET') {
    const authorization = request.headers.get('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!env.GITFLARE_VIEW_SIGNING_KEY ||
        !(await verifyReadCapability(env.GITFLARE_VIEW_SIGNING_KEY, token, repo))) {
      return json({ code: 'READ_CAPABILITY_REQUIRED' }, 401);
    }
  } else if (request.method === 'POST') {
    if (!(await hasBearer(request, env.GITFLARE_EVENT_WRITE_TOKEN))) {
      return json({ code: 'EVENT_WRITER_REQUIRED' }, 401);
    }
  } else return json({ code: 'NOT_FOUND' }, 404);

  if (!env.FORGE_EVENTS) return json({ code: 'JOURNAL_NOT_CONFIGURED' }, 503);
  const invoke = (internal: Request) => env.FORGE_EVENTS!.get(env.FORGE_EVENTS!.idFromName('gitflare:' + repo)).fetch(internal);
  if (request.method === 'GET') {
    const incoming = new URL(request.url);
    const after = incoming.searchParams.get('after') ?? '0';
    const limit = incoming.searchParams.get('limit') ?? '50';
    if (!/^\d{1,15}$/.test(after) || !/^\d{1,3}$/.test(limit) ||
        Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(Number(after))) {
      return json({ code: 'INVALID_CURSOR' }, 400);
    }
    return invoke(new Request('https://internal/replay?after=' + after + '&limit=' + limit));
  }
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return json({ code: 'INVALID_MEDIA_TYPE' }, 415);
  }
  const stated = Number(request.headers.get('content-length') ?? 0);
  if (stated > 2048) return json({ code: 'EVENT_TOO_LARGE' }, 413);
  let text = '';
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ code: 'INVALID_EVENT' }, 400);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2048) {
        await reader.cancel();
        return json({ code: 'EVENT_TOO_LARGE' }, 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch { return json({ code: 'INVALID_EVENT' }, 400); }
  let body;
  try { body = validateForgeEvent(JSON.parse(text)); }
  catch { return json({ code: 'INVALID_EVENT' }, 400); }
  return invoke(new Request('https://internal/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
