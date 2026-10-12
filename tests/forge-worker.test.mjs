import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../src/index.ts';

globalThis.crypto ??= webcrypto;
function request(path, method = 'POST', token = 'operator-secret', body = { label: 'test parser' }) {
  return new Request('https://forge.example.invalid' + path, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}
function mockEnv() {
  const calls = [];
  const env = {
    GITFLARE_ADMIN_TOKEN: 'operator-secret',
    ARTIFACTS: {
      async get(name) {
        calls.push(['get', name]);
        return {
          async fork(forkName, opts) {
            calls.push(['fork', forkName, opts]);
            return { name: forkName, remote: 'https://example.invalid/' + forkName, token: 'mock-credential' };
          },
          [Symbol.dispose]() { calls.push(['dispose']); },
        };
      },
    },
  };
  return { env, calls };
}

test('unauthenticated fork is denied before using Artifacts', async () => {
  const { env, calls } = mockEnv();
  const res = await worker.fetch(request('/repos/repo/forks', 'POST', null), env);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('an authenticated operator can create an isolated fork', async () => {
  const { env, calls } = mockEnv();
  const res = await worker.fetch(request('/repos/repo/forks'), env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.source, 'repo');
  assert.match(body.fork, /^repo-agent-[a-f0-9]{16}$/);
  assert.equal(body.initialToken, 'mock-credential');
  assert.equal(calls.filter(c => c[0] === 'fork').length, 1);
  assert.deepEqual(calls.at(-1), ['dispose']);
});

test('malformed names and bodies are 400 without contacting Artifacts', async () => {
  const { env, calls } = mockEnv();
  assert.equal((await worker.fetch(request('/repos/..%2fsecret/forks'), env)).status, 400);
  assert.equal((await worker.fetch(request('/repos/repo/forks', 'POST', 'operator-secret', null), env)).status, 400);
  assert.equal((await worker.fetch(request('/repos/repo/forks', 'POST', 'operator-secret', { label: 'bad\nlabel' }), env)).status, 400);
  assert.equal(calls.length, 0);
});

test('fork provider errors return generic 502, not internal exception strings', async () => {
  const { env } = mockEnv();
  env.ARTIFACTS.get = async () => { throw new Error('sensitive platform implementation details'); };
  const response = await worker.fetch(request('/repos/repo/forks'), env);
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /sensitive platform/);
});
