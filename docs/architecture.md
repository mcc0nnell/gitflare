# Architecture

Tentative Cloudflare mapping for Gitflare.
This is a control-plane design, not an application scaffold.

## Separation

```text
GIT        = source of truth
CLOUDFLARE = execution + state + delivery
```

Gitflare is the missing SCM primitive.
Workers, Workflows, Containers, D1, R2, and Durable Objects are the execution and state plane.

## Workers

Use as the HTTP/API edge.

Candidate responsibilities:

- Git smart HTTP endpoints
- repository API
- authentication
- authorization
- metadata queries
- push/fetch ingress
- event publication
- commit status API

Workers are a good place to terminate HTTPS, check authz, stream bytes to R2, and talk to the repository coordinator.
They are a poor place to buffer packfiles, spawn `git`, or run builds.

Current Workers constraints that matter here (paid, as of 2026):

- 128 MB isolate memory
- CPU time measured in seconds to minutes, not unbounded compile jobs
- request bodies in the hundreds of MB, streamed
- no git binary and no general-purpose filesystem
- Node compatibility is partial; `node:stream` exists, a Linux git toolchain does not

Those limits are why Gitflare does not start by implementing smart HTTP inside the Worker isolate.

## R2

Use for large immutable data.

Candidate storage:

```text
repos/<repo-id>/objects/<object-id>
repos/<repo-id>/packs/<pack-id>
artifacts/<run-id>/
```

Rules:

- object bodies live in R2, never D1
- writes are content-addressed; a mismatched id is rejected
- objects are immutable after the first successful write
- packfiles, when they exist, are additional immutable blobs, not a second source of truth for refs

The first spike stores loose objects only.

## D1

Use for relational/control-plane metadata.

Candidate tables:

- `repositories`
- `repository_members`
- `refs`
- `pushes`
- `changes`
- `reviews`
- `statuses`
- `workflow_runs`
- `deployments`

D1 is the queryable catalog: names, membership, ref pointers as durable records, event history, statuses.
The Durable Object remains the serializer for ref mutation even if D1 also stores the current pointer.

The first spike only needs `repositories` and `refs`.
Object bytes do not belong in these tables.

## Durable Objects

Use only where serialized mutation or strongly coordinated state is required.

Primary candidate: **one repository coordinator per repository**.

Responsibilities:

- ref update serialization
- compare-and-swap semantics
- push arbitration
- short-lived receive-pack state
- realtime status/review fan-out

Reads of immutable objects should not require the coordinator.
A CAS failure is a first-class result, not an exception to retry blindly.

Do not store Git object bodies in Durable Object storage.
That would fight both immutability and size.

## Workflows

Use for asynchronous repository events.

```text
push
  ↓
repository event
  ↓
Workflow
  ↓
build/test
  ↓
artifact storage
  ↓
status update
  ↓
preview/deploy
```

The SCM server emits the event.
The Workflow is Cloudflare's job system.
Gitflare should not grow an internal Actions runner.

## Containers / sandbox execution

Use for workloads that need:

- actual Git binaries
- repository checkout
- builds
- tests
- arbitrary toolchains
- isolation

Do not force these workloads into Workers if that makes the architecture worse.

Cloudflare Containers give a Linux filesystem, a real `git` binary, and isolation that a 128 MB isolate cannot fake.
They are the default home for `git upload-pack`, `git receive-pack`, checkout, and build/test once those slices exist.
Workers stay in front: auth, routing, streaming, metadata, events.

## Git protocol placement

Before selecting libraries, the current reading of the platform is:

| Operation | Where | Why |
| --- | --- | --- |
| create / list repositories | Worker + D1 | metadata |
| write / read loose objects | Worker + R2 | immutable blobs, streamable |
| create / CAS / read refs | repository coordinator DO + D1 | Git requires serialized ref mutation |
| `git upload-pack` / `git receive-pack` | Container with real git | pack negotiation, deltas, graph walk; do not hand-roll |
| checkout, build, test | Container | filesystem and toolchains |
| push event → build → status | Workflow | async; not inside the SCM lock |

`isomorphic-git` can speak Git as a **client** from a Worker (Cloudflare documents this for Artifacts). It is not a substitute for `git-http-backend`. Do not adopt it as a smart HTTP server, and do not hand-roll packfile parsing unless a later spike proves that a Container git binary cannot be used.

Wrangler remains the expected project tool (`wrangler.jsonc`, D1 migrations, Durable Object classes, R2 buckets, Containers). Local proof should run under `wrangler dev` / Workers vitest, not GitHub Actions.

## Compatibility

Keep the design compatible with:

- SHA-1 Git repositories
- SHA-256 transition paths
- packfiles
- loose objects
- smart HTTP
- normal Git clients

Do not pretend all of these ship in MVP.

Object ids should be stored as text (hex), not as a SHA-1-only binary column.
The first spike treats ids as opaque content addresses and stores loose objects.
SHA-256, packfiles, thin packs, and smart HTTP are deferred until the coordinator and object store are proven.

## Supported versus deferred

| Capability | First spike | MVP | Later |
| --- | --- | --- | --- |
| create / list repositories | yes | yes | |
| loose object write / read | yes | yes | |
| ref create / CAS / read | yes | yes | |
| branches and tags as refs | names only | yes | |
| authentication | no | yes | |
| clone / fetch / push via smart HTTP | no | yes | |
| event emission | no | yes | |
| commit status | no | yes | |
| change / review object | no | minimal | |
| build trigger via Workflow | no | yes | |
| packfiles | no | maybe receive-only | advertise / thin pack |
| SHA-256 repos | schema-ready | no | yes |
| SSH | no | no | maybe |
| GitHub Actions compatibility | never | never | never |

## First spike

Prove this before Git smart HTTP:

```text
Repository
+
ref model
+
immutable object storage
+
repository coordinator
```

Operations:

- create repo
- write object
- read object
- create ref
- compare-and-swap ref
- read ref

Once that foundation is sound, proceed toward `git upload-pack` and `git receive-pack` behind the Worker edge, executed where a real Git implementation can run.
