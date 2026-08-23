# Architecture

Gitflare is a thin forge/control-plane layer around Cloudflare Artifacts.

The central design decision is now:

```text
ARTIFACTS = Git repository primitive
GITFLARE  = policy + collaboration + automation handoff
CLOUDFLARE = execution + evidence + deployment plane
```

Gitflare does not implement Git object storage, ref coordination, smart HTTP, pack negotiation, or repository durability itself.

## Source plane

Cloudflare Artifacts is the source plane.

Each repository has:

- a namespace and repository name
- durable Git history and refs
- a standard HTTPS Git remote
- repo-scoped access tokens
- Workers and REST management APIs
- normal clone/fetch/pull/push behavior
- push events that can trigger Cloudflare automation

That is enough Git substrate for Gitflare to build on without recreating a source-control server.

## Control plane

A Gitflare Worker may eventually provide a friendly control API over Artifacts for concerns such as:

- project/repository registration
- policy
- human and agent identity mapping
- token minting rules
- source-provider mirrors
- review/change records
- commit/check status projection
- build/deploy/evidence links

The Worker should call the Artifacts binding or REST API rather than manipulating Git internals.

## Git data plane

Normal Git clients talk directly to the Artifacts repository remote.

```text
Developer / agent
      |
      | git clone / fetch / pull / push
      v
Cloudflare Artifacts repository
```

Gitflare should not proxy Git traffic unless a future requirement proves a proxy is necessary.

This keeps credentials repo-scoped and lets Cloudflare's Git implementation own protocol compatibility.

## Event plane

Repository mutation becomes an event, not an excuse to put CI inside the source server.

```text
git push
   |
   v
Artifacts repository
   |
   | cf.artifacts.repo.pushed
   v
Cloudflare Workflow
   |
   +--> classify change
   +--> checkout / snapshot
   +--> test / build
   +--> evidence
   +--> deploy if policy permits
   |
   v
status projection
```

The source path should return as soon as the repository mutation is committed and the downstream work is accepted.

## Execution plane

Use Cloudflare Workflows to orchestrate multi-step jobs.

Use Sandbox or Containers for workloads requiring:

- a filesystem
- a real toolchain
- package installation
- tests
- builds
- browser automation
- arbitrary repository tooling

Do not put build execution inside the Gitflare Worker.

## Evidence and artifacts

Do not confuse **Cloudflare Artifacts repositories** with CI build artifacts.

Artifacts owns versioned source trees and Git history.

R2 remains appropriate for immutable execution evidence such as:

```text
runs/<run-id>/manifest.json
runs/<run-id>/stdout.log
runs/<run-id>/stderr.log
runs/<run-id>/junit.xml
runs/<run-id>/screenshots/
runs/<run-id>/assurance/
runs/<run-id>/build/
runs/<run-id>/provenance.json
```

D1 can index run metadata and relationships when queryability is useful.

## Durable Objects

The original Gitflare architecture proposed one Durable Object per repository to serialize ref updates. Artifacts already owns repository mutation and durable refs, so Gitflare must not duplicate that authority.

Use Durable Objects only if Gitflare later needs strongly coordinated state that Artifacts itself does not own, for example a review-session coordinator or realtime collaboration object.

No Durable Object should become a shadow Git repository.

## GitHub relationship

GitHub is an optional collaboration provider, not a required execution layer.

A project may choose:

```text
GitHub
PRs / issues / discovery / reviews
      |
      | mirror or provider adapter
      v
Cloudflare Artifacts
canonical machine-consumed Git source
      |
      v
Cloudflare-native automation
```

Or it may use Artifacts directly with a different human collaboration surface.

Gitflare should model source providers behind a narrow adapter boundary so GitHub, GitLab, self-hosted Git, or another source can be connected without changing the execution architecture.

## SCUMM3 dogfood topology

The first production-shaped experiment is SCUMM3:

```text
GitHub main
   |
   | Git mirror during dogfood
   v
Cloudflare Artifacts
scumm3-gitflare/scumm3
   |
   | cf.artifacts.repo.pushed
   v
Cloudflare CI Workflow
   |
   v
Sandbox validation
   |
   +--> evidence
   +--> check/status projection
   +--> production deployment when admitted
```

The mirror is transitional. Its purpose is to let humans keep using GitHub while proving that Cloudflare can own the machine path.

## Security boundaries

1. **Repository tokens are repo-scoped.** Prefer short-lived read tokens for checkout and write tokens only where a push is required.
2. **Production credentials never enter untrusted PR execution.** Deployment authority is introduced only after trusted validation and explicit policy admission.
3. **Source and execution authority stay separate.** A source provider can request work; it does not automatically gain deployment authority.
4. **Mirrors are verified by commit identity.** A mirror operation is incomplete until the target ref matches the expected source commit.
5. **Gitflare does not invent weaker Git semantics.** Artifacts remains the Git authority for repository history and refs.

## Explicitly retired design

The following original Gitflare plan is no longer part of the architecture:

- loose Git objects stored manually in R2
- Git ref tables authored by Gitflare in D1
- repository-level ref CAS implemented in Durable Objects
- custom `git-upload-pack` / `git-receive-pack` hosting
- a Git smart-HTTP server built by Gitflare

Cloudflare Artifacts already supplies those source-control primitives.

Deleting that work is a feature.

## Current dependency

Cloudflare Artifacts is currently a closed beta. Gitflare therefore treats Artifacts availability as an explicit platform prerequisite while the project is experimental.
