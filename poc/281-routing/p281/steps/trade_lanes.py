"""Run the lanes of one cycle at the same time — inside one Conductor step.

usage: trade_lanes.py <profile> <spec> [<spec> ...]
       spec = lane:kind:provider:login:route:prompt-file   kind = model | deterministic

One subprocess per lane, started together. A lane that fails is recorded as failed and the others
are untouched — the isolation a multi-lane experiment depends on. The deterministic lane makes no
model call at all: it is computed here, from the same packet, so a cycle always has a baseline
even when every model lane fails.

Conductor's own `parallel` / `for_each` groups cannot be used: they refuse script steps (v0.1.37),
and a routed model call is a script step. Trial A recorded the same finding.
"""
import json, os, subprocess, sys, time

sys.path.insert(0, "/work/p281")
import settings

PY = os.environ.get("POC_PY", "/opt/venv/bin/python")
RT = settings.runtime()
RUN = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
WS = f"{RT['paths']['workspace_root']}/{RUN}"

prof = sys.argv[1]
specs = [s.split(":") for s in sys.argv[2:]]


def deterministic_lane(lane_id):
    """Momentum baseline: the three best 20-day returns, equal weight, nothing else."""
    packet = json.load(open(f"{WS}/packet.json", encoding="utf-8"))
    top = sorted(packet["universe"], key=lambda s: s["ret_20d"], reverse=True)[:3]
    w = round(min(packet["constraints"]["max_weight_per_symbol"], 0.75 / len(top)), 4)
    doc = {"lane": lane_id, "policy": "momentum20-top3-equal-weight", "model_calls": 0,
           "targets": [{"symbol": s["symbol"], "weight": w} for s in top],
           "rationale": "결정론 기준선: 20일 수익률 상위 3종목 동일 비중", "refs": []}
    json.dump(doc, open(f"{WS}/lane_{lane_id}.json", "w"), ensure_ascii=False, indent=1)
    return {"status": "COMPLETED", "produced": True, "run_id": f"{RUN}-{lane_id}-deterministic"}


t0 = time.time()
running, results = [], []
for lane, kind, provider, login, route, prompt in specs:
    started = round(time.time() - t0, 2)
    if kind == "deterministic":
        r = deterministic_lane(lane)
        results.append({"lane": lane, "kind": kind, "provider": "none", "status": r["status"],
                        "produced": True, "started_at": started,
                        "ended_at": round(time.time() - t0, 2), "model_calls": 0})
        continue
    argv = [PY, "/work/p281/steps/agent_task.py", provider, route, f"lane-{lane}",
            prompt, f"lane_{lane}.json", prof, login]
    running.append({"lane": lane, "kind": kind, "provider": provider, "started_at": started,
                    "p": subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)})

failed = []
for r in running:
    out_s, err_s = r["p"].communicate()
    try:
        res = json.loads(out_s.strip().splitlines()[-1])
    except Exception:
        res = {"status": "FAILED", "produced": False, "error": (err_s or out_s)[-200:]}
    ok = bool(res.get("produced"))
    if not ok:
        failed.append(r["lane"])
    results.append({"lane": r["lane"], "kind": r["kind"], "provider": r["provider"],
                    "status": res.get("status"), "produced": ok, "started_at": r["started_at"],
                    "ended_at": round(time.time() - t0, 2), "model_calls": 1,
                    "attempts": res.get("attempts", 1), "run_id": res.get("run_id", "")})

wall = round(time.time() - t0, 2)
serial = sum(x["ended_at"] - x["started_at"] for x in results)
print(json.dumps({
    "status": "OK",
    "lanes": len(results),
    "produced": sum(1 for x in results if x["produced"]),
    "failed": ",".join(failed),
    "model_calls": sum(x["model_calls"] for x in results),
    "wall_s": wall,
    "sum_of_steps_s": round(serial, 2),
    "concurrency": round(serial / wall, 2) if wall else 0,
    "detail": json.dumps(results, ensure_ascii=False),
}))
