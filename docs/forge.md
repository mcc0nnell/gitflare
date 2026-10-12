# Gitflare Forge: isolated agents and signed review gate

This slice separates **source**, **untrusted agents**, **trusted validation**, **human review**, and **integration**. A successful receipt is **not a merge**.

## Artifacts agent workspaces

Authenticated administrators may create a task-specific fork:

    POST /repos/:repo/forks
    Authorization: Bearer <GITFLARE_ADMIN_TOKEN>
    Content-Type: application/json

    {"label":"parser fix"}

The response includes a separate remote and, when returned by Artifacts, an initial token. Treat that token as a secret. Do not log or store it in browser analytics. Forks are not merged automatically.

The existing Gitflare administrator token is too broad for a multi-user collaboration console. Before opening the route to regular users, implement server-side identity, per-repository authorization, quotas, and narrowly scoped credentials.

## Local review gate

The credential-free gate runs against a complete local Git clone. It uses the actual Git merge engine (git merge-tree --write-tree) without pushing or moving target refs.

    node scripts/forge-gate.mjs \
      --repo /work/checkout \
      --base "$BASE_SHA" \
      --target "$TARGET_SHA" \
      --candidate "$CANDIDATE_SHA" \
      --target-ref refs/remotes/origin/main \
      --checks /trusted-evidence/checks.json \
      --trusted-key /etc/gitflare/trusted-ci-ed25519.pub.pem \
      --evidence-dir /trusted-evidence \
      --issuer gitflare-ci \
      --require-check tests \
      --out /trusted-evidence/review.json

The PEM is a trusted public key provisioned **outside the candidate source tree**.
The corresponding Ed25519 private key belongs exclusively to independent validation,
never to a coding agent, checkout or browser.

The signed JSON envelope:

    {
      "schemaVersion": 2,
      "issuer": "gitflare-ci",
      "baseSha": "<40 lowercase hex>",
      "targetSha": "<40 lowercase hex>",
      "subjectSha": "<40 lowercase hex>",
      "checks": [{"id":"tests","status":"PASS","evidenceSha256":"<64 lowercase hex>"}],
      "signature": "<base64 Ed25519 signature>"
    }

Sign the bytes returned by the exported canonicalAttestation(envelope) helper, before adding the signature. Canonicalization sorts checks and serializes only fixed identity/check fields. The trusted validation runner must calculate evidence file SHA-256 hashes before signing.

The gate validates signature, issuer, exact commit identities, required checks, evidence file bytes, ancestry, target snapshot, and actual merge result. It does **not** independently prove the process that produced the signed results ran in an isolated environment, or verify remote Cloudflare ref authority. Those remain trusted-runner/source-provider obligations.

The receipt returns READY_FOR_HUMAN_REVIEW (exit 0) or BLOCKED (exit 2). Malformed CLI usage exits 1. Receipt SHA-256 is a checksum, not a signature.

## Independently observed Git checks

The fixed-check producer uses `git fsck --connectivity-only --no-reflogs` and
`git diff --no-ext-diff --no-textconv --check` against the exact base and
candidate SHAs. It never executes agent-supplied scripts, npm lifecycle hooks,
or shell snippets. An operator creates a 0600 Ed25519 private key **outside**
the untrusted checkout and runs:

    npm run forge:prove -- \
      --repo /work/checkout \
      --base "$BASE_SHA" --target "$TARGET_SHA" --candidate "$CANDIDATE_SHA" \
      --issuer gitflare-ci --private-key /operator/ci-ed25519.pem \
      --evidence-dir /operator/evidence/new-run

The evidence directory must not already exist, and the signer creates private
log files and an attestation there. Each check status comes from the actual
Git command exit code. The review gate now **rehashes actual evidence files**
(`<check-id>.log`) and rejects modified bytes, missing files, symlinks, and
candidate-controlled evidence paths. Missing required checks always BLOCK.

This producer proves only **fixed Git integrity/diff checks**. It does **not**
replace independent, sandboxed application-test execution. Only deploy the
producer from a separately trusted revision and keep signing keys inaccessible
to untrusted test processes. Do not claim that a test was run merely because
an agent supplied a PASS string.

## Read-only remote drift preflight

    npm run forge:preflight -- \
      --repo /work/checkout --receipt /operator/evidence/review.json \
      --remote "$ARTIFACTS_REMOTE" --remote-ref refs/heads/main \
      --review-ref refs/remotes/origin/main

This reads the currently published Git ref with `git ls-remote`, checks the
operator-stored review receipt's checksum, and returns `TARGET_UNCHANGED` or
`BLOCKED`. The checksum is **not** an authenticity signature; the receipt path
must be operator-controlled, and the approved review must still be bound to
independently verified evidence. This check is not a lease: a real integration
must use a last-moment expected-ref condition and verify the resulting remote
commit after the push. Gitflare does not yet provide that write path.

## Production integration remains a separate trust boundary

1. Validate the exact candidate commit in a clean, isolated runner.
2. Have the trusted runner measure evidence digests and sign the attestation.
3. Re-read the live target ref after human approval and reject changed targets.
4. Integrate only via an authorized non-forced push with expected-ref checking.
5. Read the remote ref again and verify the resulting commit SHA.
6. Publish evidence and receipts to independent storage.
7. Project authenticated, replay-safe events to the console.

There is deliberately **no automatic merge or deployment endpoint** in this slice.

## Local verification

    npm run typecheck
    npm run test:forge
    npm run check

The last command also uses Wrangler dry-run and requires dependencies installed. The package pins Wrangler 4.149.0. Use `npm run dev` for local Worker execution with an explicitly remote Artifacts binding; it does not require the legacy `--remote` flag. Put the local administrator token in an ignored `.dev.vars` file. All Artifacts binding operations still address the real Cloudflare namespace.

## Remaining acceptance work

Create three real Artifacts forks, validate unrelated and conflicting changes with independent signatures, display events in the ANSI console, then verify integration under target-ref races. This has not been exercised against a live Cloudflare account; Workers Paid/Artifacts access and operator credentials are required.
