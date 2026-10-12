import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ForgeJournal } from '../src/forge-journal.ts';

const EVENT = { eventId: 'agent-a-commit-1', type: 'agent.committed', actor: 'agent-a',
  commitSha: 'a'.repeat(40), receiptSha256: null, detail: 'Parser update' };
function state(db) {
  return { storage: { sql: { exec(query, ...params) {
    const stmt = db.prepare(query);
    if (/^SELECT\b/i.test(query)) return { toArray: () => stmt.all(...params) };
    stmt.run(...params);
    return { toArray: () => [] };
  } } } };
}
async function append(journal, event) {
  const r = await journal.fetch(new Request('https://internal/append', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(event),
  }));
  return { status: r.status, body: await r.json() };
}
async function replay(journal, after = 0, limit = 50) {
  const r = await journal.fetch(new Request(`https://internal/replay?after=${after}&limit=${limit}`));
  return { status: r.status, body: await r.json() };
}
test('SQLite journal persists after instance restart, with monotonically increasing replay cursors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-journal-'));
  const path = join(dir, 'storage.db');
  try {
    let db = new DatabaseSync(path);
    let journal = new ForgeJournal(state(db), {});
    const first = await append(journal, EVENT);
    assert.equal(first.status, 201); assert.equal(first.body.sequence, 1);
    const dupe = await append(journal, EVENT);
    assert.equal(dupe.status, 200); assert.equal(dupe.body.duplicate, true); assert.equal(dupe.body.sequence, 1);
    const conflicting = await append(journal, { ...EVENT, detail: 'Different payload' });
    assert.equal(conflicting.status, 409);
    const second = await append(journal, { ...EVENT, eventId: 'agent-b-commit-2', actor: 'agent-b' });
    assert.equal(second.status, 201); assert.equal(second.body.sequence, 2);
    db.close();
    db = new DatabaseSync(path); journal = new ForgeJournal(state(db), {});
    const page = await replay(journal, 0, 1);
    assert.equal(page.body.events.length, 1); assert.equal(page.body.events[0].event.eventId, EVENT.eventId);
    assert.equal(page.body.nextCursor, 1);
    assert.equal((await replay(journal, 1)).body.events[0].sequence, 2);
    assert.equal((await replay(journal, 2)).body.events.length, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('rejects unknown fields, malformed event identifiers and invalid cursors', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new ForgeJournal(state(db), {});
    assert.equal((await append(journal, { ...EVENT, secret: 'PRIVATE' })).status, 400);
    assert.equal((await append(journal, { ...EVENT, detail: '\nsecret' })).status, 400);
    assert.equal((await append(journal, { ...EVENT, eventId: '../escape' })).status, 400);
    assert.equal((await append(journal, { ...EVENT, eventId: 7 })).status, 400);
    assert.equal((await append(journal, { ...EVENT, actor: 7 })).status, 400);
    assert.equal((await replay(journal, -1)).status, 400);
    assert.equal((await replay(journal, 0, 101)).status, 400);
  } finally { db.close(); }
});
