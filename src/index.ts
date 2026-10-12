import { forgeConsoleHtml } from './forge-console.ts';
import { provisionAgentFork } from './agent-forks.ts';

type TokenScope = 'read' | 'write';
type LogLevel = 'info' | 'warn' | 'error';

interface ArtifactRepoSummary {
  name: string;
  status?: string;
}

interface ArtifactRepoListResult {
  repos: ArtifactRepoSummary[];
  cursor?: string | null;
}

interface ArtifactTokenResult {
  plaintext: string;
  expiresAt?: string;
}

interface ArtifactRepoHandle {
  fork(name: string, opts: { description: string; defaultBranchOnly: boolean; readOnly: boolean }): Promise<{ name: string; remote: string; defaultBranch?: string; token?: unknown }>;
  [Symbol.dispose]?: () => void;
  createToken(scope?: TokenScope, ttl?: number): Promise<ArtifactTokenResult>;
}

interface ArtifactCreateResult {
  name: string;
  remote: string;
  defaultBranch?: string;
  token?: unknown;
}

interface ArtifactsBinding {
  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactRepoListResult>;
  create(
    name: string,
    opts?: {
      description?: string;
      readOnly?: boolean;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactCreateResult>;
  get(name: string): Promise<ArtifactRepoHandle>;
}

interface Env {
  ARTIFACTS: ArtifactsBinding;
  GITFLARE_ADMIN_TOKEN: string;
}

interface CreateRepoBody {
  name?: unknown;
  description?: unknown;
  readOnly?: unknown;
  defaultBranch?: unknown;
}

interface CreateTokenBody {
  scope?: unknown;
  ttl?: unknown;
}

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  startedAt: number;
  cfRay?: string;
}

interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

class GitflareError extends Error {
  readonly status: number;
  readonly code: string;
  readonly boundary: 'request' | 'auth' | 'artifacts' | 'gitflare';
  constructor(
    status: number,
    code: string,
    message: string,
    boundary: 'request' | 'auth' | 'artifacts' | 'gitflare' = 'request',
  ) {
    super(message);
    this.name = 'GitflareError';
    this.status = status;
    this.code = code;
    this.boundary = boundary;
  }
}

function emit(level: LogLevel, event: string, ctx: RequestContext, fields: LogFields = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'gitflare-api',
    source_plane: 'cloudflare-artifacts',
    event,
    request_id: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    ...(ctx.cfRay ? { cf_ray: ctx.cfRay } : {}),
    ...fields,
  };

  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
  } else if (level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

function json(body: unknown, status = 200, requestId?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (requestId) headers.set('x-gitflare-request-id', requestId);

  return new Response(JSON.stringify(body), { status, headers });
}

function forgeConsoleResponse(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(forgeConsoleHtml().replace('__FORGE_NONCE__', nonce), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  });
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.GITFLARE_ADMIN_TOKEN) return false;
  const provided = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.GITFLARE_ADMIN_TOKEN}`;
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const actual = new Uint8Array(actualHash), wanted = new Uint8Array(expectedHash);
  let different = 0;
  for (let i = 0; i < wanted.length; i++) different |= actual[i] ^ wanted[i];
  return different === 0;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GitflareError(400, 'INVALID_ARGUMENT', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function repoNameFromPath(segment: string): string {
  let name: string;
  try { name = decodeURIComponent(segment); } catch {
    throw new GitflareError(400, 'INVALID_REPO_NAME', 'Invalid repository name');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name)) {
    throw new GitflareError(400, 'INVALID_REPO_NAME', 'Invalid repository name');
  }
  return name;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new GitflareError(400, 'INVALID_ARGUMENT', `${label} must be a boolean`);
  }
  return value;
}

function tokenTtl(value: unknown): number {
  if (value === undefined || value === null) return 900;
  if (!Number.isSafeInteger(value)) {
    throw new GitflareError(400, 'INVALID_TOKEN_TTL', 'ttl must be an integer number of seconds');
  }
  const ttl = Number(value);
  if (ttl < 60 || ttl > 3600) {
    throw new GitflareError(400, 'INVALID_TOKEN_TTL', 'ttl must be between 60 and 3600 seconds');
  }
  return ttl;
}

function tokenScope(value: unknown): TokenScope {
  if (value === undefined || value === null) return 'read';
  if (value !== 'read' && value !== 'write') {
    throw new GitflareError(400, 'INVALID_TOKEN_SCOPE', 'scope must be read or write');
  }
  return value;
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new GitflareError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new GitflareError(400, 'INVALID_JSON', 'request body must contain valid JSON');
  }
}

function upstreamFailure(code: string): GitflareError {
  return new GitflareError(502, code, 'Cloudflare Artifacts operation failed', 'artifacts');
}

async function listRepos(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '25');
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
  const cursor = url.searchParams.get('cursor') ?? undefined;

  let page: ArtifactRepoListResult;
  try {
    page = await env.ARTIFACTS.list({ limit, ...(cursor ? { cursor } : {}) });
  } catch {
    throw upstreamFailure('ARTIFACTS_LIST_FAILED');
  }

  emit('info', 'repos.list.succeeded', ctx, {
    repo_count: page.repos.length,
    limit,
    has_next_cursor: Boolean(page.cursor),
  });

  return json({
    repos: page.repos.map((repo) => ({ name: repo.name, status: repo.status ?? null })),
    cursor: page.cursor ?? null,
  }, 200, ctx.requestId);
}

async function createRepo(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const body = await readJson<CreateRepoBody>(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GitflareError(400, 'INVALID_ARGUMENT', 'JSON object required');
  const name = repoNameFromPath(encodeURIComponent(requireString(body.name, 'name')));
  const description = optionalString(body.description, 'description');
  const readOnly = optionalBoolean(body.readOnly, 'readOnly');
  const defaultBranch = optionalString(body.defaultBranch, 'defaultBranch') ?? 'main';

  let created: ArtifactCreateResult;
  try {
    created = await env.ARTIFACTS.create(name, {
      description,
      readOnly,
      setDefaultBranch: defaultBranch,
    });
  } catch {
    throw upstreamFailure('ARTIFACTS_CREATE_FAILED');
  }

  emit('info', 'repo.create.succeeded', ctx, {
    repo: created.name,
    default_branch: created.defaultBranch ?? defaultBranch,
    read_only: readOnly ?? false,
  });

  return json({
    name: created.name,
    remote: created.remote,
    defaultBranch: created.defaultBranch ?? defaultBranch,
    initialToken: created.token ?? null,
  }, 201, ctx.requestId);
}

async function createRepoToken(
  request: Request,
  env: Env,
  repoName: string,
  ctx: RequestContext,
): Promise<Response> {
  const body = await readJson<CreateTokenBody>(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GitflareError(400, 'INVALID_ARGUMENT', 'JSON object required');
  const scope = tokenScope(body.scope);
  const ttl = tokenTtl(body.ttl);

  let repo: ArtifactRepoHandle;
  try {
    repo = await env.ARTIFACTS.get(repoName);
  } catch {
    throw upstreamFailure('ARTIFACTS_REPO_GET_FAILED');
  }

  let token: ArtifactTokenResult;
  try {
    token = await repo.createToken(scope, ttl);
  } catch {
    throw upstreamFailure('ARTIFACTS_TOKEN_CREATE_FAILED');
  } finally {
    repo[Symbol.dispose]?.();
  }

  emit('info', 'repo.token.create.succeeded', ctx, {
    repo: repoName,
    scope,
    ttl_seconds: ttl,
    expires_at: token.expiresAt ?? null,
  });

  return json({
    repo: repoName,
    scope,
    ttl,
    token: token.plaintext,
    expiresAt: token.expiresAt ?? null,
  }, 201, ctx.requestId);
}

function requestContext(request: Request, url: URL): RequestContext {
  return {
    requestId: crypto.randomUUID(),
    method: request.method,
    path: url.pathname,
    startedAt: Date.now(),
    cfRay: request.headers.get('cf-ray') ?? undefined,
  };
}

function complete(ctx: RequestContext, response: Response, event = 'request.completed'): Response {
  emit('info', event, ctx, {
    status: response.status,
    duration_ms: Date.now() - ctx.startedAt,
  });
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ctx = requestContext(request, url);

    emit('info', 'request.received', ctx);

    if (request.method === 'GET' && url.pathname === '/forge') return forgeConsoleResponse();

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return complete(ctx, json({
        ok: true,
        service: 'gitflare-api',
        sourcePlane: 'cloudflare-artifacts',
        namespace: 'gitflare',
        requestId: ctx.requestId,
      }, 200, ctx.requestId));
    }

    if (!(await authorized(request, env))) {
      emit('warn', 'auth.denied', ctx, {
        status: 401,
        error_code: 'UNAUTHORIZED',
      });
      return complete(ctx, json({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        requestId: ctx.requestId,
      }, 401, ctx.requestId));
    }

    try {
      if (request.method === 'GET' && url.pathname === '/repos') {
        return complete(ctx, await listRepos(request, env, ctx));
      }

      if (request.method === 'POST' && url.pathname === '/repos') {
        return complete(ctx, await createRepo(request, env, ctx));
      }

      const tokenMatch = /^\/repos\/([^/]+)\/tokens$/.exec(url.pathname);
      if (request.method === 'POST' && tokenMatch) {
        return complete(
          ctx,
          await createRepoToken(request, env, repoNameFromPath(tokenMatch[1]), ctx),
        );
      }

      const forkMatch = /^\/repos\/([^/]+)\/forks$/.exec(url.pathname);
      if (request.method === 'POST' && forkMatch) {
        const body = await readJson<{ label?: unknown }>(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new GitflareError(400, 'INVALID_ARGUMENT', 'JSON object required');
        }
        const label = optionalString(body.label, 'label') ?? 'isolated agent workspace';
        const name = repoNameFromPath(forkMatch[1]);
        try {
          const fork = await provisionAgentFork(env.ARTIFACTS, name, label);
          emit('info', 'repo.fork.created', ctx, { repo: name, fork: fork.fork });
          return complete(ctx, json(fork, 201, ctx.requestId));
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Invalid')) {
            throw new GitflareError(400, 'INVALID_ARGUMENT', error.message);
          }
          throw upstreamFailure('ARTIFACTS_FORK_FAILED');
        }
      }

      throw new GitflareError(404, 'NOT_FOUND', 'Not found');
    } catch (error) {
      const normalized = error instanceof GitflareError
        ? error
        : new GitflareError(500, 'INTERNAL_ERROR', 'Internal server error', 'gitflare');

      emit(normalized.status >= 500 ? 'error' : 'warn', 'request.failed', ctx, {
        status: normalized.status,
        error_code: normalized.code,
        boundary: normalized.boundary,
        duration_ms: Date.now() - ctx.startedAt,
      });

      return json({
        error: normalized.message,
        code: normalized.code,
        requestId: ctx.requestId,
      }, normalized.status, ctx.requestId);
    }
  },
};
