# Self-hosted Gitflare: RepoContainer + R2

This example is the self-hosted source-plane fallback for Gitflare when Cloudflare Artifacts is unavailable or when an operator wants to own the Git substrate.

It deliberately does **not** mount R2 as Git's live filesystem.

```text
normal Git client
      |
      | smart HTTP
      v
Worker auth + routing
      |
      | one stable name per owner/repo
      v
RepoContainer
Durable Object + Cloudflare Container
      |
      +-- DO SQLite
      |     repo identity
      |     committed generation
      |     checkpoint key / ETag
      |     HEAD
      |     clean | mutating phase
      |
      +-- Container local disk
            /data/repo.git
            real git-http-backend
            real POSIX filesystem
      |
      | completed checkpoint only
      v
R2
repos/<repo>/generations/<n>.tar.gz
```

## Why the DO exists

The Durable Object is the **repository coordinator**, not the repository disk.

Every `owner/repo` routes to one named `RepoContainer`. That gives the repository one logical place to serialize state transitions while still using ordinary Git inside the Linux container.

The `RepoContainer` class extends Cloudflare's `Container` class, which itself is a Durable Object. There is no extra DO hop.

## Persistence protocol

Reads operate against `/data/repo.git` on local container disk.

A push follows a stricter protocol:

1. restore the last committed generation if this is a fresh container
2. persist `phase = mutating` in DO SQLite
3. run ordinary `git receive-pack`
4. run `git fsck --no-reflogs --connectivity-only`
5. export the completed bare repository as a gzip tar stream
6. stream that checkpoint into R2
7. atomically advance the DO's committed generation and checkpoint pointer
8. only then return the Git push response

If the Worker, DO, or Container dies after step 2 but before step 7, the durable phase remains `mutating`. The next request discards the unacknowledged local state and restores the last committed R2 generation.

If R2 receives a checkpoint but the DO never commits its pointer, that object is an orphan and is never treated as authoritative.

## Container restart detection

The Git container generates a random boot ID at process start. The DO caches the boot ID and committed generation only in memory.

A different boot ID means the local disk is not trusted yet, so the DO restores the current committed R2 checkpoint before serving Git.

## Bootstrap

Create the R2 bucket:

```bash
npx wrangler r2 bucket create gitflare-repo-backups
```

Install dependencies and configure two Worker secrets:

```bash
npm install
npx wrangler secret put GITFLARE_GIT_TOKEN
npx wrangler secret put GITFLARE_ADMIN_TOKEN
npm run check
npm run deploy
```

`GITFLARE_GIT_TOKEN` is the temporary v0 repository credential. Git can send it as the Basic-auth password. `GITFLARE_ADMIN_TOKEN` protects introspection and forced-restart routes.

## Normal Git

Assuming the Worker is deployed at `git.example.com`:

```bash
export GITFLARE_GIT_TOKEN='...'

git clone https://git:${GITFLARE_GIT_TOKEN}@git.example.com/mcc0nnell/demo.git
cd demo
echo 'hello gitflare' > hello.txt
git add hello.txt
git commit -m 'hello gitflare'
git push origin main
```

There is no Gitflare-specific transport or client.

## Persistence proof

After a successful push, inspect the committed generation:

```bash
curl \
  -H "Authorization: Bearer $GITFLARE_ADMIN_TOKEN" \
  https://git.example.com/_gitflare/repos/mcc0nnell/demo/state
```

Then deliberately destroy that repository's container:

```bash
curl -X POST \
  -H "Authorization: Bearer $GITFLARE_ADMIN_TOKEN" \
  https://git.example.com/_gitflare/repos/mcc0nnell/demo/restart
```

Clone again. The next request starts a fresh container, observes a new boot ID, restores the R2 checkpoint, validates it, and serves the same committed Git history.

The acceptance test is:

```text
push SHA A
  -> generation N committed to R2
  -> destroy Container
  -> fresh Container
  -> restore generation N
  -> git clone
  -> HEAD / refs still contain SHA A
  -> git fsck passes
```

The repository includes the same test as an executable script:

```bash
BASE_URL=https://git.example.com \
GITFLARE_GIT_TOKEN=... \
GITFLARE_ADMIN_TOKEN=... \
npm run proof:persistence
```

## Current v0 boundaries

This is a correctness-first vertical slice, not the final storage format.

- one full gzip checkpoint per acknowledged push
- a v0 checkpoint uses one R2 `put`, so a checkpoint must remain within R2's single-upload object limit; multipart/incremental checkpoints are a later step
- all control operations for a repository are serialized by its DO
- reads use standard Git smart HTTP
- Git runs only on local POSIX disk
- R2 is never mounted as the live repository filesystem
- snapshots stream between Container and R2 through the DO; they are not intentionally buffered in Worker memory
- auth is a bootstrap static secret, not the final repo-scoped credential model

Likely follow-ups are incremental pack/checkpoint storage, garbage collection of orphan/old generations, repo-scoped short-lived credentials, push events, and a provider adapter matching the Artifacts backend.
