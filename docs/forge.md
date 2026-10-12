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

The gate validates signature, issuer, exact commit identities, required checks, ancestry, target snapshot, and actual merge result. It does **not** fetch or rehash the external evidence blobs, independently prove that tests were run, or verify remote Cloudflare ref authority. Those remain trusted-runner/source-provider obligations.

The receipt returns READY_FOR_HUMAN_REVIEW (exit 0) or BLOCKED (exit 2). Malformed CLI usage exits 1. Receipt SHA-256 is a checksum, not a signature.

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

The last command also uses Wrangler dry-run and requires dependencies installed. The package pins Wrangler 4.145.0, the documented minimum for generated Artifacts types and some remote-binding methods.

## Remaining acceptance work

Create three real Artifacts forks, validate unrelated and conflicting changes with independent signatures, display events in the ANSI console, then verify integration under target-ref races. This has not been exercised against a live Cloudflare account; Workers Paid/Artifacts access and operator credentials are required.
