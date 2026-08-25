import baseHandler from './index';

type TokenScope = 'read' | 'write';
type SourcePlaneMode = 'unavailable' | 'cloudflare-artifacts';

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
  /** Present only after the account has Cloudflare Artifacts access. */
  ARTIFACTS?: ArtifactsBinding;
  GITFLARE_ADMIN_TOKEN?: string;
  /**
   * Default deployments deliberately set this to `unavailable` so Gitflare can
   * deploy before the closed-beta Artifacts entitlement exists.
   */
  GITFLARE_SOURCE_PLANE_MODE?: SourcePlaneMode;
  /**
   * The exact `remote` returned by Cloudflare Artifacts for gitflare/firecrab.
   * This is configuration, not a Git credential.
   */
  GITFLARE_FIRECRAB_REMOTE?: string;
}

interface SourceTicketBody {
  sha?: unknown;
  ttl?: unknown;
}

export interface SourcePlaneStatus {
  schemaVersion: 1;
  authority: 'gitflare';
  requestedProvider: 'cloudflare-artifacts';
  canonical: boolean;
  available: boolean;
  mode: SourcePlaneMode;
  bindingPresent: boolean;
  remoteConfigured: boolean;
  reason: null
    | 'cloudflare-artifacts-access-unavailable'
    | 'cloudflare-artifacts-binding-unavailable'
    | 'cloudflare-artifacts-remote-unconfigured';
}

const SHA1 = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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

function sourcePlaneMode(env: AssuranceEnv): SourcePlaneMode {
  return env.GITFLARE_SOURCE_PLANE_MODE === 'cloudflare-artifacts'
    ? 'cloudflare-artifacts'
    : 'unavailable';
}

function canonicalFireCrabRemote(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'artifacts.cloudflare.net' && !host.endsWith('.artifacts.cloudflare.net')) return null;
    const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.at(-1) !== 'firecrab.git' || !segments.includes('gitflare')) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function sourcePlaneStatus(env: AssuranceEnv): SourcePlaneStatus {
  const mode = sourcePlaneMode(env);
  const bindingPresent = Boolean(env.ARTIFACTS);
  const remoteConfigured = canonicalFireCrabRemote(env.GITFLARE_FIRECRAB_REMOTE) !== null;

  let reason: SourcePlaneStatus['reason'] = null;
  if (mode !== 'cloudflare-artifacts') {
    reason = 'cloudflare-artifacts-access-unavailable';
  } else if (!bindingPresent) {
    reason = 'cloudflare-artifacts-binding-unavailable';
  } else if (!remoteConfigured) {
    reason = 'cloudflare-artifacts-remote-unconfigured';
  }

  const available = reason === null;
  return {
    schemaVersion: 1,
    authority: 'gitflare',
    requestedProvider: 'cloudflare-artifacts',
    canonical: available,
    available,
    mode,
    bindingPresent,
    remoteConfigured,
    reason,
  };
}

function sourcePlaneBlocked(env: AssuranceEnv): Response {
  const sourcePlane = sourcePlaneStatus(env);
  return json({
    schemaVersion: 1,
    verdict: 'BLOCKED',
    error: 'canonical source plane is unavailable',
    code: 'SOURCE_PLANE_UNAVAILABLE',
    reason: sourcePlane.reason,
    retryable: true,
    sourcePlane,
  }, 503);
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

function configuredFireCrabRemote(env: AssuranceEnv): string {
  const remote = canonicalFireCrabRemote(env.GITFLARE_FIRECRAB_REMOTE);
  if (!remote) throw new Error('Gitflare FireCrab Artifacts remote is not configured');
  return remote;
}

export async function handleAssuranceSourceTicket(
  request: Request,
  env: AssuranceEnv,
  repoName: string,
): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  if (!REPO.test(repoName)) return json({ error: 'invalid repository name', code: 'INVALID_REPOSITORY' }, 400);

  const sourcePlane = sourcePlaneStatus(env);
  if (!sourcePlane.available || !env.ARTIFACTS) return sourcePlaneBlocked(env);

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
  let remote: string;
  try {
    ttl = ttlSeconds(body.ttl);
    remote = configuredFireCrabRemote(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message, code: 'INVALID_ARGUMENT' }, 400);
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
    remote,
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

    if (request.method === 'GET' && url.pathname === '/v1/source-plane') {
      return json(sourcePlaneStatus(env));
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      const sourcePlane = sourcePlaneStatus(env);
      return json({
        ok: true,
        service: 'gitflare-api',
        authority: 'gitflare',
        sourcePlane,
      });
    }

    const match = /^\/repos\/([^/]+)\/assurance\/source-ticket\/?$/.exec(url.pathname);
    if (match) {
      if (request.method !== 'POST') return json({ error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);
      return handleAssuranceSourceTicket(request, env, decodeURIComponent(match[1]));
    }

    // The pre-entitlement deployment is intentionally useful: health and
    // assurance status work, while every Artifacts-backed repo operation fails
    // closed instead of crashing on an absent Worker binding.
    if (!env.ARTIFACTS && url.pathname.startsWith('/repos')) {
      return sourcePlaneBlocked(env);
    }

    return baseHandler.fetch(request, env as never);
  },
};
