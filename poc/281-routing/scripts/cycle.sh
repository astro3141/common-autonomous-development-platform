#!/usr/bin/env bash
# One unattended cycle, for a scheduler to call.
#
#   scripts/cycle.sh <workflow> [profile] [--retain-days N] [--retain-keep M] [--allow-unrecorded]
#
# What this adds over starting a run by hand, and why each part exists for long operation:
#
#   * **one at a time.** A scheduler that fires while the last cycle is still going must not start
#     a second one: the two would share logins and workspaces. A busy invocation is skipped, not
#     queued — a cycle that is late is worth less than the one already running, and a queue of them
#     would arrive together later.
#   * **it refuses rather than pretends.** The capabilities are checked before starting
#     (p281/capabilities.py, through run_workflow.py): a cycle that cannot be governed or recorded
#     does not run, and says which capability was missing.
#   * **it leaves an operations record.** One line per cycle in evidence/ops/cycles.jsonl: when,
#     which run, how long, how it ended, and what the stack could do at the time. That file is the
#     thing to read after a week of unattended operation.
#   * **retention, if asked.** Nothing is deleted by default. With --retain-days / --retain-keep it
#     runs the same cleanup as by hand (whole runs, live runs and pending approvals protected) and
#     records what went.
#
# Exit codes are for the scheduler: 0 = a cycle ran (whatever the workflow decided) or one was
# already running; 3 = the stack could not run it; 1 = the runner itself failed.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
command -v cygpath >/dev/null && HERE="$(cygpath -m "$HERE")"
export MSYS_NO_PATHCONV=1
[ -f "$HERE/config/instance.env" ] && . "$HERE/config/instance.env"
STACK="${STACK:-cadp278}"
PY=/opt/venv/bin/python

WORKFLOW="${1:-trading-b}"; shift || true
PROFILE="research-default"
RETAIN_DAYS=""; RETAIN_KEEP=""; UNRECORDED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --retain-days) RETAIN_DAYS="${2:-}"; shift 2;;
    --retain-keep) RETAIN_KEEP="${2:-}"; shift 2;;
    --allow-unrecorded) UNRECORDED="--allow-unrecorded"; shift;;
    -*) echo "unknown argument: $1" >&2; exit 2;;
    *) PROFILE="$1"; shift;;
  esac
done

mkdir -p "$HERE/evidence/ops"
LOCKDIR="$HERE/evidence/ops/.cycle.lock.d"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # This script never decides that the other cycle is dead: two cycles at once would share logins
  # and workspaces, which is the failure worth avoiding. But a lock left behind by a killed run
  # would skip every cycle from then on, silently — so the skip carries the lock's age, and
  # p281/ops_health.py shows it. Clearing it stays an operator's decision.
  held_since="$(cat "$LOCKDIR/started" 2>/dev/null || echo unknown)"
  age=$(( $(date +%s) - $(cat "$LOCKDIR/started_epoch" 2>/dev/null || date +%s) ))
  echo "busy: a cycle has been running since $held_since (${age}s) — lock: $LOCKDIR"
  printf '{"at":"%s","workflow":"%s","skipped":"busy","lock_since":"%s","lock_age_s":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WORKFLOW" "$held_since" "$age" \
    >> "$HERE/evidence/ops/cycles.jsonl"
  exit 0
fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCKDIR/started"
date +%s > "$LOCKDIR/started_epoch"
echo $$ > "$LOCKDIR/pid"
trap 'rm -f "$LOCKDIR"/started "$LOCKDIR"/started_epoch "$LOCKDIR"/pid; rmdir "$LOCKDIR" 2>/dev/null' EXIT

UI="cyc-$(date -u +%Y%m%d-%H%M%S)"
t0=$(date +%s)
start_out="$(docker exec "$STACK-agent" sh -c \
  "cd /work && $PY p281/run_workflow.py start $UI $WORKFLOW $PROFILE $UNRECORDED" 2>&1)"
rc=$?
t1=$(date +%s)

if [ $rc -eq 3 ]; then
  echo "refused: $start_out"
  printf '{"at":"%s","workflow":"%s","ui":"%s","refused":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WORKFLOW" "$UI" "$start_out" >> "$HERE/evidence/ops/cycles.jsonl"
  exit 3
fi

outcome="$(docker exec "$STACK-agent" "$PY" /work/p281/soak_outcome.py "$UI" 2>/dev/null)"
[ -n "$outcome" ] || outcome='{"state":"unknown"}'
printf '{"at":"%s","workflow":"%s","ui":"%s","seconds":%s,"outcome":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WORKFLOW" "$UI" "$((t1-t0))" "$outcome" \
  >> "$HERE/evidence/ops/cycles.jsonl"
echo "$UI  $((t1-t0))s  $outcome"

if [ -n "$RETAIN_DAYS$RETAIN_KEEP" ]; then
  set -- --apply --json
  [ -n "$RETAIN_DAYS" ] && set -- "$@" --days "$RETAIN_DAYS"
  [ -n "$RETAIN_KEEP" ] && set -- "$@" --keep "$RETAIN_KEEP"
  removed="$(docker exec "$STACK-agent" "$PY" /work/p281/cleanup.py "$@" 2>&1 | tail -1)"
  printf '{"at":"%s","retention":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${removed:-null}" \
    >> "$HERE/evidence/ops/cycles.jsonl"
  echo "retention: $removed"
fi

[ $rc -eq 0 ] || exit 1
