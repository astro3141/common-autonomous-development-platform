#!/usr/bin/env bash
# Stop the instance THIS workspace belongs to — the one named in config/instance.env if that file
# exists (a restored copy), otherwise the live one.
#
#   scripts/down.sh [--volumes]
#
# --volumes also deletes that instance's volumes: its provider logins, its Preloop database and
# its agent home. It prints exactly what it will remove and refuses anything named differently.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$HERE/config/instance.env" ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|'#'*) continue;; esac
    eval "[ -n \"\${$k:-}\" ]" || eval "$k=\$v"
  done < "$HERE/config/instance.env"
fi
PRELOOP_DIR="${PRELOOP_DIR:-$HOME/.preloop-oss}"
command -v cygpath >/dev/null && { PRELOOP_DIR="$(cygpath -m "$PRELOOP_DIR")"; HERE="$(cygpath -m "$HERE")"; }
export MSYS_NO_PATHCONV=1
STACK="${STACK:-cadp278}"
PRELOOP_PROJECT="${PRELOOP_PROJECT:-preloop-oss}"
# as in up.sh: never default a path here, or it would win over docker/.env
export STACK
[ -n "${POC_HOST_DIR:-}" ] && export POC_HOST_DIR
[ -n "${RESEARCH_HOST_DIR:-}" ] && export RESEARCH_HOST_DIR
VOLUMES=0; [ "${1:-}" = "--volumes" ] && VOLUMES=1

echo "instance : $STACK   (Preloop project $PRELOOP_PROJECT)"
echo "workspace: ${POC_HOST_DIR:-$HERE (compose defaults / docker/.env)}"
echo "== stopping"
(cd "$HERE/docker" && docker compose -f compose.poc.yaml down) || exit 1
docker compose --project-directory "$PRELOOP_DIR" -p "$PRELOOP_PROJECT" \
  -f "$PRELOOP_DIR/docker-compose.yaml" -f "$PRELOOP_DIR/docker-compose.auth.yaml" down || exit 1

if [ "$VOLUMES" = 1 ]; then
  # Exact names only. A prefix match would also take another instance's volumes: with
  # STACK=cadp278r, "cadp278r-second-route-creds" starts with "cadp278r-" too.
  VOLS=""
  for n in "$STACK-agent-home" "$STACK-ws" "$STACK-quota-home" "$STACK-route-creds" \
           "$STACK-quota-obs" "${PRELOOP_PROJECT}_postgres-data"; do
    docker volume inspect "$n" >/dev/null 2>&1 && VOLS="$VOLS $n"
  done
  if [ -z "$VOLS" ]; then
    echo "== no volumes of $STACK left"
  else
    echo "== removing the volumes of $STACK (logins, Preloop database, agent home):"
    for n in $VOLS; do echo "     $n"; done
    docker volume rm $VOLS >/dev/null && echo "  removed"
  fi
fi
