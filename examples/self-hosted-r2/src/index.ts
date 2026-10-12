import { Container, getContainer } from '@cloudflare/containers';

type Phase = 'clean' | 'mutating';

type RepoStateRow = {
  repo_key: string;
  generation: number;
  checkpoint_key: string | null;
  checkpoint_etag: string | null;
  head_sha: string | null;
  phase: Phase;
  updated_at: number;
};

type ContainerStatus = {
  ok: boolean;
  bootId: string;
  head: string | null;
};

type Checkpoint = {
  key: string;
  etag: string | null;
  head: string | null;
};

export interface Env {
  REPO_CONTAINER: DurableObjectNamespace<RepoContainer>;
  REPO_BACKUPS: R2Bucket;
  GITFLARE_GIT_TOKEN: string;
  GITFLARE_ADMIN_TOKEN: string;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  responseHeaders.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function validRepoPart(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

function parseRepoPath(pathname: string): { repoKey: string; suffix: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const owner = decodeURIComponent(match[1]);
  const repo = decodeURIComponent(match[2]);
  if (!validRepoPart(owner) || !validRepoPart(repo)) return null;
  return { repoKey: `${owner}/${repo}`, suffix: match[3] ?? '' };
}

function parseAdminPath(pathname: string): { repoKey: string; action: 'state' | 'restart' } | null {
  const match = /^\/_gitflare\/repos\/([^/]+)\/([^/]+)\/(state|restart)$/.exec(pathname);
  if (!match) return null;
  const owner = decodeURIComponent(match[1]);
  const repo = decodeURIComponent(match[2]);
  if (!validRepoPart(owner) || !validRepoPart(repo)) return null;
  return { repoKey: `${owner}/${repo}`, action: match[3] as 'state' | 'restart' };
}

function tokenMatches(actual: string | null | undefined, expected: string | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length);
}

function basicPassword(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Basic ')) return null;
  try {
    const decoded = atob(authorization.slice('Basic '.length));
    const separator = decoded.indexOf(':');
    return separator >= 0 ? decoded.slice(separator + 1) : null;
  } catch {
    return null;
  }
}

function gitAuthorized(request: Request, env: Env): boolean {
  return (
    tokenMatches(bearerToken(request), env.GITFLARE_GIT_TOKEN) ||
    tokenMatches(basicPassword(request), env.GITFLARE_GIT_TOKEN)
  );
}

function adminAuthorized(request: Request, env: Env): boolean {
  return tokenMatches(bearerToken(request), env.GITFLARE_ADMIN_TOKEN);
}

function unauthorized(): Response {
  return json({ error: 'Unauthorized' }, 401, {
    'www-authenticate': 'Basic realm="Gitflare"',
  });
}

export class RepoContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = false;

  private queue: Promise<void> = Promise.resolve();
  private readyBootId: string | null = null;
  private readyGeneration: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS repo_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        repo_key TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        checkpoint_key TEXT,
        checkpoint_etag TEXT,
        head_sha TEXT,
        phase TEXT NOT NULL DEFAULT 'clean' CHECK(phase IN ('clean', 'mutating')),
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private readState(): RepoStateRow | null {
    const rows = this.ctx.storage.sql.exec<RepoStateRow>('SELECT * FROM repo_state WHERE singleton = 1').toArray();
    return rows[0] ?? null;
  }

  private ensureIdentity(repoKey: string): RepoStateRow {
    const existing = this.readState();
    if (existing) {
      if (existing.repo_key !== repoKey) throw new Error('repository identity mismatch');
      return existing;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO repo_state
       (singleton, repo_key, generation, checkpoint_key, checkpoint_etag, head_sha, phase, updated_at)
       VALUES (1, ?, 0, NULL, NULL, NULL, 'clean', ?)`,
      repoKey,
      Date.now(),
    );
    return this.readState()!;
  }

  private async containerStatus(): Promise<ContainerStatus> {
    const response = await this.containerFetch('http://localhost/__gitflare/status');
    if (!response.ok) throw new Error(`container status failed: ${response.status}`);
    return response.json<ContainerStatus>();
  }

  private async resetContainer(): Promise<void> {
    const response = await this.containerFetch('http://localhost/__gitflare/reset', { method: 'POST' });
    if (!response.ok) throw new Error(`container reset failed: ${response.status}`);
  }

  private async ensureReady(repoKey: string): Promise<RepoStateRow> {
    let state = this.ensureIdentity(repoKey);
    const status = await this.containerStatus();

    if (
      state.phase === 'clean' &&
      this.readyBootId === status.bootId &&
      this.readyGeneration === state.generation
    ) {
      return state;
    }

    if (state.checkpoint_key) {
      const backup = await this.env.REPO_BACKUPS.get(state.checkpoint_key);
      if (!backup) throw new Error(`checkpoint missing: ${state.checkpoint_key}`);
      const restored = await this.containerFetch('http://localhost/__gitflare/import', {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: backup.body,
      });
      if (!restored.ok) throw new Error(`checkpoint restore failed: ${restored.status}`);
      const restoredState = await restored.json<{ ok: boolean; head: string | null }>();
      if (state.head_sha && restoredState.head !== state.head_sha) {
        throw new Error(`restored HEAD mismatch: expected ${state.head_sha}, got ${restoredState.head}`);
      }
    } else {
      await this.resetContainer();
    }

    if (state.phase === 'mutating') {
      this.ctx.storage.sql.exec(
        "UPDATE repo_state SET phase = 'clean', updated_at = ? WHERE singleton = 1",
        Date.now(),
      );
      await this.ctx.storage.sync();
      state = this.readState()!;
    }

    this.readyBootId = status.bootId;
    this.readyGeneration = state.generation;
    return state;
  }

  private async createCheckpoint(repoKey: string, generation: number): Promise<Checkpoint> {
    const exported = await this.containerFetch('http://localhost/__gitflare/export');
    if (!exported.ok || !exported.body) throw new Error(`checkpoint export failed: ${exported.status}`);

    const length = Number(exported.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('checkpoint export did not provide a valid content length');

    const head = exported.headers.get('x-gitflare-head');
    const key = `repos/${encodeURIComponent(repoKey)}/generations/${generation}.tar.gz`;
    const fixed = new FixedLengthStream(length);
    const pipePromise = exported.body.pipeTo(fixed.writable);
    const putPromise = this.env.REPO_BACKUPS.put(key, fixed.readable, {
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: {
        repo: repoKey,
        generation: String(generation),
        head: head ?? '',
      },
    });
    const [stored] = await Promise.all([putPromise, pipePromise.then(() => undefined)]);
    if (!stored) throw new Error('R2 rejected checkpoint upload');

    return { key, etag: stored.etag, head };
  }

  private markMutating(): void {
    this.ctx.storage.sql.exec(
      "UPDATE repo_state SET phase = 'mutating', updated_at = ? WHERE singleton = 1",
      Date.now(),
    );
  }

  private commitCheckpoint(generation: number, checkpoint: Checkpoint): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE repo_state
         SET generation = ?, checkpoint_key = ?, checkpoint_etag = ?, head_sha = ?, phase = 'clean', updated_at = ?
         WHERE singleton = 1`,
        generation,
        checkpoint.key,
        checkpoint.etag,
        checkpoint.head,
        Date.now(),
      );
    });
  }

  private async handleGit(request: Request, repoKey: string): Promise<Response> {
    const state = await this.ensureReady(repoKey);
    const pathname = new URL(request.url).pathname;
    const mutatesRepo = request.method === 'POST' && pathname === '/repo.git/git-receive-pack';

    if (!mutatesRepo) return this.containerFetch(request);

    const generation = state.generation + 1;
    this.markMutating();
    await this.ctx.storage.sync();

    try {
      const upstream = await this.containerFetch(request);
      const responseBody = await upstream.arrayBuffer();
      const responseHeaders = new Headers(upstream.headers);

      if (!upstream.ok) {
        this.readyBootId = null;
        this.readyGeneration = null;
        await this.ensureReady(repoKey);
        return new Response(responseBody, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }

      const checkpoint = await this.createCheckpoint(repoKey, generation);
      this.commitCheckpoint(generation, checkpoint);
      await this.ctx.storage.sync();
      this.readyGeneration = generation;

      return new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      this.readyBootId = null;
      this.readyGeneration = null;
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const repoKey = request.headers.get('x-gitflare-repo');
    if (!repoKey) return json({ error: 'Missing repository identity' }, 400);

    return this.serialized(() => this.handleGit(request, repoKey));
  }

  async stateSnapshot(repoKey: string): Promise<RepoStateRow> {
    return this.serialized(async () => this.ensureIdentity(repoKey));
  }

  async restartContainer(repoKey: string): Promise<RepoStateRow> {
    return this.serialized(async () => {
      const state = this.ensureIdentity(repoKey);
      await this.destroy();
      this.readyBootId = null;
      this.readyGeneration = null;
      return state;
    });
  }
}

async function handleAdmin(
  request: Request,
  env: Env,
  admin: NonNullable<ReturnType<typeof parseAdminPath>>,
): Promise<Response> {
  if (!adminAuthorized(request, env)) return unauthorized();
  const repo = getContainer(env.REPO_CONTAINER, admin.repoKey);

  if (request.method === 'GET' && admin.action === 'state') {
    return json(await repo.stateSnapshot(admin.repoKey));
  }
  if (request.method === 'POST' && admin.action === 'restart') {
    return json({ ok: true, repo: admin.repoKey, state: await repo.restartContainer(admin.repoKey) });
  }
  return json({ error: 'Method not allowed' }, 405);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({
        ok: true,
        service: 'gitflare-self-hosted-r2',
        sourcePlane: 'repo-container-do',
        persistence: 'r2-checkpoints',
      });
    }

    const admin = parseAdminPath(url.pathname);
    if (admin) {
      try {
        return await handleAdmin(request, env, admin);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
      }
    }

    const parsed = parseRepoPath(url.pathname);
    if (!parsed) return json({ error: 'Not found' }, 404);
    if (!gitAuthorized(request, env)) return unauthorized();

    const target = new URL(request.url);
    target.pathname = `/repo.git${parsed.suffix}`;
    const forwarded = new Request(target, request);
    forwarded.headers.delete('authorization');
    forwarded.headers.set('x-gitflare-repo', parsed.repoKey);

    try {
      return await getContainer(env.REPO_CONTAINER, parsed.repoKey).fetch(forwarded);
    } catch (error) {
      return json(
        {
          error: 'Repository service unavailable',
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
        503,
      );
    }
  },
} satisfies ExportedHandler<Env>;
