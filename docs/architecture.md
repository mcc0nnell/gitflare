# Architecture

Gitflare is a thin forge/control-plane layer with a replaceable Git source plane.

```text
GIT SOURCE = Cloudflare Artifacts OR RepoContainer + R2
GITFLARE   = provider seam + policy + collaboration + automation handoff
CLOUDFLARE = execution + evidence + deployment plane
```

Normal Git semantics are non-negotiable. The source provider may change; commits, refs, branches, tags, clone, fetch, and push do not.

## SourceControlProvider

Gitflare has two source-plane strategies.

| Provider | Git implementation | Live repository storage | Coordination | Durable storage |
| --- | --- | --- | --- | --- |
| Cloudflare Artifacts | Cloudflare Artifacts | managed by Artifacts | managed by Artifacts | managed by Artifacts |
| self-hosted RepoContainer | real `git` / `git-http-backend` | Container local POSIX disk | one RepoContainer DO per repo | versioned R2 checkpoints |

The collaboration and execution layers should consume a narrow provider contract rather than assuming one implementation.

Conceptually:

```text
SourceControlProvider
  list/create repo
  resolve revision
  issue credential
  clone/fetch/push endpoint
  emit durable push event
  expose commit/status identity
```

Provider-specific storage details stay below that boundary.

## Managed provider: Cloudflare Artifacts

Cloudflare Artifacts is the preferred source plane when available.

Each repository has:

- a namespace and repository name
- durable Git history and refs
- a standard HTTPS Git remote
- repo-scoped access tokens
- Workers and REST management APIs
- normal clone/fetch/pull/push behavior
- push events that can trigger Cloudflare automation

For this provider, Gitflare does not proxy Git traffic or implement repository durability. Artifacts owns those concerns.

```text
Developer / agent
      |
      | normal Git
      v
Cloudflare Artifacts repository
      |
      | cf.artifacts.repo.pushed
      v
Cloudflare Workflow / Gitflare automation
```

No additional repository Durable Object is required.

## Self-hosted provider: RepoContainer + R2

The self-hosted provider exists for two reasons:

1. Artifacts is currently a closed beta.
2. Some operators may prefer to own the Git substrate even when a managed provider exists.

Its topology is:

```text
Developer / agent
      |
      | HTTPS Git smart protocol
      v
Gitflare Worker
  auth / route owner+repo
      |
      | stable named DO
      v
RepoContainer
Container class = Durable Object + Linux Container
      |
      +-- SQLite: committed generation / checkpoint pointer / phase
      |
      +-- local disk: /data/repo.git
      |              real git-http-backend
      |
      `-- completed checkpoint stream
                     |
                     v
                     R2
```

### Why the Durable Object exists

The Durable Object is the repository coordinator, not a shadow Git database.

One stable `owner/repo` name maps to one `RepoContainer` identity. That object serializes repository control transitions and keeps a tiny strongly consistent record of what state is acknowledged as durable.

The Git object graph itself remains in an ordinary bare repository on Container local disk while the Container is active.

### Why R2 is not the live filesystem

Git relies on normal filesystem behavior for lock files, atomic ref replacement, pack creation, and repository maintenance.

The self-hosted provider therefore does not depend on an R2 FUSE mount for the active bare repository. R2 is used as durable checkpoint storage after Git has completed its local transaction.

This keeps each storage system in the job it is best suited for:

| Layer | Responsibility |
| --- | --- |
| Container local disk | live Git repository and POSIX semantics |
| RepoContainer DO SQLite | authoritative generation pointer and crash phase |
| R2 | immutable/versioned completed repository checkpoints |

### Push commit protocol

A push is acknowledged only after its resulting repository state is durable.

```text
ensure last committed generation restored
      |
      v
DO SQLite: phase = mutating
      |
      v
git receive-pack on local disk
      |
      v
git fsck --connectivity-only
      |
      v
stream completed checkpoint to R2 generation N+1
      |
      v
DO SQLite atomically advances committed generation
      |
      v
return Git push response
```

Failure semantics are intentional:

- crash before `phase=mutating` persists: no mutation began
- crash after local Git mutation but before R2 checkpoint: next request restores the previous committed generation
- R2 upload succeeds but DO pointer does not commit: the uploaded object is an orphan, not authoritative
- DO generation commits but client loses the response: the push is durable; a retry observes ordinary Git ref state

An unacknowledged local mutation is never allowed to become authoritative merely because the Container survived.

### Container restart protocol

The repository process exposes a random boot identifier created at Container process start.

The DO caches the last boot ID and ready generation only in memory. If the boot ID changes, the local filesystem is considered untrusted until the current committed R2 generation has been restored and validated.

The implementation includes an admin-only forced restart route so this invariant can be exercised directly.

## Event plane

Repository mutation becomes an event, not an excuse to put CI inside the source server.

Managed provider:

```text
Artifacts push
   -> cf.artifacts.repo.pushed
   -> Workflow
```

Self-hosted provider:

```text
receive-pack
   -> R2 checkpoint committed
   -> DO generation advanced
   -> logical repo.pushed event
   -> Workflow
```

The self-hosted event is emitted only after durability admission. Downstream CI should not care which provider produced the revision.

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

Do not put build execution inside the Git source service.

## Evidence and build artifacts

Do not confuse source repositories with CI build artifacts or self-hosted source checkpoints.

A useful separation is:

```text
source provider
  Artifacts OR RepoContainer/R2 checkpoints

execution evidence
  R2 runs/<run-id>/...

query/index metadata
  D1 when useful
```

Build logs, test output, screenshots, provenance, assurance, and deploy evidence belong to the execution plane, not Git history.

## GitHub relationship

GitHub is an optional collaboration provider, not a required execution layer.

```text
GitHub
PRs / issues / discovery / reviews
      |
      | mirror or provider adapter
      v
SourceControlProvider
      |
      +--> Artifacts
      `--> self-hosted RepoContainer + R2
      |
      v
Cloudflare-native automation
```

Changing the human-facing collaboration surface or the Git source provider must not require rewriting the execution architecture.

## SCUMM3 dogfood topology

The first production-shaped experiment remains SCUMM3.

The managed path is:

```text
GitHub main
   -> verified mirror
   -> Cloudflare Artifacts
   -> cf.artifacts.repo.pushed
   -> Cloudflare CI Workflow
   -> Sandbox validation
```

The self-hosted path gives the same project a fallback:

```text
normal Git push
   -> RepoContainer
   -> committed R2 generation
   -> Gitflare push event
   -> same Cloudflare CI handoff
```

## Security boundaries

1. Repository credentials are provider-scoped and narrow. The self-hosted example uses bootstrap secrets only until short-lived repo-scoped credentials are added.
2. Production credentials never enter untrusted source execution.
3. Source and execution authority stay separate.
4. Mirrors are verified by exact commit identity.
5. The DO stores coordination metadata, not arbitrary Git object bodies.
6. A self-hosted push is not acknowledged until the checkpoint pointer is durable.
7. Internal Container import/export endpoints are not exposed as public repository routes.

## Retired design

Gitflare still does **not** implement Git object formats, pack negotiation, or ref algorithms itself.

The retired design remains retired:

- loose Git objects manually modeled in R2
- Git ref tables authored in D1
- custom Git pack parsing
- custom receive-pack/upload-pack implementations

The self-hosted provider runs the actual Git binary and uses `git-http-backend`. The custom code is coordination and checkpointing around Git, not a reimplementation of Git.
