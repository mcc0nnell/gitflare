# Principles

Gitflare exists to keep Git boring and let Cloudflare do the work.
These principles are the product contract. Features that violate them do not belong here.

## 1. Git is the source of truth

Preserve normal Git semantics.
Do not invent a replacement version-control model.

Repositories, objects, refs, branches, and tags should mean what they mean in Git.
A clone produced by Gitflare should be a Git repository, not a Gitflare repository.

## 2. Cloudflare does the work

Prefer Cloudflare-native primitives for everything surrounding Git.

| Concern | Home |
| --- | --- |
| HTTP/API edge | Workers |
| metadata | D1 |
| Git objects and artifacts | R2 |
| serialized mutation | Durable Objects |
| asynchronous events | Workflows |
| git binaries, checkout, builds, tests | Containers |

Do not rebuild execution, identity, storage, or delivery as a sidecar forge when Cloudflare already provides the primitive.

## 3. Small control plane

The SCM layer should remain intentionally narrow.

Gitflare owns repositories, refs, objects, statuses, review objects, and events.
It does not own CI orchestration, issue trackers, boards, package registries, social feeds, wikis, or plugin marketplaces.

If a feature can live as a Cloudflare Workflow, Container job, or Worker reacting to an event, it should not be absorbed into the SCM server.

## 4. Open protocols first

Normal Git tooling must work.

A developer should eventually be able to run:

```bash
git clone https://git.example.com/org/repo.git
git fetch
git push
```

without a proprietary client.

HTTP(S) Git smart protocol is the intended access path.
SSH, custom CLIs, and web UIs are not prerequisites for the control plane to be useful.

## 5. Immutable objects

Git objects and build artifacts should favor immutable storage models.

Content-addressed bytes go to R2.
Once written, an object id refers to those bytes forever.
Overwrite is a bug.
Mutation belongs to refs, not objects.

Do not store large Git object bodies in D1.

## 6. Explicit coordination

Strong coordination should exist only where Git semantics require it, especially ref mutation.

One repository coordinator Durable Object per repository is the default place for:

- ref update serialization
- compare-and-swap
- push arbitration
- short-lived receive-pack state
- status/review fan-out that must not race the ref

Do not introduce global locks, cluster coordinators, or chatty consensus for reads of immutable data.

## 7. No CI inside Git

Push events should emit work.
They should not turn the SCM server itself into a giant CI orchestrator.

The push path authenticates, accepts objects, validates the graph it must validate, coordinates the ref update, records the event, and returns.
Build, test, artifact storage, and deploy happen downstream on Cloudflare Workflows and Containers.
Statuses come back as data, not as a second control plane living inside Git.
