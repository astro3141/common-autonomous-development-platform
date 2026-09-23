#!/usr/bin/env bash
# One consistent, encrypted backup of everything that cannot be regenerated (OPERATIONS.md §4).
#
#   scripts/backup.sh [--out DIR] [--key FILE] [--no-stop] [--allow-missing]
#
# What it does, in order:
#   1. reads the instance's real paths from the running containers' mounts — never from where this
#      script happens to live — and records the release (revisions, image ids, tool versions, and
#      the row counts of Preloop's key tables);
#   2. stops the writers, so volumes and the database are captured at one point in time;
#   3. dumps Preloop's database, copies each volume and each host path;
#   4. starts everything again;
#   5. writes a manifest (sizes and SHA-256 of every member), then encrypts the archive with
#      AES-256 and removes the plaintext.
#
# A required member that is missing is a failure, not a warning: a backup that quietly holds
# nothing is worse than no backup. --allow-missing downgrades that to a warning, deliberately.
#
# The archive holds provider logins, the Preloop enrolment token and Preloop's key file, so it is
# always encrypted and never written inside the workspace or the repository. The staging directory
# is created with owner-only permissions and removed on every exit path, success or not.
# Losing the key file means losing the backup: keep a copy of it, and of the archive, elsewhere.
set -euo pipefail
export MSYS_NO_PATHCONV=1
u() { if command -v cygpath >/dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
m() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HERE/config/instance.env" ] && . "$HERE/config/instance.env"
STACK="${STACK:-cadp278}"
PRELOOP_PROJECT="${PRELOOP_PROJECT:-preloop-oss}"
PRELOOP_DIR="${PRELOOP_DIR:-$HOME/.preloop-oss}"
OUT="${BACKUP_DIR:-$HOME/cadp-backups}"
KEY="${BACKUP_KEY:-$HOME/.cadp-backup.key}"
STOP=1; ALLOW_MISSING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --no-stop) STOP=0; shift;;          # crash-consistent only; for a dry run, not for keeps
    --allow-missing) ALLOW_MISSING=1; shift;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
OUTU="$(u "$OUT")"; KEYU="$(u "$KEY")"; PRELOOPU="$(u "$PRELOOP_DIR")"
OUT="$(m "$OUTU")"; KEY="$(m "$KEYU")"

say()  { printf '  %-42s %s\n' "$1" "$2"; }
fail() { echo "backup failed: $*" >&2; exit 1; }

AGENT="$STACK-agent"
docker inspect "$AGENT" >/dev/null 2>&1 || fail "no container $AGENT — is this the right instance?"

# ---------------------------------------------------------------- 0. the instance's real paths
# Docker Desktop reports a bind source either as the host path (D:/Work/…) or in the VM's own
# form (/run/desktop/mnt/host/d/Work/…, /host_mnt/d/…). Both must come back as the host path.
norm_host() {
  case "$1" in
    /run/desktop/mnt/host/?/*|/host_mnt/?/*)
      p="${1#/run/desktop/mnt/host/}"; p="${p#/host_mnt/}"
      d="${p%%/*}"; printf '%s:/%s' "$(printf '%s' "$d" | tr 'a-z' 'A-Z')" "${p#*/}";;
    *) printf '%s' "$1";;
  esac
}
mount_src() {  # container, destination
  norm_host "$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1" 2>/dev/null)"
}
POC_DIR="$(mount_src "$AGENT" /work)"
RESEARCH_DIR="$(mount_src "$AGENT" /research)"
MLFLOW_DIR="$(mount_src "$STACK-mlflow" /mlflow)"
[ -n "$POC_DIR" ] || fail "cannot read the workspace mount (/work) of $AGENT"
POC_DIRU="$(u "$POC_DIR")"; RESEARCH_DIRU="$(u "${RESEARCH_DIR:-}")"; MLFLOW_DIRU="$(u "${MLFLOW_DIR:-}")"
echo "== instance"
say "stack" "$STACK"
say "workspace (/work)" "$POC_DIR"
say "research (/research)" "${RESEARCH_DIR:-—}"
say "mlflow (/mlflow)" "${MLFLOW_DIR:-—}"
say "preloop install" "$PRELOOP_DIR"
if [ "$POC_DIRU" != "$(u "$HERE")" ]; then
  echo "  note: this script runs from $HERE, the instance works in $POC_DIR — the mount wins" >&2
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$OUTU"
WORKU="$OUTU/.staging-$TS"; WORK="$(m "$WORKU")"
(umask 077; mkdir -p "$WORKU/volumes" "$WORKU/host")
chmod 700 "$WORKU" 2>/dev/null || true
ARCHIVE="$OUT/cadp-backup-$TS.tar.gz.enc"

STOPPED=""
cleanup() {
  local rc=$?
  [ -n "$STOPPED" ] && { echo "== starting containers again"; docker start $STOPPED >/dev/null 2>&1 || true; STOPPED=""; }
  # nothing readable is left behind, on any exit path
  rm -rf "$WORKU"
  [ $rc -eq 0 ] || echo "backup did not complete; the staging directory was removed" >&2
}
trap cleanup EXIT

if [ ! -f "$KEYU" ]; then
  echo "== backup key: creating $KEY (keep a copy elsewhere; without it no backup can be read)"
  mkdir -p "$(dirname "$KEYU")"
  (umask 077; docker run --rm alpine sh -c 'head -c 48 /dev/urandom | base64 -w0' > "$KEYU")
  chmod 600 "$KEYU" 2>/dev/null || true
fi

# ---------------------------------------------------------------- 1. the release in use
echo "== release in use"
PG="$(docker ps -a --format '{{.Names}}' | grep -E "^$PRELOOP_PROJECT-postgres" | head -1 || true)"
[ -n "$PG" ] || fail "no Preloop postgres container for project $PRELOOP_PROJECT"
docker start "$PG" >/dev/null 2>&1 || true
count() { docker exec "$PG" psql -U postgres -d preloop -tAc "select count(*) from \"$1\"" 2>/dev/null | tr -d '\r' || echo ""; }
# The tool versions are part of the release (OPERATIONS.md §3) and they live in a volume, so they
# are read from the running container. If it is stopped, start it — an empty release is not a
# release, and the writers are stopped again below anyway.
docker start "$AGENT" >/dev/null 2>&1 || true
for i in $(seq 1 15); do docker exec "$AGENT" true >/dev/null 2>&1 && break; sleep 1; done
tool()  { docker exec "$AGENT" sh -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$AGENT")"
{
  echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "stack=$STACK"
  echo "workspace_dir=$POC_DIR"
  echo "research_dir=${RESEARCH_DIR:-}"
  echo "preloop_project=$PRELOOP_PROJECT"
  echo "workspace_revision=$(git -C "$(m "$POC_DIRU")" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "workspace_dirty_files=$(git -C "$(m "$POC_DIRU")" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "tool.claude=$(tool 'claude --version')"
  echo "tool.conductor=$(tool 'conductor --version')"
  echo "tool.preloop_cli=$(tool 'preloop version')"
  echo "tool.codex=$(tool 'codex --version')"
  echo "tool.grok=$(tool 'grok --version')"
  echo "tool.node=$(tool 'node -v')"
  echo "tool.npm_globals=$(tool 'npm ls -g --depth 0 2>/dev/null | tail -n +2 | tr "\n" " "')"
  for c in $(docker ps -a --format '{{.Names}}' | grep -E "^($STACK-|$PRELOOP_PROJECT-)" | sort); do
    echo "image.$c=$(docker inspect -f '{{.Config.Image}}' "$c")@$(docker inspect -f '{{.Image}}' "$c")"
  done
} > "$WORKU/release.kv"

# ---------------------------------------------------------------- 2. quiesce
if [ "$STOP" = 1 ]; then
  echo "== stopping writers"
  STOPPED="$(docker ps --format '{{.Names}}' | grep -E "^($STACK-|$PRELOOP_PROJECT-)" | grep -v -- "-postgres" || true)"
  # Postgres stays up: its dump is taken transactionally, everything else must not write.
  [ -n "$STOPPED" ] && docker stop $STOPPED >/dev/null
  say "stopped" "$(echo "$STOPPED" | wc -w | tr -d ' ') containers"
fi

# ---------------------------------------------------------------- 3. copy
# The row counts a restore is checked against must describe the SAME state as the dump, so they
# are taken after the writers are stopped and immediately before it. Taken earlier, one approval
# arriving in between would make a perfectly good dump look wrong.
echo "== Preloop database"
for t in account user api_key mcp_server approval_request; do
  echo "dbcount.$t=$(count "$t")" >> "$WORKU/release.kv"
done
docker exec "$PG" pg_dump -U postgres -d preloop --format=custom > "$WORKU/preloop.dump" \
  || fail "pg_dump failed"
[ -s "$WORKU/preloop.dump" ] || fail "the database dump is empty"
say "preloop.dump" "$(du -h "$WORKU/preloop.dump" | cut -f1)"

# real JSON, written and parsed by a JSON library — not by string concatenation
docker run --rm -i -v "$WORK:/w" --entrypoint /opt/venv/bin/python "$IMAGE" - <<'PY'
import json
out, tools, images, counts = {}, {}, {}, {}
for line in open("/w/release.kv", encoding="utf-8"):
    k, _, v = line.rstrip("\n").partition("=")
    if k.startswith("tool."):      tools[k[5:]] = v
    elif k.startswith("image."):   images[k[6:]] = v
    elif k.startswith("dbcount."): counts[k[8:]] = int(v) if v.strip().isdigit() else None
    elif k:                        out[k] = v
out.update({"tools": tools, "images": images, "db_row_counts": counts})
with open("/w/release.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent=1, sort_keys=True)
json.load(open("/w/release.json", encoding="utf-8"))      # parses, or this backup fails
print("release.json ok")
PY
rm -f "$WORKU/release.kv"
MISSING=""
for t in claude conductor preloop_cli codex grok node; do
  grep -q "\"$t\": \"[^\"]" "$WORKU/release.json" || MISSING="$MISSING release:tool.$t"
done
for t in account user api_key mcp_server approval_request; do
  grep -q "\"$t\": [0-9]" "$WORKU/release.json" || MISSING="$MISSING release:dbcount.$t"
done
say "release recorded" "$(grep -o '"workspace_revision": "[^"]*"' "$WORKU/release.json" | cut -d'"' -f4 | cut -c1-8)"

echo "== volumes"
for v in route-creds agent-home quota-home; do
  docker volume inspect "$STACK-$v" >/dev/null 2>&1 || { MISSING="$MISSING volume:$STACK-$v"; say "$v" "MISSING"; continue; }
  docker run --rm -v "$STACK-$v:/v:ro" -v "$WORK/volumes:/out" alpine \
    tar czf "/out/$v.tar.gz" -C /v . 2>/dev/null || fail "could not copy volume $STACK-$v"
  say "$v" "$(du -h "$WORKU/volumes/$v.tar.gz" | cut -f1)"
done
# quota-obs and ws are regenerated (OPERATIONS.md §4) and are not copied.

echo "== host paths"
copy_dir() {  # source (POSIX path), name, required(yes/no)
  if [ -z "$1" ] || [ ! -d "$1" ]; then
    say "$2" "MISSING ($1)"
    [ "$3" = yes ] && MISSING="$MISSING $2"
    return 0
  fi
  tar czf "$WORKU/host/$2.tar.gz" -C "$(dirname "$1")" "$(basename "$1")" || fail "could not copy $1"
  say "$2" "$(du -h "$WORKU/host/$2.tar.gz" | cut -f1)"
}
copy_dir "$MLFLOW_DIRU" mlflow yes                   # SQLite database and artifacts together
copy_dir "$POC_DIRU/evidence/p281" evidence-p281 no
copy_dir "$POC_DIRU/evidence/ui-runs" evidence-ui-runs no
copy_dir "$POC_DIRU/evidence/runs" evidence-runs no
copy_dir "$POC_DIRU/evidence/conductor-events" evidence-conductor-events no
copy_dir "$POC_DIRU/config" config yes               # sources and generated/state.json together
copy_dir "$POC_DIRU/policy" policy yes
copy_dir "$RESEARCH_DIRU" research yes
copy_dir "$PRELOOPU" preloop-dir yes                 # compose files and .env (keys!)

if [ -n "$MISSING" ]; then
  if [ "$ALLOW_MISSING" = 1 ]; then
    echo "  WARNING: required members missing:$MISSING (--allow-missing)" >&2
  else
    fail "required members missing:$MISSING"
  fi
fi

[ -n "$STOPPED" ] && { echo "== starting containers again"; docker start $STOPPED >/dev/null 2>&1 || true; STOPPED=""; }

# ---------------------------------------------------------------- 4. manifest, pack, encrypt
echo "== manifest"
docker run --rm -v "$WORK:/w" alpine sh -c '
  cd /w && { echo "member  bytes  sha256";
  find . -type f ! -name manifest.txt | sort | while read -r f; do
    printf "%s  %s  %s\n" "${f#./}" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d" " -f1)";
  done; } > manifest.txt'
say "members" "$(($(wc -l < "$WORKU/manifest.txt") - 1))"

echo "== packing and encrypting"
docker run --rm -v "$WORK:/w:ro" -v "$OUT:/out" -v "$KEY:/key:ro" alpine sh -c '
  apk add --no-cache openssl >/dev/null 2>&1
  tar czf - -C /w . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:/key \
    -out "/out/'"$(basename "$ARCHIVE")"'"' || fail "packing failed"
cp "$WORKU/manifest.txt" "$OUTU/cadp-backup-$TS.manifest.txt"
cp "$WORKU/release.json" "$OUTU/cadp-backup-$TS.release.json"

echo
echo "archive : $ARCHIVE  ($(du -h "$OUTU/$(basename "$ARCHIVE")" | cut -f1))"
echo "manifest: $OUT/cadp-backup-$TS.manifest.txt"
echo "key     : $KEY  (not in the archive — keep it somewhere else too)"
