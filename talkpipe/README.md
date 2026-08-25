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

## FireCrab release-compliance preflight

When the Artifacts repository is named `firecrab`, Gitflare selects the `release-compliance-preflight` profile after the normal `verify-source` boundary. The profile itself is versioned in FireCrab as `scripts/gitflare-release-compliance.sh`; Gitflare does not carry FireCrab's compliance policy.

```bash
python talkpipe/ci_mcp.py ci_run_start \
  '{"repo":"firecrab","sha":"<exact-firecrab-sha>","ref":"refs/heads/<branch>"}'
```

The preflight deliberately has no cross-run CI cache. It verifies the exact checked-out object ID, refuses a dirty checkout, runs the Python compliance tests with `PYTHONOPTIMIZE=1`, runs the M2Image and host-package contracts, rebuilds Cargo/npm dependency state in per-run scratch directories, regenerates the release license inventory with `--deny-incompatible`, and emits a hash-bound receipt bundle at `dist/gitflare-receipts.tar.gz` in the successful runner snapshot.

The successful profile discards its Cargo/npm scratch state before the final snapshot. The retained snapshot is evidence, not a dependency cache.

## Inspect, retry, or cancel

```bash
python talkpipe/ci_mcp.py ci_run_status '{"id":"ci-..."}'
python talkpipe/ci_mcp.py ci_run_retry '{"id":"ci-..."}'
python talkpipe/ci_mcp.py ci_run_retry '{"id":"ci-...","fromStep":"verify-source"}'
python talkpipe/ci_mcp.py ci_run_cancel '{"id":"ci-...","rollback":false}'
```

The MCP endpoint uses the stateless `2026-07-28` protocol shape and the official `@modelcontextprotocol/server` Worker-compatible server package. The bearer token protects the entire `/mcp` surface.
