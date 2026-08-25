import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleEvidenceDownload,
  handleEvidenceHandoff,
  handleEvidenceManifest,
  handleEvidenceUpload,
  type EvidenceBucket,
  type EvidenceEnv,
} from './evidence.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = 'a'.repeat(64);

class Bucket implements EvidenceBucket {
  objects = new Map<string, {
    bytes: Uint8Array;
    key: string;
    size: number;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  }>();

  async put(key: string, value: ReadableStream, options?: any) {
    if (this.objects.has(key) && options?.onlyIf?.etagDoesNotMatch === '*') return null;
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const object = {
      key,
      bytes,
      size: bytes.byteLength,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };
    this.objects.set(key, object);
    return object;
  }

  async head(key: string) {
    return this.objects.get(key) ?? null;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { ...object, body: new Response(object.bytes).body! } : null;
  }
}

function env(bucket = new Bucket()): EvidenceEnv {
  return {
    ARTIFACTS: {
      async get() {
        return {
          async readCommit(hash: string) {
            if (hash !== SHA) throw new Error('missing');
          },
          async createToken() {
            return { plaintext: 'unused' };
          },
        };
      },
    },
    EVIDENCE: bucket,
    GITFLARE_ADMIN_TOKEN: 'admin',
    GITFLARE_EVIDENCE_HMAC_KEY: '0123456789abcdef0123456789abcdef',
  };
}

async function handoff(e: EvidenceEnv): Promise<any> {
  const request = new Request('https://gitflare.example/repos/firecrab/evidence-handoffs', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sha: SHA }),
  });
  const response = await handleEvidenceHandoff(request, e, 'firecrab');
  assert.equal(response.status, 201);
  return response.json();
}

test('handoff binds capability to exact source object', async () => {
  const result = await handoff(env());
  assert.equal(result.sha, SHA);
  assert.equal(result.authority, 'gitflare-r2');
  assert.equal(result.artifacts.length, 5);
  assert.ok(result.uploadToken.startsWith('v1.'));
});

test('one artifact slot seals after first content claim', async () => {
  const bucket = new Bucket();
  const e = env(bucket);
  const result = await handoff(e);

  const upload = (digest: string, body = 'ok') => handleEvidenceUpload(
    new Request(`${result.uploadBaseUrl}/result`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${result.uploadToken}`,
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-gitflare-sha256': digest,
      },
      body,
    }),
    e,
    result.runId,
    'result',
  );

  assert.equal((await upload(DIGEST)).status, 201);
  assert.equal((await upload(DIGEST)).status, 204);
  assert.equal((await upload('b'.repeat(64), 'no')).status, 409);
});

test('manifest and download never expose upload capability', async () => {
  const bucket = new Bucket();
  const e = env(bucket);
  const result = await handoff(e);

  await handleEvidenceUpload(
    new Request(`${result.uploadBaseUrl}/result`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${result.uploadToken}`,
        'content-type': 'application/json',
        'content-length': '2',
        'x-gitflare-sha256': DIGEST,
      },
      body: 'ok',
    }),
    e,
    result.runId,
    'result',
  );

  const manifest = await handleEvidenceManifest(
    new Request(`https://gitflare.example/evidence/runs/${result.runId}`, {
      headers: { authorization: 'Bearer admin' },
    }),
    e,
    result.runId,
  );
  const body = await manifest.json() as any;
  assert.equal(body.artifacts[0].claimedSha256, DIGEST);
  assert.equal(JSON.stringify(body).includes(result.uploadToken), false);

  const download = await handleEvidenceDownload(
    new Request('https://gitflare.example/evidence', {
      headers: { authorization: 'Bearer admin' },
    }),
    e,
    result.runId,
    'result',
  );
  assert.equal(await download.text(), 'ok');
  assert.equal(download.headers.get('x-gitflare-claimed-sha256'), DIGEST);
});
