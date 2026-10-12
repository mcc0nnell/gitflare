# Forge read-only receipt inspector

Gitflare exposes **GET /forge** as a static, client-side inspection tool for
signed Forge review receipts. It requires **no administrator token** and does not modify or upload any repository or evidence. A separate read-only event
panel can poll a scoped journal capability from the same origin, without an
administrator token. The Worker delivers
an inline-script nonce, restrictive CSP, no-store headers and frame denial.

The operator loads an existing Gate v2 receipt by file picker or pasted JSON.
The page renders its target/candidate SHA identities, simulated merge shape,
reported validation checks and reasons. It recomputes the receipt self-digest
using Web Crypto and visibly rejects mismatches. The sample button is explicitly
labeled demo data. Browser parsing is limited to one megabyte and user-provided
strings are placed with DOM `textContent`, not HTML interpolation.

**Trust boundary:** A matching SHA-256 checksum is not a signature, and the
page does not have access to a trusted signing key, CI evidence store, live
Cloudflare Artifacts refs, or a durable human approval. It labels the verdict
as a *receipt claim*, not as an independently verified approval. Real approval
and source writes remain exclusively outside the browser.

## Scope

This deliberately does not add browser administrator sessions, source mutation,
new Cloudflare resources, or general agent execution. It can coexist with the
separate ANSI console proposal (#6) until a scoped authentication model and
replay-safe event journal are developed.

## Validation

    npm ci
    npm run check

The Forge console test verifies that /forge is anonymously readable but
private API routes remain protected, and checks response security headers.
No visual browser automation or WebSocket integration is claimed yet.

## Journal viewer extension

With the stacked [event journal](forge-events.md), the console can poll
repository-scoped activity every four seconds. The temporary viewer token
is only held in JavaScript memory and removed on disconnect/page exit. The
viewer cannot write events or integrate source. A journal event remains a
producer assertion, not independently verified evidence.
