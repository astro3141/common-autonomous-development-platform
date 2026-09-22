#!/usr/bin/env bash
# One consistent, encrypted backup of everything that cannot be regenerated (OPERATIONS.md §4).
#
#   scripts/backup.sh [--out DIR] [--key FILE] [--no-stop]
#
# What it does, in order:
#   1. records the release in use (revisions, image ids, tool versions read from the containers);
#   2. stops the writers, so volumes and the database are captured at one point in time;
#   3. dumps Preloop's database, copies each volume and each host path;
#   4. starts everything again;
#   5. writes a manifest (sizes and SHA-256 of every member, no secret values), then encrypts
#      the archive with AES-256 and removes the plaintext.
#
# The archive holds provider logins, the Preloop enrolment token and Preloop's key file, so it is
# always encrypted and never written inside the workspace or the repository. Losing the key file
# means losing the backup: keep a copy of it, and of the archive, on separate media.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
command -v cygpath >/dev/null && HERE="$(cygpath -m "$HERE")"
export MSYS_NO_PATHCONV=1

STACK="${STACK:-cadp278}"
PRELOOP_DIR="${PRELOOP_DIR:-$HOME/.preloop-oss}"
PRELOOP_PROJECT="${PRELOOP_PROJECT:-preloop-oss}"
RESEARCH_DIR="${RESEARCH_HOST_DIR:-D:/Work/research-280}"
OUT="${BACKUP_DIR:-$HOME/cadp-backups}"
KEY="${BACKUP_KEY:-$HOME/.cadp-backup.key}"
STOP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --no-stop) STOP=0; shift;;          # crash-consistent only; for a dry run, not for keeps
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
command -v cygpath >/dev/null && { OUT="$(cygpath -m "$OUT")"; KEY="$(cygpath -m "$KEY")"; \
                                   PRELOOP_DIR="$(cygpath -m "$PRELOOP_DIR")"; }
# Docker needs native paths (D:/...); the shell's own tar reads "D:/..." as a remote host, so
# every native file operation below uses the POSIX form instead.
u() { if command -v cygpath >/dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
OUTU="$(u "$OUT")"; HEREU="$(u "$HERE")"; RESEARCHU="$(u "$RESEARCH_DIR")"; PRELOOPU="$(u "$PRELOOP_DIR")"

TS="$(date -u +%Y%m%d-%H%M%S)"
WORK="$OUT/.staging-$TS"; WORKU="$OUTU/.staging-$TS"
ARCHIVE="$OUT/cadp-backup-$TS.tar.gz.enc"
mkdir -p "$WORKU/volumes" "$WORKU/host"

if [ ! -f "$KEY" ]; then
  echo "== backup key: creating $KEY (keep a copy elsewhere; without it no backup can be read)"
  mkdir -p "$(dirname "$KEY")"
  docker run --rm alpine sh -c 'head -c 48 /dev/urandom | base64 -w0' > "$KEY"
  chmod 600 "$KEY" 2>/dev/null || true
fi

say() { printf '  %-42s %s\n' "$1" "$2"; }

# ---------------------------------------------------------------- 1. the release in use
echo "== release in use"
AGENT="$STACK-agent"
tool() { docker exec "$AGENT" sh -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
{
  echo "{"
  echo "  \"taken_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"stack\": \"$STACK\","
  echo "  \"workspace_revision\": \"$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo unknown)\","
  echo "  \"workspace_dirty_files\": $(git -C "$HERE" status --porcelain 2>/dev/null | wc -l),"
  echo "  \"images\": {"
  first=1
  for c in $(docker ps -a --format '{{.Names}}' | grep -E "^($STACK|$PRELOOP_PROJECT)" | sort); do
    [ $first -eq 1 ] || echo ","
    first=0
    printf '    "%s": {"image": "%s", "id": "%s"}' "$c" \
      "$(docker inspect -f '{{.Config.Image}}' "$c")" "$(docker inspect -f '{{.Image}}' "$c")"
  done
  echo ""
  echo "  },"
  echo "  \"tools\": {"
  echo "    \"claude\": \"$(tool 'claude --version')\","
  echo "    \"conductor\": \"$(tool 'conductor --version')\","
  echo "    \"preloop_cli\": \"$(tool 'preloop version')\","
  echo "    \"codex\": \"$(tool 'codex --version')\","
  echo "    \"grok\": \"$(tool 'grok --version')\","
  echo "    \"node\": \"$(tool 'node -v')\","
  echo "    \"npm_globals\": \"$(tool 'npm ls -g --depth 0 --json 2>/dev/null | tr -d "\n " | cut -c1-400')\""
  echo "  }"
  echo "}"
} > "$WORKU/release.json"
say "release recorded" "$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ---------------------------------------------------------------- 2. quiesce
STOPPED=""
if [ "$STOP" = 1 ]; then
  echo "== stopping writers"
  STOPPED="$(docker ps --format '{{.Names}}' | grep -E "^($STACK-|$PRELOOP_PROJECT-)" | grep -v -- "-postgres" || true)"
  # Postgres stays up: its dump is taken transactionally, everything else must not write.
  [ -n "$STOPPED" ] && docker stop $STOPPED >/dev/null
  say "stopped" "$(echo "$STOPPED" | wc -w) containers"
fi
restart_all() {
  if [ -n "$STOPPED" ]; then
    echo "== starting containers again"
    docker start $STOPPED >/dev/null 2>&1 || true
  fi
}
trap restart_all EXIT

# ---------------------------------------------------------------- 3. copy
echo "== Preloop database"
PG="$(docker ps -a --format '{{.Names}}' | grep -E "^$PRELOOP_PROJECT-postgres" | head -1)"
docker start "$PG" >/dev/null 2>&1 || true
docker exec "$PG" pg_dump -U postgres -d preloop --format=custom > "$WORKU/preloop.dump"
say "preloop.dump" "$(du -h "$WORKU/preloop.dump" | cut -f1)"

echo "== volumes"
for v in route-creds agent-home quota-home; do
  docker run --rm -v "$STACK-$v:/v:ro" -v "$WORK/volumes:/out" alpine \
    tar czf "/out/$v.tar.gz" -C /v . 2>/dev/null
  say "$v" "$(du -h "$WORKU/volumes/$v.tar.gz" | cut -f1)"
done
# quota-obs and ws are regenerated (OPERATIONS.md §4) and are not copied.

echo "== host paths"
copy_dir() {  # source (POSIX path), name
  [ -d "$1" ] || { say "$2" "absent, skipped"; return; }
  tar czf "$WORKU/host/$2.tar.gz" -C "$(dirname "$1")" "$(basename "$1")"
  say "$2" "$(du -h "$WORKU/host/$2.tar.gz" | cut -f1)"
}
copy_dir "$HEREU/evidence/mlflow" mlflow            # SQLite database and artifacts together
copy_dir "$HEREU/evidence/p281" evidence-p281
copy_dir "$HEREU/evidence/ui-runs" evidence-ui-runs
copy_dir "$HEREU/evidence/runs" evidence-runs
copy_dir "$HEREU/evidence/conductor-events" evidence-conductor-events
copy_dir "$HEREU/config" config                      # sources and generated/state.json together
copy_dir "$HEREU/policy" policy
copy_dir "$RESEARCHU" research
copy_dir "$PRELOOPU" preloop-dir                 # compose files and .env (keys!)

restart_all
trap - EXIT

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
    -out "/out/'"$(basename "$ARCHIVE")"'"'
cp "$WORKU/manifest.txt" "$OUTU/cadp-backup-$TS.manifest.txt"
cp "$WORKU/release.json" "$OUTU/cadp-backup-$TS.release.json"
rm -rf "$WORKU"

echo
echo "archive : $ARCHIVE  ($(du -h "$OUTU/$(basename "$ARCHIVE")" | cut -f1))"
echo "manifest: $OUT/cadp-backup-$TS.manifest.txt"
echo "key     : $KEY  (not in the archive — keep it somewhere else too)"
