"""Platform capability: run one member's steps in order, and report each one.

usage: task_chain.py <member.json>          (started by steps/tasks.py, one process per member)

member.json: {"label": str, "steps": [step, ...]}
  step = {"kind": "model", "provider", "login", "route", "prompt", "expected"}
       | {"kind": "script", "argv": [...], "expected": <file or "">}

A member is a *sequence*, because a lane of an experiment is often one: a deterministic base that
an agent then modifies, a desk whose roles run one after another, a forecast that a deterministic
scorer grades before the next call reads the grade. Members still run at the same time as each
other (steps/tasks.py); only the steps inside one member are ordered.

What it guarantees, and nothing more: the steps run in the given order, the first one that does
not produce what it was asked for stops *that* member and no other, and every step's own record is
kept — so a chain of four calls is four executions in the record, not one.

It does not know what any step means. Which steps a member has, and what a failure of one of them
costs, is the workflow's (CONTRACT.md).
"""
import json, os, subprocess, sys, time

sys.path.insert(0, "/work/p281")
import settings

PY = os.environ.get("POC_PY", "/opt/venv/bin/python")
RUN = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
WS = f"{settings.runtime()['paths']['workspace_root']}/{RUN}"

member = json.load(open(sys.argv[1], encoding="utf-8"))
label = member["label"]
prof = member.get("profile", "research-default")

results, ok = [], True
for i, st in enumerate(member["steps"], 1):
    name = st.get("name") or f"{label}-{i}"
    started = time.time()
    if st["kind"] == "model":
        argv = [PY, "/work/p281/steps/agent_task.py", st["provider"], st.get("route", "direct"),
                name, st["prompt"], st["expected"], prof, st.get("login", st["provider"])]
    else:
        argv = st["argv"]
    p = subprocess.run(argv, capture_output=True, text=True)
    try:
        res = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        res = {"status": "FAILED", "produced": False,
               "error": (p.stderr or p.stdout)[-200:]}
    expected = st.get("expected") or ""
    produced = (bool(res.get("produced")) if st["kind"] == "model"
                else (p.returncode == 0 and (not expected or os.path.exists(f"{WS}/{expected}"))))
    res.update({"step": name, "kind": st["kind"], "produced": produced,
                "seconds": round(time.time() - started, 2)})
    results.append(res)
    if not produced:
        ok = False
        break                      # the rest of this member's chain depends on what did not arrive

final = member["steps"][-1].get("expected") or ""
print(json.dumps({
    "status": "COMPLETED" if ok else "FAILED",
    "produced": ok and (not final or os.path.exists(f"{WS}/{final}")),
    "run_id": f"{RUN}-{label}",
    "steps_run": len(results),
    "steps_planned": len(member["steps"]),
    "failed_step": "" if ok else results[-1]["step"],
    "model_calls": sum(1 for r in results if r.get("kind") == "model"),
    # every step's own record, so the recorder can give each execution its own run
    "steps": results,
}))
