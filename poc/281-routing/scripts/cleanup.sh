#!/usr/bin/env bash
# Remove old runs — as whole runs. Preview by default; --apply to act.
#
#   scripts/cleanup.sh [--days N] [--keep N] [--apply] [--include-orphans] [--json]
#
# The work is done by p281/cleanup.py inside the agent container, which is the only place that
# sees all three traces of a run (the screen's record, the workspace, the adapter's evidence).
# A run that is still going, that Preloop is waiting on, or that carries a `keep` file is never
# removed. See OPERATIONS.md §9.
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HERE/config/instance.env" ] && . "$HERE/config/instance.env"
export MSYS_NO_PATHCONV=1
STACK="${STACK:-cadp278}"
exec docker exec "$STACK-agent" /opt/venv/bin/python /work/p281/cleanup.py "$@"
