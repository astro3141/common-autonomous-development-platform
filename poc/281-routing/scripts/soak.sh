#!/usr/bin/env bash
# Run the same workflow many times in a row and record what the stack does over that time.
#
#   scripts/soak.sh <cycles> <workflow> [profile]
#
# Everything measured so far has been a single run. Long operation is a different question — what
# grows, what leaks, what degrades after the tenth cycle — and it cannot be answered by reasoning
# about the code. This runs the cycles back to back and samples, before and after each one:
#
#   * every container's memory (from the host, where Docker can be asked)
#   * disk under the run workspace, the evidence tree, MLflow's own store
#   * how many run workspaces, evidence directories and UI runs exist
#   * the outcome and wall time of the cycle itself, and the router's quota view
#
# It writes evidence/soak/<id>/samples.jsonl (one line per sample) and summary.json (first vs last,
# with the per-cycle series). It changes nothing: no cleanup runs, so growth is growth.
#
# One soak at a time — a second one would measure the first.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
command -v cygpath >/dev/null && HERE="$(cygpath -m "$HERE")"
export MSYS_NO_PATHCONV=1

CYCLES="${1:-5}"
WORKFLOW="${2:-trading-b}"
PROFILE="${3:-research-default}"
STACK="${STACK:-cadp278}"
PY=/opt/venv/bin/python

mkdir -p "$HERE/evidence/soak"
# mkdir is the atomic primitive available everywhere this runs (Git Bash on Windows has no flock)
LOCKDIR="$HERE/evidence/soak/.lock.d"
mkdir "$LOCKDIR" 2>/dev/null || { echo "another soak is running (or $LOCKDIR is stale)"; exit 2; }
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

ID="$(date -u +%Y%m%d-%H%M%S)"
OUT="$HERE/evidence/soak/$ID"
mkdir -p "$OUT"
echo "soak $ID: $CYCLES x $WORKFLOW ($PROFILE) -> evidence/soak/$ID"

in_agent() { docker exec "$STACK-agent" sh -c "$1" 2>/dev/null; }

sample() {  # $1 = when, $2 = cycle number
  local mem counts
  # memory per container, MiB, from the host
  mem="$(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | awk '{
      n=$1; v=$2; unit=v; sub(/[0-9.]+/,"",unit); sub(/[A-Za-z]+/,"",v);
      if (unit ~ /^GiB/) v=v*1024; else if (unit ~ /^KiB/) v=v/1024;
      printf "%s\"%s\":%.1f", (NR>1?",":""), n, v }')"
  counts="$(in_agent 'printf "{\"ws_dirs\":%s,\"evidence_dirs\":%s,\"ui_runs\":%s,\"ws_kb\":%s,\"evidence_kb\":%s,\"mlflow_kb\":%s,\"p281_kb\":%s}" \
      "$(ls /ws 2>/dev/null | wc -l)" "$(ls /work/evidence/p281 2>/dev/null | wc -l)" \
      "$(ls /work/evidence/ui-runs 2>/dev/null | wc -l)" \
      "$(du -sk /ws 2>/dev/null | cut -f1)" "$(du -sk /work/evidence 2>/dev/null | cut -f1)" \
      "$(du -sk /work/evidence/mlflow 2>/dev/null | cut -f1)" "$(du -sk /work/evidence/p281 2>/dev/null | cut -f1)"')"
  # Processes and zombies per container: a stack that reaps nothing runs out of PIDs eventually,
  # and that shows up in neither memory nor disk. Measured before this was sampled — the agent held
  # 111 zombies and the file server 550, one per provider call that had ever run.
  local procs="" n z
  for c in agent fsmcp toolsvc quota ops hub; do
    n="$(docker exec "$STACK-$c" sh -c 'ls /proc | grep -c "^[0-9]*$"' 2>/dev/null || echo 0)"
    z="$(docker exec "$STACK-$c" sh -c 'ps -eo stat 2>/dev/null | grep -c "^Z" || true' 2>/dev/null || echo 0)"
    procs="$procs${procs:+,}\"$c\":{\"procs\":${n:-0},\"zombies\":${z:-0}}"
  done
  printf '{"at":"%s","when":"%s","cycle":%s,"memory_mib":{%s},"counts":%s,"processes":{%s}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$mem" "${counts:-{\}}" "$procs" \
    >> "$OUT/samples.jsonl"
}

sample start 0
ok=0; failed=0; held=0
for i in $(seq 1 "$CYCLES"); do
  ui="soak-$ID-$(printf %02d "$i")"
  t0=$(date +%s)
  in_agent "cd /work && $PY p281/run_workflow.py start $ui $WORKFLOW $PROFILE" >/dev/null 2>&1
  t1=$(date +%s)
  outcome="$(in_agent "$PY /work/p281/soak_outcome.py $ui")"
  [ -n "$outcome" ] || outcome='{"state":"unknown"}'
  case "$outcome" in
    *'"ended_at": "done_hold"'*) held=$((held+1));;
    *'"exit": 0'*) ok=$((ok+1));;
    *) failed=$((failed+1));;
  esac
  printf '{"at":"%s","when":"cycle","cycle":%s,"seconds":%s,"outcome":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$i" "$((t1-t0))" "$outcome" >> "$OUT/samples.jsonl"
  echo "  cycle $i/$CYCLES  $((t1-t0))s  $outcome"
  
  sample after "$i"
done

# the summary is computed where the files are: the agent sees this tree as /work
docker exec -i "$STACK-agent" "$PY" - "/work/evidence/soak/$ID" <<'PY' > "$OUT/summary.json"
import json, sys
out = sys.argv[1]
rows = [json.loads(l) for l in open(f"{out}/samples.jsonl", encoding="utf-8")]
samples = [r for r in rows if r["when"] in ("start", "after")]
cycles = [r for r in rows if r["when"] == "cycle"]
first, last = samples[0], samples[-1]
def delta(key, field):
    return round(last[key].get(field, 0) - first[key].get(field, 0), 1)
mem_keys = sorted(set(first["memory_mib"]) & set(last["memory_mib"]))
print(json.dumps({
    "cycles": len(cycles),
    "seconds": {"total": sum(c["seconds"] for c in cycles),
                "per_cycle": [c["seconds"] for c in cycles],
                "first": cycles[0]["seconds"] if cycles else None,
                "last": cycles[-1]["seconds"] if cycles else None},
    "outcomes": [c["outcome"] for c in cycles],
    "memory_mib_first_last": {k: [first["memory_mib"][k], last["memory_mib"][k]] for k in mem_keys},
    "memory_mib_growth": {k: round(last["memory_mib"][k] - first["memory_mib"][k], 1) for k in mem_keys},
    "memory_mib_total": [round(sum(first["memory_mib"].values()), 1),
                         round(sum(last["memory_mib"].values()), 1)],
    "counts_first_last": {k: [first["counts"][k], last["counts"][k]] for k in first["counts"]},
    "counts_growth": {k: delta("counts", k) for k in first["counts"]},
    "processes_first_last": {k: [first.get("processes", {}).get(k), last.get("processes", {}).get(k)]
                             for k in (first.get("processes") or {})},
}, indent=1))
PY
echo
echo "== summary (evidence/soak/$ID/summary.json)"
cat "$OUT/summary.json"
