# MVP

Gitflare MVP is no longer “build a Git server on Cloudflare.” Cloudflare Artifacts already provides the Git server.

The MVP is now the smallest useful forge and automation layer around an Artifacts repository.

## MVP capabilities

1. register or import an Artifacts repository
2. expose its canonical remote and repository identity
3. mint short-lived repo-scoped read/write credentials according to policy
4. clone/fetch/pull/push with a normal Git client
5. receive repository push events
6. trigger a Cloudflare Workflow
7. run validation in Sandbox or Containers
8. persist execution evidence outside the source repository
9. project a commit/check status to the collaboration surface
10. optionally deploy a trusted validated revision

A GitHub mirror/provider is part of the first dogfood configuration, not part of the Gitflare core requirement.

## First proof: SCUMM3

SCUMM3 is the first end-to-end proof.

```text
GitHub contribution
      |
      | verified mirror
      v
Cloudflare Artifacts
scumm3-gitflare/scumm3
      |
      | repo pushed event
      v
Cloudflare Workflow
      |
      v
Cloudflare-native CI
      |
      v
Sandbox validation
      |
      +--> evidence
      +--> status/check result
      +--> deploy trusted main
```

### Success criteria

The proof is complete when:

- the Artifacts `main` ref exactly matches the expected source commit
- a standard Git client can clone the Artifacts repository using a repo-scoped read token
- a controlled write token can push a branch/ref
- an Artifacts push starts the CI Workflow without GitHub Actions acting as the CI runner
- validation completes in Cloudflare Sandbox/Containers
- the result is visible from the human collaboration surface
- a trusted `main` success can deploy without a GitHub-hosted runner
- the GitHub mirror can be disabled without changing the CI engine

## Gitflare v0 API surface

The first implementation should stay small.

Candidate operations:

```text
GET  /repos
POST /repos
GET  /repos/:namespace/:repo
POST /repos/:namespace/:repo/tokens
POST /repos/:namespace/:repo/mirrors
GET  /repos/:namespace/:repo/statuses/:sha
GET  /runs/:run-id
```

These are convenience/policy endpoints over existing Cloudflare primitives, not a second repository database.

## What not to build

Do not build any of these for MVP:

- custom Git object storage
- custom refs database
- custom packfile parser
- `git-upload-pack`
- `git-receive-pack`
- SSH Git transport
- GitHub Actions clone
- package registry
- wiki
- project boards
- social feed
- generalized issue tracker

## Minimal review model

Gitflare may eventually need a change/review object for deployments that do not use GitHub PRs.

Keep it Git-shaped:

```text
change
  source_ref
  target_ref
  source_sha
  target_sha
  status
  review_state
  checks[]
```

The review object never owns source history. It points at Artifacts refs and commits.

## After MVP

Once the SCUMM3 dogfood path is proven:

1. make the GitHub mirror optional
2. support direct Artifacts-native developer/agent pushes
3. add provider-neutral status projection
4. add a minimal review/change UI only if the workflow requires it
5. add durable CI evidence indexing
6. extract the SCUMM3-specific CI profile into reusable Gitflare conventions

## Definition of done

Gitflare MVP is done when a developer can use ordinary Git, an agent can receive a short-lived repository credential, Cloudflare can validate the resulting revision, and a human can see whether it is safe — without Gitflare owning a Git implementation or CI runner fleet.
