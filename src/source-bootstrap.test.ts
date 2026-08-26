import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  handleSourceBootstrap,
  registeredSourceRemote,
  type SourceBootstrapEnv,
  type SourceRegistryBucket,
} from './source-bootstrap.ts';

const REMOTE = 'https://acct.artifacts.cloudflare.net/git/gitflare/firecrab.git';

class Registry implements SourceRegistryBucket {
  objects = new Map<string, Uint8Array>();

  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { body: new Response(bytes).body! } : null;
  }

  async put(key: string, value: ReadableStream) {
    this.objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
    return {};
  }
}

function env(events: string[], registry = new Registry()): SourceBootstrapEnv {
  return {
    EVIDENCE: registry,
    ARTIFACTS: {
      async get() {
        throw new Error('not used');
      },
      async import(params) {
        events.push(`import:${params.source.url}:${params.source.branch}:${params.target.name}`);
        return {
          name: params.target.name,
          remote: REMOTE,
          defaultBranch: params.source.branch,
          token: 'initial-token-must-not-escape',
        };
      },
    },
  };
}

function request(branch: string, host = 'gitflare.internal'): Request {
  return new Request(`https://${host}/repos/firecrab/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
}

test('imports only the matching mcc0nnell repo and records returned Artifacts remote', async () => {
  const events: string[] = [];
  const registry = new Registry();
  const e = env(events, registry);
  const branch = 'feat/gitflare-assurance-v1';
  const response = await handleSourceBootstrap(request(branch), e, 'firecrab');
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 201);
  assert.deepEqual(events, [
    `import:https://github.com/mcc0nnell/firecrab:${branch}:firecrab`,
  ]);
  assert.equal(body.remote, REMOTE);
  assert.equal(body.sourceUrl, 'https://github.com/mcc0nnell/firecrab');
  assert.equal(body.branch, branch);
  assert.equal(JSON.stringify(body).includes('initial-token-must-not-escape'), false);
  assert.equal(await registeredSourceRemote(registry, 'firecrab'), REMOTE);
});

test('same branch is idempotent and a different branch fails closed', async () => {
  const events: string[] = [];
  const e = env(events);
  assert.equal((await handleSourceBootstrap(request('main'), e, 'firecrab')).status, 201);
  assert.equal((await handleSourceBootstrap(request('main'), e, 'firecrab')).status, 200);
  assert.equal((await handleSourceBootstrap(request('other'), e, 'firecrab')).status, 409);
  assert.equal(events.length, 1);
});

test('rejects public or unsafe bootstrap requests before import', async () => {
  const events: string[] = [];
  const e = env(events);
  assert.equal((await handleSourceBootstrap(request('main', 'evidence.scumm.app'), e, 'firecrab')).status, 403);
  assert.equal((await handleSourceBootstrap(request('../main'), e, 'firecrab')).status, 400);
  assert.equal((await handleSourceBootstrap(request('main'), e, 'bad/repo')).status, 400);
  assert.deepEqual(events, []);
});
