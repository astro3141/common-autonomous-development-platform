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
POC_HOST_DIR="${POC_HOST_DIR:-$HERE}"
RESEARCH_HOST_DIR="${RESEARCH_HOST_DIR:-$HERE/evidence/research}"
export STACK POC_HOST_DIR RESEARCH_HOST_DIR
VOLUMES=0; [ "${1:-}" = "--volumes" ] && VOLUMES=1

echo "instance : $STACK   (Preloop project $PRELOOP_PROJECT)"
echo "workspace: $POC_HOST_DIR"
echo "== stopping"
(cd "$HERE/docker" && docker compose -f compose.poc.yaml down) || exit 1
docker compose --project-directory "$PRELOOP_DIR" -p "$PRELOOP_PROJECT" \
  -f "$PRELOOP_DIR/docker-compose.yaml" -f "$PRELOOP_DIR/docker-compose.auth.yaml" down || exit 1

if [ "$VOLUMES" = 1 ]; then
  VOLS="$(docker volume ls --format '{{.Name}}' | grep -E "^($STACK-|${PRELOOP_PROJECT}_)" || true)"
  if [ -z "$VOLS" ]; then
    echo "== no volumes of $STACK left"
  else
    echo "== removing the volumes of $STACK (logins, Preloop database, agent home):"
    echo "$VOLS" | sed 's/^/     /'
    docker volume rm $VOLS >/dev/null && echo "  removed"
  fi
fi
