# Security Policy

## Reporting a vulnerability

Do not open a public GitHub issue for security reports.

Email Rob McConnell via the address on [GitHub](https://github.com/mcc0nnell) or open a private GitHub security advisory on this repository.

Please include:

- a description of the issue
- affected endpoints, refs, or object paths if known
- steps to reproduce
- impact (auth bypass, ref mutation, object substitution, data disclosure)

## In scope

Once implementation exists, the following are in scope:

- authentication and authorization around Git HTTP and repository APIs
- ref mutation races and compare-and-swap failures
- object substitution or content-address mismatch
- pack/object graph validation gaps
- cross-repository access through storage keys or Durable Object names
- injection through ref names, object ids, or repository names

## Out of scope

- social-engineering of Cloudflare or GitHub account credentials
- denial of service against the public Cloudflare edge in general
- issues that require already-compromised Worker bindings or account tokens

## Notes

Git objects and artifacts are intended to be immutable.
Ref updates are intended to be serialized per repository.
A bug that lets a client mutate an object in place, or win a ref race without CAS, is a security bug even if authentication otherwise works.
