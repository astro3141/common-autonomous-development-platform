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

HERE="${RELEASE_SH_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
# An update or a rollback checks out another revision of this very workspace — including this
# script. A shell reads a script as it goes, so replacing the file underneath a running one can
# change behaviour halfway or break it outright. Run from a copy instead.
if [ -z "${RELEASE_SH_PINNED:-}" ]; then
  SELF_COPY="${TMPDIR:-/tmp}/cadp-release-$$.sh"
  cp "$0" "$SELF_COPY"
  RELEASE_SH_PINNED=1 RELEASE_SH_HOME="$HERE" RELEASE_SH_COPY="$SELF_COPY" \
    exec bash "$SELF_COPY" "$@"
fi
cleanup_all() {
  [ -n "${CAND_DIR:-}" ] && { git -C "$(m "$HERE")" worktree remove --force "$(m "$CAND_DIR")" >/dev/null 2>&1 || true; rm -rf "$CAND_DIR"; }
  rm -f "${RELEASE_SH_COPY:-}"
}
trap cleanup_all EXIT
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
# A tool that cannot answer is information, not a reason to abort: the caller decides.
tool_running()  { docker exec "$AGENT" sh -c "$(tool_cmd "$1")" 2>/dev/null | head -1 | tr -d '\r' || true; }
tool_in_image() { docker run --rm --entrypoint sh "$1" -c "$(tool_cmd "$2")" 2>/dev/null | head -1 | tr -d '\r' || true; }

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

# ---------------------------------------------------------------------- toolchain handling
# The toolchain is swapped in three steps — stage, verify, swap — and the copy that was running is
# kept until the new one has actually answered. An archive can be a valid tar and still be empty
# of tools: `bin/claude` is an absolute symlink into /home/agent/.local, so it must be followed
# *inside the staged copy*, and the tools it names must really be there.
REQUIRED_TOOLS_IN_VOLUME="claude conductor preloop"
verify_staged() {
  docker run --rm -v "$STACK-agent-home:/vol" alpine sh -c '
    set -e
    for t in '"$REQUIRED_TOOLS_IN_VOLUME"'; do
      p=/vol/.local.new/bin/$t
      if [ -L "$p" ]; then
        tgt="$(readlink "$p")"
        case "$tgt" in
          /home/agent/.local/*) tgt=/vol/.local.new/"${tgt#/home/agent/.local/}";;
          /*) ;;
          *) tgt="/vol/.local.new/bin/$tgt";;
        esac
        [ -e "$tgt" ] || { echo "$t points at $tgt, which the archive does not contain"; exit 1; }
        [ -s "$tgt" ] || [ -d "$tgt" ] || { echo "$t target $tgt is empty"; exit 1; }
      elif [ -f "$p" ]; then
        [ -s "$p" ] || { echo "$t is empty"; exit 1; }
      else
        echo "$t is missing from the staged toolchain"; exit 1
      fi
    done' || return 1
  say "verified" "the staged toolchain really contains $REQUIRED_TOOLS_IN_VOLUME"
}
swap_staged() {  # keeps .local.old until the new one has answered (see keep_or_restore_toolchain)
  docker run --rm -v "$STACK-agent-home:/vol" alpine sh -c \
    'rm -rf /vol/.local.old && mv /vol/.local /vol/.local.old && mv /vol/.local.new /vol/.local'
}
keep_or_restore_toolchain() {
  docker run --rm -v "$STACK-agent-home:/vol" alpine sh -c '[ -d /vol/.local.old ]' 2>/dev/null || return 0
  # the tools are asked inside the container, so it has to be up even when the checks failed
  docker start "$AGENT" >/dev/null 2>&1 || true
  for i in $(seq 1 15); do docker exec "$AGENT" true >/dev/null 2>&1 && break; sleep 1; done
  bad=""
  for t in claude conductor preloop_cli; do
    [ -n "$(tool_running "$t")" ] || bad="$bad $t"
  done
  if [ -n "$bad" ]; then
    echo "  the new toolchain does not answer ($bad) — putting the previous one back" >&2
    docker stop "$AGENT" >/dev/null 2>&1 || true
    docker run --rm -v "$STACK-agent-home:/vol" alpine sh -c \
      'rm -rf /vol/.local.broken && mv /vol/.local /vol/.local.broken && mv /vol/.local.old /vol/.local'
    docker start "$AGENT" >/dev/null 2>&1 || true
    return 1
  fi
  docker run --rm -v "$STACK-agent-home:/vol" alpine sh -c 'rm -rf /vol/.local.old'
  say "toolchain" "answers; the previous copy was removed"
  return 0
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
    echo "format=2"                  # 2: configuration sources only (no config/generated)
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
  # ---- decide on a candidate, before the workspace in use is touched --------------------
  # What runs is the volume's toolchain, not the image's. Whether this update would change it can
  # only be told by building the target revision — so that happens in a throw-away worktree with
  # its own image tag. Until this passes, /work and the `:local` tags are exactly as they were.
  echo "== candidate $TO"
  CAND_DIR="$(u "${TMPDIR:-/tmp}")/cadp-candidate-$$"
  CAND_IMAGE="cadp278/governed-runtime:cand-$(git_here rev-parse --short "$TO")"
  git_here worktree add --quiet --detach "$(m "$CAND_DIR")" "$TO" || fail "could not prepare a candidate worktree"
  # A worktree is the whole repository, and this stack may sit below its root (it does in the
  # repository layout, poc/281-routing/). The candidate's docker/ is therefore under the same
  # prefix as this workspace has inside its own repository.
  PREFIX="$(git_here rev-parse --show-prefix)"
  CAND_DOCKER="$(m "$CAND_DIR")/${PREFIX}docker"
  [ -f "$(u "$CAND_DOCKER")/agent.Dockerfile" ] || fail "the candidate has no ${PREFIX}docker/agent.Dockerfile"
  docker build --quiet -t "$CAND_IMAGE" -f "$CAND_DOCKER/agent.Dockerfile" "$CAND_DOCKER" >/dev/null \
    || fail "the candidate build failed; nothing was changed"
  say "built" "$CAND_IMAGE"
  DIFFS=""
  for t in $TOOLS; do
    have="$(tool_running "$t")"; want="$(tool_in_image "$CAND_IMAGE" "$t")"
    [ -n "$want" ] || continue
    [ "$have" = "$want" ] || DIFFS="$DIFFS    $t: running '$have', candidate image '$want'\n"
  done
  if [ -n "$DIFFS" ] && [ "$REPLACE_TOOLCHAIN" = 0 ]; then
    printf "  the new revision builds different tool versions:\n" >&2
    printf "%b" "$DIFFS" >&2
    echo "  the volume is what runs, so this update would NOT change them." >&2
    echo "  re-run with --replace-toolchain to replace /home/agent/.local." >&2
    fail "refusing an update whose toolchain would silently stay behind — the instance is untouched"
  fi

  echo "== keeping the release in use before changing anything"
  ( TAG=""; cmd_record )
  echo
  echo "== moving the workspace to $TO"
  git_here checkout --quiet "$TO"
  say "now at" "$(git_here rev-parse --short HEAD)"
  echo "== rebuilding images"
  (cd "$HERE/docker" && docker compose -f compose.poc.yaml build) || fail "the build failed; nothing was recreated"

  echo "== toolchain"
  if [ -n "$DIFFS" ]; then
    say "replacing" "/home/agent/.local with the new image's toolchain"
    # staging needs no downtime; only the swap does
    docker run --rm -v "$STACK-agent-home:/vol" --entrypoint sh "$CAND_IMAGE" -c \
      'rm -rf /vol/.local.new && cp -a /home/agent/.local /vol/.local.new' \
      || fail "could not stage the new toolchain; nothing was replaced"
    verify_staged || fail "the new toolchain did not verify; nothing was replaced"
    docker stop "$AGENT" >/dev/null 2>&1 || true
    swap_staged || fail "could not swap in the new toolchain"
  else
    say "unchanged" "the new revision builds the same tool versions"
  fi

  echo "== starting and checking"
  UP_RC=0
  (cd "$HERE" && bash scripts/up.sh --recreate) || UP_RC=1
  # Whatever happened, the swapped-in toolchain is judged now: a copy that does not answer is put
  # back before anything else is decided, so no failure path can leave the instance without tools.
  keep_or_restore_toolchain || {
    echo; echo "the previous toolchain was put back; the update did not take effect." >&2
    exit 1; }
  [ "$UP_RC" = 0 ] || {
    echo; echo "the checks did not pass after the update. Go back with:" >&2
    echo "  scripts/release.sh rollback --to <tag>   (scripts/release.sh list)" >&2
    exit 1; }
  # A policy that could not be applied means the account still enforces the previous one: that is
  # a failed update, not a warning.
  reapply_policy || {
    echo; echo "the update left the Preloop policy unapplied. Go back with:" >&2
    echo "  scripts/release.sh rollback --to <tag>   (scripts/release.sh list)" >&2
    exit 1; }
  for t in $TOOLS; do say "$t" "$(tool_running "$t")"; done
  echo
  echo "update done. If it misbehaves, go back with:"
  echo "  scripts/release.sh rollback --to <tag>   (scripts/release.sh list)"
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
  # Unpack beside the running toolchain and only then swap: what runs is never deleted before a
  # usable replacement exists. Staging needs no downtime, so the agent keeps running until the
  # staged copy has been verified — a refusal leaves the instance exactly as it was, still up.
  docker run --rm -v "$STACK-agent-home:/vol" -v "$(m "$SRC"):/in:ro" alpine sh -c \
    'rm -rf /vol/.local.new && mkdir -p /vol/.local.new && tar xzf /in/toolchain.tar.gz -C /vol/.local.new --strip-components=1' \
    || fail "the release's toolchain did not unpack — the running one is untouched"
  verify_staged || fail "the release's toolchain has no usable tools in it — the running one is untouched"
  say "verified" "images, archives, and the unpacked toolchain"
  docker stop "$AGENT" >/dev/null 2>&1 || true

  git_here checkout --quiet "$REV" || fail "cannot check out $REV"
  say "workspace" "$(git_here rev-parse --short HEAD)"
  while read -r s ref id keep; do
    docker tag "$keep" "$ref"
    say "image $s" "$ref ← $keep"
  done < "$SRC/images.txt"
  swap_staged || fail "could not swap in the release's toolchain"
  say "toolchain" "/home/agent/.local from the release (the previous copy is kept until it answers)"
  # Releases recorded by an older version of this script carry config/generated, whose state.json
  # describes the ACCOUNT, not the code. Restoring it would claim a policy the account may not
  # have, and the apply below would then skip as "already applied".
  tar xzf "$SRC/config.tar.gz" -C "$HERE" --exclude='config/generated' --exclude='config/generated/*'
  rm -rf "$HERE/config/generated"
  say "configuration" "config/ and policy/ sources only (generated settings are rebuilt)"

  echo "== starting and checking"
  UP_RC=0
  (cd "$HERE" && bash scripts/up.sh --recreate) || UP_RC=1
  # judged before anything else, exactly as in an update: a toolchain that does not answer is put
  # back, whatever the checks said
  keep_or_restore_toolchain || {
    echo; echo "the previous toolchain was put back; the rollback did not take effect." >&2
    exit 1; }
  [ "$UP_RC" = 0 ] || { echo "the checks did not pass after the rollback" >&2; exit 1; }
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
