import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../src/index.ts';
import { issueReadCapability, verifyReadCapability } from '../src/forge-capability.ts';
globalThis.crypto ??= webcrypto;
const admin = 'test-admin-secret', writer = 'test-event-write-secret';
const signer = 'forge-view-signing-secret-with-at-least-32-bytes';
const event = { eventId: 'agent-a-1', type: 'agent.started', actor: 'agent-a', commitSha: null,
  receiptSha256: null, detail: 'Started source checkout' };
function mock() {
  const entries = [], names = [];
  const stub = { async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === '/append') {
      const body = await request.json();
      const prior = entries.find(e => e.event.eventId === body.eventId);
      if (prior) {
        if (JSON.stringify(prior.event) !== JSON.stringify(body)) return Response.json({code:'EVENT_ID_CONFLICT'}, {status:409});
        return Response.json({ ...prior, duplicate: true });
      }
      const row = {sequence: entries.length + 1, createdAt: new Date().toISOString(), duplicate:false, event:body};
      entries.push(row); return Response.json(row,{status:201});
    }
    return Response.json({events:entries,nextCursor:entries.length,hasMore:false});
  } };
  const env = {
    GITFLARE_ADMIN_TOKEN:admin, GITFLARE_EVENT_WRITE_TOKEN:writer, GITFLARE_VIEW_SIGNING_KEY:signer,
    FORGE_EVENTS:{ idFromName(name) { names.push(name); return name; }, get(){return stub} },
  };
  return {env,entries,names};
}
const req = (path, method='GET', authorization=null, body=null) => new Request('https://forge.example.invalid'+path,{
  method, headers:{...(authorization?{'authorization':'Bearer '+authorization}:{}),
   ...(body!==null?{'content-type':'application/json'}:{})},
  ...(body!==null?{body:JSON.stringify(body)}:{}),
});
test('read capabilities are repository-scoped, expiring, and HMAC verified', async () => {
  const now = 1700000000000;
  const token = await issueReadCapability(signer,'repo-a',now,300);
  assert.equal(await verifyReadCapability(signer,token,'repo-a',now + 10_000),true);
  assert.equal(await verifyReadCapability(signer,token,'repo-b',now + 10_000),false);
  assert.equal(await verifyReadCapability(signer,token,'repo-a',now + 301_000),false);
  assert.equal(await verifyReadCapability(signer,token.slice(0,-1)+(token.endsWith('A')?'B':'A'),'repo-a',now),false);
  assert.equal(await verifyReadCapability('different-signing-secret-with-32-characters',token,'repo-a',now),false);
});
test('admin can issue read-only capability; it cannot write events', async () => {
  const {env,entries,names} = mock();
  const missing = await worker.fetch(req('/forge/view-tokens','POST',null,{repo:'repo-a'}),env);
  assert.equal(missing.status,401);
  const created = await worker.fetch(req('/forge/view-tokens','POST',admin,{repo:'repo-a'}),env);
  assert.equal(created.status,201);
  const data = await created.json();
  assert.equal(data.readOnly,true); assert.equal(data.expiresInSeconds,300);
  assert.equal((await worker.fetch(req('/forge/events/repo-a','POST',data.token,event),env)).status,401);
  assert.equal(entries.length,0); assert.equal(names.length,0);
  assert.equal((await worker.fetch(req('/forge/events/repo-b','GET',data.token),env)).status,401);
  assert.equal((await worker.fetch(req('/forge/events/repo-a','GET',data.token),env)).status,200);
  assert.deepEqual(names,['gitflare:repo-a']);
});
test('write-only token can append but never read, with distinct administrative authority', async () => {
  const {env,names,entries} = mock();
  assert.equal((await worker.fetch(req('/forge/events/repo-a','POST',admin,event),env)).status,401);
  assert.equal((await worker.fetch(req('/forge/events/repo-a','POST',writer,event),env)).status,201);
  assert.equal(entries.length,1);
  assert.equal((await worker.fetch(req('/forge/events/repo-a','GET',writer),env)).status,401);
  assert.equal((await worker.fetch(req('/forge/events/repo-a','GET',admin),env)).status,401);
  assert.deepEqual(names,['gitflare:repo-a']);
});
test('bad input never reaches the Durable Object', async () => {
  const {env,names}=mock();
  assert.equal((await worker.fetch(req('/forge/events/repo-a','POST',writer,{...event,privateKey:'no'}),env)).status,400);
  assert.equal((await worker.fetch(req('/forge/events/repo-a','POST',writer,{...event,detail:'x'.repeat(2500)}),env)).status,413);
  assert.equal((await worker.fetch(req('/forge/events/%2e%2e','POST',writer,event),env)).status,401);
  assert.equal((await worker.fetch(req('/forge/events/%ZZ','POST',writer,event),env)).status,400);
  assert.equal(names.length,0);
});
