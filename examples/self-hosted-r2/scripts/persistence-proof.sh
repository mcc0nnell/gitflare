#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:?set BASE_URL, e.g. https://git.example.com}"
: "${GITFLARE_GIT_TOKEN:?set GITFLARE_GIT_TOKEN}"
: "${GITFLARE_ADMIN_TOKEN:?set GITFLARE_ADMIN_TOKEN}"

OWNER="${OWNER:-gitflare-proof}"
REPO="${REPO:-restart-proof-$(date +%s)}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

REMOTE="${BASE_URL%/}/${OWNER}/${REPO}.git"
AUTH_REMOTE="${BASE_URL%/}/${OWNER}/${REPO}.git"

mkdir "$ROOT/source"
git -C "$ROOT/source" init -q -b main
git -C "$ROOT/source" config user.email gitflare-proof@example.invalid
git -C "$ROOT/source" config user.name "Gitflare persistence proof"
printf 'gitflare persistence proof\n' > "$ROOT/source/proof.txt"
git -C "$ROOT/source" add proof.txt
git -C "$ROOT/source" commit -q -m "prove repo persistence"
EXPECTED_SHA="$(git -C "$ROOT/source" rev-parse HEAD)"

git -C "$ROOT/source" remote add origin "$AUTH_REMOTE"
GIT_TERMINAL_PROMPT=0 git -c "http.extraHeader=Authorization: Basic $(printf 'git:%s' "$GITFLARE_GIT_TOKEN" | base64 | tr -d '\n')" \
  -C "$ROOT/source" push -q origin main

STATE_URL="${BASE_URL%/}/_gitflare/repos/${OWNER}/${REPO}/state"
RESTART_URL="${BASE_URL%/}/_gitflare/repos/${OWNER}/${REPO}/restart"

STATE_BEFORE="$(curl -fsS -H "Authorization: Bearer $GITFLARE_ADMIN_TOKEN" "$STATE_URL")"
GEN_BEFORE="$(printf '%s' "$STATE_BEFORE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["generation"])')"
HEAD_BEFORE="$(printf '%s' "$STATE_BEFORE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["head_sha"] or "")')"

if [[ "$GEN_BEFORE" -lt 1 ]]; then
  echo "expected committed generation >= 1, got $GEN_BEFORE" >&2
  exit 1
fi
if [[ "$HEAD_BEFORE" != "$EXPECTED_SHA" ]]; then
  echo "checkpoint HEAD mismatch before restart: expected $EXPECTED_SHA got $HEAD_BEFORE" >&2
  exit 1
fi

curl -fsS -X POST -H "Authorization: Bearer $GITFLARE_ADMIN_TOKEN" "$RESTART_URL" >/dev/null

GIT_TERMINAL_PROMPT=0 git -c "http.extraHeader=Authorization: Basic $(printf 'git:%s' "$GITFLARE_GIT_TOKEN" | base64 | tr -d '\n')" \
  clone -q "$REMOTE" "$ROOT/restored"
RESTORED_SHA="$(git -C "$ROOT/restored" rev-parse HEAD)"
git -C "$ROOT/restored" fsck --no-reflogs --connectivity-only >/dev/null

STATE_AFTER="$(curl -fsS -H "Authorization: Bearer $GITFLARE_ADMIN_TOKEN" "$STATE_URL")"
GEN_AFTER="$(printf '%s' "$STATE_AFTER" | python3 -c 'import json,sys; print(json.load(sys.stdin)["generation"])')"

if [[ "$RESTORED_SHA" != "$EXPECTED_SHA" ]]; then
  echo "restored SHA mismatch: expected $EXPECTED_SHA got $RESTORED_SHA" >&2
  exit 1
fi
if [[ "$GEN_AFTER" != "$GEN_BEFORE" ]]; then
  echo "restart unexpectedly changed committed generation: before $GEN_BEFORE after $GEN_AFTER" >&2
  exit 1
fi

printf 'PASS repo=%s/%s generation=%s sha=%s\n' "$OWNER" "$REPO" "$GEN_AFTER" "$RESTORED_SHA"
