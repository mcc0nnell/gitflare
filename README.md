# Gitflare

**Git should be boring. Cloudflare should do the work.**

Gitflare is an independent experiment in building a very small software forge around **Cloudflare Artifacts**.

Cloudflare already supplies the missing Git primitive: Artifacts repositories have durable Git history and refs, standard smart-HTTP remotes, repo-scoped tokens, Workers and REST control-plane APIs, and repository push events. Gitflare does **not** reimplement Git storage, pack negotiation, refs, or `git-http-backend`.

Instead, Gitflare asks a narrower question:

> What is the smallest useful collaboration and automation layer you can put around a Cloudflare Artifacts repository?

```text
Humans / agents
      |
      | normal Git
      v
Cloudflare Artifacts
Git history / refs / clone / fetch / push
      |
      | repo events
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

A GitHub repository can therefore be a public collaboration mirror of the same project while Cloudflare Artifacts is the source plane consumed by agents and Cloudflare-native automation.

## What Artifacts already gives us

- isolated Git repositories inside namespaces
- standard Git clone, fetch, pull, and push over HTTPS
- durable history and refs
- repo-scoped read/write tokens
- Workers binding and REST control-plane APIs
- repository import/fork operations
- `cf.artifacts.repo.pushed` events for Cloudflare-native automation

That means the old plan to build Git object storage in R2, ref tables in D1, and a ref coordinator in Durable Objects is intentionally retired.

## What Gitflare owns

Gitflare should stay thin:

- repository policy and conventions
- human/agent identity mapping
- short-lived credential issuance policy
- review/change objects where a GitHub-style PR is unavailable or undesirable
- commit/check statuses
- source-provider adapters and mirroring
- Workflow/Sandbox/Container handoff
- evidence and deployment links

It should **not** become another giant forge.

## First executable slice

The repository contains a minimal Worker control API over an Artifacts namespace.

```text
GET  /healthz
GET  /repos
POST /repos
POST /repos/:repo/tokens
```

All non-health routes require a `GITFLARE_ADMIN_TOKEN` Worker secret.
The API defaults to short-lived read credentials and requires write scope to be requested explicitly.

Bootstrap locally or in a Cloudflare-enabled development environment:

```bash
npm install
npx wrangler secret put GITFLARE_ADMIN_TOKEN
npm run check
npm run dev
```

The Worker config binds `ARTIFACTS` to the `gitflare` namespace.

## Push-to-execution example

[`examples/artifacts-push-workflow`](examples/artifacts-push-workflow/) shows the next seam:

```text
git push
   -> Cloudflare Artifacts
   -> cf.artifacts.repo.pushed
   -> Cloudflare Workflow
   -> @cloudflare/ci
   -> isolated Sandbox checkout
   -> revision + Git connectivity proof
```

The trigger covers the whole `gitflare` namespace. It deliberately performs no application-specific build or deployment; consumers layer their own CI profile after the source handoff is proven.

## Agent control plane

CI is not an MCP server internally. Gitflare exposes a thin authenticated MCP adapter over the same Cloudflare Workflow control plane used by push-triggered CI.

```text
Atlas / Shell / TalkPipe / agents
              |
              | MCP
              v
      Gitflare CI adapter
              |
              v
       CI_WORKFLOW binding
              |
              v
       @cloudflare/ci
```

The first MCP surface supports starting, inspecting, retrying, and cancelling known CI runs. MCP-triggered and push-triggered executions use the same source-derived Workflow identity, so an agent does not create a second CI universe beside normal Git events.

[`talkpipe/`](talkpipe/) contains the reference TalkPipe/ChatterLang operator path. MCP remains an adapter: Git pushes and Cloudflare events continue to run CI when no agent is connected.

See [CI MCP architecture](docs/ci-mcp.md) for the contract and security boundary.

## Dogfood

SCUMM3 is the first real dogfood workload. Its current migration mirrors Git history into a Cloudflare Artifacts repository and runs an isolated Cloudflare-native CI lane from Artifacts. GitHub remains the collaboration surface while the execution plane moves underneath it.

The intended proof is simple:

```text
GitHub contribution
      -> Cloudflare Artifacts repository
      -> repo pushed event
      -> Cloudflare CI
      -> Sandbox validation
      -> evidence / deployment
      -> status back to the human surface
```

## Status

Gitflare is experimental and Cloudflare Artifacts is currently a closed beta. This repository is public so the architecture, implementation choices, and dogfood lessons can be developed in the open.

Gitflare is not an official Cloudflare project and is not affiliated with or endorsed by Cloudflare, Inc.

## Project contract

- [Principles](docs/principles.md)
- [Architecture](docs/architecture.md)
- [MVP](docs/mvp.md)
- [CI MCP architecture](docs/ci-mcp.md)
- [SCUMM3 dogfood](docs/scumm3-dogfood.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
