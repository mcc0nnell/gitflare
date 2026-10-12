# Forge Event Journal (draft)

This slice adds a durable, repository-scoped **event timeline**, not a second Git
source of truth. It sits alongside the signed review gate (PR #9) and the
read-only Forge console (PR #10).

## Architecture

- Cloudflare SQLite-backed `ForgeJournal` Durable Object, one named instance
  per repository. The namespace is declared via Wrangler's `exports` syntax.
- Ordered SQL sequence numbers, persisted ISO-8601 insertion timestamps.
- Event IDs are unique. Exact repeats return their original sequence and
  `duplicate: true`; conflicting payloads return 409 and are not appended.
- Replay is ordered and cursor-based (`after` + bounded `limit`), with no
  default exposure to the public or to untrusted agents.
- Event types are an allowlist. Unrecognized fields, control characters,
  malformed commit hashes and bodies over 2 KiB are rejected.
- Hard per-repository limit: 20,000 events. Overflow fails closed with
  `JOURNAL_CAP_REACHED`; no silent deletion of evidence or events.

## Separate credentials

Configure these as **distinct** Worker secrets. Never put them in Git:

- `GITFLARE_ADMIN_TOKEN` — the existing operator API token.
- `GITFLARE_EVENT_WRITE_TOKEN` — event-ingestion credential. Does not grant
  Git write access or event replay.
- `GITFLARE_VIEW_SIGNING_KEY` — at least 32 bytes of operator-managed random
  signing material for short-lived read capabilities.

The API intentionally does **not** accept admin or ingestion credentials in
place of a read capability.

### Issue read capability (operator-only)

```http
POST /forge/view-tokens
Authorization: Bearer <operator token>
Content-Type: application/json

{"repo":"scumm3"}
```

Returns an HMAC-SHA256 capability with repository, read-only scope, and a fixed
300-second expiration. It can be revoked by rotating the signing key (currently
global across repositories). There is no session database or user identity yet.

### Submit an event (trusted producer only)

```http
POST /forge/events/scumm3
Authorization: Bearer <event-writer token>
Content-Type: application/json

{
  "eventId": "job-123-commit",
  "type": "agent.committed",
  "actor": "agent-01",
  "commitSha": "<exact 40-hex Git revision>",
  "receiptSha256": null,
  "detail": "Patch pushed"
}
```

Supported types: `agent.started`, `agent.committed`,
`agent.failed`, `review.ready`, `review.blocked`,
`integration.verified`. Events are *reported activity*, not cryptographic
proofs. The producer must independently verify source revisions and signed
evidence before emitting claims. In particular, `review.ready` is **not**
merge authorization.

### Replay (scoped read token only)

```http
GET /forge/events/scumm3?after=0&limit=50
Authorization: Bearer <scoped read capability>
```

Response includes ordered events, `nextCursor`, and `hasMore`. The browser
never stores a read token in localStorage/sessionStorage and the response is
`no-store`.

## Console

`GET /forge` retains the local receipt inspector and adds a repository activity
panel. Paste a read capability, choose a repository, then select **FOLLOW EVENTS**.
It polls every four seconds, resumes using its sequence cursor, and removes the
token on disconnect or page exit. It does not create events, approve changes,
or push Git. Stale in-flight HTTP responses are discarded on disconnect.

The UI uses same-origin requests and DOM text nodes for untrusted descriptions.
Its CSP permits only same-origin connections; it does not enable third-party
script, image, or frame sources.

## Verification

- `npm run check` — full regression suite, TypeScript, Wrangler dry-run.
- Node SQLite integration tests close/reopen the same file and verify preserved
  event sequence, exact deduplication, collision rejection and pagination.
- Worker authentication tests verify repository scope, 5-minute expiration,
  malformed token rejection, and separate read/write/admin authorities.
- On Butcher, local Wrangler bound `FORGE_EVENTS` to **local** SQLite storage
  while leaving the existing Artifacts binding remote. HTTP tests confirmed
  create, duplicate and collision handling, authorized read and cross-repository
  rejection. This does **not** establish a Cloudflare-deployed durable journal.

## Limitations before production

- No production deployment, external Workflows ingestion adapter, or automated
  Cloudflare push-event recording yet.
- No individual human/agent identities, per-user revocation, RBAC or signing
  of the event journal itself. Treat the timeline as an audited *activity claim*
  only, not proof or authorization.
- Four-second polling, not live WebSocket hibernation. The Durable Object can
  later add WebSockets without changing the source-of-truth boundaries.
- A new Wrangler SQLite object namespace is provisioned on deployment; review
  billing and backup/retention before approving that deployment.
