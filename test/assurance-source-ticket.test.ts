import assert from 'node:assert/strict';
import test from 'node:test';

import assuranceHandler, {
  handleAssuranceSourceTicket,
  sourcePlaneStatus,
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
    GITFLARE_SOURCE_PLANE_MODE: 'cloudflare-artifacts',
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

test('pre-entitlement Gitflare is healthy but canonical source is explicitly unavailable', () => {
  const status = sourcePlaneStatus({ GITFLARE_ADMIN_TOKEN: 'admin-secret' });
  assert.equal(status.available, false);
  assert.equal(status.canonical, false);
  assert.equal(status.mode, 'unavailable');
  assert.equal(status.bindingPresent, false);
  assert.equal(status.reason, 'cloudflare-artifacts-access-unavailable');
});

test('pre-entitlement HTTP health and source-plane routes require no Artifacts binding', async () => {
  const preAccess: AssuranceEnv = { GITFLARE_SOURCE_PLANE_MODE: 'unavailable' };

  const health = await assuranceHandler.fetch(
    new Request('https://gitflare.example/healthz'),
    preAccess,
  );
  assert.equal(health.status, 200);
  const healthBody = await health.json() as Record<string, any>;
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.sourcePlane.available, false);
  assert.equal(healthBody.sourcePlane.reason, 'cloudflare-artifacts-access-unavailable');

  const source = await assuranceHandler.fetch(
    new Request('https://gitflare.example/v1/source-plane'),
    preAccess,
  );
  assert.equal(source.status, 200);
  const sourceBody = await source.json() as Record<string, any>;
  assert.equal(sourceBody.authority, 'gitflare');
  assert.equal(sourceBody.available, false);
  assert.equal(sourceBody.canonical, false);
});

test('pre-entitlement source ticket returns typed BLOCKED without touching Artifacts', async () => {
  const response = await handleAssuranceSourceTicket(
    request({ sha: SHA }),
    {
      GITFLARE_ADMIN_TOKEN: 'admin-secret',
      GITFLARE_SOURCE_PLANE_MODE: 'unavailable',
    },
    'firecrab',
  );
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.verdict, 'BLOCKED');
  assert.equal(body.code, 'SOURCE_PLANE_UNAVAILABLE');
  assert.equal(body.reason, 'cloudflare-artifacts-access-unavailable');
  assert.equal(body.sourcePlane.available, false);
});

test('enabled mode still blocks when the Artifacts binding is absent', async () => {
  const response = await handleAssuranceSourceTicket(
    request({ sha: SHA }),
    {
      GITFLARE_ADMIN_TOKEN: 'admin-secret',
      GITFLARE_SOURCE_PLANE_MODE: 'cloudflare-artifacts',
      GITFLARE_ARTIFACTS_REMOTE_BASE: REMOTE_BASE,
    },
    'firecrab',
  );
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.reason, 'cloudflare-artifacts-binding-unavailable');
});

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
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.reason, 'cloudflare-artifacts-remote-unconfigured');
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
