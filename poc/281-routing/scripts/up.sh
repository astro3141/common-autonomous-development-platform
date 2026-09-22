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
PRELOOP_DIR="${PRELOOP_DIR:-$HOME/.preloop-oss}"
# docker on Windows needs native paths; path conversion is off below (MSYS_NO_PATHCONV)
command -v cygpath >/dev/null && { PRELOOP_DIR="$(cygpath -m "$PRELOOP_DIR")"; HERE="$(cygpath -m "$HERE")"; }
export MSYS_NO_PATHCONV=1
MODE="${1:-up}"
FORCE=""; [ "$MODE" = "--recreate" ] && FORCE="--force-recreate"

if [ "$MODE" != "--check" ]; then
  echo "== PoC stack"
  (cd "$HERE/docker" && docker compose -f compose.poc.yaml up -d $FORCE) || exit 1
  echo "== Preloop (+ PoC network attachment)"
  docker compose --project-directory "$PRELOOP_DIR" -p preloop-oss \
    -f "$PRELOOP_DIR/docker-compose.yaml" -f "$PRELOOP_DIR/docker-compose.auth.yaml" \
    -f "$HERE/docker/preloop.cadp.yaml" up -d $FORCE || exit 1
  sleep 8
fi

fail=0
check() {  # name, expected, actual
  if [ "$2" = "$3" ]; then printf '  ok    %-44s %s\n' "$1" "$3"
  else printf '  FAIL  %-44s expected %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}
in_agent() { docker exec cadp278-agent sh -c "$1" 2>/dev/null; }

echo "== isolation"
check "agent default routes"            0   "$(in_agent 'ip route | grep -c default')"
check "agent direct egress"             000 "$(in_agent 'curl -s -o /dev/null -w %{http_code} --max-time 5 https://pypi.org')"
check "egress proxy refuses non-provider" 000 "$(in_agent 'curl -s -o /dev/null -w %{http_code} --max-time 8 -x http://egress:8888 https://github.com')"
echo "== services"
check "Preloop MCP (auth required)"      401 "$(in_agent 'curl -s -o /dev/null -w %{http_code} http://console/mcp/v1')"
check "Preloop api"                      200 "$(in_agent 'curl -s -o /dev/null -w %{http_code} http://api:8000/api/v1/openapi.json')"
check "MLflow"                           200 "$(in_agent 'curl -s -o /dev/null -w %{http_code} http://mlflow:5000/health')"
check "ops API (127.0.0.1:8781)"          true "$(curl -s --max-time 5 http://127.0.0.1:8781/api/health | grep -q '"ok": true' && echo true || echo false)"
check "hub UI (127.0.0.1:8780)"            200 "$(curl -s -o /dev/null -w %{http_code} --max-time 5 http://127.0.0.1:8780/)"
check "hub has no Docker access"          none "$(docker inspect cadp278-hub --format '{{if .Mounts}}mounted{{else}}none{{end}}' 2>/dev/null)"
check "provider host via proxy (TLS up)" yes "$(in_agent 'c=$(curl -s -o /dev/null -w %{http_code} --max-time 10 -x http://egress:8888 https://api.anthropic.com); [ "$c" != 000 ] && echo yes || echo no')"
check "fsmcp tools exposed via Preloop"  yes "$(in_agent 'python3 /work/p281/mcp_list.py claude | grep -q write_file && echo yes || echo no')"
echo "== logins (routing layer)"
check "claude /route login"              true "$(in_agent 'CLAUDE_CONFIG_DIR=/route/claude claude auth status 2>/dev/null | python3 -c "import json,sys;print(str(json.load(sys.stdin).get(\"loggedIn\")).lower())"')"
check "codex /route login"               yes "$(in_agent 'CODEX_HOME=/route/codex codex login status 2>&1 | grep -q "Logged in" && echo yes || echo no')"
check "grok /route login"                yes "$(in_agent 'test -s /route/grok/auth.json && echo yes || echo no')"
check "observer codex login"             yes "$(docker exec cadp278-quota sh -c 'codex login status 2>&1 | grep -q "Logged in" && echo yes || echo no' 2>/dev/null)"
echo "== quota observer"
check "observation fresh (< 10 min)"     yes "$(in_agent 'python3 -c "
import json,datetime as d
r=json.load(open(\"/obs/codex.raw.json\")); t=d.datetime.fromisoformat(r[\"collected_at\"].replace(\"Z\",\"+00:00\"))
print(\"yes\" if r.get(\"exit\")==0 and (d.datetime.now(d.timezone.utc)-t).total_seconds()<600 else \"no\")"')"
echo
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
