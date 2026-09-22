"""Conductor script step: collect normalized quota observations and choose a provider.

Emits the router decision flat for Conductor; the full evaluation is kept in the evidence dir.
"""
import json, os, subprocess, sys

run = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
d = f"/work/evidence/p281/route-{run}"
os.makedirs(d, exist_ok=True)
here = "/work/p281"
policy_path = os.environ.get("ROUTING_POLICY", f"{here}/routing-policy.json")
routes = json.load(open(policy_path)).get("model_route", {})
subprocess.run([sys.executable, f"{here}/collect_obs.py", f"{d}/obs"], check=True, capture_output=True,
               env={**os.environ, "P281_MODEL_ROUTES": json.dumps(routes)})
r = json.loads(subprocess.run([sys.executable, f"{here}/router.py", policy_path, f"{d}/obs"],
                              check=True, capture_output=True, text=True).stdout)
json.dump(r, open(f"{d}/decision.json", "w"), indent=1)
print(json.dumps({"decision": r["decision"], "provider": r["provider"], "reason": r["reason"],
                  "model_route": routes.get(r["provider"], "preloop_gateway") if r["provider"] else "",
                  "evaluated": json.dumps(r["evaluated"]), "evidence_dir": d}))
