# Artifacts push Workflow

This example is Gitflare's smallest source-to-execution proof.

It subscribes one Cloudflare Workflow to pushes from **every repository in the `gitflare` Artifacts namespace**.

```text
git push
   -> Cloudflare Artifacts
   -> cf.artifacts.repo.pushed
   -> gitflare-artifacts-ci Workflow
   -> @cloudflare/ci
   -> Sandbox checkout
   -> git rev-parse HEAD
   -> git fsck --connectivity-only
```

The same Worker also exposes the Workflow control plane to agents over MCP:

```text
Atlas / Shell / TalkPipe / agents
              |
              v
            /mcp
              |
              v
      CI_WORKFLOW binding
              |
              v
       @cloudflare/ci
```

The generic Gitflare pipeline remains provider-neutral. Repository-specific policy is selected only after `verify-source`; for example, an Artifacts repository named `firecrab` runs the release-compliance contract versioned inside FireCrab itself.

## Prerequisites

- Cloudflare Artifacts beta access
- the `gitflare` Artifacts namespace
- an R2 bucket named `gitflare-ci-backups`
- an authenticated Wrangler environment
- the Worker secrets required by `@cloudflare/ci` / Sandbox snapshot handling
- the Gitflare CI identity and MCP secrets described below

Use the current `@cloudflare/ci` documentation as the source of truth for runner and R2 credentials.

## Configure

Repository configuration contains no account-ID or MCP-host placeholders. Runtime identity is supplied as Worker secret bindings so this branch remains portable and does not need account-specific edits.

Configure the source/runtime bindings:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CF_TOKEN
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

`CLOUDFLARE_ACCOUNT_ID` is not itself a credential; it is kept out of the committed example so the same source can be deployed into another account without editing tracked configuration. `@cloudflare/ci` uses it to construct the Cloudflare Artifacts Git remote for isolated checkout.

Configure the MCP boundary:

```bash
npx wrangler secret put GITFLARE_CI_MCP_HOST
npx wrangler secret put GITFLARE_CI_MCP_TOKEN
```

`GITFLARE_CI_MCP_HOST` is a hostname only, without a scheme or path, for example the Worker's `workers.dev` hostname or a configured custom domain. The token protects the complete `/mcp` surface.

Then install dependencies and validate the Worker before deployment:

```bash
npm install
npm run cf-typegen
npm run typecheck
npm run build
```

Deploy only after the Artifacts namespace, backup bucket, and required secret bindings exist:

```bash
npm run deploy
```

## FireCrab clean-room profile

When `repo === "firecrab"`, the verified source snapshot is chained into a second runner named `release-compliance-preflight`. It invokes `scripts/gitflare-release-compliance.sh` from the exact checked-out FireCrab commit.

The profile deliberately does not declare a CI cache. It verifies the expected object ID again, refuses dirty source state, runs compliance unit tests with Python optimization enabled, runs M2Image/host packaging contracts, resolves Cargo and npm dependency state into per-run scratch directories, regenerates the release inventory with `--deny-incompatible`, discards dependency scratch state, and retains a hash-bound `dist/gitflare-receipts.tar.gz` in the successful runner snapshot.

This is a **preflight**, not the complete release matrix: full native x86_64/aarch64 builds and real Alpine/Ubuntu/Rocky corresponding-source materialization remain later assurance stages.

## MCP tools

`POST /mcp` is served by the official `@modelcontextprotocol/server` package and supports the current stateless MCP transport as well as the SDK's legacy compatibility path.

Before MCP dispatch, the Worker validates `Host` against `GITFLARE_CI_MCP_HOST`, rejects requests carrying a browser `Origin` header, and verifies the bearer token with a constant-time comparison. The first slice is intentionally an agent/CLI surface; browser clients can gain an explicit trusted-origin allowlist later.

The first tool surface is deliberately small:

- `ci_run_start` — start a source-idempotent run for an Artifacts repository, commit, and full Git ref
- `ci_run_status` — inspect a known Workflow instance
- `ci_run_retry` — restart from the beginning or a named durable Workflow step
- `ci_run_cancel` — terminate a run, optionally with rollback handlers

`ci_run_start` uses the same source-derived Workflow ID contract as `@cloudflare/ci`, so a push-triggered run and an agent-triggered run for the same repository and commit converge instead of creating duplicate CI executions.

The TalkPipe adapter in [`../../talkpipe`](../../talkpipe/) is the reference operator/agent client for this surface.

## Why namespace-wide?

Gitflare should not require a separately authored CI controller for each repository.

The trigger filter selects the `gitflare` namespace but deliberately omits a repository name. Each push still creates its own Workflow instance for the repository/ref/commit that changed.

Gitflare policy selects any project-specific profile only after the common source verification boundary.

## First invariant

This pipeline proves:

> the exact source revision emitted by Cloudflare Artifacts can enter a Cloudflare-native Workflow, be checked out into an isolated runner as a connected Git repository, and be operated by agents through a thin authenticated MCP adapter without making MCP the CI source of truth.

That is the seam everything else builds on.
