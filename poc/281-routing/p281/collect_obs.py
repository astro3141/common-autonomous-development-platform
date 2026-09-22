"""#281: build normalized quota observations for the router, one file per provider.

usage: collect_obs.py <out-dir>
Runs in the governed agent container. Vendor-specific by design — this is the collector, the
place where each source's shape is translated; router.py sees only the common format.

  codex  : (1) the execution layer's own session rollouts — rate_limits the provider returned to
               the very login that executes (direct route), basis "same-credential"
           (2) CodexBar in the observer container (own login, egress) → /obs/codex.raw.json
           observed account = CodexBar's identity.accountEmail (fingerprinted)
           executing account = the id_token email in this container's ~/.codex/auth.json,
           whose credential Preloop custodies for execution (fingerprinted)       → basis "email"
  claude : Preloop gateway's stored upstream headers (anthropic-ratelimit-unified-*)
           observed account = the Preloop-custodied Anthropic OAuth credential
           executing account = the same credential, when Claude's route is the Preloop gateway
           No email is available on either side                                   → basis "structural"
"""
import base64, glob, hashlib, json, os, sys, urllib.request
from datetime import datetime, timezone

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
fp = lambda s: "email:" + hashlib.sha256(s.lower().encode()).hexdigest()[:16] if s else None


def write(provider, rec):
    json.dump(rec, open(os.path.join(out, f"{provider}.json"), "w"), indent=1)


def iso_from_epoch(v):
    try:
        return datetime.fromtimestamp(int(v), timezone.utc).isoformat()
    except Exception:
        return None


# Which model route each provider will execute on (policy "model_route"); it decides whose
# login is the executing account.
ROUTES = json.loads(os.environ.get("P281_MODEL_ROUTES", "{}"))


# ---- codex ------------------------------------------------------------------------------
CODEX_HOME = "/route/codex" if ROUTES.get("codex") == "direct" else os.path.expanduser("~/.codex")


def codex_email_fp(home):
    a = json.load(open(os.path.join(home, "auth.json")))
    part = ((a.get("tokens") or {}).get("id_token") or "..").split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    return fp(claims.get("email", ""))


def window_name(minutes):
    # Sources label windows differently (the rollout calls the weekly window "primary", CodexBar
    # calls it "secondary"), so classify by length, not by label.
    if minutes is None:
        return None
    return "session" if minutes <= 24 * 60 else "weekly"


LEDGER = os.environ.get("P281_CODEX_LEDGER", "/route/codex-session-ledger.jsonl")


def ledger_sessions(account):
    """Session ids the adapter recorded as run under `account` (see run-agent.mjs sessionLedger)."""
    ok = set()
    try:
        for line in open(LEDGER):
            e = json.loads(line)
            if account and e.get("account") == account:
                ok.add(e["session_id"])
    except FileNotFoundError:
        pass
    return ok


def codex_from_rollouts(home, account):
    """Newest rate_limits the execution layer received — only from rollouts whose session the
    ledger binds to the current executing account. Rollouts record no account themselves, so an
    unbound rollout (older login, pre-ledger run) is ignored rather than attributed."""
    best = None
    bound = ledger_sessions(account)
    for f in sorted(glob.glob(os.path.join(home, "sessions", "**", "*.jsonl"), recursive=True))[-20:]:
        if not any(sid in os.path.basename(f) for sid in bound):
            continue
        for line in open(f, encoding="utf-8", errors="replace"):
            if '"rate_limits"' not in line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            rl = (ev.get("payload") or {}).get("rate_limits") or {}
            wins = {}
            for k in ("primary", "secondary"):
                w = rl.get(k)
                if w and w.get("used_percent") is not None:
                    wins[window_name(w.get("window_minutes"))] = {
                        "used_percent": w["used_percent"], "resets_at": iso_from_epoch(w.get("resets_at")),
                        "window_minutes": w.get("window_minutes")}
            if wins and (best is None or ev["timestamp"] > best["observed_at"]):
                best = {"observed_at": ev["timestamp"], "windows": wins, "file": os.path.basename(f)}
    return best


def codex_from_observer():
    raw = json.load(open("/obs/codex.raw.json"))
    item = next((x for x in (raw.get("payload") or []) if x.get("provider") == "codex"), None)
    if not item:
        return {"observed_at": raw.get("collected_at"), "windows": {}, "account": None,
                "error": f"codexbar exit {raw.get('exit')}"}
    u = item.get("usage") or {}
    wins = {}
    for k in ("primary", "secondary"):
        w = u.get(k)
        if w and w.get("usedPercent") is not None:
            wins[window_name(w.get("windowMinutes"))] = {"used_percent": w["usedPercent"],
                "resets_at": w.get("resetsAt"), "window_minutes": w.get("windowMinutes")}
    return {"observed_at": u.get("updatedAt") or raw.get("collected_at"), "windows": wins,
            "account": fp((u.get("identity") or {}).get("accountEmail") or u.get("accountEmail") or ""),
            "source": f"codexbar:{item.get('source')}"}


try:
    executing = codex_email_fp(CODEX_HOME)
except Exception:
    executing = None
cands = []
try:
    r = codex_from_rollouts(CODEX_HOME, executing)
    if r:
        # Same credential that executes: the quota the provider returned to *this* login.
        cands.append({"source": f"rollout:{r['file']}", "observed_at": r["observed_at"],
                      "observed_account": executing, "identity_basis": "same-credential",
                      "windows": r["windows"]})
except Exception as e:
    pass
try:
    o = codex_from_observer()
    cands.append({"source": o.get("source", "codexbar"), "observed_at": o["observed_at"],
                  "observed_account": o.get("account"), "identity_basis": "email",
                  "windows": o["windows"], **({"error": o["error"]} if o.get("error") else {})})
except FileNotFoundError:
    pass
if cands:
    ts = lambda c: datetime.fromisoformat((c["observed_at"] or "1970-01-01T00:00:00Z").replace("Z", "+00:00"))
    pick = max(cands, key=ts)
    write("codex", {"provider": "codex", **pick, "executing_account": executing,
                    "model_route": ROUTES.get("codex", "preloop_gateway"),
                    "other_sources": [{k: c[k] for k in ("source", "observed_at")} for c in cands if c is not pick]})
# no candidates → no file → router treats codex as unknown


# ---- grok -------------------------------------------------------------------------------
# CodexBar, run here with the routing layer's own Grok login (GROK_HOME=/route/grok) through
# the allowlist proxy. The reading is taken with the credential that executes → "same-credential".
if ROUTES.get("grok") == "direct":
    import subprocess
    try:
        p = subprocess.run(["codexbar", "usage", "--provider", "grok", "--json"], capture_output=True,
                           text=True, timeout=60, env={**os.environ, "HOME": "/route/grok/home",
                           "GROK_HOME": "/route/grok", "HTTPS_PROXY": "http://egress:8888",
                           "https_proxy": "http://egress:8888", "HTTP_PROXY": "http://egress:8888",
                           "NO_PROXY": "console,api,mlflow,localhost"})
        item = next((x for x in json.loads(p.stdout or "[]") if x.get("provider") == "grok"), None)
        u = (item or {}).get("usage") or {}
        wins = {}
        for k in ("primary", "secondary"):
            w = u.get(k)
            if w and w.get("usedPercent") is not None:
                wins[window_name(w.get("windowMinutes"))] = {"used_percent": w["usedPercent"],
                    "resets_at": w.get("resetsAt"), "window_minutes": w.get("windowMinutes")}
        acct = fp((u.get("identity") or {}).get("accountEmail") or "")
        write("grok", {"provider": "grok", "source": f"codexbar:{(item or {}).get('source')}",
                       "observed_at": u.get("updatedAt"), "observed_account": acct,
                       "executing_account": acct if item else None,
                       "identity_basis": "same-credential", "model_route": "direct", "windows": wins,
                       **({} if item else {"error": (p.stderr or "")[-200:]})})
    except Exception as e:
        write("grok", {"provider": "grok", "source": "codexbar", "observed_at": None,
                       "observed_account": None, "executing_account": None,
                       "identity_basis": "same-credential", "windows": {}, "error": str(e)[:200]})


# ---- claude -----------------------------------------------------------------------------
# Direct route: CodexBar with the routing layer's own Claude login (CLAUDE_CONFIG_DIR=/route/claude)
# through the proxy — fresh, the executing credential itself ("same-credential").
def codexbar_claude_direct():
    import subprocess
    p = subprocess.run(["codexbar", "usage", "--provider", "claude", "--source", "oauth", "--json"],
                       capture_output=True, text=True, timeout=60,
                       env={**os.environ, "CLAUDE_CONFIG_DIR": "/route/claude",
                            "HTTPS_PROXY": "http://egress:8888", "https_proxy": "http://egress:8888",
                            "HTTP_PROXY": "http://egress:8888", "NO_PROXY": "console,api,mlflow,localhost"})
    item = next((x for x in json.loads(p.stdout or "[]") if x.get("provider") == "claude"), None)
    u = (item or {}).get("usage") or {}
    wins = {}
    for k in ("primary", "secondary"):
        w = u.get(k)
        if w and w.get("usedPercent") is not None:
            wins[window_name(w.get("windowMinutes"))] = {"used_percent": w["usedPercent"],
                "resets_at": w.get("resetsAt"), "window_minutes": w.get("windowMinutes")}
    ident = "route-login:claude:" + (json.load(open("/route/claude/.claude.json")).get("oauthAccount") or {}).get("organizationUuid", "unknown")
    return {"provider": "claude", "source": f"codexbar:{(item or {}).get('source')}",
            "observed_at": u.get("updatedAt"), "observed_account": ident if item else None,
            "executing_account": ident, "identity_basis": "same-credential", "model_route": "direct",
            "windows": wins, "extra_windows": u.get("extraRateWindows") or [],
            **({} if item else {"error": (p.stderr or p.stdout or "")[-200:]})}


if ROUTES.get("claude") == "direct":
    try:
        write("claude", codexbar_claude_direct())
    except Exception as e:
        write("claude", {"provider": "claude", "source": "codexbar", "observed_at": None,
                         "observed_account": None, "executing_account": None,
                         "identity_basis": "same-credential", "windows": {}, "error": str(e)[:200]})
else:
  try:
      # `preloop auth token` refreshes an expired CLI token; reading config.yaml directly returned
      # a stale one (measured: 401).
      import subprocess
      tok = subprocess.run(["preloop", "auth", "token"], capture_output=True, text=True, timeout=30).stdout.strip().split()[-1]
      d = json.load(urllib.request.urlopen(urllib.request.Request(
          "http://api:8000/api/v1/account/gateway-usage/rate-limits",
          headers={"Authorization": "Bearer " + tok}), timeout=20))
      snaps = [s for s in d.get("latest_snapshots", []) if s.get("provider_name") == "anthropic"
               and ((s.get("rate_limit") or {}).get("headers") or {}).get("anthropic-ratelimit-unified-5h-utilization")]
      s = max(snaps, key=lambda s: s["observed_at"]) if snaps else None
      base = (json.load(open(os.path.expanduser("~/.claude/settings.json"))).get("env") or {}).get("ANTHROPIC_BASE_URL", "")
      executing = ("preloop-custody:anthropic-oauth" if base.startswith("http://console")
                   and ROUTES.get("claude", "preloop_gateway") == "preloop_gateway" else None)
      if s:
          h = s["rate_limit"]["headers"]
          pct = lambda k: round(float(h[k]) * 100, 1) if h.get(k) is not None else None
          write("claude", {
              "provider": "claude", "source": f"preloop-gateway:{s['model_alias']}",
              # Preloop stores naive UTC timestamps
              "observed_at": s["observed_at"] + ("" if s["observed_at"].endswith("Z") or "+" in s["observed_at"] else "+00:00"),
              "observed_account": f"preloop-custody:anthropic-{s.get('upstream_credential_type')}",
              "executing_account": executing,
              "identity_basis": "structural",
              "windows": {
                  "session": {"used_percent": pct("anthropic-ratelimit-unified-5h-utilization"),
                              "resets_at": iso_from_epoch(h.get("anthropic-ratelimit-unified-5h-reset"))},
                  "weekly": {"used_percent": pct("anthropic-ratelimit-unified-7d-utilization"),
                             "resets_at": iso_from_epoch(h.get("anthropic-ratelimit-unified-7d-reset"))},
              },
          })
  except Exception as e:
      write("claude", {"provider": "claude", "source": "preloop-gateway", "observed_at": None,
                       "observed_account": None, "executing_account": None,
                       "identity_basis": "structural", "windows": {}, "error": str(e)[:200]})

print(json.dumps({"out": out, "files": sorted(os.listdir(out))}))
