import { DurableObject } from 'cloudflare:workers';

export const EVENT_TYPES = ['agent.started', 'agent.committed', 'agent.failed',
  'review.ready', 'review.blocked', 'integration.verified'] as const;
export type EventType = typeof EVENT_TYPES[number];

export interface ForgeEventInput {
  eventId: string;
  type: EventType;
  actor: string;
  commitSha: string | null;
  receiptSha256: string | null;
  detail: string | null;
}

const SHA = /^[a-f0-9]{40}$/;
const RECEIPT = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const MAX_EVENTS = 20000;
export function validateForgeEvent(value: unknown): ForgeEventInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_EVENT');
  const x = value as Record<string, unknown>;
  const keys = Object.keys(x);
  const allowed = ['eventId', 'type', 'actor', 'commitSha', 'receiptSha256', 'detail'];
  if (keys.some(k => !allowed.includes(k)) || typeof x.eventId !== 'string' || !IDENTIFIER.test(x.eventId) ||
      !EVENT_TYPES.includes(x.type as EventType) ||
      typeof x.actor !== 'string' || !IDENTIFIER.test(x.actor) ||
      (x.commitSha != null && (typeof x.commitSha !== 'string' || !SHA.test(x.commitSha))) ||
      (x.receiptSha256 != null && (typeof x.receiptSha256 !== 'string' || !RECEIPT.test(x.receiptSha256))) ||
      (x.detail != null && (typeof x.detail !== 'string' || x.detail.length > 160 || /[\x00-\x1f\x7f]/.test(x.detail)))) {
    throw Error('INVALID_EVENT');
  }
  return {
    eventId: x.eventId as string, type: x.type as EventType, actor: x.actor as string,
    commitSha: x.commitSha == null ? null : x.commitSha as string,
    receiptSha256: x.receiptSha256 == null ? null : x.receiptSha256 as string,
    detail: x.detail == null ? null : x.detail as string,
  };
}
type SqlCursor = { toArray(): Record<string, unknown>[] };
type Sql = { exec(query: string, ...args: (string | number)[]): SqlCursor };
type EventState = { storage: { sql: Sql } };

export class ForgeJournal extends DurableObject {
  private sql: Sql;
  constructor(ctx: EventState, env: unknown) {
    super(ctx as never, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at TEXT NOT NULL)');
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (request.method === 'POST' && url.pathname === '/append') {
      let input: ForgeEventInput;
      try { input = validateForgeEvent(await request.json()); }
      catch { return respond({ code: 'INVALID_EVENT' }, 400); }
      const body = JSON.stringify(input);
      const previous = this.sql.exec('SELECT sequence, body, created_at FROM events WHERE event_id = ?', input.eventId).toArray();
      if (previous.length) {
        if (previous[0].body !== body) return respond({ code: 'EVENT_ID_CONFLICT' }, 409);
        return respond({
          sequence: previous[0].sequence, createdAt: previous[0].created_at,
          duplicate: true, event: input,
        });
      }
      const count = this.sql.exec('SELECT COUNT(*) AS count FROM events').toArray()[0]?.count;
      if (typeof count !== 'number' || count >= MAX_EVENTS) return respond({ code: 'JOURNAL_CAP_REACHED' }, 507);
      const createdAt = new Date().toISOString();
      this.sql.exec('INSERT INTO events (event_id, body, created_at) VALUES (?, ?, ?)', input.eventId, body, createdAt);
      const row = this.sql.exec('SELECT sequence FROM events WHERE event_id = ?', input.eventId).toArray()[0];
      return respond({ sequence: row.sequence, createdAt, duplicate: false, event: input }, 201);
    }
    if (request.method === 'GET' && url.pathname === '/replay') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      if (!Number.isSafeInteger(after) || after < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return respond({ code: 'INVALID_CURSOR' }, 400);
      }
      const rows = this.sql.exec(
        'SELECT sequence, body, created_at FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?',
        after, limit,
      ).toArray();
      return respond({
        events: rows.map(r => ({
          sequence: r.sequence,
          createdAt: r.created_at,
          event: JSON.parse(String(r.body)),
        })),
        nextCursor: rows.length ? rows[rows.length - 1].sequence : after,
        hasMore: rows.length === limit,
      });
    }
    return respond({ code: 'NOT_FOUND' }, 404);
  }
}
