#!/usr/bin/env bash
# Releases: keep what is running now, change to something else, and go back to it.
#
#   scripts/release.sh record [--tag NAME]        keep the running release
#   scripts/release.sh list                       what is kept
#   scripts/release.sh update --to REV [--tag N]  record, then move the workspace to REV and rebuild
#   scripts/release.sh rollback --to TAG          put a kept release back (operator-run)
#
# A release is NOT an image tag. OPERATIONS.md §3: Claude, Conductor and the Preloop CLI live in
# /home/agent, which is a volume that masks the image's copy — so replacing the image does not
# change what actually runs. A release here is therefore
#
#   code revision + image ids (kept under a release tag) + configuration + the toolchain itself.
#
# Data is not part of a release: logins, the Preloop database, MLflow and run history stay where
# they are, and must survive both an update and a rollback. scripts/backup.sh covers those.
set -euo pipefail
export MSYS_NO_PATHCONV=1
u() { if command -v cygpath >/dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
m() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HERE/config/instance.env" ] && . "$HERE/config/instance.env"
STACK="${STACK:-cadp278}"
AGENT="$STACK-agent"
RELEASES="${RELEASE_DIR:-$HOME/cadp-releases}"
RELEASESU="$(u "$RELEASES")"; RELEASES="$(m "$RELEASESU")"
# services of this stack (the agent and the observer share one image)
SERVICES="agent mlflow toolsvc fsmcp egress ops hub"

say()  { printf '  %-42s %s\n' "$1" "$2"; }
fail() { echo "release: $*" >&2; exit 1; }

CMD="${1:-}"; shift || true
TAG=""; TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --to) TO="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

tool() { docker exec "$AGENT" sh -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
image_ref() {  # service → the image reference this instance runs
  docker inspect -f '{{.Config.Image}}' "$STACK-$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------- record
cmd_record() {
  docker inspect "$AGENT" >/dev/null 2>&1 || fail "no container $AGENT"
  docker start "$AGENT" >/dev/null 2>&1 || true
  for i in $(seq 1 15); do docker exec "$AGENT" true >/dev/null 2>&1 && break; sleep 1; done
  REV="$(git -C "$(m "$HERE")" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  DIRTY="$(git -C "$(m "$HERE")" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
  [ -n "$TAG" ] || TAG="$(date -u +%Y%m%d-%H%M%S)-$REV"
  DEST="$RELEASESU/$TAG"
  [ -e "$DEST" ] && fail "release $TAG already exists"
  mkdir -p "$DEST"
  echo "== recording release $TAG"
  say "workspace revision" "$REV$([ "$DIRTY" = 0 ] || echo " (+$DIRTY uncommitted files)")"

  # images: give the running ones a name of their own, so a later rebuild of :local cannot take
  # them away (an untagged image is a candidate for pruning)
  : > "$DEST/images.txt"
  for s in $SERVICES; do
    ref="$(image_ref "$s")"; [ -n "$ref" ] || continue
    id="$(docker inspect -f '{{.Image}}' "$STACK-$s")"
    keep="${ref%%:*}:rel-$TAG"
    docker tag "$id" "$keep"
    echo "$s $ref $id $keep" >> "$DEST/images.txt"
    say "image $s" "$keep"
  done

  # the toolchain, from the volume where it actually lives
  docker run --rm -v "$STACK-agent-home:/v:ro" -v "$(m "$DEST"):/out" alpine \
    tar czf /out/toolchain.tar.gz -C /v .local
  say "toolchain" "$(du -h "$DEST/toolchain.tar.gz" | cut -f1) (/home/agent/.local)"

  tar czf "$DEST/config.tar.gz" -C "$HERE" config policy docker/.env 2>/dev/null || \
    tar czf "$DEST/config.tar.gz" -C "$HERE" config policy
  say "configuration" "$(du -h "$DEST/config.tar.gz" | cut -f1)"

  {
    echo "tag=$TAG"
    echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "workspace_revision=$REV"
    echo "workspace_dirty_files=$DIRTY"
    echo "stack=$STACK"
    echo "tool.claude=$(tool 'claude --version')"
    echo "tool.conductor=$(tool 'conductor --version')"
    echo "tool.preloop_cli=$(tool 'preloop version')"
    echo "tool.codex=$(tool 'codex --version')"
    echo "tool.grok=$(tool 'grok --version')"
    echo "tool.node=$(tool 'node -v')"
  } > "$DEST/release.kv"
  for t in claude conductor preloop_cli codex grok node; do
    grep -q "^tool.$t=." "$DEST/release.kv" || fail "could not read the $t version from $AGENT"
  done
  sed -n 's/^tool\.//p' "$DEST/release.kv" | sed 's/^/  /' | sed 's/=/ /' | while read -r k v; do say "$k" "$v"; done
  echo
  echo "kept in $RELEASES/$TAG"
}

# ---------------------------------------------------------------------------- list
cmd_list() {
  [ -d "$RELEASESU" ] || { echo "no releases kept yet ($RELEASES)"; return 0; }
  printf '%-28s %-10s %-22s %s\n' TAG REVISION RECORDED TOOLS
  for d in "$RELEASESU"/*/; do
    [ -f "$d/release.kv" ] || continue
    t="$(basename "$d")"
    printf '%-28s %-10s %-22s %s\n' "$t" \
      "$(sed -n 's/^workspace_revision=//p' "$d/release.kv")" \
      "$(sed -n 's/^recorded_at=//p' "$d/release.kv")" \
      "claude $(sed -n 's/^tool.claude=//p' "$d/release.kv" | cut -d' ' -f1), conductor $(sed -n 's/^tool.conductor=//p' "$d/release.kv" | cut -d' ' -f2)"
  done
}

# ---------------------------------------------------------------------------- update
# Only tracked files block a change of revision: a checkout would overwrite those. Run evidence
# and other data that lives in the workspace is untracked and is not a reason to refuse.
cmd_update() {
  [ -n "$TO" ] || fail "update needs --to REVISION"
  git -C "$(m "$HERE")" rev-parse --verify --quiet "$TO" >/dev/null || fail "unknown revision $TO"
  [ -z "$(git -C "$(m "$HERE")" status --porcelain --untracked-files=no)" ] || \
    fail "the workspace has uncommitted changes to tracked files — commit or stash them first"
  echo "== keeping the release in use before changing anything"
  ( TAG=""; cmd_record )
  echo
  echo "== moving the workspace to $TO"
  git -C "$(m "$HERE")" checkout --quiet "$TO"
  say "now at" "$(git -C "$(m "$HERE")" rev-parse --short HEAD)"
  echo "== rebuilding images"
  (cd "$HERE/docker" && docker compose -f compose.poc.yaml build) || fail "the build failed; nothing was recreated"
  echo "== starting and checking"
  if (cd "$HERE" && bash scripts/up.sh --recreate); then
    echo
    echo "update done. If it misbehaves, go back with:"
    echo "  scripts/release.sh rollback --to <tag>   (scripts/release.sh list)"
  else
    echo
    echo "the checks did not pass after the update. Go back with:" >&2
    echo "  scripts/release.sh rollback --to <tag>   (scripts/release.sh list)" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------- rollback
cmd_rollback() {
  [ -n "$TO" ] || fail "rollback needs --to TAG"
  SRC="$RELEASESU/$TO"
  [ -f "$SRC/release.kv" ] || fail "no release $TO in $RELEASES"
  REV="$(sed -n 's/^workspace_revision=//p' "$SRC/release.kv")"
  echo "== rolling back to $TO (workspace $REV)"
  [ -z "$(git -C "$(m "$HERE")" status --porcelain --untracked-files=no)" ] || \
    fail "the workspace has uncommitted changes to tracked files — commit or stash them first"

  git -C "$(m "$HERE")" checkout --quiet "$REV" || fail "cannot check out $REV"
  say "workspace" "$(git -C "$(m "$HERE")" rev-parse --short HEAD)"

  # put the kept images back under the tags compose uses
  while read -r s ref id keep; do
    docker image inspect "$keep" >/dev/null 2>&1 || fail "kept image $keep is gone — cannot roll back"
    docker tag "$keep" "$ref"
    say "image $s" "$ref ← $keep"
  done < "$SRC/images.txt"

  echo "== toolchain"
  docker stop "$AGENT" >/dev/null 2>&1 || true
  docker run --rm -v "$STACK-agent-home:/v" -v "$(m "$SRC"):/in:ro" alpine sh -c \
    'rm -rf /v/.local && tar xzf /in/toolchain.tar.gz -C /v' || fail "could not put the toolchain back"
  say "restored" "/home/agent/.local from the release"

  echo "== configuration"
  tar xzf "$SRC/config.tar.gz" -C "$HERE"
  say "restored" "config/, policy/ (and docker/.env if it was kept)"

  echo "== starting and checking"
  (cd "$HERE" && bash scripts/up.sh --recreate) || { echo "the checks did not pass after the rollback" >&2; exit 1; }
  echo
  echo "rolled back to $TO"
}

case "$CMD" in
  record)   cmd_record;;
  list)     cmd_list;;
  update)   cmd_update;;
  rollback) cmd_rollback;;
  *) sed -n '2,12p' "$0"; exit 2;;
esac
