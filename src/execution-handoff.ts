export interface ArtifactTokenResult {
  plaintext: string;
  expiresAt?: string;
}

export interface HandoffRepoHandle {
  readCommit(hash: string): Promise<unknown>;
  createToken(scope?: 'read' | 'write', ttl?: number): Promise<ArtifactTokenResult>;
}

export interface HandoffArtifactsBinding {
  get(name: string): Promise<HandoffRepoHandle>;
}

export interface HandoffEnv {
  ARTIFACTS: HandoffArtifactsBinding;
  GITFLARE_ADMIN_TOKEN: string;
  /** e.g. https://<account>.artifacts.cloudflare.net/git/gitflare */
  GITFLARE_ARTIFACTS_REMOTE_BASE?: string;
}

interface HandoffBody {
  sha?: unknown;
  ttl?: unknown;
}

const GIT_SHA1 = /^[0-9a-f]{40}$/i;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function json(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-gitflare-request-id': requestId,
    },
  });
}

function authorized(request: Request, env: HandoffEnv): boolean {
  return Boolean(env.GITFLARE_ADMIN_TOKEN)
    && request.headers.get('authorization') === `Bearer ${env.GITFLARE_ADMIN_TOKEN}`;
}

function ttlSeconds(value: unknown): number {
  if (value === undefined || value === null) return 900;
  if (!Number.isSafeInteger(value)) throw new Error('ttl must be an integer');
  const ttl = Number(value);
  if (ttl < 60 || ttl > 900) throw new Error('ttl must be between 60 and 900 seconds');
  return ttl;
}

function sourceRemote(base: string | undefined, repo: string): string {
  if (!base) throw new Error('GITFLARE_ARTIFACTS_REMOTE_BASE is not configured');
  const normalized = base.replace(/\/+$/, '');
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('GITFLARE_ARTIFACTS_REMOTE_BASE must be a credential-free HTTPS base');
  }
  return `${normalized}/${repo}.git`;
}

export async function handleExecutionHandoff(
  request: Request,
  env: HandoffEnv,
  rawRepo: string,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (!authorized(request, env)) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED', requestId }, 401, requestId);
  }

  let repo: string;
  try {
    repo = decodeURIComponent(rawRepo);
  } catch {
    return json({ error: 'Invalid repository name', code: 'INVALID_REPO', requestId }, 400, requestId);
  }
  if (!REPO_NAME.test(repo)) {
    return json({ error: 'Invalid repository name', code: 'INVALID_REPO', requestId }, 400, requestId);
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'content-type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE', requestId }, 415, requestId);
  }

  let body: HandoffBody;
  try {
    body = await request.json() as HandoffBody;
  } catch {
    return json({ error: 'request body must contain valid JSON', code: 'INVALID_JSON', requestId }, 400, requestId);
  }

  const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
  if (!GIT_SHA1.test(sha)) {
    return json({ error: 'sha must be a full 40-hex Git object id', code: 'INVALID_SHA', requestId }, 400, requestId);
  }

  let ttl: number;
  let remote: string;
  try {
    ttl = ttlSeconds(body.ttl);
    remote = sourceRemote(env.GITFLARE_ARTIFACTS_REMOTE_BASE, repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid handoff configuration';
    const status = message.includes('REMOTE_BASE') ? 503 : 400;
    return json({ error: message, code: status === 503 ? 'SOURCE_REMOTE_UNCONFIGURED' : 'INVALID_ARGUMENT', requestId }, status, requestId);
  }

  let handle: HandoffRepoHandle;
  try {
    handle = await env.ARTIFACTS.get(repo);
  } catch {
    return json({ error: 'repository is unavailable', code: 'SOURCE_REPO_UNAVAILABLE', requestId }, 502, requestId);
  }

  try {
    await handle.readCommit(sha);
  } catch {
    return json({ error: 'source object is not present in Gitflare', code: 'SOURCE_OBJECT_NOT_FOUND', requestId }, 404, requestId);
  }

  let token: ArtifactTokenResult;
  try {
    token = await handle.createToken('read', ttl);
  } catch {
    return json({ error: 'could not mint source credential', code: 'SOURCE_TOKEN_FAILED', requestId }, 502, requestId);
  }

  // Never log or echo this object through a non-secret channel. It is a one-hop
  // execution handoff and the credential is deliberately short lived + read-only.
  return json({
    schemaVersion: 1,
    authority: 'gitflare',
    provider: 'cloudflare-artifacts',
    namespace: 'gitflare',
    repo,
    sha,
    remote,
    credential: {
      kind: 'artifacts-repo-token',
      scope: 'read',
      token: token.plaintext,
      expiresAt: token.expiresAt ?? null,
      ttl,
    },
    requestId,
  }, 201, requestId);
}
