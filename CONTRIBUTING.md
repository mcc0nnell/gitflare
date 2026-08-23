# Contributing

Gitflare is a deliberately small Cloudflare-native Git control plane.
Read [docs/principles.md](docs/principles.md), [docs/architecture.md](docs/architecture.md), and [docs/mvp.md](docs/mvp.md) before writing code.

## What belongs here

Work that preserves Git as the source of truth and keeps the SCM layer narrow.

Prefer:

- boring Git semantics over novel version-control models
- Cloudflare-native primitives over reimplemented forges
- small, reviewable vertical slices over generated frameworks
- standard Git implementations over hand-rolled protocol logic

Do not add:

- GitHub Actions or other GitHub-hosted CI
- project boards, wikis, social feeds, or plugin ecosystems
- a large application scaffold before the first spike is proven
- packfile parsers unless architecture.md still says that is necessary

This project is intended to reduce dependence on GitHub as an execution platform.
Cloudflare does the work.

## First implementation slice

Do not start with `git upload-pack` / `git receive-pack`.

The preferred first change is a Cloudflare-native primitive that proves:

1. create repository
2. write object
3. read object
4. create ref
5. compare-and-swap ref
6. read ref

That slice is the repository record, ref model, immutable object storage, and repository coordinator.
Details are in [docs/mvp.md](docs/mvp.md).

## Pull requests

Keep PRs small enough to review rigorously.
One primitive is better than a framework.

- Apache-2.0 applies to contributions unless a separate agreement says otherwise.
- Match the existing tone: concise, contractual, no ceremony.
- Document supported versus deferred behavior when a Git feature is introduced.
- Tests should prove the primitive, not the scaffolding.

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
