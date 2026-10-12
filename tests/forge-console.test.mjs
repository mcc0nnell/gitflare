import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../src/index.ts';
globalThis.crypto ??= webcrypto;

test('Forge inspector serves a read-only HTML page without admin credentials', async () => {
  const res=await worker.fetch(new Request('https://forge.example.invalid/forge'), { ARTIFACTS: null, GITFLARE_ADMIN_TOKEN: '' });
  assert.equal(res.status,200);
  assert.match(res.headers.get('content-type'),/text\/html/);
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('x-frame-options'),'DENY');
  const html=await res.text();
  assert.match(html,/GITFLARE/);
  assert.match(html,/LOCAL RECEIPT INSPECTOR/);
  assert.match(html,/Load Forge receipt/);
  assert.doesNotMatch(html,/sessionStorage|localStorage|GITFLARE_ADMIN_TOKEN|fetch\(/);
  assert.doesNotMatch(html,/__FORGE_NONCE__/);
  const nonce=html.match(/<script nonce="([a-z0-9]+)">/i)?.[1];
  assert.ok(nonce);
  assert.ok(res.headers.get('content-security-policy').includes("script-src 'nonce-"+nonce+"'"));
  assert.ok(res.headers.get('content-security-policy').includes("connect-src 'none'"));
});

test('the public Forge page does not grant access to protected API endpoints', async () => {
  const env={ ARTIFACTS: { async list(){ throw Error('should not read private namespace') } }, GITFLARE_ADMIN_TOKEN:'secret' };
  const repos=await worker.fetch(new Request('https://forge.example.invalid/repos'), env);
  assert.equal(repos.status,401);
  const mutate=await worker.fetch(new Request('https://forge.example.invalid/forge',{method:'POST'}),env);
  assert.equal(mutate.status,401);
});
