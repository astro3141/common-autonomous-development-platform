"""Conductor script step: assign a provider to each role of a role-split workflow.

usage: roles.py <profile> <role>=<provider> [...]

The router (steps/route.py) answers "may anything run, and on which provider" from quota. A
role-split workflow needs something else: each role is bound to a *named* provider by design
(the novel-shaped trial binds Author, Reviewer and Cold Reader to different vendors), and what
this step supplies is the login and model route that profile gives that provider — plus whether
the profile admits it at all.

A role whose provider the profile does not carry is reported as unavailable rather than guessed.
"""
import json, sys

sys.path.insert(0, "/work/p281")
import settings

prof_name = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "research-default"
PROF = settings.profile(prof_name) or {}
routing = PROF.get("routing") or {}
candidates = routing.get("candidates") or []
logins = routing.get("login") or {}
routes = routing.get("model_route") or {}

out = {"profile": prof_name}
missing = []
for arg in sys.argv[2:]:
    role, _, provider = arg.partition("=")
    if provider in candidates:
        out[f"{role}_provider"] = provider
        out[f"{role}_login"] = logins.get(provider, provider)
        out[f"{role}_route"] = routes.get(provider, "preloop_gateway")
    else:
        # the profile does not carry this provider: say so, do not substitute another vendor
        out[f"{role}_provider"] = ""
        out[f"{role}_login"] = ""
        out[f"{role}_route"] = ""
        missing.append(f"{role}:{provider}")
out["missing"] = ",".join(missing)
out["ok"] = "yes" if not missing else "no"
print(json.dumps(out))
