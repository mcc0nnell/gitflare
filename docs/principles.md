# Principles

Gitflare exists to keep Git boring and let Cloudflare do the work.

These principles are the product contract.

## 1. Normal Git wins

A Gitflare-backed repository is a Git repository.

Developers and agents should use ordinary Git clients and ordinary Git concepts: commits, refs, branches, tags, clone, fetch, pull, and push.

No proprietary source-control client is required.

## 2. Prefer managed Git; preserve a self-hosted path

Cloudflare Artifacts is the preferred managed Git primitive when available.

If Artifacts owns Git history, refs, smart HTTP, repository durability, and repo-scoped tokens, Gitflare does not duplicate that work.

Gitflare also keeps a self-hosted provider for beta availability, portability, and operator control. That provider runs the real Git binary rather than reimplementing Git formats or algorithms.

## 3. A Durable Object coordinates; it does not become Git

The Artifacts provider needs no extra repository Durable Object.

The self-hosted provider uses exactly one named RepoContainer Durable Object per logical repository because repository mutation needs one authoritative coordinator.

The DO may store:

- repository identity
- committed generation
- durable checkpoint pointer
- checkpoint ETag
- admitted HEAD/revision metadata
- crash/recovery phase

It does not store arbitrary Git object bodies.

## 4. Give Git a real filesystem

Self-hosted Git runs on Container local POSIX disk.

Do not require Git's live lock files, ref replacement, pack writes, or maintenance operations to behave correctly on an object-store FUSE mount.

R2 stores completed checkpoints; it is not the active repository filesystem.

## 5. Never acknowledge state that is not durable

For the self-hosted provider, a successful `receive-pack` is necessary but not sufficient for an acknowledged push.

The resulting repository must be validated, checkpointed to R2, and admitted by the DO's durable generation pointer before Gitflare returns the successful push response.

An unacknowledged local mutation may be discarded after failure or restart.

## 6. Gitflare stays thin

Gitflare owns only the missing coordination around the repository:

- source-provider adapters
- policy
- identity mapping
- token issuance rules
- mirrors
- review/change objects
- statuses
- automation handoff
- evidence/deployment links

It does not become a monolithic forge.

## 7. Source is not execution

A durable repository mutation emits work. It does not execute the work inside the source-control server.

Use Cloudflare Workflows for orchestration and Sandbox/Containers for builds, tests, browser proof, and toolchains.

Gitflare should never grow an internal Actions-style runner fleet.

## 8. Humans and machines can use different surfaces

Humans may prefer GitHub because contributors, PRs, issues, and discovery already exist there.

Machines do not need GitHub to own execution.

```text
human collaboration surface
          |
          v
 source/provider adapter
          |
          +--> Artifacts
          `--> self-hosted RepoContainer + R2
          |
          v
Cloudflare execution plane
```

A GitHub mirror is therefore a compatibility/social feature, not the architectural center.

## 9. Credentials are narrow and short-lived

Prefer repository-scoped short-lived credentials.

Use read credentials for clone/fetch/pull and write credentials only where push is required.

Bootstrap static secrets are acceptable only for an explicit early vertical slice and must not become the final authorization model.

Production deployment credentials never belong in untrusted source execution.

## 10. Revisions are identified, not implied

Mirrors, pushes, checkpoints, builds, checks, evidence, and deployments should all name the exact revision they concern.

A mirror is not successful because a command returned zero; it is successful when the target ref resolves to the expected revision.

A self-hosted checkpoint is not authoritative because it exists in R2; it is authoritative when the repository DO commits its generation pointer to it.

## 11. Evidence is durable and separate

Source history belongs to the selected source provider.

Execution evidence belongs in an evidence store such as R2, with metadata indexed separately when useful.

Do not pollute Git history with transient logs merely because Git is available.

## 12. Provider boundaries are explicit

GitHub, GitLab, Cloudflare Artifacts, the self-hosted Gitflare backend, or another provider should connect through a narrow source/collaboration adapter.

Changing the source provider or human-facing forge must not require rewriting the Cloudflare CI engine.

## 13. Dogfood before abstraction

SCUMM3 is the first proving ground.

Patterns become Gitflare features only after they survive a real repository, real pushes, real restart/failure tests, real CI, and real deployment boundaries.

Do not generalize imaginary requirements.

## 14. Beta means beta

Cloudflare Artifacts is currently a closed beta.

Gitflare states that dependency plainly and keeps the self-hosted provider available rather than pretending beta access is universal.

## 15. Public by default

Gitflare's architecture, experiments, failures, and reusable patterns should be developed in the open whenever they do not expose credentials or private project material.

The value of the project is as much the pattern as the code.
