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

There is intentionally no language-specific build and no deployment step here.
The purpose of this example is to prove the provider-neutral handoff from source revision to isolated execution.

## Prerequisites

- Cloudflare Artifacts beta access
- the `gitflare` Artifacts namespace
- an R2 bucket named `gitflare-ci-backups`
- an authenticated Wrangler environment
- the Cloudflare account ID filled into `wrangler.jsonc`
- the secrets required by `@cloudflare/ci` / Sandbox snapshot handling

Use the current `@cloudflare/ci` documentation as the source of truth for its required runner and R2 credentials.

## Configure

Replace:

```text
replace-with-your-cloudflare-account-id
```

in `wrangler.jsonc` with the account that owns the Artifacts namespace and CI Worker.

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

## Why namespace-wide?

Gitflare should not require a separately authored CI controller for each repository.

The trigger filter selects the `gitflare` namespace but deliberately omits a repository name. Each push still creates its own Workflow instance for the repository/ref/commit that changed.

Later Gitflare policy can choose a project-specific profile after checkout.

## First invariant

This pipeline proves only:

> the exact source revision emitted by Cloudflare Artifacts can enter a Cloudflare-native Workflow and be checked out into an isolated runner as a connected Git repository.

That is the seam everything else builds on.
