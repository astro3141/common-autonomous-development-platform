"""Deterministic Gate for the #278 composition PoC.

Pure function: evidence (stdin JSON) -> decision (stdout JSON).

Owns no workflow state, calls no model, performs no external effect, queries no
observability backend. If this file ever needs to do any of those, per issue #278
the correct action is to STOP and record the counterexample.
"""

import hashlib
import json
import sys

DECISIONS = ("PASS", "RETRY", "BLOCK", "HUMAN_REQUIRED")

REQUIRED = {
    "tests.exit_code": int,
    "tests.failed": int,
    "review.verdict": str,
    "artifact.sha256": str,
    # Measured at decision time, not at test time. Probe G1 showed that without this the
    # artifact can change between the two and nothing notices.
    "artifact.matches_tested": bool,
    "governance.status": str,
    # Probe G3/G4 showed governance evidence with no target binding accepts an approval
    # obtained for a different artifact or in a different attempt.
    "governance.bound_to_target": bool,
}


def dig(obj, path):
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def decide(evidence: dict) -> dict:
    # 1. Evidence completeness. Missing or wrong-typed evidence can never PASS.
    missing = []
    for path, typ in REQUIRED.items():
        value = dig(evidence, path)
        if value is None or isinstance(value, bool) != (typ is bool) or not isinstance(value, typ):
            missing.append(path)
    if missing:
        return {
            "decision": "BLOCK",
            "reason": "required evidence missing or wrong-typed: " + ", ".join(sorted(missing)),
            "missing": sorted(missing),
        }

    # 2a. The artifact being decided about must be the artifact that was tested.
    if dig(evidence, "artifact.matches_tested") is not True:
        return {
            "decision": "BLOCK",
            "reason": "artifact changed between measurement and decision",
            "missing": [],
        }

    attempt = evidence.get("attempt", 1)
    max_attempts = evidence.get("max_attempts", 2)
    retries_left = isinstance(attempt, int) and isinstance(max_attempts, int) and attempt < max_attempts

    # 2. Governance is an observed fact from the control plane, not a model claim.
    status = dig(evidence, "governance.status")
    if dig(evidence, "governance.bound_to_target") is not True and status == "APPROVED":
        return {
            "decision": "BLOCK",
            "reason": "governance evidence is not bound to the gated target",
            "missing": [],
        }
    if status == "PENDING_APPROVAL":
        return {"decision": "HUMAN_REQUIRED", "reason": "governance approval pending", "missing": []}
    if status == "DENIED":
        return {"decision": "BLOCK", "reason": "governance denied the governed action", "missing": []}
    if status != "APPROVED":
        return {"decision": "BLOCK", "reason": f"unrecognized governance status: {status!r}", "missing": []}

    # 3. Observed test result.
    if dig(evidence, "tests.exit_code") != 0 or dig(evidence, "tests.failed") != 0:
        return {
            "decision": "RETRY" if retries_left else "BLOCK",
            "reason": "tests did not pass",
            "missing": [],
        }

    # 4. Reviewer verdict is explicitly typed as a model output, not as evidence.
    verdict = dig(evidence, "review.verdict")
    if verdict != "PASS":
        return {
            "decision": "RETRY" if retries_left else "BLOCK",
            "reason": f"review verdict is {verdict!r}",
            "missing": [],
        }

    return {"decision": "PASS", "reason": "required evidence satisfied", "missing": []}


def main() -> int:
    raw = sys.stdin.read()
    try:
        evidence = json.loads(raw) if raw.strip() else None
    except json.JSONDecodeError as exc:
        evidence = None
        sys.stderr.write(f"gate: unparseable evidence payload: {exc}\n")
    if not isinstance(evidence, dict):
        result = {"decision": "BLOCK", "reason": "evidence payload absent or not a JSON object", "missing": ["*"]}
    else:
        result = decide(evidence)
    result["evidence_sha256"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
