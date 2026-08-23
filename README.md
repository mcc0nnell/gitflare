# Gitflare

Git should be boring. Cloudflare should do the work.

Gitflare is a minimal source-control control plane designed to run naturally on Cloudflare.

The intended separation is:

```text
GIT        = source of truth
CLOUDFLARE = execution + state + delivery
```

The goal is not to recreate GitHub, GitLab, or another giant software forge.
Gitflare should provide the smallest useful source-control layer, while delegating execution, storage, coordination, deployment, identity, and delivery to Cloudflare-native infrastructure.

## Conceptual architecture

```text
Developer
    │
    │ clone / fetch / push
    ▼
Gitflare
minimal Git control plane
    │
    ├── repositories
    ├── refs
    ├── branches
    ├── tags
    ├── review objects
    ├── statuses
    └── events
             │
             ▼
        Cloudflare
             │
   ┌─────────┼─────────────┐
   ▼         ▼             ▼
Workers   Workflows    Containers
   │         │             │
   ├─────────┴──────┬──────┘
   ▼                ▼
  D1               R2
metadata      Git objects/artifacts
   │
   ▼
Durable Objects
coordination
```

## What Gitflare is not

Gitflare is not intended to reproduce:

- GitHub Actions
- GitLab CI
- Jira
- project boards
- package marketplaces
- social coding feeds
- wiki platforms
- giant plugin ecosystems

Cloudflare already provides much of the execution plane.
Gitflare should provide the missing SCM primitive.

A developer should eventually be able to run:

```bash
git clone https://git.example.com/org/repo.git
git fetch
git push
```

without a proprietary client.

## Product contract

- [Principles](docs/principles.md) — why the control plane stays small
- [Architecture](docs/architecture.md) — Cloudflare mapping and technical discipline
- [MVP](docs/mvp.md) — first vertical slice and the end-to-end demonstration

## Current status

This repository currently holds the architecture and product contract.
There is no application framework here yet.

The first engineering spike is not Git smart HTTP.
It is the repository record, immutable object storage, ref model, and repository coordinator.
See [docs/mvp.md](docs/mvp.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
