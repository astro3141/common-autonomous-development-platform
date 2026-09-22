"""Start and read workflow runs for the ops API — runs inside the agent container.

usage:
  run_workflow.py start <ui-id> <workflow> <profile> [key=value ...]   (foreground; ops starts it detached)
  run_workflow.py show  <ui-id>                                       JSON view of one run
  run_workflow.py list                                                JSON list, newest first

Only workflows in WORKFLOWS may be started; arguments reach Conductor as an argv list, never
through a shell.

Binding a UI run to *its* Conductor run is exact, not inferred: each run gets its own directory
and its own TMPDIR, and Conductor writes its event log under the temp directory
(<tmp>/conductor/conductor-<workflow>-<ts>-<run id>.events.jsonl). That directory therefore
holds this run's event log and nothing else. The view is read from that log — no second copy
of the run's progress is kept.

The event log decides whether a run ended. If it records the end (completed or failed) but the
launcher died before writing that down, the run is restored as `finished` with the logged outcome.
A run whose launcher is gone without an end in the log is marked `interrupted`. Nothing is resumed.
"""
import glob, json, os, re, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, "/work/p281")
import settings

WORKFLOWS = {"auto": "p281/workflows/auto.yaml", "research-r": "p281/workflows/research-r.yaml"}
RUNS = Path("/work/evidence/ui-runs")
SAFE = re.compile(r"[A-Za-z0-9._\- ]{0,200}")


def instance_id():
    """Identifies this container instance: PID 1's start time changes on every (re)start."""
    try:
        return open("/proc/1/stat").read().split(")")[1].split()[19] + "@" + os.uname().nodename
    except Exception:
        return "unknown"


def run_dir(ui):
    return RUNS / ui


def meta_path(ui):
    return run_dir(ui) / "meta.json"


def cmd_start(ui, workflow, profile, pairs):
    if workflow not in WORKFLOWS or not re.fullmatch(r"[a-z0-9-]{1,40}", profile) or not re.fullmatch(r"[a-z0-9-]{6,40}", ui):
        print(json.dumps({"error": "invalid workflow, profile or id"})); return 2
    inputs = {}
    for kv in pairs:
        k, _, v = kv.partition("=")
        if not re.fullmatch(r"[a-z_]{1,30}", k) or not SAFE.fullmatch(v):
            print(json.dumps({"error": f"invalid input {k!r}"})); return 2
        inputs[k] = v
    d = run_dir(ui)
    tmp = d / "tmp"
    (tmp / "conductor").mkdir(parents=True, exist_ok=False)     # a fresh id only
    meta = {"ui_id": ui, "workflow": workflow, "profile": profile, "inputs": inputs,
            "started_at": time.time(), "state": "running",
            "launcher_pid": os.getpid(), "instance": instance_id()}
    meta_path(ui).write_text(json.dumps(meta))
    argv = ["conductor", "--silent", "run", WORKFLOWS[workflow], "--no-interactive", "-i", f"profile={profile}"]
    for k, v in inputs.items():
        argv += ["-i", f"{k}={v}"]
    env = {**os.environ, "TMPDIR": str(tmp), "CONDUCTOR_EVENT_DIR": str(tmp / "conductor")}
    with open(d / "run.log", "wb") as log:
        rc = subprocess.run(argv, cwd="/work", stdout=log, stderr=subprocess.STDOUT, env=env).returncode
    meta.update({"state": "finished", "exit": rc, "ended_at": time.time()})
    meta_path(ui).write_text(json.dumps(meta))
    return 0


def events_for(ui):
    files = glob.glob(str(run_dir(ui) / "tmp" / "conductor" / "*.events.jsonl"))
    return Path(files[0]) if len(files) == 1 else None    # exactly this run's log, or nothing


def launcher_alive(meta):
    if meta.get("instance") != instance_id():
        return False
    try:
        os.kill(int(meta.get("launcher_pid", 0)), 0)
        return True
    except (ProcessLookupError, ValueError, PermissionError):
        return False


def view(meta):
    ui = meta["ui_id"]
    out = {**meta, "steps": [], "current_step": None, "route": None, "terminated_at": None,
           "termination_reason": None, "output": None, "conductor_run": None, "error": None,
           "mlflow": None, "workspace_prefix": None, "ended": False, "ended_event_at": None}
    p = events_for(ui)
    if p:
        out["conductor_run"] = p.name.rsplit("-", 1)[-1].split(".")[0]
        # every model step of this run works under <workspace_root>/<conductor run id>… — known
        # from the start, so a pending approval can be tied to the run while the step still waits
        out["workspace_prefix"] = f"{settings.runtime()['paths']['workspace_root']}/{out['conductor_run']}"
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
            elif t == "agent_completed" and d.get("agent_type") == "terminate":
                out["terminated_at"] = d.get("agent_name")
                out["termination_reason"] = d.get("termination_reason")
            elif t == "workflow_completed":
                out["output"] = d.get("output"); out["ended"] = True; out["ended_event_at"] = e.get("timestamp")
            elif t in ("workflow_failed", "agent_failed", "script_failed"):
                # an explicit failed terminate (HOLD, BLOCK, DENIED …) carries the workflow output
                if isinstance(d.get("output"), dict):
                    out["output"] = d["output"]
                if t == "workflow_failed":
                    out["ended"] = True; out["ended_event_at"] = e.get("timestamp")
                    # a failed terminate reports where and why only here
                    out["terminated_at"] = out["terminated_at"] or d.get("terminated_by") or d.get("agent_name")
                    out["termination_reason"] = out["termination_reason"] or d.get("termination_reason")
                if not d.get("is_explicit"):
                    out["error"] = json.dumps(d)[:500]
    if meta.get("state") == "running" and out["ended"]:
        # Conductor recorded the end; the launcher may have died before writing it down (restart
        # right after the end event). The event log is the record: the run is finished with the
        # outcome read above. Persist only once the launcher is gone, so a live launcher's own
        # write (with the exit code) is not raced.
        out["state"] = "finished"
        if not launcher_alive(meta):
            meta.update({"state": "finished", "exit": None, "ended_at": out.get("ended_event_at"),
                         "recovered_from_event_log": True})
            meta_path(ui).write_text(json.dumps(meta))
            out.update({k: meta[k] for k in ("exit", "ended_at", "recovered_from_event_log")})
    elif meta.get("state") == "running" and not launcher_alive(meta):
        meta.update({"state": "interrupted", "interrupted_detected_at": time.time()})
        meta_path(ui).write_text(json.dumps(meta))
        out.update({"state": "interrupted",
                    "error": "the run's launcher is gone (container restart or process killed) and "
                             "Conductor recorded no end; it was not resumed"})
    if meta.get("state") == "finished" and not out["output"] and not out["error"] and not out["ended"]:
        log = run_dir(ui) / "run.log"
        out["error"] = log.read_text(errors="replace")[-600:] if log.exists() else "no output"
    return out


def cmd_show(ui):
    if not re.fullmatch(r"[a-z0-9-]{6,40}", ui) or not meta_path(ui).exists():
        print(json.dumps({"error": "no such run"})); return 1
    print(json.dumps(view(json.loads(meta_path(ui).read_text()))))
    return 0


def cmd_list():
    rows = []
    metas = sorted(RUNS.glob("*/meta.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:50]
    for m in metas:
        v = view(json.loads(m.read_text()))
        rows.append({k: v.get(k) for k in ("ui_id", "workflow", "profile", "state", "started_at", "current_step",
                                            "terminated_at", "route")} | {"decision": (v.get("output") or {}).get("decision")})
    print(json.dumps(rows))
    return 0


if __name__ == "__main__":
    a = sys.argv[1]
    sys.exit({"start": lambda: cmd_start(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]),
              "show": lambda: cmd_show(sys.argv[2]), "list": cmd_list}[a]())
