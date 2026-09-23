"""Controls for p281/cleanup.py — the protections and the all-or-nothing removal.

usage (agent container): /opt/venv/bin/python /work/p281/cleanup_controls.py

Everything happens in temporary directories with a stubbed approvals reader: no run of the real
instance is read or removed, and no model is called. Written after a review found that a cleanup
deleted while the approvals reader was failing, and after two runs of these very cases against
the live workspace removed real evidence (restored from git and from the backup).
"""
import importlib, io, json, os, shutil, stat, sys, tempfile, time
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, "/work/p281")
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  — {detail}"))


class Sandbox:
    """A cleanup module pointed at temporary directories, with a stubbed approvals reader."""

    def __init__(self, pending=None, complete=True, reader_fails=False):
        self.root = Path(tempfile.mkdtemp(prefix="p281-clean-"))
        self.ws = self.root / "ws"; self.evid = self.root / "p281"; self.runs = self.root / "ui-runs"
        for d in (self.ws, self.evid, self.runs):
            d.mkdir(parents=True)
        self.reader = self.root / "approvals_stub.py"
        body = ("import sys\n" +
                ("sys.exit(3)\n" if reader_fails else
                 f"import json\nfull='--all' in sys.argv[1:]\n"
                 f"items={json.dumps(pending or [])}\ncomplete={complete}\n"
                 "print(json.dumps({'complete': complete, 'items': items} if full else items))\n"))
        self.reader.write_text(body)

    def set_pending(self, items):
        """Point the stubbed reader at another list of pending requests."""
        import json as _json
        body = ("import json,sys\n"
                "full='--all' in sys.argv[1:]\n"
                f"items={_json.dumps(items)}\n"
                "print(json.dumps({'complete': True, 'items': items} if full else items))\n")
        self.reader.write_text(body)

    def load(self):
        import subprocess as real_subprocess
        cleanup = importlib.reload(importlib.import_module("cleanup"))
        run_workflow = importlib.import_module("run_workflow")
        cleanup.WS, cleanup.EVID, cleanup.RUNS = self.ws, self.evid, self.runs
        run_workflow.RUNS = self.runs          # view() reads the event log through this
        stub = str(self.reader)
        # a namespace of its own: patching the subprocess module would leak into every later case
        cleanup.subprocess = type("S", (), {"run": staticmethod(
            lambda argv, **kw: real_subprocess.run([argv[0], stub] + list(argv[2:]), **kw))})
        cleanup.trash_for = lambda p: self._trash(p)
        return cleanup

    def _trash(self, path):
        base = self.ws if str(path).startswith(str(self.ws)) else self.root
        d = base / ".cleanup-trash"; d.mkdir(parents=True, exist_ok=True)
        return d

    def run(self, ui_id, conductor, started, state="finished", alive=False, keep=False):
        d = self.runs / ui_id
        (d / "tmp" / "conductor").mkdir(parents=True)
        (d / "tmp" / "conductor" / f"conductor-x-{started}-{conductor}.events.jsonl").write_text(
            json.dumps({"type": "agent_started", "timestamp": 1, "data": {"agent_name": "execute"}}) + "\n" +
            (json.dumps({"type": "workflow_completed", "timestamp": 2, "data": {"output": {"decision": "PASS"}}}) + "\n"
             if state != "running" else ""))
        (d / "meta.json").write_text(json.dumps({
            "ui_id": ui_id, "workflow": "auto", "profile": "p", "inputs": {},
            "started_at": time.time() - 30 * 86400, "state": "running" if state == "running" else "finished",
            "launcher_pid": os.getpid() if alive else 999999,
            "instance": importlib.import_module("run_workflow").instance_id() if alive else "someone-else"}))
        if keep:
            (d / "keep").touch()
        (self.ws / f"{conductor}-codex").mkdir()
        (self.evid / f"{conductor}-propose-codex").mkdir()
        return d

    def call(self, *args):
        cleanup = self.load()
        argv = sys.argv
        sys.argv = ["cleanup.py", "--json", *args]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = cleanup.main()
        except SystemExit as e:
            sys.argv = argv
            return None, str(e), 2
        sys.argv = argv
        return json.loads(buf.getvalue()), "", rc

    def drop(self):
        shutil.rmtree(self.root, ignore_errors=True)


# ------------------------------------------------------------------ the launcher is still alive
sb = Sandbox()
sb.run("20260101-010101-aaaaaa", "11111111", "20260101", state="finished", alive=True)
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply")
check("a run whose launcher is alive is kept, even with an end in the log",
      out and not out["removed"] and any("launcher" in k["why"] for k in out["kept"]), out or err)
check("… and its directory is still there", (sb.runs / "20260101-010101-aaaaaa").exists())
sb.drop()

# ------------------------------------------------------------------ a real removal, all of it
sb = Sandbox()
d = sb.run("20260101-020202-bbbbbb", "22222222", "20260101")
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply")
check("an old finished run is removed with its workspace and evidence",
      out and out["removed"] == ["20260101-020202-bbbbbb"] and not d.exists()
      and not (sb.ws / "22222222-codex").exists() and not (sb.evid / "22222222-propose-codex").exists(),
      out or err)
sb.drop()

# ------------------------------------------------------------------ partial failure: all or nothing
sb = Sandbox()
d = sb.run("20260101-030303-cccccc", "33333333", "20260101")
cleanup = sb.load()
real_rename = cleanup.os.rename
state = {"n": 0}


def failing_rename(src, dst):
    state["n"] += 1
    if state["n"] == 2:                      # the second path of the group cannot be moved
        raise PermissionError("permission denied (injected)")
    return real_rename(src, dst)


cleanup.os = type("O", (), {"rename": staticmethod(failing_rename), "getpid": os.getpid,
                            "path": os.path, "utime": os.utime})
sys.argv = ["cleanup.py", "--json", "--days", "0", "--keep", "0", "--apply"]
buf = io.StringIO()
with redirect_stdout(buf):
    rc = cleanup.main()
res = json.loads(buf.getvalue())
check("a group that cannot be removed in full is reported as failed, not removed",
      res["removed"] == [] and res["failed"] and rc == 1, res)
check("… and every path of it is still there",
      d.exists() and (sb.ws / "33333333-codex").exists() and (sb.evid / "33333333-propose-codex").exists())
sb.drop()

# ------------------------------------------------------------------ orphans and their protections
sb = Sandbox(pending=[{"cwd": "/ws-none"}])
(sb.ws / "44444444-codex").mkdir()           # no run on the screen refers to it
old = time.time() - 40 * 86400
os.utime(sb.ws / "44444444-codex", (old, old))
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply")
check("an orphan is not removed without --include-orphans",
      (sb.ws / "44444444-codex").exists() and out["orphans"], out or err)
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply", "--include-orphans")
check("… and is removed with it", not (sb.ws / "44444444-codex").exists(), out or err)
sb.drop()

sb = Sandbox()
p = sb.ws / "55555555-codex"; p.mkdir()
os.utime(p, (old, old))
sb.set_pending([{"cwd": str(p)}])
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply", "--include-orphans")
check("an orphan with a pending approval under it is kept",
      p.exists() and any("approval" in k["why"] for k in out["orphans_kept"]), out or err)
sb.drop()

sb = Sandbox()
p = sb.ws / "66666666-codex"; p.mkdir()      # recent: inside the retention window
out, err, rc = sb.call("--days", "14", "--keep", "0", "--apply", "--include-orphans")
check("a recently changed orphan is kept", p.exists(), out or err)
sb.drop()

sb = Sandbox()
p = sb.ws / "77777777-codex"; p.mkdir(); os.utime(p, (old, old))
(sb.runs / "20260101-040404-dddddd").mkdir()
(sb.runs / "20260101-040404-dddddd" / "meta.json").write_text("{ this is not json")
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply", "--include-orphans")
check("orphans are kept while any run's state cannot be read",
      p.exists() and out["unreadable_runs"] == 1
      and any("could not be read" in k["why"] for k in out["orphans_kept"]), out or err)
sb.drop()

# ------------------------------------------------------------------ the approvals reader
sb = Sandbox(reader_fails=True)
sb.run("20260101-050505-eeeeee", "88888888", "20260101")
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply")
check("a failing approvals reader stops everything",
      out is None and "nothing was removed" in err and (sb.runs / "20260101-050505-eeeeee").exists(), err)
sb.drop()

sb = Sandbox(complete=False)
sb.run("20260101-060606-ffffff", "99999999", "20260101")
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply")
check("an incomplete list of pending approvals stops everything",
      out is None and "not complete" in err and (sb.runs / "20260101-060606-ffffff").exists(), err)
sb.drop()

# ------------------------------------------------------------------ preview is the default
sb = Sandbox()
d = sb.run("20260101-070707-aaaabb", "aaaaaaaa", "20260101")
out, err, rc = sb.call("--days", "0", "--keep", "0")
check("without --apply nothing is removed", d.exists() and out["removable"] and not out["removed"], out or err)
sb.drop()

# ------------------------------------------------------------------ orphans are grouped by run
sb = Sandbox()
ws_p = sb.ws / "abcdef01-execute"; ws_p.mkdir()
ev_p = sb.evid / "abcdef01-execute-codex"; ev_p.mkdir()
for q in (ws_p, ev_p):
    os.utime(q, (old, old))
sb.set_pending([{"cwd": str(ws_p)}])
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply", "--include-orphans")
check("an approval on one trace protects the whole run's orphan traces",
      ws_p.exists() and ev_p.exists()
      and any(k["run"] == "abcdef01" for k in out["orphans_kept"]), out or err)
sb.drop()

sb = Sandbox()
ws_p = sb.ws / "abcdef02-execute"; ws_p.mkdir()
ev_p = sb.evid / "abcdef02-execute-codex"; ev_p.mkdir()
for q in (ws_p, ev_p):
    os.utime(q, (old, old))
out, err, rc = sb.call("--days", "0", "--keep", "0", "--apply", "--include-orphans")
check("an unprotected orphan run goes with all of its traces",
      not ws_p.exists() and not ev_p.exists() and out["orphans_removed"] == ["abcdef02"], out or err)
sb.drop()

# ------------------------------------------------------------------ no copy fallback on failure
sb = Sandbox()
d = sb.run("20260101-080808-bbbbcc", "bbbbbbbb", "20260101")
cleanup = sb.load()
real_rename = cleanup.os.rename
calls = {"n": 0}


def failing_rename(src, dst):
    calls["n"] += 1
    if calls["n"] == 2:
        raise OSError(18, "Invalid cross-device link (injected)")
    return real_rename(src, dst)


cleanup.os = type("O", (), {"rename": staticmethod(failing_rename), "getpid": os.getpid,
                            "path": os.path, "utime": os.utime})
sys.argv = ["cleanup.py", "--json", "--days", "0", "--keep", "0", "--apply"]
buf = io.StringIO()
with redirect_stdout(buf):
    rc = cleanup.main()
res = json.loads(buf.getvalue())
check("a rename that fails leaves every path of the run where it was",
      res["removed"] == [] and res["failed"] and rc == 1
      and d.exists() and (sb.ws / "bbbbbbbb-codex").exists() and (sb.evid / "bbbbbbbb-propose-codex").exists(),
      res)
check("… and nothing of it is left in the holding place",
      not any((sb.ws / ".cleanup-trash").glob("*")) and not any((sb.root / ".cleanup-trash").glob("*")))
sb.drop()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
