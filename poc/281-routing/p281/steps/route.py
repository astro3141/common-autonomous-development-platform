"""Conductor script step: collect normalized quota observations and choose a provider.

Emits the router decision flat for Conductor; the full evaluation is kept in the evidence dir.
"""
import json, os, subprocess, sys
sys.path.insert(0, "/work/p281")
import settings

run = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
d = f"/work/evidence/p281/route-{run}"
os.makedirs(d, exist_ok=True)
here = "/work/p281"
# The profile's routing policy, generated from config/profiles/<name>.yaml. ROUTING_POLICY
# (a raw policy file) still overrides it — used by the fault-injection and limit tests.
prof_name = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "research-default"
if os.environ.get("ROUTING_POLICY"):
    policy_path = os.environ["ROUTING_POLICY"]
    pol = json.load(open(policy_path))
else:
    prof = settings.profile(prof_name)
    if prof is None:
        print(json.dumps({"decision": "HOLD", "provider": "", "reason": f"unknown profile {prof_name!r} (run cfg.py generate)",
                          "evaluated": "[]", "model_route": "", "login": "", "profile": prof_name, "evidence_dir": d}))
        sys.exit(0)
    pol = prof["routing"]
    policy_path = f"{d}/policy.json"
    json.dump(pol, open(policy_path, "w"), indent=1)
routes = pol.get("model_route", {})
subprocess.run([sys.executable, f"{here}/collect_obs.py", f"{d}/obs"], check=True, capture_output=True,
               env={**os.environ, "P281_MODEL_ROUTES": json.dumps(routes)})
r = json.loads(subprocess.run([sys.executable, f"{here}/router.py", policy_path, f"{d}/obs"],
                              check=True, capture_output=True, text=True).stdout)
json.dump(r, open(f"{d}/decision.json", "w"), indent=1)
print(json.dumps({"decision": r["decision"], "provider": r["provider"], "reason": r["reason"],
                  "model_route": routes.get(r["provider"], "preloop_gateway") if r["provider"] else "",
                  "login": (pol.get("login") or {}).get(r["provider"], r["provider"]) if r["provider"] else "",
                  "profile": prof_name,
                  "evaluated": json.dumps(r["evaluated"]), "evidence_dir": d}))
