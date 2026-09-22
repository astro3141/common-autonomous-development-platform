"""Account connection for the routing layer — run inside the agent container, driven by the ops API.

usage:
  login_helper.py start  <provider> [login-name]   start the provider's official login in the background
  login_helper.py status <provider> [login-name]   JSON: state, url, user_code, needs_code, account
  login_helper.py code   <provider> [login-name]   read an authorization code on stdin, hand it to the login
  login_helper.py cancel <provider> [login-name]

The provider's own CLI runs under a pseudo-terminal, through the allowlist proxy, into the
routing layer's login directory (<logins_root>/<login-name>). Its output is parsed for the
official login URL and device code. For flows that end with "paste the code" (Claude), the code
is handed over through a FIFO — never written to disk, never logged.
"""
import json, os, pty, re, select, signal, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, "/work/p281")
import settings

RT = settings.runtime()
LOGINS = Path(RT["paths"]["logins_root"])
STATE_DIR = LOGINS / ".logins"
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


def provider_cmd(provider, home):
    """The provider's official login command and environment. Nothing else is ever executed."""
    env = {**os.environ, **settings.egress_env(RT)}
    if provider == "claude":
        env["CLAUDE_CONFIG_DIR"] = str(home)
        return ["claude", "auth", "login", "--claudeai"], env
    if provider == "codex":
        env["CODEX_HOME"] = str(home)
        return ["codex", "login", "--device-auth"], env
    if provider == "grok":
        env["GROK_HOME"] = str(home); env["HOME"] = str(home / "home")
        (home / "home").mkdir(parents=True, exist_ok=True)
        return ["grok", "login", "--device-auth"], env
    raise SystemExit(json.dumps({"error": f"unknown provider {provider!r}"}))


def account_status(provider, home):
    """Whether the login directory holds a working login, and a non-reversible account label."""
    env = {**os.environ, **settings.egress_env(RT)}
    try:
        if provider == "claude":
            r = subprocess.run(["claude", "auth", "status"], env={**env, "CLAUDE_CONFIG_DIR": str(home)},
                               capture_output=True, text=True, timeout=30)
            d = json.loads(r.stdout or "{}")
            return {"logged_in": bool(d.get("loggedIn")), "plan": d.get("subscriptionType")}
        if provider == "codex":
            r = subprocess.run(["codex", "login", "status"], env={**env, "CODEX_HOME": str(home)},
                               capture_output=True, text=True, timeout=30)
            return {"logged_in": "Logged in" in (r.stdout + r.stderr), "plan": None}
        if provider == "grok":
            return {"logged_in": (home / "auth.json").is_file() and (home / "auth.json").stat().st_size > 0, "plan": None}
    except Exception as e:
        return {"logged_in": False, "error": f"{type(e).__name__}"}
    return {"logged_in": False}


def paths(provider, login):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    base = STATE_DIR / login
    return {"home": LOGINS / login, "log": base.with_suffix(".log"), "state": base.with_suffix(".json"),
            "fifo": base.with_suffix(".fifo")}


def parse(text, provider):
    t = ANSI.sub("", text)
    url = next(iter(re.findall(r"https://[^\s\"'<>]+", t)), None)
    urls = re.findall(r"https://[^\s\"'<>]+", t)
    # prefer the provider's authorisation URL over incidental links
    for u in urls:
        if any(k in u for k in ("oauth", "authorize", "/device", "login")):
            url = u; break
    code = None
    m = re.search(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b", t)
    if m and provider in ("codex", "grok"):
        code = m.group(1)
    needs_code = provider == "claude" and bool(re.search(r"(?i)paste|enter.*code|authorization code", t))
    ok = bool(re.search(r"(?i)successfully logged in|signed in as|login successful|logged in", t))
    return {"url": url, "user_code": code, "needs_code": needs_code, "success_text": ok}


def cmd_start(provider, login):
    p = paths(provider, login)
    st = json.loads(p["state"].read_text()) if p["state"].exists() else {}
    if st.get("pid") and Path(f"/proc/{st['pid']}").exists():
        return {"state": "running", "note": "a login is already in progress"}
    p["home"].mkdir(parents=True, exist_ok=True)
    os.chmod(p["home"], 0o700)
    for f in ("log", "fifo"):
        if p[f].exists():
            p[f].unlink()
    os.mkfifo(p["fifo"], 0o600)
    if os.fork():                                   # parent returns to the caller at once
        time.sleep(1.5)
        return {"state": "started"}
    os.setsid()
    cmd, env = provider_cmd(provider, p["home"])
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(cmd[0], cmd, env)
    p["state"].write_text(json.dumps({"pid": pid, "provider": provider, "login": login, "started_at": time.time()}))
    fifo = os.open(p["fifo"], os.O_RDONLY | os.O_NONBLOCK)
    with open(p["log"], "wb") as log:
        while True:
            r, _, _ = select.select([fd, fifo], [], [], 1.0)
            if fd in r:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                log.write(data); log.flush()
            if fifo in r:
                code = os.read(fifo, 4096)
                if code:
                    os.write(fd, code.strip() + b"\r")    # handed straight to the CLI; not logged
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                break
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
    st = json.loads(p["state"].read_text())
    st.update({"exit": os.waitstatus_to_exitcode(status) if isinstance(status, int) else None, "ended_at": time.time()})
    p["state"].write_text(json.dumps(st))
    try:
        p["fifo"].unlink()
    except FileNotFoundError:
        pass
    os._exit(0)


def cmd_status(provider, login):
    p = paths(provider, login)
    st = json.loads(p["state"].read_text()) if p["state"].exists() else {}
    text = p["log"].read_text(errors="replace") if p["log"].exists() else ""
    running = bool(st.get("pid")) and "exit" not in st and Path(f"/proc/{st['pid']}").exists()
    parsed = parse(text, provider)
    acct = account_status(provider, p["home"])
    if running:
        state = "waiting_for_code" if parsed["needs_code"] else ("waiting_for_browser" if parsed["url"] else "starting")
    elif st.get("exit") == 0 and acct.get("logged_in"):
        state = "connected"
    elif "exit" in st:
        state = "failed"
    else:
        state = "connected" if acct.get("logged_in") else "not_connected"
    tail = ANSI.sub("", text)[-400:] if state == "failed" else ""
    return {"provider": provider, "login": login, "state": state, "url": parsed["url"] if running else None,
            "user_code": parsed["user_code"] if running else None, "needs_code": parsed["needs_code"] and running,
            "account": acct, "detail": tail}


def cmd_code(provider, login):
    p = paths(provider, login)
    code = sys.stdin.read().strip()
    if not code:
        return {"ok": False, "error": "empty code"}
    if not p["fifo"].exists():
        return {"ok": False, "error": "no login is waiting for a code"}
    fd = os.open(p["fifo"], os.O_WRONLY | os.O_NONBLOCK)
    os.write(fd, code.encode() + b"\n"); os.close(fd)
    return {"ok": True}


def cmd_cancel(provider, login):
    p = paths(provider, login)
    st = json.loads(p["state"].read_text()) if p["state"].exists() else {}
    if st.get("pid"):
        try:
            os.kill(st["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
    return {"ok": True}


if __name__ == "__main__":
    os.umask(0o077)   # login state and output: readable by the agent user only
    action, provider = sys.argv[1], sys.argv[2]
    login = sys.argv[3] if len(sys.argv) > 3 else provider
    if provider not in ("claude", "codex", "grok") or not re.fullmatch(r"[a-z0-9-]{1,40}", login):
        print(json.dumps({"error": "invalid provider or login name"})); sys.exit(2)
    out = {"start": cmd_start, "status": cmd_status, "code": cmd_code, "cancel": cmd_cancel}[action](provider, login)
    if out is not None:
        print(json.dumps(out))
