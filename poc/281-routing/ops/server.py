"""cadp278-ops — the only component with Docker control. A fixed set of actions over HTTP.

The UI (and anything else) calls this API; it never talks to Docker itself. Each route maps to
one predetermined `docker exec` into a known container, with arguments passed as an argv list
(no shell) and validated first. Adding a capability means adding a route here, deliberately.

Listens on 0.0.0.0:8781 inside its container; compose publishes it on 127.0.0.1 only. That limits
who can reach it, not what it can do: whoever reaches it controls these actions.

Routes
  GET  /api/health
  GET  /api/config/status                 POST /api/config/generate   POST /api/config/apply
  GET  /api/profiles
  GET  /api/accounts?profile=<name>       per provider: login state, quota, account match, eligibility
  POST /api/accounts/<provider>/login     body {"login": optional}     start the official login
  GET  /api/accounts/<provider>/login?login=<name>
  POST /api/accounts/<provider>/code      body {"code": "...", "login": optional}
  POST /api/accounts/<provider>/cancel    body {"login": optional}
  GET  /api/runs                          POST /api/runs  body {"workflow","profile","inputs":{}}
  GET  /api/runs/<ui-id>
  GET  /api/approvals                     pending approval requests (read-only)
"""
import json, os, re, secrets, subprocess, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

AGENT = os.environ.get("OPS_AGENT_CONTAINER", "cadp278-agent")
PY = "/opt/venv/bin/python"
PROVIDERS = {"claude", "codex", "grok"}
NAME = re.compile(r"[a-z0-9-]{1,40}")


def dexec(args, stdin=None, detach=False, timeout=120):
    """docker exec into the agent container. args is an argv list; nothing is shell-interpreted."""
    cmd = ["docker", "exec"] + (["-d"] if detach else []) + (["-i"] if stdin is not None else []) + [AGENT] + args
    r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def jexec(args, **kw):
    rc, out, err = dexec(args, **kw)
    for cand in (out.strip(), (out.strip().splitlines() or [""])[-1]):   # whole output, else last line
        try:
            return json.loads(cand)
        except Exception:
            continue
    return {"error": (err or out or f"exit {rc}").strip()[-400:]}


def accounts(profile):
    prof = jexec(["cat", f"/work/config/generated/profiles/{profile}.json"])
    if "error" in prof or "routing" not in prof:
        return {"error": f"unknown profile {profile!r}"}
    routing = prof["routing"]
    # quota observations + the router's own evaluation, with this profile's policy
    obs_dir = f"/tmp/ops-obs-{secrets.token_hex(4)}"
    routes = json.dumps(routing["model_route"])
    logins = json.dumps(routing.get("login") or {})
    ev = jexec(["sh", "-c", 'P281_MODEL_ROUTES="$1" P281_LOGINS="$5" "$2" /work/p281/collect_obs.py "$3" >/dev/null 2>&1; '
                'printf %s "$4" > "$3/policy.json"; "$2" /work/p281/router.py "$3/policy.json" "$3"; rm -rf "$3"',
                "sh", routes, PY, obs_dir, json.dumps(routing), logins], timeout=180)
    evaluated = {e["provider"]: e for e in (ev.get("evaluated") or [])}
    rows = []
    for name in routing["candidates"]:
        login = routing["login"].get(name, name)
        st = jexec([PY, "/work/p281/login_helper.py", "status", name, login])
        e = evaluated.get(name, {})
        rows.append({
            "provider": name, "login": login, "route": routing["model_route"].get(name),
            "connection": st.get("state"), "plan": (st.get("account") or {}).get("plan"),
            "eligible": e.get("eligible"), "why": e.get("why"),
            "observed_at": e.get("observed_at"), "age_s": e.get("age_s"), "source": e.get("source"),
            "identity_basis": e.get("identity_basis"),
            "account_match": None if "why" not in e else not str(e.get("why", "")).startswith("account_mismatch"),
            "session_used": e.get("session_used"), "weekly_used": e.get("weekly_used"),
        })
    return {"profile": profile, "decision": ev.get("decision"), "chosen": ev.get("provider"),
            "reason": ev.get("reason"), "providers": rows}


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20000:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def log_message(self, fmt, *args):
        # never log request bodies (authorization codes); method and path only
        print(f"{self.command} {urlparse(self.path).path} -> {args[1] if len(args) > 1 else ''}", flush=True)

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); p = u.path
        if p == "/api/health":
            return self._send(200, {"ok": True, "agent": AGENT})
        if p == "/api/config/status":
            return self._send(200, jexec([PY, "/work/p281/cfg.py", "status"]))
        if p == "/api/profiles":
            rc, out, _ = dexec(["sh", "-c", "ls /work/config/generated/profiles/"])
            names = [x[:-5] for x in out.split() if x.endswith(".json")]
            profs = [jexec(["cat", f"/work/config/generated/profiles/{n}.json"]) for n in names]
            return self._send(200, [{"name": x.get("name"), "description": x.get("description"),
                                     "candidates": (x.get("routing") or {}).get("candidates")} for x in profs])
        if p == "/api/accounts":
            prof = (q.get("profile") or ["research-default"])[0]
            if not NAME.fullmatch(prof):
                return self._send(400, {"error": "invalid profile"})
            return self._send(200, accounts(prof))
        m = re.fullmatch(r"/api/accounts/([a-z]+)/login", p)
        if m:
            prov, login = m.group(1), (q.get("login") or [m.group(1)])[0]
            if prov not in PROVIDERS or not NAME.fullmatch(login):
                return self._send(400, {"error": "invalid provider or login"})
            return self._send(200, jexec([PY, "/work/p281/login_helper.py", "status", prov, login]))
        if p == "/api/runs":
            return self._send(200, jexec([PY, "/work/p281/run_workflow.py", "list"]))
        if p == "/api/approvals":          # read-only; approving stays in Preloop's console
            return self._send(200, jexec([PY, "/work/p281/approvals.py"]))
        if p == "/api/checks":             # what scripts/up.sh --check last found, and when
            rc, out, _ = dexec(["cat", "/work/evidence/checks/last.json"])
            if rc != 0:
                return self._send(200, {"at": None, "ok": None,
                                        "error": "the checks have not been run since this was added"})
            try:
                return self._send(200, json.loads(out))
            except ValueError:
                return self._send(200, {"at": None, "ok": None, "error": "unreadable check result"})
        m = re.fullmatch(r"/api/runs/([a-z0-9-]{6,40})", p)
        if m:
            return self._send(200, jexec([PY, "/work/p281/run_workflow.py", "show", m.group(1)]))
        return self._send(404, {"error": "no such route"})

    def do_POST(self):
        p = urlparse(self.path).path; b = self._body()
        if p in ("/api/config/generate", "/api/config/apply"):
            return self._send(200, jexec([PY, "/work/p281/cfg.py", p.rsplit("/", 1)[1]], timeout=300))
        m = re.fullmatch(r"/api/accounts/([a-z]+)/(login|code|cancel)", p)
        if m:
            prov, act = m.groups()
            login = b.get("login") or prov
            if prov not in PROVIDERS or not isinstance(login, str) or not NAME.fullmatch(login):
                return self._send(400, {"error": "invalid provider or login"})
            if act == "login":
                return self._send(200, jexec([PY, "/work/p281/login_helper.py", "start", prov, login], timeout=60))
            if act == "cancel":
                return self._send(200, jexec([PY, "/work/p281/login_helper.py", "cancel", prov, login]))
            code = b.get("code")
            if not isinstance(code, str) or not code.strip() or len(code) > 2000:
                return self._send(400, {"error": "missing code"})
            return self._send(200, jexec([PY, "/work/p281/login_helper.py", "code", prov, login], stdin=code))
        if p == "/api/runs":
            wf, prof, inputs = b.get("workflow"), b.get("profile") or "research-default", b.get("inputs") or {}
            if wf not in ("auto", "research-r", "novel-a", "trading-b") or not NAME.fullmatch(prof) or not isinstance(inputs, dict):
                return self._send(400, {"error": "invalid workflow, profile or inputs"})
            # The run is started detached, so what the stack cannot do has to be found out before
            # that: a refusal after detaching would look like a run that never reported anything.
            unrecorded = b.get("allow_unrecorded") is True
            gate = jexec([PY, "/work/p281/capabilities.py", "--missing"]
                         + (["--allow-unrecorded"] if unrecorded else []))
            if gate.get("missing"):
                return self._send(409, {"error": "the stack cannot run this now: "
                                                 + ", ".join(gate["missing"]), **gate})
            ui = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
            pairs = [f"{k}={v}" for k, v in inputs.items() if isinstance(v, (str, int))]
            rc, out, err = dexec([PY, "/work/p281/run_workflow.py", "start", ui, wf, prof] + pairs
                                 + (["--allow-unrecorded"] if unrecorded else []), detach=True)
            return self._send(202 if rc == 0 else 500, {"ui_id": ui} if rc == 0 else {"error": err[-300:]})
        return self._send(404, {"error": "no such route"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8781), H).serve_forever()
