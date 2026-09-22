"""#281 router: choose a provider from normalized quota observations. No vendor code.

usage: router.py <policy.json> <observations-dir>
prints one JSON decision: {"decision": "ROUTE"|"HOLD", "provider": ..., "reason": ..., "evaluated": [...]}

Observation files (<obs-dir>/<provider>.json), written by collect_obs.py or by a test:
  {"provider": str, "source": str, "observed_at": ISO-8601 UTC,
   "observed_account": str|null,          # whose quota this is, as the source reports it
   "executing_account": str|null,          # the account the execution layer would run as
   "identity_basis": "email"|"structural", # how the two were obtained
   "windows": {"session": {"used_percent": float, "resets_at": ISO|null},
               "weekly":  {"used_percent": float, "resets_at": ISO|null}}}

Rules, in order, per candidate (policy "candidates" order is preference order):
  1. no observation                      -> ineligible (unknown)
  2. observed_account != executing_account -> ineligible (account_mismatch) — never "close enough"
  3. observation older than max_age_s     -> ineligible (stale) — a stale number is not a number
  4. a window in require_windows missing   -> ineligible (unknown); other missing windows are
     recorded as "not reported", never assumed empty
  5. any reported window used_percent >= its limit -> ineligible (exhausted)
  6. otherwise eligible
First eligible candidate wins. None eligible -> HOLD: the run does not start (fail closed).
"""
import json, math, os, sys
from datetime import datetime, timezone


def valid_percent(u):
    """A usable utilisation is a real, finite number in [0, 100]. bool is excluded explicitly
    (it is an int in Python). Anything else is not a number the router may act on."""
    return (isinstance(u, (int, float)) and not isinstance(u, bool) and math.isfinite(u)
            and 0 <= u <= 100)


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def evaluate(cand, obs, policy, now):
    r = {"provider": cand}
    if obs is None:
        return {**r, "eligible": False, "why": "unknown: no observation"}
    r.update(source=obs.get("source"), observed_at=obs.get("observed_at"),
             identity_basis=obs.get("identity_basis"))
    oa, ea = obs.get("observed_account"), obs.get("executing_account")
    if not oa or not ea or oa != ea:
        return {**r, "eligible": False,
                "why": f"account_mismatch: observed={oa!r} executing={ea!r}"}
    try:
        age = (now - parse_ts(obs["observed_at"])).total_seconds()
    except Exception:
        return {**r, "eligible": False, "why": "unknown: unparseable observed_at"}
    r["age_s"] = round(age)
    if age < -60:
        return {**r, "eligible": False, "why": f"unknown: observed_at is {-round(age)}s in the future"}
    if age > policy["max_age_s"]:
        return {**r, "eligible": False, "why": f"stale: {round(age)}s old > {policy['max_age_s']}s"}
    wins = obs.get("windows") or {}
    if not isinstance(wins, dict):
        return {**r, "eligible": False, "why": "unknown: windows malformed"}
    for w in policy.get("require_windows", []):
        if (wins.get(w) or {}).get("used_percent") is None:
            return {**r, "eligible": False, "why": f"unknown: required {w} window not reported"}
    for w, limit in policy["max_used_percent"].items():
        u = (wins.get(w) or {}).get("used_percent")
        if u is None:
            r[f"{w}_used"] = "not reported"   # optional window: recorded, not assumed
            continue
        if not valid_percent(u):
            return {**r, "eligible": False, "why": f"unknown: {w} used_percent invalid ({u!r})"}
        r[f"{w}_used"] = u
        if u >= limit:
            return {**r, "eligible": False, "why": f"exhausted: {w} {u}% >= {limit}%"}
    return {**r, "eligible": True, "why": "within limits"}


def main():
    policy = json.load(open(sys.argv[1]))
    d = sys.argv[2]
    now = parse_ts(os.environ["ROUTER_NOW"]) if os.environ.get("ROUTER_NOW") else datetime.now(timezone.utc)
    evaluated = []
    for cand in policy["candidates"]:
        p = os.path.join(d, f"{cand}.json")
        obs = json.load(open(p)) if os.path.exists(p) else None
        try:
            evaluated.append(evaluate(cand, obs, policy, now))
        except Exception as e:   # one malformed observation must not stop the whole choice
            evaluated.append({"provider": cand, "eligible": False,
                              "why": f"unknown: observation unreadable ({type(e).__name__})"})
    chosen = next((e for e in evaluated if e["eligible"]), None)
    print(json.dumps({
        "decision": "ROUTE" if chosen else "HOLD",
        "provider": chosen["provider"] if chosen else "",
        "reason": (f"{chosen['provider']}: {chosen['why']}" if chosen
                   else "no eligible provider: " + "; ".join(f"{e['provider']}={e['why']}" for e in evaluated)),
        "evaluated": evaluated,
        "now": now.isoformat(),
    }))


if __name__ == "__main__":
    main()
