#!/usr/bin/env bash
# Releases: keep what is running now, change to something else, and go back to it.
#
#   scripts/release.sh record [--tag NAME]                    keep the running release
#   scripts/release.sh list                                   what is kept
#   scripts/release.sh update --to REV [--replace-toolchain]  record, move to REV, rebuild, check
#   scripts/release.sh rollback --to TAG                      put a kept release back (operator-run)
#
# A release is NOT an image tag. OPERATIONS.md §3: Claude, Conductor and the Preloop CLI live in
# /home/agent, which is a volume that masks the image's copy — so replacing the image does not
# change what actually runs. A release here is
#
#   code revision + image ids (kept under a release tag) + configuration + the toolchain itself.
#
# Data is not part of a release: logins, the Preloop database, MLflow and run history stay where
# they are and must survive both directions. scripts/backup.sh covers those. The one exception is
# the Preloop *policy*, which is configuration held in another system: after a change of release
# the restored policy is applied again, so what the account enforces matches what was restored.
set -euo pipefail
export MSYS_NO_PATHCONV=1
u() { if command -v cygpath >/dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
m() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HERE/config/instance.env" ] && . "$HERE/config/instance.env"
STACK="${STACK:-cadp278}"
AGENT="$STACK-agent"
PY_IN_AGENT="/opt/venv/bin/python"
RELEASES="${RELEASE_DIR:-$HOME/cadp-releases}"
RELEASESU="$(u "$RELEASES")"; RELEASES="$(m "$RELEASESU")"
# services of this stack (the agent and the observer share one image)
SERVICES="agent mlflow toolsvc fsmcp egress ops hub"
TOOLS="claude conductor preloop_cli codex grok node"

say()  { printf '  %-42s %s\n' "$1" "$2"; }
fail() { echo "release: $*" >&2; exit 1; }

CMD="${1:-}"; shift || true
TAG=""; TO=""; REPLACE_TOOLCHAIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --to) TO="$2"; shift 2;;
    --replace-toolchain) REPLACE_TOOLCHAIN=1; shift;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

git_here() { git -C "$(m "$HERE")" "$@"; }
tool_cmd() {
  case "$1" in
    claude)      echo 'claude --version';;
    conductor)   echo 'conductor --version';;
    preloop_cli) echo 'preloop version';;
    codex)       echo 'codex --version';;
    grok)        echo 'grok --version';;
    node)        echo 'node -v';;
  esac
}
tool_running()  { docker exec "$AGENT" sh -c "$(tool_cmd "$1")" 2>/dev/null | head -1 | tr -d '\r'; }
tool_in_image() { docker run --rm --entrypoint sh "$1" -c "$(tool_cmd "$2")" 2>/dev/null | head -1 | tr -d '\r'; }

# Docker Desktop reports a bind source either as the host path or in the VM's own form.
norm_host() {
  case "$1" in
    /run/desktop/mnt/host/?/*|/host_mnt/?/*)
      p="${1#/run/desktop/mnt/host/}"; p="${p#/host_mnt/}"
      d="${p%%/*}"; printf '%s:/%s' "$(printf '%s' "$d" | tr 'a-z' 'A-Z')" "${p#*/}";;
    *) printf '%s' "$1";;
  esac
}
real_of() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }

require_same_workspace() {
  docker inspect "$AGENT" >/dev/null 2>&1 || fail "no container $AGENT"
  mounted="$(norm_host "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/work"}}{{.Source}}{{end}}{{end}}' "$AGENT")")"
  [ -n "$mounted" ] || fail "cannot read the workspace mount (/work) of $AGENT"
  # A release describes what RUNS. Reading the revision and the configuration from a different
  # checkout than the mounted one would record a release that never ran — and this project has
  # more than one checkout of the same code.
  [ "$(real_of "$(u "$mounted")")" = "$(real_of "$HERE")" ] || \
    fail "this script is in $HERE but $AGENT runs $mounted — run it from the workspace in use"
}
require_clean_tree() {  # only tracked files matter; run evidence in the workspace is untracked data
  [ -z "$(git_here status --porcelain --untracked-files=no)" ] || \
    fail "the workspace has uncommitted changes to tracked files — commit or stash them first ($1)"
}

# Bring the Preloop policy in line with the configuration now on disk. The apply state lives in
# config/generated/state.json, which is NOT part of a release: it describes the account, not the
# code. Restoring an old copy of it would claim a policy the account does not have.
reapply_policy() {
  echo "== policy"
  docker exec "$AGENT" "$PY_IN_AGENT" /work/p281/cfg.py generate >/dev/null || fail "cfg.py generate failed"
  out="$(docker exec "$AGENT" "$PY_IN_AGENT" /work/p281/cfg.py apply || true)"
  echo "$out" | grep -o '"preloop-policy[^,]*' | sed 's/^/  /' || true
  if ! echo "$out" | grep -q '"ok": true'; then
    echo "  the policy could not be applied — the account may still enforce the previous one" >&2
    return 1
  fi
  st="$(docker exec "$AGENT" "$PY_IN_AGENT" /work/p281/cfg.py status || true)"
  say "state" "$(echo "$st" | grep -A1 '"preloop-policy' | sed -n 's/.*"state": "\([^"]*\)".*/\1/p' | head -1)"
  return 0
}

# ---------------------------------------------------------------------------- record
cmd_record() {
  require_same_workspace
  require_clean_tree "a release keeps a revision, not a working tree"
  docker start "$AGENT" >/dev/null 2>&1 || true
  for i in $(seq 1 15); do docker exec "$AGENT" true >/dev/null 2>&1 && break; sleep 1; done
  REV="$(git_here rev-parse --short HEAD)"
  [ -n "$TAG" ] || TAG="$(date -u +%Y%m%d-%H%M%S)-$REV"
  DEST="$RELEASESU/$TAG"
  [ -e "$DEST" ] && fail "release $TAG already exists"
  mkdir -p "$DEST"
  echo "== recording release $TAG"
  say "workspace revision" "$REV"
  say "workspace" "$HERE (the one $AGENT runs)"

  : > "$DEST/images.txt"
  for s in $SERVICES; do
    ref="$(docker inspect -f '{{.Config.Image}}' "$STACK-$s" 2>/dev/null || true)"
    [ -n "$ref" ] || continue
    id="$(docker inspect -f '{{.Image}}' "$STACK-$s")"
    keep="${ref%%:*}:rel-$TAG"
    docker tag "$id" "$keep"
    echo "$s $ref $id $keep" >> "$DEST/images.txt"
    say "image $s" "$keep"
  done

  # the toolchain, from the volume where it actually lives
  docker run --rm -v "$STACK-agent-home:/v:ro" -v "$(m "$DEST"):/out" alpine \
    tar czf /out/toolchain.tar.gz -C /v .local
  docker run --rm -v "$(m "$DEST"):/in:ro" alpine tar tzf /in/toolchain.tar.gz >/dev/null \
    || fail "the toolchain archive did not verify"
  say "toolchain" "$(du -h "$DEST/toolchain.tar.gz" | cut -f1) (/home/agent/.local)"

  # configuration sources only: config/generated is derived, and its state.json describes the
  # Preloop account rather than this code — see reapply_policy()
  tar czf "$DEST/config.tar.gz" --exclude='config/generated' -C "$HERE" config policy docker/.env 2>/dev/null || \
    tar czf "$DEST/config.tar.gz" --exclude='config/generated' -C "$HERE" config policy
  docker run --rm -v "$(m "$DEST"):/in:ro" alpine tar tzf /in/config.tar.gz >/dev/null \
    || fail "the configuration archive did not verify"
  say "configuration" "$(du -h "$DEST/config.tar.gz" | cut -f1) (sources only)"

  {
    echo "tag=$TAG"
    echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "workspace_revision=$REV"
    echo "workspace_dir=$HERE"
    echo "stack=$STACK"
    for t in $TOOLS; do echo "tool.$t=$(tool_running "$t")"; done
  } > "$DEST/release.kv"
  for t in $TOOLS; do
    grep -q "^tool\.$t=." "$DEST/release.kv" || fail "could not read the $t version from $AGENT"
    say "$t" "$(sed -n "s/^tool\.$t=//p" "$DEST/release.kv")"
  done
  echo
  echo "kept in $RELEASES/$TAG"
}

# ---------------------------------------------------------------------------- list
cmd_list() {
  [ -d "$RELEASESU" ] || { echo "no releases kept yet ($RELEASES)"; return 0; }
  printf '%-28s %-10s %-22s %s\n' TAG REVISION RECORDED TOOLS
  for d in "$RELEASESU"/*/; do
    [ -f "$d/release.kv" ] || continue
    printf '%-28s %-10s %-22s %s\n' "$(basename "$d")" \
      "$(sed -n 's/^workspace_revision=//p' "$d/release.kv")" \
      "$(sed -n 's/^recorded_at=//p' "$d/release.kv")" \
      "claude $(sed -n 's/^tool.claude=//p' "$d/release.kv" | cut -d' ' -f1), conductor $(sed -n 's/^tool.conductor=//p' "$d/release.kv" | cut -d' ' -f2)"
  done
}

# ---------------------------------------------------------------------------- update
cmd_update() {
  [ -n "$TO" ] || fail "update needs --to REVISION"
  require_same_workspace
  require_clean_tree "an update checks out another revision"
  git_here rev-parse --verify --quiet "$TO" >/dev/null || fail "unknown revision $TO"
  echo "== keeping the release in use before changing anything"
  ( TAG=""; cmd_record )
  echo
  echo "== moving the workspace to $TO"
  git_here checkout --quiet "$TO"
  say "now at" "$(git_here rev-parse --short HEAD)"
  echo "== rebuilding images"
  (cd "$HERE/docker" && docker compose -f compose.poc.yaml build) || fail "the build failed; nothing was recreated"

  # What runs is the volume's toolchain, not the image's. If the new image carries different
  # versions, the update would leave the old ones running: say so, and replace only when asked.
  echo "== toolchain"
  NEW_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$AGENT" 2>/dev/null || echo cadp278/governed-runtime:local)"
  DIFFS=""
  for t in $TOOLS; do
    have="$(tool_running "$t")"; want="$(tool_in_image "$NEW_IMAGE" "$t")"
    [ -n "$want" ] || continue
    [ "$have" = "$want" ] || DIFFS="$DIFFS    $t: running '$have', new image '$want'\n"
  done
  if [ -n "$DIFFS" ]; then
    if [ "$REPLACE_TOOLCHAIN" = 1 ]; then
      say "replacing" "/home/agent/.local with the new image's toolchain"
      docker stop "$AGENT" >/dev/null 2>&1 || true
      docker run --rm -v "$STACK-agent-home:/vol" --entrypoint sh "$NEW_IMAGE" -c \
        'rm -rf /vol/.local.new && cp -a /home/agent/.local /vol/.local.new && [ -e /vol/.local.new/bin/claude -o -L /vol/.local.new/bin/claude ] && [ -d /vol/.local.new/share/claude ]' \
        || fail "could not stage the new toolchain; nothing was replaced"
      docker run --rm -v "$STACK-agent-home:/vol" alpine sh -c \
        'rm -rf /vol/.local.old && mv /vol/.local /vol/.local.old && mv /vol/.local.new /vol/.local && rm -rf /vol/.local.old' \
        || fail "could not swap in the new toolchain"
    else
      printf "  the new image carries different tool versions:\n" >&2
      printf "%b" "$DIFFS" >&2
      echo "  the volume is what runs, so this update would NOT change them." >&2
      echo "  re-run with --replace-toolchain to replace /home/agent/.local." >&2
      fail "refusing an update whose toolchain would silently stay behind"
    fi
  else
    say "unchanged" "the new image carries the same tool versions"
  fi

  echo "== starting and checking"
  if (cd "$HERE" && bash scripts/up.sh --recreate); then
    reapply_policy || true
    for t in $TOOLS; do say "$t" "$(tool_running "$t")"; done
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
  require_same_workspace
  require_clean_tree "a rollback checks out the release's revision"
  REV="$(sed -n 's/^workspace_revision=//p' "$SRC/release.kv")"
  echo "== rolling back to $TO (workspace $REV)"

  # Everything is verified BEFORE anything changes: a rollback that fails half way would leave
  # the instance without the toolchain it had.
  git_here rev-parse --verify --quiet "$REV" >/dev/null || fail "the release's revision $REV is not in this repository"
  while read -r s ref id keep; do
    docker image inspect "$keep" >/dev/null 2>&1 || fail "kept image $keep is gone — cannot roll back"
  done < "$SRC/images.txt"
  docker run --rm -v "$(m "$SRC"):/in:ro" alpine sh -c \
    'tar tzf /in/toolchain.tar.gz >/dev/null && tar tzf /in/config.tar.gz >/dev/null' \
    || fail "the release's archives do not verify — nothing was changed"
  # unpack beside the running toolchain and only then swap: what runs is never deleted before a
  # usable replacement exists
  docker stop "$AGENT" >/dev/null 2>&1 || true
  docker run --rm -v "$STACK-agent-home:/vol" -v "$(m "$SRC"):/in:ro" alpine sh -c \
    'rm -rf /vol/.local.new && mkdir -p /vol/.local.new && tar xzf /in/toolchain.tar.gz -C /vol/.local.new --strip-components=1 && [ -e /vol/.local.new/bin/claude -o -L /vol/.local.new/bin/claude ] && [ -d /vol/.local.new/share/claude ]' \
    || fail "the release's toolchain did not unpack — the running one is untouched"
  say "verified" "images, archives, and the unpacked toolchain"

  git_here checkout --quiet "$REV" || fail "cannot check out $REV"
  say "workspace" "$(git_here rev-parse --short HEAD)"
  while read -r s ref id keep; do
    docker tag "$keep" "$ref"
    say "image $s" "$ref ← $keep"
  done < "$SRC/images.txt"
  docker run --rm -v "$STACK-agent-home:/vol" alpine sh -c \
    'rm -rf /vol/.local.old && mv /vol/.local /vol/.local.old && mv /vol/.local.new /vol/.local && rm -rf /vol/.local.old' \
    || fail "could not swap in the release's toolchain"
  say "toolchain" "/home/agent/.local from the release"
  tar xzf "$SRC/config.tar.gz" -C "$HERE"
  say "configuration" "config/ and policy/ sources (generated settings are rebuilt)"

  echo "== starting and checking"
  (cd "$HERE" && bash scripts/up.sh --recreate) || { echo "the checks did not pass after the rollback" >&2; exit 1; }
  # the account must enforce the policy that was just restored, not the one from before
  reapply_policy || exit 1
  for t in $TOOLS; do say "$t" "$(tool_running "$t")"; done
  echo
  echo "rolled back to $TO"
}

case "$CMD" in
  record)   cmd_record;;
  list)     cmd_list;;
  update)   cmd_update;;
  rollback) cmd_rollback;;
  *) sed -n '2,8p' "$0"; exit 2;;
esac
