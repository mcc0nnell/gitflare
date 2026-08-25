import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleAssuranceSourceTicket,
  type AssuranceEnv,
} from '../src/assurance-entry';

const SHA = '66ff69111fa562b17d4f0739e1c962539b6ea6b3';
const REMOTE_BASE = 'https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/gitflare';

function request(body: Record<string, unknown>, auth = 'admin-secret'): Request {
  return new Request('https://gitflare.example/repos/firecrab/assurance/source-ticket', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function env(options: { commitPresent?: boolean; remoteBase?: string } = {}): AssuranceEnv {
  return {
    GITFLARE_ADMIN_TOKEN: 'admin-secret',
    GITFLARE_ARTIFACTS_REMOTE_BASE: options.remoteBase ?? REMOTE_BASE,
    ARTIFACTS: {
      async get(name: string) {
        assert.equal(name, 'firecrab');
        return {
          async readCommit(hash: string) {
            assert.equal(hash, SHA);
            if (options.commitPresent === false) throw new Error('not found');
            return { hash };
          },
          async createToken(scope = 'read', ttl = 300) {
            assert.equal(scope, 'read');
            return {
              plaintext: 'r'.repeat(32),
              expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
            };
          },
        };
      },
    },
  };
}

test('source ticket proves canonical commit before minting a read credential', async () => {
  const response = await handleAssuranceSourceTicket(request({ sha: SHA, ttl: 300 }), env(), 'firecrab');
  assert.equal(response.status, 201);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.authority, 'gitflare');
  assert.equal(body.sourcePlane, 'cloudflare-artifacts');
  assert.equal(body.namespace, 'gitflare');
  assert.equal(body.repo, 'firecrab');
  assert.equal(body.sha, SHA);
  assert.equal(body.remote, `${REMOTE_BASE}/firecrab.git`);
  assert.equal(body.credential.kind, 'artifacts-repo-read-token');
  assert.equal(body.credential.ttl, 300);
});

test('source ticket refuses a SHA absent from canonical Artifacts', async () => {
  const response = await handleAssuranceSourceTicket(request({ sha: SHA }), env({ commitPresent: false }), 'firecrab');
  assert.equal(response.status, 404);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, 'SOURCE_OBJECT_NOT_FOUND');
});

test('source ticket fails closed when the canonical Artifacts remote is not configured', async () => {
  const response = await handleAssuranceSourceTicket(
    request({ sha: SHA }),
    env({ remoteBase: 'https://github.com/mcc0nnell' }),
    'firecrab',
  );
  assert.equal(response.status, 503);
});

test('source ticket requires Gitflare authentication', async () => {
  const response = await handleAssuranceSourceTicket(request({ sha: SHA }, 'wrong'), env(), 'firecrab');
  assert.equal(response.status, 401);
});

test('source ticket rejects unexpected fields and overlong TTLs', async () => {
  const extra = await handleAssuranceSourceTicket(request({ sha: SHA, mirror: 'github' }), env(), 'firecrab');
  assert.equal(extra.status, 400);

  const ttl = await handleAssuranceSourceTicket(request({ sha: SHA, ttl: 901 }), env(), 'firecrab');
  assert.equal(ttl.status, 400);
});
