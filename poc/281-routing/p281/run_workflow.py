"""Start and read workflow runs for the ops API — runs inside the agent container.

usage:
  run_workflow.py start <ui-id> <workflow> <profile> [key=value ...]   (runs in the foreground; the
                                                                     ops API starts it detached)
  run_workflow.py show  <ui-id>                                       JSON view of one run
  run_workflow.py list                                                JSON list, newest first

Only workflows in WORKFLOWS may be started. Arguments are passed to Conductor as an argv list,
never through a shell. The view is read from Conductor's own event log; nothing here keeps a
second copy of the run's progress.
"""
import glob, json, os, re, subprocess, sys, time
from pathlib import Path

WORKFLOWS = {"auto": "p281/workflows/auto.yaml", "research-r": "p281/workflows/research-r.yaml"}
RUNS = Path("/work/evidence/ui-runs")
EVENTS = Path(os.environ.get("CONDUCTOR_EVENT_DIR", "/tmp/conductor"))
SAFE = re.compile(r"[A-Za-z0-9._\- ]{0,200}")


def meta_path(ui):
    return RUNS / f"{ui}.json"


def cmd_start(ui, workflow, profile, pairs):
    if workflow not in WORKFLOWS or not re.fullmatch(r"[a-z0-9-]{1,40}", profile) or not re.fullmatch(r"[a-z0-9-]{6,40}", ui):
        print(json.dumps({"error": "invalid workflow, profile or id"})); return 2
    inputs = {}
    for kv in pairs:
        k, _, v = kv.partition("=")
        if not re.fullmatch(r"[a-z_]{1,30}", k) or not SAFE.fullmatch(v):
            print(json.dumps({"error": f"invalid input {k!r}"})); return 2
        inputs[k] = v
    RUNS.mkdir(parents=True, exist_ok=True)
    started = time.time()
    meta = {"ui_id": ui, "workflow": workflow, "profile": profile, "inputs": inputs,
            "started_at": started, "state": "running"}
    meta_path(ui).write_text(json.dumps(meta))
    argv = ["conductor", "--silent", "run", WORKFLOWS[workflow], "--no-interactive", "-i", f"profile={profile}"]
    for k, v in inputs.items():
        argv += ["-i", f"{k}={v}"]
    with open(RUNS / f"{ui}.log", "wb") as log:
        rc = subprocess.run(argv, cwd="/work", stdout=log, stderr=subprocess.STDOUT).returncode
    meta.update({"state": "finished", "exit": rc, "ended_at": time.time()})
    meta_path(ui).write_text(json.dumps(meta))
    return 0


def events_for(meta):
    """Conductor's event log for this run: the p281 workflow's file created after the start."""
    name = {"auto": "p281-route-auto", "research-r": "p281-research-r"}[meta["workflow"]]
    cands = [Path(p) for p in glob.glob(str(EVENTS / f"conductor-{name}-*.events.jsonl"))
             if os.path.getmtime(p) >= meta["started_at"] - 2]
    cands.sort(key=lambda p: p.stat().st_ctime)
    # the earliest file started after this run began is this run's (runs are started one per id)
    for p in cands:
        try:
            first = json.loads(p.open().readline())
        except Exception:
            continue
        if first.get("timestamp", 0) >= meta["started_at"] - 2:
            return p
    return None


def view(meta):
    out = {**meta, "steps": [], "current_step": None, "route": None, "terminated_at": None,
           "termination_reason": None, "output": None, "conductor_run": None, "error": None,
           "mlflow": None, "workspace": None}
    p = events_for(meta)
    if p:
        out["conductor_run"] = p.name.split("-")[-1].split(".")[0]
        for line in p.open():
            try:
                e = json.loads(line)
            except Exception:
                continue
            t, d = e.get("type"), e.get("data") or {}
            if t == "agent_started":
                out["current_step"] = d.get("agent_name")
                out["steps"].append({"step": d.get("agent_name"), "at": e.get("timestamp")})
            elif t == "script_completed" and d.get("agent_name") == "route":
                try:
                    r = json.loads(d.get("stdout") or "{}")
                    out["route"] = {k: r.get(k) for k in ("decision", "provider", "reason", "model_route", "profile")}
                except Exception:
                    pass
            elif t == "script_completed" and d.get("agent_name") in ("record", "record_hold"):
                try:
                    r = json.loads(d.get("stdout") or "{}")
                    out["mlflow"] = {"run_id": r.get("mlflow_run_id"), "experiment_id": r.get("experiment_id"),
                                     "error": r.get("record_error")}
                except Exception:
                    pass
            elif t == "script_completed" and d.get("agent_name") in ("execute", "propose"):
                try:
                    out["workspace"] = json.loads(d.get("stdout") or "{}").get("workspace")
                except Exception:
                    pass
            elif t == "agent_completed" and d.get("agent_type") == "terminate":
                out["terminated_at"] = d.get("agent_name")
                out["termination_reason"] = d.get("termination_reason")
            elif t == "workflow_completed":
                out["output"] = d.get("output")
            elif t in ("workflow_failed", "agent_failed", "script_failed"):
                # an explicit failed terminate (HOLD, BLOCK, DENIED …) carries the workflow output
                # here; show it as the output, and keep only a genuine error as an error
                if isinstance(d.get("output"), dict):
                    out["output"] = d["output"]
                if not d.get("is_explicit"):
                    out["error"] = json.dumps(d)[:500]
    if meta.get("state") == "finished" and not out["output"]:
        log = RUNS / f"{meta['ui_id']}.log"
        out["error"] = out["error"] or (log.read_text(errors="replace")[-600:] if log.exists() else "no output")
    return out


def cmd_show(ui):
    m = meta_path(ui)
    if not m.exists():
        print(json.dumps({"error": "no such run"})); return 1
    print(json.dumps(view(json.loads(m.read_text()))))
    return 0


def cmd_list():
    rows = []
    for m in sorted(RUNS.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
        meta = json.loads(m.read_text())
        v = view(meta)
        rows.append({k: v.get(k) for k in ("ui_id", "workflow", "profile", "state", "started_at", "current_step",
                                            "terminated_at", "route")} | {"decision": (v.get("output") or {}).get("decision")})
    print(json.dumps(rows))
    return 0


if __name__ == "__main__":
    a = sys.argv[1]
    sys.exit({"start": lambda: cmd_start(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]),
              "show": lambda: cmd_show(sys.argv[2]), "list": cmd_list}[a]())
