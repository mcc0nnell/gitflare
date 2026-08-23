# Source

Gitflare starts with a deliberately small Worker control plane over Cloudflare Artifacts.

`src/index.ts` currently provides:

- `GET /healthz`
- `GET /repos`
- `POST /repos`
- `POST /repos/:repo/tokens`

All repository operations are delegated to the Cloudflare Artifacts binding.
Gitflare does not store Git objects, refs, packfiles, or repository history itself.

## Authentication

Every route except `/healthz` requires:

```text
Authorization: Bearer <GITFLARE_ADMIN_TOKEN>
```

Configure `GITFLARE_ADMIN_TOKEN` as a Worker secret before deploying.

This is an intentionally narrow bootstrap boundary, not the final human/agent identity model.

## Token policy

The initial API defaults to:

- `read` scope
- 15-minute TTL
- minimum 60 seconds
- maximum 60 minutes

Write tokens must be explicitly requested.

## What comes next

The next implementation slice is event-driven execution:

```text
Artifacts repo push
      -> cf.artifacts.repo.pushed
      -> Cloudflare Workflow
      -> Sandbox / Container
      -> status + evidence
```

Do not add a custom Git server, object database, ref coordinator, or GitHub Actions runner to this directory.
