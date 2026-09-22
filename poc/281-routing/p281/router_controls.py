"""#281 router controls: inject faults into normalized observations, check the decision.

usage: router_controls.py <live-obs-dir>
Starts from the live observations, applies one mutation per case, runs router.py on the result
and compares with the expected decision. No model, no network — deterministic.
"""
import copy, json, os, subprocess, sys, tempfile
from datetime import datetime, timedelta, timezone

live = sys.argv[1]
base = {p[:-5]: json.load(open(os.path.join(live, p))) for p in os.listdir(live) if p.endswith(".json")}
now = datetime.now(timezone.utc)
iso = lambda dt: dt.isoformat()


def fresh(o, age_s=60):
    o["observed_at"] = iso(now - timedelta(seconds=age_s)); return o


def case(name, mutate, expect_decision, expect_provider=""):
    obs = copy.deepcopy(base)
    mutate(obs)
    with tempfile.TemporaryDirectory() as d:
        for k, v in obs.items():
            if v is not None:
                json.dump(v, open(os.path.join(d, f"{k}.json"), "w"))
        r = json.loads(subprocess.run(
            [sys.executable, os.path.join(os.path.dirname(__file__), "router.py"),
             os.path.join(os.path.dirname(__file__), "routing-policy.json"), d],
            capture_output=True, text=True, env={**os.environ, "ROUTER_NOW": iso(now)}).stdout)
    ok = r["decision"] == expect_decision and r["provider"] == expect_provider
    why = {e["provider"]: e["why"] for e in r["evaluated"]}
    return {"case": name, "expect": f"{expect_decision} {expect_provider}".strip(),
            "got": f"{r['decision']} {r['provider']}".strip(), "ok": ok, "why": why}


def set_(path, value):
    def f(obs):
        o = obs
        for k in path[:-1]:
            o = o[k]
        o[path[-1]] = value
    return f


def seq(*fs):
    def f(obs):
        for g in fs:
            g(obs)
    return f


stale_claude = lambda o: fresh(o["claude"], 7200)   # take claude out, to exercise the fallbacks

cases = [
    # preference order: claude, codex, grok
    case("live observations as collected", lambda o: None, "ROUTE", "claude"),
    case("claude STALE → next in order (codex)", stale_claude, "ROUTE", "codex"),
    case("claude session 85% → codex",
         set_(["claude", "windows", "session", "used_percent"], 85.0), "ROUTE", "codex"),
    case("claude ACCOUNT MISMATCH → never claude; codex",
         set_(["claude", "observed_account"], "route-login:claude:other-org"), "ROUTE", "codex"),
    case("claude out, codex ACCOUNT MISMATCH → grok",
         seq(stale_claude, set_(["codex", "observed_account"], "email:0000000000000000")), "ROUTE", "grok"),
    case("claude out, codex executing account unknown → grok",
         seq(stale_claude, set_(["codex", "executing_account"], None)), "ROUTE", "grok"),
    case("claude out, codex STALE (2 h, numbers fine) → grok",
         seq(stale_claude, lambda o: fresh(o["codex"], 7200)), "ROUTE", "grok"),
    case("claude out, codex timestamp 1 h in the future → grok",
         seq(stale_claude, lambda o: fresh(o["codex"], -3600)), "ROUTE", "grok"),
    case("claude out, codex required weekly window missing → grok",
         seq(stale_claude, lambda o: o["codex"]["windows"].pop("weekly", None)), "ROUTE", "grok"),
    case("claude out, codex weekly 95% → grok",
         seq(stale_claude, set_(["codex", "windows", "weekly", "used_percent"], 95)), "ROUTE", "grok"),
    case("claude out, codex observer down → grok",
         seq(stale_claude, set_(["codex"], None)), "ROUTE", "grok"),
    case("claude out, grok mismatch, codex exhausted → HOLD",
         seq(stale_claude, set_(["grok", "observed_account"], "email:0000000000000000"),
             set_(["codex", "windows", "weekly", "used_percent"], 95)), "HOLD"),
    case("all three stale → HOLD",
         seq(stale_claude, lambda o: fresh(o["grok"], 7200), lambda o: fresh(o["codex"], 7200)), "HOLD"),
    case("all three exhausted → HOLD",
         seq(set_(["claude", "windows", "weekly", "used_percent"], 99.0),
             set_(["codex", "windows", "weekly", "used_percent"], 99),
             set_(["grok", "windows", "weekly", "used_percent"], 99)), "HOLD"),
    # malformed numbers: the bad candidate becomes unknown, the choice continues (review 2026-09-22)
    case("claude weekly -1 → claude unknown; codex",
         set_(["claude", "windows", "weekly", "used_percent"], -1), "ROUTE", "codex"),
    case("claude weekly NaN → claude unknown; codex",
         set_(["claude", "windows", "weekly", "used_percent"], float("nan")), "ROUTE", "codex"),
    case("claude weekly Infinity → codex",
         set_(["claude", "windows", "weekly", "used_percent"], float("inf")), "ROUTE", "codex"),
    case("claude weekly 150 → codex",
         set_(["claude", "windows", "weekly", "used_percent"], 150), "ROUTE", "codex"),
    case("claude weekly \"55\" (string) → codex, no crash",
         set_(["claude", "windows", "weekly", "used_percent"], "55"), "ROUTE", "codex"),
    case("claude weekly true (bool) → codex",
         set_(["claude", "windows", "weekly", "used_percent"], True), "ROUTE", "codex"),
    case("claude windows is a list → codex, no crash",
         set_(["claude", "windows"], [1, 2]), "ROUTE", "codex"),
    case("claude observed_at is a number → codex, no crash",
         set_(["claude", "observed_at"], 12345), "ROUTE", "codex"),
    case("every candidate malformed → HOLD, no crash",
         seq(set_(["claude", "windows", "weekly", "used_percent"], "x"),
             set_(["codex", "windows", "weekly", "used_percent"], -5),
             set_(["grok", "windows", "weekly", "used_percent"], float("nan"))), "HOLD"),
    case("codex and grok exhausted, claude fine → claude",
         seq(set_(["codex", "windows", "weekly", "used_percent"], 99),
             set_(["grok", "windows", "weekly", "used_percent"], 99)), "ROUTE", "claude"),
]

for c in cases:
    print(json.dumps(c))
print(json.dumps({"passed": sum(c["ok"] for c in cases), "total": len(cases)}))
