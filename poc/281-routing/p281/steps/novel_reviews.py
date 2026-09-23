"""Run the reviewers at the same time — inside one Conductor step.

usage: novel_reviews.py <profile> <spec> [<spec> ...]
       spec = label:provider:login:route:prompt-file:expected-file:required|advisory

Why not a Conductor `parallel` group: Conductor has one (and a dynamic `for_each` too), but both
refuse script steps — measured on v0.1.37, `config/validator.py`. Every routed model step in this
stack *is* a script step, because the model runs through the routing/execution layer rather than
through Conductor's own provider clients. So concurrency for routed calls has to happen inside a
step, which is what this does, through steps/fanout.py: one subprocess per reviewer, started
together, each timed on its own.

It never fails the workflow: an advisory reviewer that dies is recorded as unusable, and the
deterministic triage decides what that means.
"""
import json, os, sys

sys.path.insert(0, "/work/p281/steps")
import fanout

PY = os.environ.get("POC_PY", "/opt/venv/bin/python")
prof = sys.argv[1]

jobs = []
for spec in sys.argv[2:]:
    label, provider, login, route, prompt, expected, kind = spec.split(":")
    jobs.append({"key": label, "label": label, "provider": provider, "kind": kind,
                 "argv": [PY, "/work/p281/steps/agent_task.py", provider, route, label,
                          prompt, expected, prof, login]})

rows, wall = fanout.run_all(jobs)

out_rows, usable_required, failed = [], 0, []
for r in rows:
    try:
        res = json.loads(r["stdout"].strip().splitlines()[-1])
    except Exception:
        res = {"status": "FAILED", "produced": False,
               "error": (r["stderr"] or r["stdout"])[-200:]}
    ok = bool(res.get("produced"))
    if r["kind"] == "required" and ok:
        usable_required += 1
    if not ok:
        failed.append(r["label"])
    out_rows.append({"label": r["label"], "provider": r["provider"], "kind": r["kind"],
                     "status": res.get("status"), "produced": ok,
                     "started_at": r["started_at"], "ended_at": r["ended_at"],
                     "seconds": round(r["ended_at"] - r["started_at"], 2),
                     "attempts": res.get("attempts", 1), "run_id": res.get("run_id", "")})

print(json.dumps({
    "status": "OK",
    "reviewers": len(out_rows),
    "required_usable": usable_required,
    "failed": ",".join(failed),
    "wall_s": wall,
    "busy_s": round(sum(x["seconds"] for x in out_rows), 2),
    "longest_step_s": max((x["seconds"] for x in out_rows), default=0),
    # busy ÷ wall: 1.0 would mean they might as well have been sequential
    "overlap": fanout.overlap(rows, wall),
    "detail": json.dumps(out_rows, ensure_ascii=False),
}))
