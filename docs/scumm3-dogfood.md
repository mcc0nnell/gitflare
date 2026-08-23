# SCUMM3 dogfood

SCUMM3 is the first production-shaped Gitflare consumer.

The purpose of the dogfood is not to move human collaboration away from GitHub immediately. It is to prove that GitHub can become optional to the machine path.

## Initial topology

```text
GitHub
human collaboration / PRs / discovery
      |
      | verified Git mirror
      v
Cloudflare Artifacts
scumm3-gitflare/scumm3
      |
      | cf.artifacts.repo.pushed
      v
Cloudflare CI Workflow
      |
      v
Sandbox / Containers
      |
      +--> validation
      +--> evidence
      +--> check/status
      +--> trusted deployment
```

## Stage 1 — mirror proof

- mirror branches, tags, and notes where present
- use short-lived repo-scoped write credentials
- verify the Artifacts `main` SHA equals the source `main` SHA
- revoke the write credential after the mirror

GitHub remains canonical for human contribution during this stage.

## Stage 2 — Artifacts-native CI proof

- bind the CI system to the Artifacts repository
- trigger from `cf.artifacts.repo.pushed`
- check out the exact pushed revision
- run the same validation policy already proven by SCUMM3 Cloudflare CI
- persist evidence outside the repository

A GitHub-hosted runner must not be required to execute validation.

## Stage 3 — status projection

Project the result back to the surface the human is using.

For GitHub dogfood this means the user still sees a normal check/status on the relevant revision or change while the work itself ran on Cloudflare.

The status is a projection of Cloudflare execution, not proof that GitHub executed the job.

## Stage 4 — deployment

A trusted validated `main` revision may enter the production deployment path.

The production credential is not available to pull-request or other untrusted execution.

## Stage 5 — remove the mirror dependency

Once direct Artifacts workflows are comfortable:

- allow direct developer/agent pushes to the Artifacts repository
- make GitHub mirroring optional
- retain GitHub as a social/collaboration surface where useful
- prove the CI engine does not care which provider supplied the revision

## Success condition

Gitflare is proven by SCUMM3 when this statement is true:

> Humans can keep using GitHub because they want to, not because the build and deployment machinery requires it.
