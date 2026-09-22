#!/usr/bin/env bash
# Restore a backup into a SEPARATE instance: new volumes, a new workspace, its own Preloop
# project and its own ports. The instance in use is never written to.
#
#   scripts/restore.sh --archive FILE --workspace DIR [--stack NAME] [--key FILE]
#                      [--clone-from REPO --rev REV] [--verify-only]
#
#   --workspace DIR    where the restored instance's /work lives. With --clone-from it is created
#                      as a fresh clone (the repository layout: <clone>/poc/281-routing).
#   --stack NAME       instance name for containers, volumes and networks (default cadp278r).
#
# Ports of the restored instance default to the live ones + 10 (hub 8790, ops 8791, MLflow 5010,
# Preloop api 8010 / gateway 8011 / console 3010).
#
# The two instances hold the SAME provider credentials, so they must not run at the same time:
# the script refuses to start while the live stack is up, and says how to stop it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
command -v cygpath >/dev/null && HERE="$(cygpath -m "$HERE")"
export MSYS_NO_PATHCONV=1
u() { if command -v cygpath >/dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
m() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

ARCHIVE=""; WORKSPACE=""; CLONE_FROM=""; REV=""; VERIFY_ONLY=0
STACK="${STACK:-cadp278r}"
LIVE_STACK="${LIVE_STACK:-cadp278}"
KEY="${BACKUP_KEY:-$HOME/.cadp-backup.key}"
PRELOOP_PROJECT="${PRELOOP_PROJECT:-preloop-restore}"
export HUB_PORT="${HUB_PORT:-8790}" OPS_PORT="${OPS_PORT:-8791}" MLFLOW_PORT="${MLFLOW_PORT:-5010}"
export PRELOOP_API_PORT="${PRELOOP_API_PORT:-8010}" PRELOOP_GATEWAY_PORT="${PRELOOP_GATEWAY_PORT:-8011}"
export PRELOOP_CONSOLE_PORT="${PRELOOP_CONSOLE_PORT:-3010}"
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2;;
    --workspace) WORKSPACE="$2"; shift 2;;
    --stack) STACK="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --clone-from) CLONE_FROM="$2"; shift 2;;
    --rev) REV="$2"; shift 2;;
    --verify-only) VERIFY_ONLY=1; shift;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
[ -n "$ARCHIVE" ] && [ -n "$WORKSPACE" ] || { echo "need --archive and --workspace" >&2; exit 2; }
[ "$STACK" != "$LIVE_STACK" ] || { echo "refusing: --stack must differ from the live stack" >&2; exit 2; }
ARCHIVEU="$(u "$ARCHIVE")"; KEYU="$(u "$KEY")"; WORKSPACEU="$(u "$WORKSPACE")"
[ -f "$ARCHIVEU" ] || { echo "no such archive: $ARCHIVE" >&2; exit 2; }
[ -f "$KEYU" ] || { echo "no key file: $KEY" >&2; exit 2; }

say() { printf '  %-42s %s\n' "$1" "$2"; }

# The same credentials must not be used by two instances at once. Verifying an archive reads
# nothing from the running instance, so that case is allowed.
RUNNING="$(docker ps --format '{{.Names}}' | grep -E "^($LIVE_STACK-|preloop-oss-)" || true)"
if [ -n "$RUNNING" ] && [ "$VERIFY_ONLY" = 0 ]; then
  echo "The live instance is running. Stop it first, then run this again:" >&2
  echo "  docker stop \$(docker ps --format '{{.Names}}' | grep -E '^($LIVE_STACK-|preloop-oss-)')" >&2
  exit 3
fi

STAGE="$(u "${TMPDIR:-/tmp}")/cadp-restore-$$"
STAGEM="$(m "$STAGE")"
mkdir -p "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# ---------------------------------------------------------------- 1. unpack and check
echo "== unpacking"
docker run --rm -v "$(m "$(dirname "$ARCHIVEU")")":/in:ro -v "$STAGEM":/out -v "$(m "$KEYU")":/key:ro alpine sh -c "
  apk add --no-cache openssl >/dev/null 2>&1
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/key -in '/in/$(basename "$ARCHIVEU")' | tar xzf - -C /out"
say "members" "$(find "$STAGE" -type f | wc -l)"

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
  [ -e "$WORKSPACEU" ] && { echo "refusing: $WORKSPACE already exists" >&2; exit 2; }
  # git here is a native Windows build: it takes native paths, not POSIX ones.
  git clone --quiet "$(m "$CLONE_FROM")" "$(m "$WORKSPACEU")"
  [ -n "$REV" ] && git -C "$(m "$WORKSPACEU")" checkout --quiet "$REV"
  # the repository keeps the stack under poc/281-routing
  [ -d "$WORKSPACEU/poc/281-routing" ] && WORKSPACEU="$WORKSPACEU/poc/281-routing"
  say "cloned" "$(git -C "$(m "$WORKSPACEU")" rev-parse --short HEAD)"
fi
[ -d "$WORKSPACEU" ] || { echo "no such workspace: $WORKSPACE" >&2; exit 2; }
WORKSPACE="$(m "$WORKSPACEU")"
# The restored copy must be able to run under its own name. A revision from before the instance
# name existed would silently start the live instance's containers against this workspace.
grep -q 'STACK:-cadp278' "$WORKSPACEU/docker/compose.poc.yaml" && grep -q 'STACK=' "$WORKSPACEU/scripts/up.sh" || {
  echo "refusing: $WORKSPACE has no instance-name support (STACK) — pick a revision that has it" >&2
  exit 5
}

untar_host() {  # member, destination parent
  [ -f "$STAGE/host/$1.tar.gz" ] || { say "$1" "not in the backup"; return; }
  mkdir -p "$2"
  tar xzf "$STAGE/host/$1.tar.gz" -C "$2"
  say "$1" "-> ${2#$WORKSPACEU/}"
}
untar_host mlflow "$WORKSPACEU/evidence"
untar_host evidence-p281 "$STAGE/tmp-p281" && [ -d "$STAGE/tmp-p281/p281" ] && \
  { rm -rf "$WORKSPACEU/evidence/p281"; mv "$STAGE/tmp-p281/p281" "$WORKSPACEU/evidence/"; }
untar_host evidence-ui-runs "$STAGE/tmp-ui" && [ -d "$STAGE/tmp-ui/ui-runs" ] && \
  { rm -rf "$WORKSPACEU/evidence/ui-runs"; mv "$STAGE/tmp-ui/ui-runs" "$WORKSPACEU/evidence/"; }
untar_host evidence-runs "$STAGE/tmp-runs" && [ -d "$STAGE/tmp-runs/runs" ] && \
  { rm -rf "$WORKSPACEU/evidence/runs"; mv "$STAGE/tmp-runs/runs" "$WORKSPACEU/evidence/"; }
untar_host evidence-conductor-events "$STAGE/tmp-ce" && [ -d "$STAGE/tmp-ce/conductor-events" ] && \
  { rm -rf "$WORKSPACEU/evidence/conductor-events"; mv "$STAGE/tmp-ce/conductor-events" "$WORKSPACEU/evidence/"; }
untar_host config "$STAGE/tmp-cfg" && { rm -rf "$WORKSPACEU/config"; mv "$STAGE/tmp-cfg/config" "$WORKSPACEU/"; }
untar_host policy "$STAGE/tmp-pol" && { rm -rf "$WORKSPACEU/policy"; mv "$STAGE/tmp-pol/policy" "$WORKSPACEU/"; }
RESEARCH_TARGET="$WORKSPACEU/evidence/research"
untar_host research "$STAGE/tmp-res" && { rm -rf "$RESEARCH_TARGET"; mkdir -p "$(dirname "$RESEARCH_TARGET")"
  mv "$STAGE/tmp-res/$(ls "$STAGE/tmp-res" | head -1)" "$RESEARCH_TARGET"; }

# ---------------------------------------------------------------- 3. volumes
echo "== volumes"
for v in route-creds agent-home quota-home; do
  docker volume inspect "$STACK-$v" >/dev/null 2>&1 && \
    { echo "refusing: volume $STACK-$v already exists (remove it or pick another --stack)" >&2; exit 2; }
  docker volume create "$STACK-$v" >/dev/null
  docker run --rm -v "$STACK-$v:/v" -v "$STAGEM/volumes:/in:ro" alpine \
    tar xzf "/in/$v.tar.gz" -C /v
  say "$v" "restored"
done

# ---------------------------------------------------------------- 4. Preloop
echo "== Preloop"
PRELOOP_RESTORE_DIR="$(u "$HOME")/.preloop-restore"
rm -rf "$PRELOOP_RESTORE_DIR"; mkdir -p "$PRELOOP_RESTORE_DIR"
mkdir -p "$STAGE/tmp-preloop"
tar xzf "$STAGE/host/preloop-dir.tar.gz" -C "$STAGE/tmp-preloop"
# the member is the Preloop install directory itself, whose name starts with a dot
PRELOOP_SRC="$(dirname "$(find "$STAGE/tmp-preloop" -maxdepth 2 -name docker-compose.yaml | head -1)")"
cp -a "$PRELOOP_SRC"/. "$PRELOOP_RESTORE_DIR"/
PRELOOP_DIR_M="$(m "$PRELOOP_RESTORE_DIR")"
docker compose --project-directory "$PRELOOP_DIR_M" -p "$PRELOOP_PROJECT" \
  -f "$PRELOOP_DIR_M/docker-compose.yaml" -f "$PRELOOP_DIR_M/docker-compose.auth.yaml" \
  up -d postgres >/dev/null
for i in $(seq 1 30); do
  docker exec "$PRELOOP_PROJECT-postgres-1" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$PRELOOP_PROJECT-postgres-1" psql -U postgres -c "DROP DATABASE IF EXISTS preloop" >/dev/null
docker exec "$PRELOOP_PROJECT-postgres-1" psql -U postgres -c "CREATE DATABASE preloop" >/dev/null
docker exec -i "$PRELOOP_PROJECT-postgres-1" pg_restore -U postgres -d preloop --no-owner < "$STAGE/preloop.dump" >/dev/null 2>&1 || true
TABLES="$(docker exec "$PRELOOP_PROJECT-postgres-1" psql -U postgres -d preloop -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")"
say "database restored" "$TABLES tables"

# ---------------------------------------------------------------- 5. start
echo "== starting the restored instance"
export STACK PRELOOP_PROJECT
export PRELOOP_DIR="$PRELOOP_DIR_M"
export POC_HOST_DIR="$WORKSPACE" RESEARCH_HOST_DIR="$WORKSPACE/evidence/research"
(cd "$WORKSPACEU" && STACK="$STACK" PRELOOP_DIR="$PRELOOP_DIR_M" PRELOOP_PROJECT="$PRELOOP_PROJECT" \
   bash scripts/up.sh)
# what came up must be this instance, not the live one
docker ps --format '{{.Names}}' | grep -q "^$STACK-agent$" || {
  echo "the restored instance did not start under its own name — check $WORKSPACE" >&2; exit 6; }
docker ps --format '{{.Names}}' | grep -qE "^$LIVE_STACK-" && {
  echo "WARNING: containers of the live instance ($LIVE_STACK) are running as well" >&2; }
echo
echo "restored instance : $STACK   (hub http://127.0.0.1:$HUB_PORT, Preloop console http://127.0.0.1:$PRELOOP_CONSOLE_PORT)"
echo "workspace         : $WORKSPACE"
echo "to remove it      : docker compose -f $WORKSPACE/docker/compose.poc.yaml down && \\"
echo "                    docker volume rm $STACK-route-creds $STACK-agent-home $STACK-quota-home $STACK-ws $STACK-quota-obs"
