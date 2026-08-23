# Gitflare

**Git should be boring. Cloudflare should do the work.**

Gitflare is an independent experiment in building a very small Cloudflare-native software forge.

It now has two source-plane strategies:

1. **Cloudflare Artifacts** — the preferred managed Git primitive when available.
2. **RepoContainer + R2** — a self-hosted fallback using real Git on Container local disk, one Durable Object coordinator per repository, and committed R2 checkpoints for durability.

Both preserve the same rule: developers and agents use ordinary Git. Gitflare does not invent a replacement version-control protocol.

```text
Humans / agents
      |
      | normal Git
      v
SourceControlProvider
      |
      +--> Cloudflare Artifacts
      |
      `--> RepoContainer (DO + Linux Git) -> R2 checkpoints
      |
      | push event / admitted revision
      v
Gitflare
policy / reviews / statuses / handoff
      |
      v
Cloudflare Workflows + Sandbox / Containers
      |
      v
build / test / evidence / deploy
```

## Why

GitHub is excellent as a social forge because everyone is already there. It does not need to be the execution authority.

Gitflare is designed so a project can keep GitHub for discovery, pull requests, discussion, and contribution while Cloudflare owns the machine path underneath it.

The source backend should also be replaceable. A project can use managed Cloudflare Artifacts when available or operate the Git substrate itself without changing the higher-level automation model.

## Managed source plane: Cloudflare Artifacts

Artifacts already supplies the Git machinery Gitflare does not need to rebuild:

- isolated Git repositories inside namespaces
- standard Git clone, fetch, pull, and push over HTTPS
- durable history and refs
- repo-scoped read/write tokens
- Workers binding and REST control-plane APIs
- repository import/fork operations
- `cf.artifacts.repo.pushed` events for Cloudflare-native automation

The root Worker is the first executable slice over this provider:

```text
GET  /healthz
GET  /repos
POST /repos
POST /repos/:repo/tokens
```

All non-health routes require a `GITFLARE_ADMIN_TOKEN` Worker secret.

## Self-hosted source plane: RepoContainer + R2

[`examples/self-hosted-r2`](examples/self-hosted-r2/) is the self-hosted backend.

```text
git clone / fetch / push
          |
          v
       Worker
    auth + routing
          |
          | one stable owner/repo identity
          v
     RepoContainer
 Durable Object + Container
     |             |
 DO SQLite     local POSIX disk
 committed      bare repo +
 generation     git-http-backend
     |             |
     `------ checkpoint ------>
                   R2
```

The Durable Object is the **repository coordinator**, not the repository disk. Git runs on ordinary local Linux storage. R2 stores only completed checkpoints.

A push is acknowledged only after:

```text
phase=mutating persisted in DO SQLite
        -> git receive-pack completes
        -> git fsck passes
        -> completed repo streams to R2
        -> committed generation advances atomically
        -> push response returns
```

If the Container dies, the next instance restores the last committed generation from R2 before serving Git. The example includes a forced-restart acceptance test specifically for this invariant.

This avoids depending on R2 FUSE for Git's live lockfile/rename/ref semantics while keeping the durable bytes on Cloudflare.

## Push-to-execution example

[`examples/artifacts-push-workflow`](examples/artifacts-push-workflow/) shows the managed-provider source-to-execution seam:

```text
git push
   -> Cloudflare Artifacts
   -> cf.artifacts.repo.pushed
   -> Cloudflare Workflow
   -> @cloudflare/ci
   -> isolated Sandbox checkout
   -> revision + Git connectivity proof
```

The self-hosted backend will emit the same logical push event after a generation becomes durable, so downstream CI does not need to care which source provider stored the repository.

## What Gitflare owns

Gitflare should stay thin:

- source-provider adapters
- repository policy and conventions
- human/agent identity mapping
- short-lived credential issuance policy
- review/change objects
- commit/check statuses
- Workflow/Sandbox/Container handoff
- evidence and deployment links

It should **not** become another giant forge.

## Dogfood

SCUMM3 is the first real dogfood workload. Its current migration mirrors Git history into Cloudflare Artifacts and runs an isolated Cloudflare-native CI lane from Artifacts while GitHub remains the human collaboration surface.

The self-hosted provider gives the same project an escape hatch if Artifacts is unavailable or if owning the Git substrate is preferable.

## Status

Gitflare is experimental. Cloudflare Artifacts is currently a closed beta; the self-hosted RepoContainer + R2 path exists specifically so the architecture does not depend on beta availability.

Gitflare is not an official Cloudflare project and is not affiliated with or endorsed by Cloudflare, Inc.

## Project contract

- [Principles](docs/principles.md)
- [Architecture](docs/architecture.md)
- [MVP](docs/mvp.md)
- [SCUMM3 dogfood](docs/scumm3-dogfood.md)
- [Self-hosted R2 provider](examples/self-hosted-r2/)

## License

Apache License 2.0. See [LICENSE](LICENSE).
