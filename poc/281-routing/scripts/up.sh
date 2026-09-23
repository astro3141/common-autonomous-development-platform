#!/usr/bin/env bash
# Bring the whole stack up (or back after a restart / recreate) and check it.
#
#   scripts/up.sh            up + check
#   scripts/up.sh --check    check only
#   scripts/up.sh --recreate up with --force-recreate (the "survives recreation" test)
#
# No manual step afterwards: Preloop joins the PoC networks through docker/preloop.cadp.yaml,
# every PoC container restarts on its own, the quota observer's loop is its container process,
# and logins / Preloop's database / MLflow live in volumes or bind mounts.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# A workspace that is a restored copy says so in config/instance.env (written by scripts/
# restore.sh): its instance name, Preloop project, paths and ports. Reading it here is what keeps
# a later `up.sh --check` or `down.sh` in that directory from acting on the live instance instead.
# Values already set in the environment win, so a deliberate override still works.
if [ -f "$HERE/config/instance.env" ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|'#'*) continue;; esac
    eval "[ -n \"\${$k:-}\" ]" || eval "$k=\$v"
  done < "$HERE/config/instance.env"
fi
PRELOOP_DIR="${PRELOOP_DIR:-$HOME/.preloop-oss}"
# docker on Windows needs native paths; path conversion is off below (MSYS_NO_PATHCONV)
command -v cygpath >/dev/null && { PRELOOP_DIR="$(cygpath -m "$PRELOOP_DIR")"; HERE="$(cygpath -m "$HERE")"; }
export MSYS_NO_PATHCONV=1
MODE="${1:-up}"
# One instance per name: STACK selects container/volume/network names and the published ports.
# The defaults are the live instance; a restored copy runs under another name (scripts/restore.sh).
STACK="${STACK:-cadp278}"
OPS_PORT="${OPS_PORT:-8781}"; HUB_PORT="${HUB_PORT:-8780}"; MLFLOW_PORT="${MLFLOW_PORT:-5000}"
PRELOOP_PROJECT="${PRELOOP_PROJECT:-preloop-oss}"
PRELOOP_API_PORT="${PRELOOP_API_PORT:-8000}"; PRELOOP_GATEWAY_PORT="${PRELOOP_GATEWAY_PORT:-8001}"
PRELOOP_CONSOLE_PORT="${PRELOOP_CONSOLE_PORT:-3000}"
# Paths are NOT defaulted here. Compose reads docker/.env (this host's own paths) and falls back
# to the relative defaults in compose.poc.yaml; a shell variable would win over both, so one is
# exported only when something actually set it — the environment, or a restored workspace's
# config/instance.env. See docs.docker.com/compose/how-tos/environment-variables/.
export STACK OPS_PORT HUB_PORT MLFLOW_PORT
[ -n "${POC_HOST_DIR:-}" ] && export POC_HOST_DIR
[ -n "${RESEARCH_HOST_DIR:-}" ] && export RESEARCH_HOST_DIR
export PRELOOP_API_PORT PRELOOP_GATEWAY_PORT PRELOOP_CONSOLE_PORT
FORCE=""; [ "$MODE" = "--recreate" ] && FORCE="--force-recreate"

if [ "$MODE" != "--check" ]; then
  echo "== PoC stack"
  (cd "$HERE/docker" && docker compose -f compose.poc.yaml up -d $FORCE) || exit 1
  echo "== Preloop (+ PoC network attachment)"
  docker compose --project-directory "$PRELOOP_DIR" -p "$PRELOOP_PROJECT" \
    -f "$PRELOOP_DIR/docker-compose.yaml" -f "$PRELOOP_DIR/docker-compose.auth.yaml" \
    -f "$HERE/docker/preloop.cadp.yaml" up -d $FORCE || exit 1
  sleep 8
fi

fail=0
FAILED=""
check() {  # name, expected, actual
  if [ "$2" = "$3" ]; then printf '  ok    %-44s %s\n' "$1" "$3"
  else printf '  FAIL  %-44s expected %s, got %s\n' "$1" "$2" "$3"; fail=1
       FAILED="$FAILED{\"check\":\"$1\",\"expected\":\"$2\",\"got\":\"$3\"},"; fi
}
in_agent() { docker exec "$STACK-agent" sh -c "$1" 2>/dev/null; }

echo "== isolation"
check "agent default routes"            0   "$(in_agent 'ip route | grep -c default')"
check "agent direct egress"             000 "$(in_agent 'curl -s -o /dev/null -w %{http_code} --max-time 5 https://pypi.org')"
check "egress proxy refuses non-provider" 000 "$(in_agent 'curl -s -o /dev/null -w %{http_code} --max-time 8 -x http://egress:8888 https://github.com')"
echo "== services"
check "Preloop MCP (auth required)"      401 "$(in_agent 'curl -s -o /dev/null -w %{http_code} http://console/mcp/v1')"
check "Preloop api"                      200 "$(in_agent 'curl -s -o /dev/null -w %{http_code} http://api:8000/api/v1/openapi.json')"
check "MLflow"                           200 "$(in_agent 'curl -s -o /dev/null -w %{http_code} http://mlflow:5000/health')"
check "ops API (127.0.0.1:$OPS_PORT)"      true "$(curl -s --max-time 5 http://127.0.0.1:$OPS_PORT/api/health | grep -q '"ok": true' && echo true || echo false)"
check "hub UI (127.0.0.1:$HUB_PORT)"        200 "$(curl -s -o /dev/null -w %{http_code} --max-time 5 http://127.0.0.1:$HUB_PORT/)"
check "hub has no Docker access"          none "$(docker inspect "$STACK-hub" --format '{{if .Mounts}}mounted{{else}}none{{end}}' 2>/dev/null)"
check "provider host via proxy (TLS up)" yes "$(in_agent 'c=$(curl -s -o /dev/null -w %{http_code} --max-time 10 -x http://egress:8888 https://api.anthropic.com); [ "$c" != 000 ] && echo yes || echo no')"
check "fsmcp tools exposed via Preloop"  yes "$(in_agent 'python3 /work/p281/mcp_list.py claude | grep -q write_file && echo yes || echo no')"
echo "== logins (routing layer)"
check "claude /route login"              true "$(in_agent 'CLAUDE_CONFIG_DIR=/route/claude claude auth status 2>/dev/null | python3 -c "import json,sys;print(str(json.load(sys.stdin).get(\"loggedIn\")).lower())"')"
check "codex /route login"               yes "$(in_agent 'CODEX_HOME=/route/codex codex login status 2>&1 | grep -q "Logged in" && echo yes || echo no')"
check "grok /route login"                yes "$(in_agent 'test -s /route/grok/auth.json && echo yes || echo no')"
check "observer codex login"             yes "$(docker exec "$STACK-quota" sh -c 'codex login status 2>&1 | grep -q "Logged in" && echo yes || echo no' 2>/dev/null)"
echo "== quota observer"
check "observation fresh (< 10 min)"     yes "$(in_agent 'python3 -c "
import json,datetime as d
r=json.load(open(\"/obs/codex.raw.json\")); t=d.datetime.fromisoformat(r[\"collected_at\"].replace(\"Z\",\"+00:00\"))
print(\"yes\" if r.get(\"exit\")==0 and (d.datetime.now(d.timezone.utc)-t).total_seconds()<600 else \"no\")"')"
echo
# Leave the result where the screen can read it: when the checks last ran and what failed.
# A check that has not run for a long time is itself worth seeing.
mkdir -p "$HERE/evidence/checks"
printf '{"at":"%s","stack":"%s","ok":%s,"failed":[%s]}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STACK" "$([ $fail = 0 ] && echo true || echo false)" \
  "${FAILED%,}" > "$HERE/evidence/checks/last.json"

[ $fail = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
