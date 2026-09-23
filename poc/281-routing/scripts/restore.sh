#!/usr/bin/env bash
# Restore a backup into a SEPARATE instance: new volumes, a new workspace, its own Preloop
# project and its own ports. The instance in use is never written to.
#
#   scripts/restore.sh --archive FILE --workspace DIR [--stack NAME] [--key FILE]
#                      [--clone-from REPO --rev REV] [--verify-only] [--into-existing]
#
#   --workspace DIR    where the restored instance's /work lives. With --clone-from it is created
#                      as a fresh clone (the repository layout: <clone>/poc/281-routing).
#   --stack NAME       instance name for containers, volumes and networks (default cadp278r).
#   --into-existing    allow a workspace that already holds config/ or evidence/ to be overwritten.
#
# Ports default to the live ones + 10 (hub 8790, ops 8791, MLflow 5010, Preloop 8010/8011/3010).
#
# Every check that protects the live instance runs BEFORE the first write: nothing is unpacked,
# no volume is created and no database is touched until the target is known to be separate.
# The restored instance records what it is in config/instance.env, and scripts/up.sh and
# scripts/down.sh in that workspace read it — so later start, check and teardown commands act on
# the restored copy and not on the live one.
#
# Both copies hold the SAME provider credentials, so they must not run at the same time: the
# script refuses to start while the live instance is up, and says how to stop it.
set -euo pipefail
export MSYS_NO_PATHCONV=1
u() { if command -v cygpath >/dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
m() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

ARCHIVE=""; WORKSPACE=""; CLONE_FROM=""; REV=""; VERIFY_ONLY=0; INTO_EXISTING=0
STACK="${STACK:-cadp278r}"
LIVE_STACK="${LIVE_STACK:-cadp278}"
LIVE_PRELOOP_PROJECT="${LIVE_PRELOOP_PROJECT:-preloop-oss}"
LIVE_PRELOOP_DIR="${LIVE_PRELOOP_DIR:-$HOME/.preloop-oss}"
KEY="${BACKUP_KEY:-$HOME/.cadp-backup.key}"
PRELOOP_PROJECT="${RESTORE_PRELOOP_PROJECT:-preloop-restore}"
PRELOOP_RESTORE_DIR="${RESTORE_PRELOOP_DIR:-$HOME/.preloop-restore}"
HUB_PORT="${HUB_PORT:-8790}"; OPS_PORT="${OPS_PORT:-8791}"; MLFLOW_PORT="${MLFLOW_PORT:-5010}"
PRELOOP_API_PORT="${PRELOOP_API_PORT:-8010}"; PRELOOP_GATEWAY_PORT="${PRELOOP_GATEWAY_PORT:-8011}"
PRELOOP_CONSOLE_PORT="${PRELOOP_CONSOLE_PORT:-3010}"
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2;;
    --workspace) WORKSPACE="$2"; shift 2;;
    --stack) STACK="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --clone-from) CLONE_FROM="$2"; shift 2;;
    --rev) REV="$2"; shift 2;;
    --verify-only) VERIFY_ONLY=1; shift;;
    --into-existing) INTO_EXISTING=1; shift;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
say()    { printf '  %-42s %s\n' "$1" "$2"; }
refuse() { echo "refusing: $*" >&2; exit 2; }

[ -n "$ARCHIVE" ] && [ -n "$WORKSPACE" ] || { echo "need --archive and --workspace" >&2; exit 2; }
ARCHIVEU="$(u "$ARCHIVE")"; KEYU="$(u "$KEY")"; WORKSPACEU="$(u "$WORKSPACE")"
PRELOOP_RESTORE_DIRU="$(u "$PRELOOP_RESTORE_DIR")"; LIVE_PRELOOP_DIRU="$(u "$LIVE_PRELOOP_DIR")"
[ -f "$ARCHIVEU" ] || { echo "no such archive: $ARCHIVE" >&2; exit 2; }
[ -f "$KEYU" ] || { echo "no key file: $KEY" >&2; exit 2; }

# ---------------------------------------------------------------- 0. checks, before any write
if [ "$VERIFY_ONLY" = 0 ]; then
  echo "== checks"
  [ "$STACK" != "$LIVE_STACK" ] || refuse "--stack must differ from the live stack ($LIVE_STACK)"
  [ "$PRELOOP_PROJECT" != "$LIVE_PRELOOP_PROJECT" ] || \
    refuse "the Preloop project ($PRELOOP_PROJECT) is the live one — set RESTORE_PRELOOP_PROJECT"
  # a stray PRELOOP_PROJECT in the environment must never point the DROP DATABASE at the live one
  docker ps -a --format '{{.Names}}' | grep -q "^$PRELOOP_PROJECT-postgres" && \
    refuse "a Preloop postgres container already exists for project $PRELOOP_PROJECT"

  # Every directory this script writes to or deletes is compared with every directory the live
  # instance uses — in both directions, on normalised paths. "Same path" is not enough: a parent
  # of the live Preloop directory would be removed with it inside.
  realpath_of() {  # resolve the part that exists, keep the rest — a path that does not exist yet
    p="$1"; rest=""                       # must still compare as itself, not as its parent
    while [ -n "$p" ] && [ ! -d "$p" ]; do
      rest="/$(basename "$p")$rest"; q="$(dirname "$p")"
      [ "$q" = "$p" ] && break
      p="$q"
    done
    base="$( (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p" )"
    printf '%s%s' "${base%/}" "$rest"
  }
  overlaps() {  # a, b → true when either contains the other
    a="$(realpath_of "$1")"; b="$(realpath_of "$2")"
    [ "$a" = "$b" ] && return 0
    case "$a/" in "$b"/*) return 0;; esac
    case "$b/" in "$a"/*) return 0;; esac
    return 1
  }
  # Docker Desktop reports a bind source either as the host path (D:/Work/…) or in the VM's own
  # form (/run/desktop/mnt/host/d/Work/…, /host_mnt/d/…). Unnormalised, the second form matches
  # nothing and the check silently passes.
  norm_host() {
    case "$1" in
      /run/desktop/mnt/host/?/*|/host_mnt/?/*)
        p="${1#/run/desktop/mnt/host/}"; p="${p#/host_mnt/}"
        d="${p%%/*}"; printf '%s:/%s' "$(printf '%s' "$d" | tr 'a-z' 'A-Z')" "${p#*/}";;
      *) printf '%s' "$1";;
    esac
  }
  # the live instance's own directories: its Preloop install and every bind mount it has
  LIVE_DIRS_FILE="$(mktemp)"
  printf '%s\n' "$LIVE_PRELOOP_DIRU" > "$LIVE_DIRS_FILE"
  docker inspect $(docker ps -aq --filter "name=$LIVE_STACK-") \
    --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
    | sed '/^$/d' | while IFS= read -r p; do u "$(norm_host "$p")"; done >> "$LIVE_DIRS_FILE"
  check_against_live() {  # path, what it is used for
    while IFS= read -r live; do
      [ -n "$live" ] || continue
      overlaps "$1" "$live" && { rm -f "$LIVE_DIRS_FILE"; refuse "$2 ($1) overlaps a directory the live instance uses ($live)"; }
    done < "$LIVE_DIRS_FILE"
    return 0          # "no overlap" is success; without this, set -e would end the run silently
  }
  check_against_live "$PRELOOP_RESTORE_DIRU" "the Preloop install directory for the restore"
  check_against_live "$WORKSPACEU" "the restore workspace"
  # …and the two restore targets must not contain each other either
  overlaps "$PRELOOP_RESTORE_DIRU" "$WORKSPACEU" && \
    refuse "the Preloop directory and the workspace of the restore overlap"
  rm -f "$LIVE_DIRS_FILE"
  # a leftover directory from an earlier restore is ours to replace (it is named after this
  # project and has no containers, both checked just above); the live one is never touched

  # nothing of the live instance may be running: the two copies share credentials
  RUNNING="$(docker ps --format '{{.Names}}' | grep -E "^($LIVE_STACK-|$LIVE_PRELOOP_PROJECT-)" || true)"
  if [ -n "$RUNNING" ]; then
    echo "The live instance is running. Stop it first, then run this again:" >&2
    echo "  docker stop \$(docker ps --format '{{.Names}}' | grep -E '^($LIVE_STACK-|$LIVE_PRELOOP_PROJECT-)')" >&2
    exit 3
  fi
  # the restored instance's own names must be free
  for v in route-creds agent-home quota-home ws quota-obs; do
    docker volume inspect "$STACK-$v" >/dev/null 2>&1 && \
      refuse "volume $STACK-$v already exists (remove it or pick another --stack)"
  done
  EXISTING="$(docker ps -a --format '{{.Names}}' | grep -E "^$STACK-" || true)"
  [ -z "$EXISTING" ] || refuse "containers of $STACK already exist: $(echo "$EXISTING" | tr '\n' ' ')"

  # the workspace must not be overwritten by accident (its overlap with the live instance's
  # directories was checked above, on normalised paths and without splitting on spaces)
  if [ -n "$CLONE_FROM" ]; then
    [ -e "$WORKSPACEU" ] && refuse "$WORKSPACE already exists (a clone needs a new directory)"
  else
    [ -d "$WORKSPACEU" ] || refuse "no such workspace: $WORKSPACE (use --clone-from to create one)"
    if [ -e "$WORKSPACEU/config" ] || [ -e "$WORKSPACEU/evidence" ]; then
      [ "$INTO_EXISTING" = 1 ] || \
        refuse "$WORKSPACE already holds config/ or evidence/ — they would be replaced (pass --into-existing to accept)"
    fi
  fi
  say "target" "$STACK (workspace $WORKSPACE)"
  say "preloop" "$PRELOOP_PROJECT in $PRELOOP_RESTORE_DIR"
  say "live instance" "stopped; its volumes and paths untouched"
fi

STAGE="$(u "${TMPDIR:-/tmp}")/cadp-restore-$$"
STAGEM="$(m "$STAGE")"
(umask 077; mkdir -p "$STAGE")
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# ---------------------------------------------------------------- 1. unpack and check
echo "== unpacking"
docker run --rm -v "$(m "$(dirname "$ARCHIVEU")")":/in:ro -v "$STAGEM":/out -v "$(m "$KEYU")":/key:ro alpine sh -c "
  apk add --no-cache openssl >/dev/null 2>&1
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/key -in '/in/$(basename "$ARCHIVEU")' | tar xzf - -C /out"
say "members" "$(find "$STAGE" -type f | wc -l | tr -d ' ')"

echo "== manifest"
BAD="$(docker run --rm -v "$STAGEM":/w:ro alpine sh -c '
  cd /w && tail -n +2 manifest.txt | while read -r f size sum; do
    [ -f "$f" ] || { echo "missing $f"; continue; }
    [ "$(sha256sum "$f" | cut -d" " -f1)" = "$sum" ] || echo "changed $f"
  done')"
[ -z "$BAD" ] || { echo "backup is damaged:"; echo "$BAD"; exit 4; }
say "checked" "$(( $(wc -l < "$STAGE/manifest.txt") - 1 )) members, all match"
say "taken from" "$(grep -o '"workspace_revision": "[^"]*"' "$STAGE/release.json" | cut -d'"' -f4 | cut -c1-8)"
[ "$VERIFY_ONLY" = 1 ] && { echo; echo "archive verified; nothing restored (--verify-only)"; exit 0; }

# ---------------------------------------------------------------- 2. workspace
echo "== workspace"
if [ -n "$CLONE_FROM" ]; then
  # git here is a native Windows build: it takes native paths, not POSIX ones.
  git clone --quiet "$(m "$CLONE_FROM")" "$(m "$WORKSPACEU")"
  [ -n "$REV" ] && git -C "$(m "$WORKSPACEU")" checkout --quiet "$REV"
  # the repository keeps the stack under poc/281-routing
  [ -d "$WORKSPACEU/poc/281-routing" ] && WORKSPACEU="$WORKSPACEU/poc/281-routing"
  say "cloned" "$(git -C "$(m "$WORKSPACEU")" rev-parse --short HEAD)"
fi
WORKSPACE="$(m "$WORKSPACEU")"
# The restored copy must be able to run under its own name, AND its scripts must read the
# instance file this restore writes. A revision missing either one would start the live
# instance's containers against this workspace instead — checked before anything is started.
for need in \
  "docker/compose.poc.yaml:STACK:-cadp278" \
  "scripts/up.sh:config/instance.env" \
  "scripts/down.sh:config/instance.env"
do
  f="${need%%:*}"; pat="${need#*:}"
  [ -f "$WORKSPACEU/$f" ] && grep -q "$pat" "$WORKSPACEU/$f" || {
    echo "refusing: $WORKSPACE/$f does not support running as a separate instance ($pat) —" >&2
    echo "          pick a revision that does; nothing has been started" >&2
    exit 5; }
done

untar_host() {  # member, destination parent
  [ -f "$STAGE/host/$1.tar.gz" ] || { say "$1" "not in the backup"; return 1; }
  mkdir -p "$2"
  tar xzf "$STAGE/host/$1.tar.gz" -C "$2"
}
replace_with() {  # member, directory name inside the tar, destination parent
  untar_host "$1" "$STAGE/x-$1" || return 0
  local src="$STAGE/x-$1/$2"
  [ -d "$src" ] || { say "$1" "unexpected layout, skipped"; return 0; }
  rm -rf "${3:?}/$2"; mkdir -p "$3"; mv "$src" "$3/"
  say "$1" "-> ${3#$WORKSPACEU/}/$2"
}
replace_with mlflow mlflow "$WORKSPACEU/evidence"
replace_with evidence-p281 p281 "$WORKSPACEU/evidence"
replace_with evidence-ui-runs ui-runs "$WORKSPACEU/evidence"
replace_with evidence-runs runs "$WORKSPACEU/evidence"
replace_with evidence-conductor-events conductor-events "$WORKSPACEU/evidence"
replace_with config config "$WORKSPACEU"
replace_with policy policy "$WORKSPACEU"
if untar_host research "$STAGE/x-research"; then
  RES_SRC="$STAGE/x-research/$(ls "$STAGE/x-research" | head -1)"
  rm -rf "$WORKSPACEU/evidence/research"; mkdir -p "$WORKSPACEU/evidence"
  mv "$RES_SRC" "$WORKSPACEU/evidence/research"
  say "research" "-> evidence/research"
fi

# ---------------------------------------------------------------- 3. volumes
echo "== volumes"
for v in route-creds agent-home quota-home; do
  docker volume create "$STACK-$v" >/dev/null
  docker run --rm -v "$STACK-$v:/v" -v "$STAGEM/volumes:/in:ro" alpine tar xzf "/in/$v.tar.gz" -C /v
  say "$v" "restored"
done

# ---------------------------------------------------------------- 4. Preloop
echo "== Preloop"
rm -rf "$PRELOOP_RESTORE_DIRU"; mkdir -p "$PRELOOP_RESTORE_DIRU"
mkdir -p "$STAGE/x-preloop"
tar xzf "$STAGE/host/preloop-dir.tar.gz" -C "$STAGE/x-preloop"
PRELOOP_SRC="$(dirname "$(find "$STAGE/x-preloop" -maxdepth 2 -name docker-compose.yaml | head -1)")"
[ -d "$PRELOOP_SRC" ] || { echo "the backup has no Preloop install directory" >&2; exit 4; }
cp -a "$PRELOOP_SRC"/. "$PRELOOP_RESTORE_DIRU"/
PRELOOP_DIR_M="$(m "$PRELOOP_RESTORE_DIRU")"
docker compose --project-directory "$PRELOOP_DIR_M" -p "$PRELOOP_PROJECT" \
  -f "$PRELOOP_DIR_M/docker-compose.yaml" -f "$PRELOOP_DIR_M/docker-compose.auth.yaml" \
  up -d postgres >/dev/null
PGC="$PRELOOP_PROJECT-postgres-1"
for i in $(seq 1 30); do docker exec "$PGC" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
docker exec "$PGC" pg_isready -U postgres >/dev/null 2>&1 || { echo "the restored database did not start" >&2; exit 4; }
docker exec "$PGC" psql -U postgres -c "DROP DATABASE IF EXISTS preloop" >/dev/null
docker exec "$PGC" psql -U postgres -c "CREATE DATABASE preloop" >/dev/null
# A failed load must stop the restore here: a few tables existing proves nothing about the
# account, its policies or its approval history.
if ! docker exec -i "$PGC" pg_restore -U postgres -d preloop --no-owner --exit-on-error \
      < "$STAGE/preloop.dump" > "$STAGE/pg_restore.log" 2>&1; then
  echo "the database could not be restored:" >&2
  tail -20 "$STAGE/pg_restore.log" >&2
  echo "nothing was started; remove the volumes of $STACK and try again" >&2
  exit 4
fi
# and what came back must match what was backed up
MISMATCH="$(for t in account user api_key mcp_server approval_request; do
  want="$(grep -o "\"$t\": [0-9]*" "$STAGE/release.json" | head -1 | awk '{print $2}')"
  got="$(docker exec "$PGC" psql -U postgres -d preloop -tAc "select count(*) from \"$t\"" 2>/dev/null | tr -d '\r')"
  [ -n "$want" ] || continue
  [ "$want" = "$got" ] || echo "$t: backup $want, restored ${got:-none}"
done)"
[ -z "$MISMATCH" ] || { echo "the restored database does not match the backup:" >&2; echo "$MISMATCH" >&2; exit 4; }
say "database restored" "$(docker exec "$PGC" psql -U postgres -d preloop -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" | tr -d '\r') tables, key counts match"

# ---------------------------------------------------------------- 5. what this instance is
cat > "$WORKSPACEU/config/instance.env" <<EOF
# Written by scripts/restore.sh — read by scripts/up.sh and scripts/down.sh in THIS workspace,
# so start, check and teardown act on this instance and never on the live one.
STACK=$STACK
PRELOOP_PROJECT=$PRELOOP_PROJECT
PRELOOP_DIR=$PRELOOP_DIR_M
POC_HOST_DIR=$WORKSPACE
RESEARCH_HOST_DIR=$WORKSPACE/evidence/research
HUB_PORT=$HUB_PORT
OPS_PORT=$OPS_PORT
MLFLOW_PORT=$MLFLOW_PORT
PRELOOP_API_PORT=$PRELOOP_API_PORT
PRELOOP_GATEWAY_PORT=$PRELOOP_GATEWAY_PORT
PRELOOP_CONSOLE_PORT=$PRELOOP_CONSOLE_PORT
RESTORED_FROM=$(basename "$ARCHIVEU")
EOF
# compose run by hand in that directory needs the same values
sed 's/^#.*//' "$WORKSPACEU/config/instance.env" | grep -v '^$' > "$WORKSPACEU/docker/.env"
say "instance.env" "config/instance.env, docker/.env"

# ---------------------------------------------------------------- 6. start
echo "== starting the restored instance"
(cd "$WORKSPACEU" && bash scripts/up.sh)
docker ps --format '{{.Names}}' | grep -q "^$STACK-agent$" || {
  echo "the restored instance did not start under its own name — check $WORKSPACE" >&2; exit 6; }
docker ps --format '{{.Names}}' | grep -qE "^$LIVE_STACK-" && \
  echo "WARNING: containers of the live instance ($LIVE_STACK) are running as well" >&2
echo
echo "restored instance : $STACK   (hub http://127.0.0.1:$HUB_PORT, Preloop console http://127.0.0.1:$PRELOOP_CONSOLE_PORT)"
echo "workspace         : $WORKSPACE"
echo "check it          : (cd $WORKSPACE && bash scripts/up.sh --check)"
echo "remove it         : (cd $WORKSPACE && bash scripts/down.sh --volumes)"
