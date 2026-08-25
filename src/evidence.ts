import type { HandoffArtifactsBinding } from './execution-handoff.js';

export const HOST_EVIDENCE_ARTIFACTS = [
  'result',
  'archive',
  'sha256s',
  'notices',
  'license-inventory',
] as const;

type EvidenceArtifact = typeof HOST_EVIDENCE_ARTIFACTS[number];

interface EvidenceObject {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface EvidenceBody extends EvidenceObject {
  body: ReadableStream;
}

export interface EvidenceBucket {
  put(
    key: string,
    value: ReadableStream,
    options?: {
      onlyIf?: { etagDoesNotMatch?: string };
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<EvidenceObject | null>;
  head(key: string): Promise<EvidenceObject | null>;
  get(key: string): Promise<EvidenceBody | null>;
}

export interface EvidenceEnv {
  ARTIFACTS: HandoffArtifactsBinding;
  EVIDENCE: EvidenceBucket;
  GITFLARE_ADMIN_TOKEN: string;
  GITFLARE_EVIDENCE_HMAC_KEY: string;
}

const GIT_SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_TTL_SECONDS = 2 * 60 * 60;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function adminAuthorized(request: Request, env: EvidenceEnv): boolean {
  return Boolean(env.GITFLARE_ADMIN_TOKEN)
    && request.headers.get('authorization') === `Bearer ${env.GITFLARE_ADMIN_TOKEN}`;
}

function artifactId(value: string): EvidenceArtifact | null {
  return (HOST_EVIDENCE_ARTIFACTS as readonly string[]).includes(value)
    ? value as EvidenceArtifact
    : null;
}

function objectKey(runId: string, artifact: EvidenceArtifact): string {
  return `runs/${runId}/${artifact}`;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error('GITFLARE_EVIDENCE_HMAC_KEY must be at least 32 characters');
  }
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function capabilityInput(runId: string, repo: string, sha: string, expiresAt: number): string {
  return `gitflare-evidence-v1\n${runId}\n${repo}\n${sha}\n${expiresAt}`;
}

async function mintCapability(
  env: EvidenceEnv,
  runId: string,
  repo: string,
  sha: string,
  expiresAt: number,
): Promise<string> {
  const key = await hmacKey(env.GITFLARE_EVIDENCE_HMAC_KEY);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(capabilityInput(runId, repo, sha, expiresAt)),
  );
  return `v1.${expiresAt}.${repo}.${sha}.${toHex(signature)}`;
}

interface CapabilityClaims {
  repo: string;
  sha: string;
  expiresAt: number;
}

async function verifyCapability(
  env: EvidenceEnv,
  runId: string,
  token: string,
): Promise<CapabilityClaims | null> {
  const [version, rawExpiry, repo, sha, signature, ...extra] = token.split('.');
  if (
    version !== 'v1'
    || extra.length
    || !REPO_NAME.test(repo ?? '')
    || !GIT_SHA1.test(sha ?? '')
    || !/^[0-9a-f]{64}$/i.test(signature ?? '')
  ) {
    return null;
  }
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }
  const key = await hmacKey(env.GITFLARE_EVIDENCE_HMAC_KEY);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromHex(signature!),
    new TextEncoder().encode(capabilityInput(runId, repo!, sha!, expiresAt)),
  );
  return valid ? { repo: repo!, sha: sha!.toLowerCase(), expiresAt } : null;
}

export async function handleEvidenceHandoff(
  request: Request,
  env: EvidenceEnv,
  rawRepo: string,
): Promise<Response> {
  if (!adminAuthorized(request, env)) {
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
  let body: { sha?: unknown };
  try {
    body = await request.json() as { sha?: unknown };
  } catch {
    return json({ error: 'request body must contain valid JSON', code: 'INVALID_JSON' }, 400);
  }
  const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
  if (!GIT_SHA1.test(sha)) {
    return json({ error: 'sha must be a full 40-hex Git object id', code: 'INVALID_SHA' }, 400);
  }

  let handle;
  try {
    handle = await env.ARTIFACTS.get(repo);
  } catch {
    return json({ error: 'repository is unavailable', code: 'SOURCE_REPO_UNAVAILABLE' }, 502);
  }
  try {
    await handle.readCommit(sha);
  } catch {
    return json({ error: 'source object is not present in Gitflare', code: 'SOURCE_OBJECT_NOT_FOUND' }, 404);
  }

  const runId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + EVIDENCE_TTL_SECONDS;
  let uploadToken: string;
  try {
    uploadToken = await mintCapability(env, runId, repo, sha, expiresAt);
  } catch {
    return json({ error: 'evidence capability is not configured', code: 'EVIDENCE_UNCONFIGURED' }, 503);
  }
  const origin = new URL(request.url).origin;
  return json({
    schemaVersion: 1,
    authority: 'gitflare-r2',
    runId,
    repo,
    sha,
    uploadBaseUrl: `${origin}/evidence/uploads/${runId}`,
    uploadToken,
    expiresAt,
    artifacts: HOST_EVIDENCE_ARTIFACTS,
  }, 201);
}

export async function handleEvidenceUpload(
  request: Request,
  env: EvidenceEnv,
  runId: string,
  rawArtifact: string,
): Promise<Response> {
  if (!RUN_ID.test(runId)) {
    return json({ error: 'Invalid run id', code: 'INVALID_RUN_ID' }, 400);
  }
  const artifact = artifactId(rawArtifact);
  if (!artifact) {
    return json({ error: 'Unknown evidence artifact', code: 'INVALID_ARTIFACT' }, 404);
  }
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }
  let claims: CapabilityClaims | null;
  try {
    claims = await verifyCapability(env, runId, authorization.slice(7));
  } catch {
    return json({ error: 'evidence capability is not configured', code: 'EVIDENCE_UNCONFIGURED' }, 503);
  }
  if (!claims) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }
  if (!request.body) {
    return json({ error: 'artifact body is required', code: 'EMPTY_ARTIFACT' }, 400);
  }
  const claimedSha256 = (request.headers.get('x-gitflare-sha256') ?? '').toLowerCase();
  if (!SHA256.test(claimedSha256)) {
    return json({ error: 'x-gitflare-sha256 must be 64 hex characters', code: 'INVALID_SHA256' }, 400);
  }
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_ARTIFACT_BYTES) {
    return json({ error: 'content-length must be between 1 and 536870912 bytes', code: 'INVALID_CONTENT_LENGTH' }, 400);
  }

  const key = objectKey(runId, artifact);
  const existing = await env.EVIDENCE.head(key);
  if (existing) {
    const existingDigest = existing.customMetadata?.claimedSha256?.toLowerCase();
    if (existingDigest === claimedSha256) {
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    return json({ error: 'artifact is already sealed for this run', code: 'ARTIFACT_ALREADY_SEALED' }, 409);
  }

  const stored = await env.EVIDENCE.put(key, request.body, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: {
      contentType: request.headers.get('content-type') ?? 'application/octet-stream',
    },
    customMetadata: {
      repo: claims.repo,
      sourceSha: claims.sha,
      artifact,
      claimedSha256,
      runId,
    },
  });
  if (!stored) {
    return json({ error: 'artifact is already sealed for this run', code: 'ARTIFACT_ALREADY_SEALED' }, 409);
  }
  return json({ runId, artifact, claimedSha256, bytes: contentLength }, 201);
}

export async function handleEvidenceManifest(
  request: Request,
  env: EvidenceEnv,
  runId: string,
): Promise<Response> {
  if (!adminAuthorized(request, env)) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }
  if (!RUN_ID.test(runId)) {
    return json({ error: 'Invalid run id', code: 'INVALID_RUN_ID' }, 400);
  }
  const found = [];
  for (const artifact of HOST_EVIDENCE_ARTIFACTS) {
    const object = await env.EVIDENCE.head(objectKey(runId, artifact));
    if (!object) continue;
    found.push({
      artifact,
      bytes: object.size,
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      repo: object.customMetadata?.repo ?? null,
      sourceSha: object.customMetadata?.sourceSha ?? null,
      claimedSha256: object.customMetadata?.claimedSha256 ?? null,
    });
  }
  return json({ schemaVersion: 1, authority: 'gitflare-r2', runId, artifacts: found }, 200);
}

export async function handleEvidenceDownload(
  request: Request,
  env: EvidenceEnv,
  runId: string,
  rawArtifact: string,
): Promise<Response> {
  if (!adminAuthorized(request, env)) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }
  if (!RUN_ID.test(runId)) {
    return json({ error: 'Invalid run id', code: 'INVALID_RUN_ID' }, 400);
  }
  const artifact = artifactId(rawArtifact);
  if (!artifact) {
    return json({ error: 'Unknown evidence artifact', code: 'INVALID_ARTIFACT' }, 404);
  }
  const object = await env.EVIDENCE.get(objectKey(runId, artifact));
  if (!object) {
    return json({ error: 'Evidence artifact not found', code: 'NOT_FOUND' }, 404);
  }
  const headers = new Headers({
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-length': String(object.size),
    'cache-control': 'no-store',
  });
  for (const [header, key] of [
    ['x-gitflare-claimed-sha256', 'claimedSha256'],
    ['x-gitflare-source-sha', 'sourceSha'],
    ['x-gitflare-repo', 'repo'],
  ] as const) {
    const value = object.customMetadata?.[key];
    if (value) headers.set(header, value);
  }
  return new Response(object.body, { status: 200, headers });
}
