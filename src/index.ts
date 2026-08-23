type TokenScope = 'read' | 'write';

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function authorized(request: Request, env: Env): boolean {
  if (!env.GITFLARE_ADMIN_TOKEN) return false;
  return request.headers.get('authorization') === `Bearer ${env.GITFLARE_ADMIN_TOKEN}`;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function tokenTtl(value: unknown): number {
  if (value === undefined || value === null) return 900;
  if (!Number.isSafeInteger(value)) throw new Error('ttl must be an integer number of seconds');
  const ttl = Number(value);
  if (ttl < 60 || ttl > 3600) throw new Error('ttl must be between 60 and 3600 seconds');
  return ttl;
}

function tokenScope(value: unknown): TokenScope {
  if (value === undefined || value === null) return 'read';
  if (value !== 'read' && value !== 'write') throw new Error('scope must be read or write');
  return value;
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error('content-type must be application/json');
  return request.json() as Promise<T>;
}

async function listRepos(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '25');
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const page = await env.ARTIFACTS.list({ limit, ...(cursor ? { cursor } : {}) });
  return json({
    repos: page.repos.map((repo) => ({ name: repo.name, status: repo.status ?? null })),
    cursor: page.cursor ?? null,
  });
}

async function createRepo(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateRepoBody>(request);
  const name = requireString(body.name, 'name');
  const created = await env.ARTIFACTS.create(name, {
    description: optionalString(body.description, 'description'),
    readOnly: optionalBoolean(body.readOnly, 'readOnly'),
    setDefaultBranch: optionalString(body.defaultBranch, 'defaultBranch') ?? 'main',
  });

  return json({
    name: created.name,
    remote: created.remote,
    defaultBranch: created.defaultBranch ?? 'main',
    initialToken: created.token ?? null,
  }, 201);
}

async function createRepoToken(request: Request, env: Env, repoName: string): Promise<Response> {
  const body = await readJson<CreateTokenBody>(request);
  const scope = tokenScope(body.scope);
  const ttl = tokenTtl(body.ttl);
  const repo = await env.ARTIFACTS.get(repoName);
  const token = await repo.createToken(scope, ttl);
  return json({
    repo: repoName,
    scope,
    ttl,
    token: token.plaintext,
    expiresAt: token.expiresAt ?? null,
  }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({
        ok: true,
        service: 'gitflare-api',
        sourcePlane: 'cloudflare-artifacts',
        namespace: 'gitflare',
      });
    }

    if (!authorized(request, env)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/repos') {
        return await listRepos(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/repos') {
        return await createRepo(request, env);
      }

      const tokenMatch = /^\/repos\/([^/]+)\/tokens$/.exec(url.pathname);
      if (request.method === 'POST' && tokenMatch) {
        return await createRepoToken(request, env, decodeURIComponent(tokenMatch[1]));
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 400);
    }
  },
};
