import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleExecutionHandoff, type HandoffEnv } from './execution-handoff.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REMOTE = 'https://acct.artifacts.cloudflare.net/git/gitflare/firecrab.git';

function sourceRecord(repo = 'firecrab'): string {
  return JSON.stringify({
    schemaVersion: 1,
    authority: 'gitflare',
    provider: 'cloudflare-artifacts',
    namespace: 'gitflare',
    repo,
    sourceUrl: `https://github.com/mcc0nnell/${repo}`,
    branch: 'feat/gitflare-assurance-v1',
    remote: REMOTE,
  });
}

function env(events: string[], registered = true): HandoffEnv {
  return {
    GITFLARE_ADMIN_TOKEN: 'admin',
    EVIDENCE: {
      async get(key: string) {
        events.push(`registry:${key}`);
        return registered
          ? { body: new Response(sourceRecord()).body! }
          : null;
      },
      async put() {
        throw new Error('not used');
      },
    },
    ARTIFACTS: {
      async get(name: string) {
        events.push(`get:${name}`);
        return {
          async readCommit(hash: string) {
            events.push(`read:${hash}`);
            return { hash };
          },
          async createToken(scope = 'write', ttl = 3600) {
            events.push(`token:${scope}:${ttl}`);
            return { plaintext: 'secret-token', expiresAt: 'soon' };
          },
        };
      },
    },
  };
}

function request(body: unknown, token = 'admin'): Request {
  return new Request('https://gitflare.example/repos/firecrab/execution-handoffs', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('verifies exact object before minting a short-lived read token', async () => {
  const events: string[] = [];
  const response = await handleExecutionHandoff(request({ sha: SHA, ttl: 300 }), env(events), 'firecrab');
  const body = await response.json() as Record<string, any>;

  assert.equal(response.status, 201);
  assert.deepEqual(events, [
    'registry:control/source-repos/firecrab.json',
    'get:firecrab',
    `read:${SHA}`,
    'token:read:300',
  ]);
  assert.equal(body.sha, SHA);
  assert.equal(body.credential.scope, 'read');
  assert.equal(body.credential.ttl, 300);
  assert.equal(body.remote, REMOTE);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('invalid SHA fails before registry or Artifacts is touched', async () => {
  const events: string[] = [];
  const response = await handleExecutionHandoff(request({ sha: 'main' }), env(events), 'firecrab');
  assert.equal(response.status, 400);
  assert.deepEqual(events, []);
});

test('unbootstrapped repo fails before Artifacts is touched', async () => {
  const events: string[] = [];
  const response = await handleExecutionHandoff(request({ sha: SHA }), env(events, false), 'firecrab');
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 503);
  assert.equal(body.code, 'SOURCE_NOT_BOOTSTRAPPED');
  assert.deepEqual(events, ['registry:control/source-repos/firecrab.json']);
});

test('unauthorized caller fails before registry or Artifacts is touched', async () => {
  const events: string[] = [];
  const response = await handleExecutionHandoff(request({ sha: SHA }, 'wrong'), env(events), 'firecrab');
  assert.equal(response.status, 401);
  assert.deepEqual(events, []);
});
