# Principles

Gitflare exists to keep Git boring and let Cloudflare do the work.

These principles are the product contract.

## 1. Do not reimplement Artifacts

Cloudflare Artifacts is the Git repository primitive.

If Artifacts already owns a concern — Git history, refs, smart HTTP, repository durability, repo-scoped tokens, import/fork behavior — Gitflare does not create a shadow implementation of it.

Deletion of redundant infrastructure is architectural progress.

## 2. Normal Git wins

A Gitflare-backed repository is a Git repository.

Developers and agents should use ordinary Git clients and ordinary Git concepts: commits, refs, branches, tags, clone, fetch, pull, and push.

No proprietary source-control client is required.

## 3. Gitflare stays thin

Gitflare owns only the missing coordination around the repository:

- policy
- identity mapping
- token issuance rules
- mirrors/provider adapters
- review/change objects
- statuses
- automation handoff
- evidence/deployment links

It does not become a monolithic forge.

## 4. Source is not execution

A repository mutation emits work. It does not execute the work inside the source-control server.

Use Cloudflare Workflows for orchestration and Sandbox/Containers for builds, tests, browser proof, and toolchains.

Gitflare should never grow an internal Actions-style runner fleet.

## 5. Humans and machines can use different surfaces

Humans may prefer GitHub because that is where contributors, PRs, issues, and discovery already exist.

Machines do not need GitHub to own execution.

Gitflare explicitly supports this split:

```text
human collaboration surface
          |
          v
     source provider
          |
          v
Cloudflare Artifacts
          |
          v
Cloudflare execution plane
```

A GitHub mirror is therefore a compatibility/social feature, not the architectural center.

## 6. Credentials are narrow and short-lived

Prefer repository-scoped Artifacts tokens.

Use read credentials for clone/fetch/pull and write credentials only where push is required.

Production deployment credentials never belong in untrusted source execution.

## 7. Revisions are identified, not implied

Mirrors, builds, checks, evidence, and deployments should all name the exact commit they concern.

A mirror is not “successful” because a command returned zero; it is successful when the target ref resolves to the expected revision.

A deployment is not “the latest”; it is deployment of a specific validated revision.

## 8. Evidence is durable and separate

Source history belongs in Artifacts.

Execution evidence belongs in an evidence store such as R2, with metadata indexed separately when useful.

Do not pollute Git history with transient logs merely because Git is available.

## 9. Provider boundaries are explicit

GitHub, GitLab, self-hosted Git, or another forge should connect through a narrow source/collaboration adapter.

Changing the human-facing provider must not require rewriting the Cloudflare CI engine.

## 10. Dogfood before abstraction

SCUMM3 is the first proving ground.

Patterns become Gitflare features only after they survive a real repository, real pushes, real CI, and real deployment boundaries.

Do not generalize imaginary requirements.

## 11. Beta means beta

Cloudflare Artifacts is currently a closed beta.

Gitflare should state that dependency plainly, keep boundaries reversible, and avoid pretending the platform contract is more stable than it is.

## 12. Public by default

Gitflare's architecture, experiments, failures, and reusable patterns should be developed in the open whenever they do not expose credentials or private project material.

The value of the project is as much the pattern as the code.
