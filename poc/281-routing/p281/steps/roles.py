"""Conductor script step: assign a provider to each role of a role-split workflow.

usage: roles.py <profile> <router-evidence-dir> <role>=<provider> [...]

The router (steps/route.py) answers "may anything run, and on which provider" from quota, and its
answer names one provider. A role-split workflow needs more than that: each role is bound to a
*named* provider by design (the novel-shaped trial binds Author, Reviewer and Cold Reader to
different vendors), so every provider a role will actually run on has to be admissible on its own.

Two things are therefore checked per role, and a role that fails either is reported rather than
guessed or substituted:

  * the profile carries that provider at all (it names its login and model route), and
  * the router found that provider **eligible** in this run's own evaluation — read from the
    decision the router just wrote, never inferred from the fact that some other provider had
    room. Measured before this check existed: with Codex and Claude both over their limit and
    only Grok eligible, the Codex and Claude roles were still returned as ok.

No evaluation to read is not "fine": it is reported as unavailable, the same way the router holds
a run when it cannot see a quota.
"""
import json, os, sys

sys.path.insert(0, "/work/p281")
import settings

prof_name = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "research-default"
evidence_dir = sys.argv[2] if len(sys.argv) > 2 else ""
specs = sys.argv[3:]
if evidence_dir and "=" in evidence_dir:        # called without the evidence dir
    specs, evidence_dir = [evidence_dir, *specs], ""

PROF = settings.profile(prof_name) or {}
routing = PROF.get("routing") or {}
candidates = routing.get("candidates") or []
logins = routing.get("login") or {}
routes = routing.get("model_route") or {}


def eligibility():
    """provider -> (eligible, why) from this run's router decision; {} when there is none."""
    p = os.path.join(evidence_dir, "decision.json") if evidence_dir else ""
    if not p or not os.path.isfile(p):
        return None
    try:
        d = json.load(open(p, encoding="utf-8"))
    except ValueError:
        return None
    ev = d.get("evaluated")
    if not isinstance(ev, list):
        return None
    return {e.get("provider"): (bool(e.get("eligible")), e.get("why") or "")
            for e in ev if isinstance(e, dict)}


elig = eligibility()
out = {"profile": prof_name}
missing, ineligible = [], []
for arg in specs:
    role, _, provider = arg.partition("=")
    why = ""
    if provider not in candidates:
        # the profile does not carry this provider: say so, do not substitute another vendor
        why, bucket = "not in the profile", missing
    elif elig is None:
        why, bucket = "no router evaluation to read", ineligible
    elif provider not in elig:
        why, bucket = "the router did not evaluate it", ineligible
    elif not elig[provider][0]:
        why, bucket = elig[provider][1], ineligible
    if why:
        out[f"{role}_provider"] = out[f"{role}_login"] = out[f"{role}_route"] = ""
        bucket.append(f"{role}:{provider} ({why})")
        continue
    out[f"{role}_provider"] = provider
    out[f"{role}_login"] = logins.get(provider, provider)
    out[f"{role}_route"] = routes.get(provider, "preloop_gateway")
out["missing"] = ",".join(missing)
out["ineligible"] = ",".join(ineligible)
out["ok"] = "yes" if not missing and not ineligible else "no"
print(json.dumps(out, ensure_ascii=False))
