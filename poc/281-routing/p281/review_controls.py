"""Controls for the #284 review boundaries: partial apply, observation source choice, restart after
the end event, workspace_root spelling. Real functions, in-memory/temporary inputs — no Preloop,
no provider, no model call.

usage (agent container): /opt/venv/bin/python /work/p281/review_controls.py
"""
import base64, contextlib, hashlib, importlib, io, json, os, shutil, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE.parent
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  — {detail}"))


def quiet(fn, *a):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = fn(*a)
    return rc, buf.getvalue()


# ---------------------------------------------------------------- 1. policy apply, partial failure
def policy_controls():
    root = Path(tempfile.mkdtemp(prefix="p281-cfg-"))
    shutil.copytree(WORK / "config", root / "config", ignore=shutil.ignore_patterns("generated"))
    shutil.copytree(WORK / "policy", root / "policy")
    (root / "policy" / "a.yaml").write_text((root / "policy" / "b-fsmcp.yaml").read_text() + "\n# A\n")
    os.environ["P281_ROOT"] = str(root)
    sys.path.insert(0, str(HERE))
    cfg = importlib.reload(importlib.import_module("cfg"))

    account = {"policy": None}                       # what the fake Preloop holds
    mode = {"apply": "ok", "scan": "ok"}
    calls = {"apply": 0}
    names = []
    for f in ("a.yaml", "b-fsmcp.yaml"):
        names += [s["name"] for s in cfg.load_yaml(root / "policy" / f).get("mcp_servers") or []]

    def fake_run(argv, **kw):
        calls["apply"] += 1
        if mode["apply"] == "timeout":
            account["policy"] = Path(argv[-1]).name  # a timeout may still have replaced it
            raise subprocess.TimeoutExpired(argv, 120)
        if mode["apply"] == "error":
            return subprocess.CompletedProcess(argv, 1, "", "rejected")
        account["policy"] = Path(argv[-1]).name
        return subprocess.CompletedProcess(argv, 0, "ok", "")

    def fake_call(env, method, path, token):
        if method == "GET":
            return [{"name": n, "id": str(i)} for i, n in enumerate(names)]
        if mode["scan"] == "timeout":
            raise TimeoutError("scan timed out")
        return {}

    cfg.subprocess = type("FakeSubprocess", (), {"run": staticmethod(fake_run), "TimeoutExpired": subprocess.TimeoutExpired,
                                                  "CompletedProcess": subprocess.CompletedProcess})
    cfg.preloop_token = lambda: "t"
    cfg.preloop_call = fake_call

    def use(pol):
        for p in (root / "config" / "profiles").glob("*.yaml"):
            s = p.read_text()
            s = s.replace("policy/b-fsmcp.yaml", pol).replace("policy/a.yaml", pol)
            p.write_text(s)

    def apply():
        n = calls["apply"]
        _, out = quiet(cfg.cmd_apply)
        return json.loads(out)["results"], calls["apply"] - n

    def status(pol):
        _, out = quiet(cfg.cmd_status)
        return next(r for r in json.loads(out)["targets"] if r["target"] == f"preloop-policy:{pol}")

    use("policy/a.yaml"); r, n = apply()
    check("policy: A applies", account["policy"] == "a.yaml" and list(r.values()) == ["applied"], r)
    use("policy/b-fsmcp.yaml"); mode["scan"] = "timeout"; r, n = apply()
    s = status("policy/b-fsmcp.yaml")
    check("policy: B applied, scan failed → reported as such", list(r.values()) == ["policy applied, scan failed"], r)
    check("policy: after B's scan failure the account is recorded as B",
          s["active_on_account"] == "policy/b-fsmcp.yaml" and s["state"] == "apply_failed" and "scan stage" in s["error"], s)
    use("policy/a.yaml"); mode["scan"] = "ok"; r, n = apply()
    check("policy: A→B(scan failed)→A applies A again (review case)", n == 1 and account["policy"] == "a.yaml"
          and list(r.values()) == ["applied"] and status("policy/a.yaml")["state"] == "applied", (r, n, account))
    r, n = apply()
    check("policy: A again → already applied, no call", n == 0 and list(r.values()) == ["already applied"], (r, n))
    use("policy/b-fsmcp.yaml"); mode["scan"] = "timeout"; apply(); mode["scan"] = "ok"; r, n = apply()
    check("policy: B retried after its scan failed is not skipped", n == 1 and list(r.values()) == ["applied"]
          and status("policy/b-fsmcp.yaml")["state"] == "applied", (r, n))
    use("policy/a.yaml"); mode["apply"] = "timeout"; r, n = apply()
    s = status("policy/a.yaml")
    check("policy: apply timeout → account unknown, not B", list(r.values()) == ["apply failed"]
          and s["active_on_account"] == "unknown" and s["state"] == "apply_failed", (r, s))
    use("policy/b-fsmcp.yaml"); mode["apply"] = "ok"; r, n = apply()
    check("policy: after an unknown state B is applied, not skipped as 'already'", n == 1 and account["policy"] == "b-fsmcp.yaml"
          and list(r.values()) == ["applied"], (r, n, account))
    use("policy/a.yaml"); mode["apply"] = "error"; apply(); mode["apply"] = "ok"; use("policy/b-fsmcp.yaml"); r, n = apply()
    check("policy: failed apply of A, then B → B applied again (was the active one before)", n == 1
          and list(r.values()) == ["applied"], (r, n))
    # a legacy state record (before stages were tracked) is re-applied once, never trusted
    st = cfg.load_state(); st["preloop_active"].pop("scan", None); cfg.save_state(st); r, n = apply()
    check("policy: record without scan stage is not trusted", n == 1 and list(r.values()) == ["applied"], (r, n))

    for ws, ok in [("/ws", True), ("/ws/alt", True), ("/ws/", True), ("/data", False), ("/ws/../data", False),
                   ("/ws/./alt", False), ("/wsx", False), ("/ws/alt/..", False), ("ws/alt", False)]:
        env = {"paths": {"workspace_root": ws}}
        bad = any("workspace_root" in e and "must be" in e for e in cfg.validate_env(env))
        check(f"workspace_root {ws!r} {'accepted' if ok else 'rejected'}", bad != ok)
    shutil.rmtree(root)


# ---------------------------------------------------------------- 2. Codex observation source
def codex_controls():
    fp = lambda s: "email:" + hashlib.sha256(s.lower().encode()).hexdigest()[:16]
    b64 = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")

    def run(with_a_newer):
        root = Path(tempfile.mkdtemp(prefix="p281-obs-"))
        logins, obs, out = root / "route", root / "obs", root / "out"
        (root / "config" / "generated").mkdir(parents=True)
        rt = json.loads(json.dumps(__import__("settings").DEFAULT_RUNTIME))
        rt["paths"].update({"logins_root": str(logins), "observations": str(obs)})
        (root / "config" / "generated" / "runtime.json").write_text(json.dumps(rt))
        home = logins / "codex-b"; (home / "sessions" / "2026").mkdir(parents=True); obs.mkdir()
        (home / "auth.json").write_text(json.dumps({"tokens": {"id_token": "h." + b64({"email": "b@example.test"}) + ".s"}}))
        t0 = datetime.now(timezone.utc) - timedelta(minutes=2)
        sid = "0199aaaa-bbbb-cccc-dddd-000000000001"
        (logins / "codex-session-ledger.jsonl").write_text(json.dumps({"account": fp("b@example.test"), "session_id": sid}) + "\n")
        (home / "sessions" / "2026" / f"rollout-x-{sid}.jsonl").write_text(json.dumps({
            "timestamp": t0.isoformat().replace("+00:00", "Z"), "payload": {"rate_limits": {
                "primary": {"used_percent": 10, "window_minutes": 300, "resets_at": int(time.time()) + 3600},
                "secondary": {"used_percent": 20, "window_minutes": 10080, "resets_at": int(time.time()) + 86400}}}}) + "\n")
        if with_a_newer:
            (obs / "codex.raw.json").write_text(json.dumps({"collected_at": (t0 + timedelta(seconds=1)).isoformat(), "payload": [
                {"provider": "codex", "source": "oauth", "usage": {"updatedAt": (t0 + timedelta(seconds=1)).isoformat(),
                 "primary": {"usedPercent": 5, "windowMinutes": 300}, "secondary": {"usedPercent": 5, "windowMinutes": 10080},
                 "identity": {"accountEmail": "a@example.test"}}}]}))
        fake = root / "bin"; fake.mkdir()
        for tool in ("codexbar", "preloop"):
            (fake / tool).write_text("#!/bin/sh\nexit 1\n"); (fake / tool).chmod(0o755)
        env = {**os.environ, "P281_ROOT": str(root), "PATH": f"{fake}:{os.environ['PATH']}",
               "P281_MODEL_ROUTES": json.dumps({"codex": "direct"}), "P281_LOGINS": json.dumps({"codex": "codex-b"}),
               "P281_CODEX_LEDGER": str(logins / "codex-session-ledger.jsonl")}
        cp = subprocess.run([sys.executable, str(HERE / "collect_obs.py"), str(out)], env=env, capture_output=True, text=True, timeout=60)
        if not (out / "codex.json").exists():
            print(cp.stdout[-800:], cp.stderr[-1500:])
        rec = json.loads((out / "codex.json").read_text())
        pol = {"candidates": ["codex"], "model_route": {"codex": "direct"}, "login": {"codex": "codex-b"},
               "max_age_s": 1800, "require_windows": ["weekly"], "max_used_percent": {"session": 80, "weekly": 90}}
        (out / "policy.json").write_text(json.dumps(pol))
        dec = json.loads(subprocess.run([sys.executable, str(HERE / "router.py"), str(out / "policy.json"), str(out)],
                                        env=env, capture_output=True, text=True, timeout=60).stdout)
        shutil.rmtree(root)
        return rec, dec

    rec, dec = run(False)
    check("codex: B's bound rollout only → eligible", dec.get("decision") == "ROUTE" and dec.get("provider") == "codex", dec)
    rec, dec = run(True)
    check("codex: A's reading 1 s newer does not displace B's (review case)",
          rec["observed_account"] == rec["executing_account"] and rec["source"].startswith("rollout:"), rec)
    check("codex: … and B stays eligible", dec.get("decision") == "ROUTE" and dec.get("provider") == "codex", dec)
    check("codex: A's reading is kept as another source", any(s["source"].startswith("codexbar") for s in rec["other_sources"]), rec)


# ---------------------------------------------------------------- 3. restart after the end event
def run_controls():
    sys.path.insert(0, str(HERE))
    rw = importlib.import_module("run_workflow")
    rw.RUNS = Path(tempfile.mkdtemp(prefix="p281-runs-"))
    dead = subprocess.Popen(["true"]); dead.wait()

    def make(ui, events, pid):
        d = rw.RUNS / ui / "tmp" / "conductor"; d.mkdir(parents=True)
        (d / f"conductor-p281-x-20260923-000000-{ui[-8:]}.events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
        meta = {"ui_id": ui, "workflow": "auto", "profile": "p", "inputs": {}, "started_at": time.time(),
                "state": "running", "launcher_pid": pid, "instance": rw.instance_id()}
        rw.meta_path(ui).write_text(json.dumps(meta))
        return meta

    start = {"type": "agent_started", "timestamp": 1.0, "data": {"agent_name": "execute"}}
    done = {"type": "workflow_completed", "timestamp": 2.0, "data": {"output": {"decision": "PASS"}}}
    failed = {"type": "workflow_failed", "timestamp": 2.0, "data": {"output": {"decision": "DENIED"}, "is_explicit": True,
              "terminated_by": "denied", "termination_reason": "DENIED: policy"}}
    for ui, ev, dec in [("rc-pass-0000aaaa", done, "PASS"), ("rc-deny-0000bbbb", failed, "DENIED")]:
        v = rw.view(make(ui, [start, ev], dead.pid))
        saved = json.loads(rw.meta_path(ui).read_text())
        check(f"run: end event + launcher gone → finished ({dec})", v["state"] == "finished" and v["ended"]
              and (v["output"] or {}).get("decision") == dec and not v["error"], v)
        check(f"run: … and the restored state is persisted ({dec})", saved["state"] == "finished"
              and saved.get("recovered_from_event_log") and saved.get("ended_at") == 2.0, saved)
    v = rw.view(make("rc-live-0000cccc", [start, done], os.getpid()))
    check("run: end event, launcher alive → shown finished, meta left to the launcher",
          v["state"] == "finished" and json.loads(rw.meta_path("rc-live-0000cccc").read_text())["state"] == "running", v)
    v = rw.view(make("rc-intr-0000dddd", [start], dead.pid))
    check("run: no end event + launcher gone → interrupted", v["state"] == "interrupted", v)
    v = rw.view(make("rc-runn-0000eeee", [start], os.getpid()))
    check("run: no end event, launcher alive → running", v["state"] == "running", v)
    shutil.rmtree(rw.RUNS)


policy_controls()
codex_controls()
run_controls()
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
