import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { provisionAgentFork } from '../src/agent-forks.ts';
globalThis.crypto ??= webcrypto;

test('creates an isolated repo with only agent-scoped creation credentials', async () => {
  const calls = []; let disposed = false;
  const artifacts = { async get(name) {
    calls.push(['get', name]);
    return {
      async fork(forkName, opts) {
        calls.push(['fork', forkName, opts]);
        return { name: forkName, remote: 'https://example.invalid/' + forkName + '.git', token: 'one-time-secret' };
      },
      [Symbol.dispose]() { disposed = true; },
    };
  } };
  const result = await provisionAgentFork(artifacts, 'sample', 'lint docs');
  assert.match(result.fork, /^sample-agent-[a-f0-9]{16}$/);
  assert.equal(result.initialToken, 'one-time-secret');
  assert.equal(calls[1][2].readOnly, false);
  assert.equal(calls[1][2].defaultBranchOnly, true);
  assert.equal(disposed, true);
});

test('rejects malformed names and control characters before contacting Artifacts', async () => {
  let touched = false;
  const artifacts = { async get() { touched = true; throw new Error('unexpected'); } };
  await assert.rejects(provisionAgentFork(artifacts, '../outside'));
  await assert.rejects(provisionAgentFork(artifacts, 'okay', 'bad\nlabel'));
  assert.equal(touched, false);
});

test('disposes upstream capability if Cloudflare fork fails', async () => {
  let disposed = false;
  const artifacts = { async get() {
    return { async fork() { throw new Error('upstream'); }, [Symbol.dispose]() { disposed = true; } };
  } };
  await assert.rejects(provisionAgentFork(artifacts, 'repo'));
  assert.equal(disposed, true);
});
