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

There is intentionally no language-specific build and no deployment step here.
The purpose of this example is to prove the provider-neutral handoff from source revision to isolated execution and a thin agent-operable control seam over it.

## Prerequisites

- Cloudflare Artifacts beta access
- the `gitflare` Artifacts namespace
- an R2 bucket named `gitflare-ci-backups`
- an authenticated Wrangler environment
- the Cloudflare account ID filled into `wrangler.jsonc`
- the MCP Worker hostname filled into `wrangler.jsonc`
- the secrets required by `@cloudflare/ci` / Sandbox snapshot handling
- a `GITFLARE_CI_MCP_TOKEN` Worker secret for MCP access

Use the current `@cloudflare/ci` documentation as the source of truth for its required runner and R2 credentials.

## Configure

Replace both placeholders in `wrangler.jsonc`:

```text
replace-with-your-cloudflare-account-id
replace-with-your-ci-worker-host
```

`GITFLARE_CI_MCP_HOST` is a hostname only, without a scheme or path, for example `gitflare-artifacts-ci.example.workers.dev` or the hostname of a configured custom domain.

Set the MCP bearer secret:

```bash
npx wrangler secret put GITFLARE_CI_MCP_TOKEN
```

Then install dependencies and generate binding types:

```bash
npm install
npm run cf-typegen
npm run typecheck
npm run build
```

Deploy only after the Artifacts namespace and backup bucket exist and the required secrets are configured:

```bash
npm run deploy
```

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

Later Gitflare policy can choose a project-specific profile after checkout.

## First invariant

This pipeline proves:

> the exact source revision emitted by Cloudflare Artifacts can enter a Cloudflare-native Workflow, be checked out into an isolated runner as a connected Git repository, and be operated by agents through a thin authenticated MCP adapter without making MCP the CI source of truth.

That is the seam everything else builds on.
