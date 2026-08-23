# Source

This directory is intentionally empty of application code.

The first commit establishes the architecture and product contract, not a generated Worker or Git protocol stack.

The first implementation that belongs here is the spike in [docs/mvp.md](../docs/mvp.md):

- repository records
- immutable object storage
- ref model
- repository coordinator (compare-and-swap)

Do not add `git upload-pack` / `git receive-pack` until those primitives are proven.
Do not add GitHub Actions or a large framework to fill this directory.
