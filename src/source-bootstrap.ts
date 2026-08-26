import type { HandoffArtifactsBinding } from './execution-handoff.js';

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const OWNER = 'mcc0nnell';

export interface ArtifactsImportResult {
  name: string;
  remote: string;
  defaultBranch?: string;
  token?: string;
}

export interface SourceArtifactsBinding extends HandoffArtifactsBinding {
  import(params: {
    source: { url: string; branch?: string };
    target: { name: string; opts?: { description?: string; readOnly?: boolean } };
  }): Promise<ArtifactsImportResult>;
}

export interface SourceRegistryObject {
  body: ReadableStream;
}

export interface SourceRegistryBucket {
  get(key: string): Promise<SourceRegistryObject | null>;
  put(
    key: string,
    value: ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

export interface SourceBootstrapEnv {
  ARTIFACTS: SourceArtifactsBinding;
  EVIDENCE: SourceRegistryBucket;
  GITFLARE_ADMIN_TOKEN: string;
}

export interface SourceRepoRecord {
  schemaVersion: 1;
  authority: 'gitflare';
  provider: 'cloudflare-artifacts';
  namespace: 'gitflare';
  repo: string;
  sourceUrl: string;
  branch: string;
  remote: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function authorized(request: Request, env: SourceBootstrapEnv): boolean {
  return Boolean(env.GITFLARE_ADMIN_TOKEN)
    && request.headers.get('authorization') === `Bearer ${env.GITFLARE_ADMIN_TOKEN}`;
}

function registryKey(repo: string): string {
  return `control/source-repos/${repo}.json`;
}

function sourceUrl(repo: string): string {
  return `https://github.com/${OWNER}/${repo}`;
}

function validBranch(value: string): boolean {
  return GIT_BRANCH.test(value)
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && !value.endsWith('/')
    && !value.endsWith('.lock');
}

function validRemote(value: string, repo: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && parsed.pathname.endsWith(`/${repo}.git`);
  } catch {
    return false;
  }
}

async function readRecord(bucket: SourceRegistryBucket, repo: string): Promise<SourceRepoRecord | null> {
  const object = await bucket.get(registryKey(repo));
  if (!object) return null;
  try {
    const raw = await new Response(object.body).json() as SourceRepoRecord;
    if (
      raw.schemaVersion !== 1
      || raw.authority !== 'gitflare'
      || raw.provider !== 'cloudflare-artifacts'
      || raw.namespace !== 'gitflare'
      || raw.repo !== repo
      || !validBranch(raw.branch)
      || !validRemote(raw.remote, repo)
    ) {
      throw new Error('invalid source registry record');
    }
    return raw;
  } catch {
    throw new Error('invalid source registry record');
  }
}

export async function registeredSourceRemote(
  bucket: SourceRegistryBucket,
  repo: string,
): Promise<string | null> {
  const record = await readRecord(bucket, repo);
  return record?.remote ?? null;
}

export async function handleSourceBootstrap(
  request: Request,
  env: SourceBootstrapEnv,
  rawRepo: string,
): Promise<Response> {
  if (!authorized(request, env)) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }

  let repo: string;
  try {
    repo = decodeURIComponent(rawRepo);
  } catch {
    return json({ error: 'Invalid repository name', code: 'INVALID_REPO' }, 400);
  }
  if (!REPO_NAME.test(repo)) {
    return json({ error: 'Invalid repository name', code: 'INVALID_REPO' }, 400);
  }
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    return json({ error: 'content-type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
  }

  let raw: { branch?: unknown };
  try {
    raw = await request.json() as { branch?: unknown };
  } catch {
    return json({ error: 'request body must contain valid JSON', code: 'INVALID_JSON' }, 400);
  }
  const branch = typeof raw.branch === 'string' ? raw.branch.trim() : '';
  if (!validBranch(branch)) {
    return json({ error: 'branch is invalid', code: 'INVALID_BRANCH' }, 400);
  }

  let existing: SourceRepoRecord | null;
  try {
    existing = await readRecord(env.EVIDENCE, repo);
  } catch {
    return json({ error: 'source registry record is invalid', code: 'SOURCE_REGISTRY_INVALID' }, 500);
  }
  if (existing) {
    if (existing.branch !== branch) {
      return json({ error: 'repository is already bootstrapped from another branch', code: 'SOURCE_ALREADY_REGISTERED' }, 409);
    }
    return json(existing, 200);
  }

  const upstream = sourceUrl(repo);
  let imported: ArtifactsImportResult;
  try {
    imported = await env.ARTIFACTS.import({
      source: { url: upstream, branch },
      target: {
        name: repo,
        opts: {
          description: `Gitflare immutable source baseline for ${OWNER}/${repo}`,
          readOnly: false,
        },
      },
    });
  } catch {
    return json({ error: 'source repository import failed', code: 'SOURCE_IMPORT_FAILED' }, 502);
  }

  if (imported.name !== repo || !validRemote(imported.remote, repo)) {
    return json({ error: 'Artifacts import returned unexpected repository identity', code: 'SOURCE_IMPORT_IDENTITY_MISMATCH' }, 502);
  }

  const record: SourceRepoRecord = {
    schemaVersion: 1,
    authority: 'gitflare',
    provider: 'cloudflare-artifacts',
    namespace: 'gitflare',
    repo,
    sourceUrl: upstream,
    branch,
    remote: imported.remote,
  };
  const body = new Response(JSON.stringify(record)).body;
  if (!body) return json({ error: 'could not encode source registry record', code: 'SOURCE_REGISTRY_FAILED' }, 500);
  try {
    await env.EVIDENCE.put(registryKey(repo), body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { repo, branch },
    });
  } catch {
    return json({ error: 'could not persist source registry record', code: 'SOURCE_REGISTRY_FAILED' }, 502);
  }

  // Artifacts import returns an initial token. It is intentionally discarded;
  // execution receives fresh, short-lived repo-scoped read tokens instead.
  return json(record, 201);
}
