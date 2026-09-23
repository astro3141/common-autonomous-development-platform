"""Run the reviewers at the same time — inside one Conductor step.

usage: novel_reviews.py <profile> <spec> [<spec> ...]
       spec = label:provider:login:route:prompt-file:expected-file:required|advisory

Why not a Conductor `parallel` group: Conductor has one (and a dynamic `for_each` too), but both
refuse script steps — measured on v0.1.37, `config/validator.py`. Every routed model step in this
stack *is* a script step, because the model runs through the routing/execution layer rather than
through Conductor's own provider clients. So concurrency for routed calls has to happen inside a
step, which is what this does: one subprocess per reviewer, started together, waited on together.

It reports each reviewer's own start and end offsets so the overlap is visible rather than
asserted, and it never fails the workflow: an advisory reviewer that dies is recorded as
unusable, and the deterministic triage decides what that means.
"""
import json, os, subprocess, sys, time

PY = os.environ.get("POC_PY", "/opt/venv/bin/python")
prof = sys.argv[1]
specs = [s.split(":") for s in sys.argv[2:]]

t0 = time.time()
procs = []
for label, provider, login, route, prompt, expected, kind in specs:
    argv = [PY, "/work/p281/steps/agent_task.py", provider, route, label, prompt, expected, prof, login]
    procs.append({"label": label, "provider": provider, "kind": kind,
                  "started_at": round(time.time() - t0, 2),
                  "p": subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)})

rows, usable_required, failed = [], 0, []
for r in procs:
    out, err = r["p"].communicate()
    try:
        res = json.loads(out.strip().splitlines()[-1])
    except Exception:
        res = {"status": "FAILED", "produced": False, "error": (err or out)[-200:]}
    ok = bool(res.get("produced"))
    if r["kind"] == "required" and ok:
        usable_required += 1
    if not ok:
        failed.append(r["label"])
    rows.append({"label": r["label"], "provider": r["provider"], "kind": r["kind"],
                 "status": res.get("status"), "produced": ok,
                 "started_at": r["started_at"], "ended_at": round(time.time() - t0, 2),
                 "run_id": res.get("run_id", "")})

wall = round(time.time() - t0, 2)
longest = max((x["ended_at"] - x["started_at"] for x in rows), default=0)
serial = sum(x["ended_at"] - x["started_at"] for x in rows)
print(json.dumps({
    "status": "OK",
    "reviewers": len(rows),
    "required_usable": usable_required,
    "failed": ",".join(failed),
    "wall_s": wall,
    "sum_of_steps_s": round(serial, 2),
    "longest_step_s": round(longest, 2),
    # >1 means they really overlapped; ~1 would mean they ran one after another
    "concurrency": round(serial / wall, 2) if wall else 0,
    "detail": json.dumps(rows, ensure_ascii=False),
}))
