# MVP

The first vertical slice is a usable Git control plane on Cloudflare, not a forge and not a CI product.

## Capabilities

1. create repository
2. list repositories
3. store Git objects
4. read refs
5. create/update refs
6. branches
7. tags
8. clone
9. fetch
10. push
11. authentication
12. repository event emission
13. commit/check status
14. minimal change/review object
15. build trigger

Capabilities 1–5, without Git HTTP, are the first engineering spike.
Capabilities 6–15 complete the MVP after that spike is sound.

## Target demonstration

```bash
git clone https://git.scumm.app/mcc0nnell/demo.git
cd demo
git checkout -b feat/hello
echo "hello gitflare" > hello.txt
git add hello.txt
git commit -m "hello gitflare"
git push origin feat/hello
```

Gitflare should eventually process that as:

```text
receive push
    ↓
authenticate
    ↓
receive Git objects
    ↓
validate object graph
    ↓
coordinate ref mutation
    ↓
atomically update branch ref
    ↓
record push event
    ↓
trigger Cloudflare Workflow
    ↓
launch build environment
    ↓
report commit status
```

The SCM server stops being interesting after the event is recorded.
The Workflow and Container do the work.
The status API is how the work reports back.

## First engineering spike

Do not attempt the whole Git protocol in the first implementation.

Preferred slice:

```text
Repository
+
ref model
+
immutable object storage
+
repository coordinator
```

Prove:

- create repo
- write object
- read object
- create ref
- compare-and-swap ref
- read ref

before implementing Git smart HTTP.

### What "proven" means

A Worker, a D1 catalog, an R2 object bucket, and one Durable Object per repository that can:

- insert a repository row
- put bytes to `repos/<repo-id>/objects/<object-id>` only if the id matches the content address
- refuse a second put of different bytes for the same id
- create `refs/heads/main`
- CAS that ref from SHA A to SHA B and fail if the stored value is not A
- read the ref back

No generated app framework.
No GitHub Actions.
No `upload-pack` until those six operations are real.

### After the spike

Proceed toward:

1. auth in front of the same primitives
2. Container-backed `git receive-pack` / `git upload-pack`
3. branch and tag ref conventions
4. clone / fetch / push with a normal Git client
5. push event → Cloudflare Workflow → Container build → status
6. a minimal change/review object pointing at ref movement, not a GitHub-clone PR product

## Out of MVP

- SHA-256 repository creation (schema should not preclude it)
- thin packs, delta reuse policy, partial clone
- SSH
- merge queues, CODEOWNERS, protected-branch policy engines beyond simple CAS
- issue tracker, wiki, packages, project boards
- GitHub Actions or any in-process CI orchestrator
