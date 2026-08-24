# CI MCP architecture

Gitflare treats MCP as an **adapter over CI**, not as the CI engine itself.

The source of truth remains normal Git plus Cloudflare-native events and Workflows:

```text
Git push / tag
      |
      v
Cloudflare Artifacts
      |
      v
cf.artifacts.repo.pushed
      |
      v
@cloudflare/ci Workflow
```

Agents reach that same control plane through a stateless MCP endpoint:

```text
Atlas / Shell / TalkPipe / agents
              |
              v
          POST /mcp
              |
              v
       MCP tool adapter
              |
              v
       CI_WORKFLOW binding
```

If every MCP client is offline, push-triggered CI must still function normally.

## First tool contract

The initial surface is intentionally narrow:

| Tool | Effect |
| --- | --- |
| `ci_run_start` | Start the CI Workflow for an Artifacts repository, commit and full Git ref. |
| `ci_run_status` | Read the status of a known Workflow instance. |
| `ci_run_retry` | Restart a known Workflow, optionally from a durable step occurrence. |
| `ci_run_cancel` | Terminate a known Workflow, optionally running rollback handlers. |

Run discovery, logs, artifacts, checks and deployment promotion are deliberately deferred until they can be backed by authoritative Cloudflare APIs rather than local shadow state.

## Run identity

`@cloudflare/ci` derives a deterministic Workflow ID from:

```text
provider + owner + repo + sha
```

The MCP adapter follows the same compatibility contract. For Gitflare Artifacts runs:

```text
provider = cloudflare-artifacts
owner    = gitflare
repo     = <Artifacts repository>
sha      = <commit object id>
```

This gives a critical invariant:

> Starting CI through MCP for a source revision that already entered through a repository push resolves to the same Workflow identity instead of creating a duplicate run.

The compatibility implementation is intentionally local today because `@cloudflare/ci` 0.1.0 does not export its internal run-ID helper. Replace it with the upstream helper if that helper becomes public.

## Authentication and authority

The `/mcp` route is protected by a dedicated Worker secret, `GITFLARE_CI_MCP_TOKEN`.

The token is separate from repository credentials and Cloudflare deployment credentials. MCP clients never receive Artifacts checkout tokens, Sandbox credentials, R2 credentials or Cloudflare API credentials through this interface.

Before authentication, the Worker also validates the request `Host` against `GITFLARE_CI_MCP_HOST`. The initial surface is deliberately non-browser: any request carrying an `Origin` header is rejected. This follows the MCP SDK requirement that bare fetch runtimes put Host/Origin validation in front of `createMcpHandler` instead of assuming the handler performs those checks.

Tool authority is also intentionally smaller than arbitrary Workflow or shell execution:

- an agent cannot supply a shell command;
- an agent cannot choose a different Artifacts namespace;
- an agent cannot inject secrets into a runner;
- an agent cannot create an alternative pipeline definition;
- cancellation is explicitly marked destructive in MCP tool annotations.

Interactive browser clients can be added later with an explicit trusted-origin allowlist instead of reflected or wildcard CORS.

## TalkPipe role

TalkPipe is the reference orchestration spine, not a replacement MCP implementation.

`talkpipe/ci_mcp.py` registers a `gitflareMcpCall` ChatterLang segment. A TalkPipe pipeline supplies JSON arguments to the segment, the segment performs one MCP exchange, and the MCP server translates the operation into the Cloudflare Workflow binding.

```text
ChatterLang
    |
    v
TalkPipe pipeline
    |
    v
gitflareMcpCall
    |
    v
Gitflare /mcp
    |
    v
Cloudflare Workflow
```

This keeps orchestration composable while preserving the MCP wire protocol as the stable boundary between agents and CI.

## Next slices

The next useful additions should be read-heavy before they are write-heavy:

1. `ci_runs_list` backed by the authoritative Cloudflare Workflows API.
2. `ci_run_logs` with bounded output and per-run authorization.
3. `ci_artifacts_list` and artifact metadata without exposing storage credentials.
4. commit/check status resources so Atlas can render CI state without provider-specific knowledge.
5. deployment preview/promote tools only after policy and approval semantics are explicit.

Do not add a Gitflare-only run database merely to satisfy MCP. If a capability cannot be answered from the CI control plane or durable CI evidence, add that evidence at the CI layer first and expose it second.
