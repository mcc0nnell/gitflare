# Cloudflare Artifacts entitlement gate

Gitflare treats Cloudflare Artifacts as the canonical Git source plane, but the
Artifacts product is currently access-gated. Gitflare must remain deployable
before that entitlement exists without silently substituting GitHub as source
authority.

## Pre-entitlement mode

The default `wrangler.jsonc` intentionally has **no** `artifacts` binding and
sets:

```text
GITFLARE_SOURCE_PLANE_MODE=unavailable
```

This mode is useful and safe:

- `GET /healthz` reports the Gitflare service healthy.
- `GET /v1/source-plane` reports canonical source unavailable.
- Artifacts-backed `/repos` operations fail closed with HTTP 503.
- `POST /repos/:repo/assurance/source-ticket` returns a typed `BLOCKED` result.
- GitHub may still be used as a collaboration/bootstrap mirror, but cannot mint
  a canonical assurance source ticket.

Expected source-plane reason before entitlement:

```text
cloudflare-artifacts-access-unavailable
```

## Activation sequence

Do not collapse these steps. Each one is an independent gate.

1. Confirm the Cloudflare account has Artifacts access.
2. Use `wrangler.artifacts.jsonc`, which binds namespace `gitflare` and sets
   `GITFLARE_SOURCE_PLANE_MODE=cloudflare-artifacts`.
3. Create or import the canonical `firecrab` repository in the `gitflare`
   namespace.
4. Capture the **exact** `remote` returned by Cloudflare Artifacts for that
   repository. Do not synthesize a URL from an assumed account/namespace layout.
5. Configure that exact value as `GITFLARE_FIRECRAB_REMOTE`. Until it is present,
   `/v1/source-plane` remains unavailable with
   `cloudflare-artifacts-remote-unconfigured`.
6. Verify the admitted immutable FireCrab commit is readable from that repo.
7. Only then can Gitflare mint a short-lived read source ticket.
8. WindAnvil may pass that credential to SCUMM for native execution. The token
   dies at the transport boundary and is never retained in the WindAnvil
   receipt.

The activation command is deliberately separate from the normal deploy:

```bash
npm run check:artifacts
npm run deploy:artifacts
```

`GITFLARE_FIRECRAB_REMOTE` is not a credential, but it is account-specific
configuration. It can be supplied through deployment configuration rather than
committed to the repository.

The normal commands remain pre-entitlement safe:

```bash
npm run check
npm run deploy
```

## Availability invariant

`/v1/source-plane` may report `available: true` only when all of these are true:

- mode is `cloudflare-artifacts`
- the Worker has an Artifacts binding
- the exact canonical `gitflare/firecrab` remote is configured
- the remote is HTTPS on `artifacts.cloudflare.net` or an Artifacts subdomain
- the remote path identifies namespace `gitflare` and repository `firecrab.git`
- reason is `null`

That endpoint establishes capability only. A specific assurance source ticket
still requires `repo.readCommit(sha)` to succeed before Gitflare mints a
repo-scoped read token.

## What never becomes a fallback

The following must never satisfy canonical source authority:

- a GitHub commit existing at the same SHA
- a local checkout
- a cached tarball
- a SCUMM workspace copy
- a Gitflare-shaped identity string without an Artifacts authority check

Until the Artifacts gate is complete, the correct assurance verdict is
`BLOCKED`, not `PASS` and not a mirror-backed approximation.
