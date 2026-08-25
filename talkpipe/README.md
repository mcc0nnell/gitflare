# TalkPipe operator flow

Gitflare keeps MCP as an adapter over the CI control plane. TalkPipe is the orchestration layer used by agents and operators to drive that adapter.

`ci_mcp.py` registers a `gitflareMcpCall` ChatterLang segment and executes the selected MCP tool through a compiled TalkPipe pipeline.

## Setup

```bash
python -m pip install talkpipe
export GITFLARE_CI_MCP_URL="https://<gitflare-ci-worker>/mcp"
export GITFLARE_CI_MCP_TOKEN="<secret>"
```

Configure the Worker secret separately:

```bash
cd examples/artifacts-push-workflow
npx wrangler secret put GITFLARE_CI_MCP_TOKEN
```

## Start a run

```bash
python talkpipe/ci_mcp.py ci_run_start \
  '{"repo":"scumm3","sha":"<commit-sha>","ref":"refs/heads/main"}'
```

The start operation is source-idempotent. A push-triggered run and an MCP-triggered run for the same Artifacts repository and commit resolve to the same Cloudflare Workflow instance ID.

## FireCrab release assurance

When the Artifacts repository is named `firecrab`, Gitflare selects the project-owned `release-compliance-preflight` after the normal `verify-source` boundary. The executable policy is versioned with FireCrab; Gitflare does not carry FireCrab's compliance matrix.

```bash
python talkpipe/ci_mcp.py ci_run_start \
  '{"repo":"firecrab","sha":"<exact-firecrab-sha>","ref":"refs/heads/<branch>"}'
```

The preflight deliberately has no cross-run CI cache. It verifies the exact checked-out object ID, refuses a dirty checkout, runs the Python compliance tests with `PYTHONOPTIMIZE=1`, runs the M2Image and host-package contracts, rebuilds Cargo/npm dependency state in per-run scratch directories, regenerates the release license inventory with `--deny-incompatible`, and emits a hash-bound receipt bundle.

The receipt also contains `assurance-plan.json`, expanded from FireCrab's versioned profile and M2Image manifest. Gitflare persists that plan under the exact repository/SHA after a successful preflight. TalkPipe can retrieve it without knowing FireCrab's matrix:

```bash
python talkpipe/ci_mcp.py ci_assurance_plan \
  '{"repo":"firecrab","sha":"<exact-firecrab-sha>"}'
```

For the current FireCrab profile the plan contains twelve jobs: one sandbox preflight, six native/root M2Image + corresponding-source cells, four native host-release cells, and one evidence aggregator. The ten native jobs declare their architecture, privilege/network requirements, expected evidence path, and dependency on the preflight.

A native executor must honor each job's `constraints` and use a disposable checkout of the same SHA. A missing runner capability is represented by the project's `BLOCKED` result; it is not converted into PASS and should not be confused with a FireCrab test failure. Once all native result documents are collected, the aggregate job emits the source-bound `PASS`, `FAIL`, or `BLOCKED` assurance verdict.

The successful preflight discards its Cargo/npm scratch state before the final snapshot. The retained snapshot is evidence, not a dependency cache.

## Inspect, retrieve, retry, or cancel

```bash
python talkpipe/ci_mcp.py ci_run_status '{"id":"ci-..."}'
python talkpipe/ci_mcp.py ci_assurance_plan '{"repo":"firecrab","sha":"<commit-sha>"}'
python talkpipe/ci_mcp.py ci_run_retry '{"id":"ci-..."}'
python talkpipe/ci_mcp.py ci_run_retry '{"id":"ci-...","fromStep":"verify-source"}'
python talkpipe/ci_mcp.py ci_run_cancel '{"id":"ci-...","rollback":false}'
```

The MCP endpoint uses the stateless `2026-07-28` protocol shape and the official `@modelcontextprotocol/server` Worker-compatible server package. The bearer token protects the entire `/mcp` surface.
