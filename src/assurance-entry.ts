import baseHandler from './index';

type TokenScope = 'read' | 'write';

interface ArtifactTokenResult {
  plaintext: string;
  expiresAt?: string;
}

interface ArtifactRepoHandle {
  createToken(scope?: TokenScope, ttl?: number): Promise<ArtifactTokenResult>;
  readCommit(hash: string): Promise<unknown>;
}

interface ArtifactsBinding {
  get(name: string): Promise<ArtifactRepoHandle>;
}

export interface AssuranceEnv {
  ARTIFACTS: ArtifactsBinding;
  GITFLARE_ADMIN_TOKEN: string;
  /**
   * Example: https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/gitflare
   *
   * This is configuration, not a credential. Gitflare returns a short-lived
   * repo-scoped read token separately and never proxies Git object bytes.
   */
  GITFLARE_ARTIFACTS_REMOTE_BASE?: string;
}

interface SourceTicketBody {
  sha?: unknown;
  ttl?: unknown;
}

const SHA1 = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REMOTE_BASE = /^https:\/\/[A-Za-z0-9.-]+\.artifacts\.cloudflare\.net\/git\/gitflare$/;
const MAX_TTL_SECONDS = 900;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function authorized(request: Request, env: AssuranceEnv): boolean {
  return Boolean(env.GITFLARE_ADMIN_TOKEN)
    && request.headers.get('authorization') === `Bearer ${env.GITFLARE_ADMIN_TOKEN}`;
}

function ttlSeconds(value: unknown): number {
  if (value === undefined || value === null) return 300;
  if (!Number.isSafeInteger(value)) throw new Error('ttl must be an integer number of seconds');
  const ttl = Number(value);
  if (ttl < 60 || ttl > MAX_TTL_SECONDS) {
    throw new Error(`ttl must be between 60 and ${MAX_TTL_SECONDS} seconds`);
  }
  return ttl;
}

function configuredRemoteBase(env: AssuranceEnv): string {
  const base = env.GITFLARE_ARTIFACTS_REMOTE_BASE?.replace(/\/+$/, '') ?? '';
  if (!REMOTE_BASE.test(base)) {
    throw new Error('Gitflare Artifacts remote base is not configured');
  }
  return base;
}

export async function handleAssuranceSourceTicket(
  request: Request,
  env: AssuranceEnv,
  repoName: string,
): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  if (!REPO.test(repoName)) return json({ error: 'invalid repository name', code: 'INVALID_REPOSITORY' }, 400);

  let body: SourceTicketBody;
  try {
    body = await request.json() as SourceTicketBody;
  } catch {
    return json({ error: 'request body must contain valid JSON', code: 'INVALID_JSON' }, 400);
  }
  const allowed = new Set(['sha', 'ttl']);
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowed.has(key)) return json({ error: `unsupported source-ticket field: ${key}`, code: 'INVALID_ARGUMENT' }, 400);
  }

  if (typeof body.sha !== 'string' || !SHA1.test(body.sha)) {
    return json({ error: 'sha must be a 40-character Git object id', code: 'INVALID_SHA' }, 400);
  }
  const sha = body.sha.toLowerCase();
  let ttl: number;
  let remoteBase: string;
  try {
    ttl = ttlSeconds(body.ttl);
    remoteBase = configuredRemoteBase(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('not configured') ? 503 : 400;
    return json({ error: message, code: status === 503 ? 'SOURCE_PLANE_NOT_CONFIGURED' : 'INVALID_ARGUMENT' }, status);
  }

  let repo: ArtifactRepoHandle;
  try {
    repo = await env.ARTIFACTS.get(repoName);
  } catch {
    return json({ error: 'canonical Artifacts repository is unavailable', code: 'ARTIFACTS_REPO_UNAVAILABLE' }, 502);
  }

  // This is the source-authority check. A GitHub mirror is insufficient: the
  // exact immutable commit must be readable from the canonical Artifacts repo.
  try {
    await repo.readCommit(sha);
  } catch {
    return json({ error: 'immutable commit is not present in canonical Artifacts', code: 'SOURCE_OBJECT_NOT_FOUND' }, 404);
  }

  let credential: ArtifactTokenResult;
  try {
    credential = await repo.createToken('read', ttl);
  } catch {
    return json({ error: 'failed to mint repo-scoped read credential', code: 'ARTIFACTS_TOKEN_CREATE_FAILED' }, 502);
  }

  const ticketId = `gitflare-source:${crypto.randomUUID()}`;
  return json({
    schemaVersion: 1,
    ticketId,
    authority: 'gitflare',
    sourcePlane: 'cloudflare-artifacts',
    namespace: 'gitflare',
    repo: repoName,
    sha,
    remote: `${remoteBase}/${encodeURIComponent(repoName)}.git`,
    credential: {
      kind: 'artifacts-repo-read-token',
      token: credential.plaintext,
      expiresAt: credential.expiresAt ?? null,
      ttl,
    },
  }, 201);
}

export default {
  async fetch(request: Request, env: AssuranceEnv): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/repos\/([^/]+)\/assurance\/source-ticket\/?$/.exec(url.pathname);
    if (match) {
      if (request.method !== 'POST') return json({ error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);
      return handleAssuranceSourceTicket(request, env, decodeURIComponent(match[1]));
    }
    return baseHandler.fetch(request, env as never);
  },
};
