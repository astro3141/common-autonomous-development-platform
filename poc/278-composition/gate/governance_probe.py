"""Governance evidence for the #278 Gate, derived from Conductor's own event stream.

This replaces an earlier version that queried the Preloop control plane over HTTP.
That approach is refuted by measurement (FINDINGS.md F14/F15): on this stack a policy
decision is enforced reliably but is not exposed through any queryable API, and the
OTel spans that reach MLflow cannot distinguish an allowed call from a denied one.

Conductor's run event log does carry the outcome verbatim (F16), it is written
incrementally during the run, and Conductor exports `CONDUCTOR_SELF_RUN_ID` to script
steps — a native identifier, so no correlation shim is needed.

Classification rule, stated explicitly because it is the one place this script
interprets anything:

    A governed call is one whose tool name starts with `mcp__preloop__`.
    Its result is treated as EXECUTED when the payload parses as a JSON object
    (the tool's own structured return), and as NOT EXECUTED otherwise.

This keys on "did the tool return its own payload", not on matching Preloop's wording,
so it does not re-implement policy semantics. The verbatim result is carried into the
evidence either way, so the Gate's input is auditable rather than a bare verdict.

Owns no state, makes no network call, and reaches no policy decision of its own.
"""

import glob
import json
import os
import sys

GOVERNED_PREFIX = "mcp__preloop__"
EVENT_DIR = os.environ.get("CONDUCTOR_EVENT_DIR", "/tmp/conductor")

# The token the governed call must name for its approval to count as evidence about THIS
# target and THIS attempt. Probes G3/G4 showed that without it, an approval obtained for a
# different artifact — or in an earlier attempt of the same run — satisfies the Gate.
BINDING_TOKEN = (sys.argv[1] if len(sys.argv) > 1 else "").strip()


def find_event_log(run_id: str) -> str | None:
    if not run_id:
        return None
    matches = glob.glob(os.path.join(EVENT_DIR, f"conductor-*-{run_id}.events.jsonl"))
    return max(matches, key=os.path.getmtime) if matches else None


def read_events(path: str) -> list[dict]:
    events = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                # A partially written trailing line while the run is still going.
                continue
    return events


def executed(result: str) -> bool:
    try:
        return isinstance(json.loads(result), dict)
    except (json.JSONDecodeError, TypeError):
        return False


def main() -> int:
    run_id = os.environ.get("CONDUCTOR_SELF_RUN_ID", "")
    path = find_event_log(run_id)
    if path is None:
        out = {
            "status": "UNKNOWN",
            "source": "conductor-events",
            "detail": f"no event log for run_id={run_id!r} under {EVENT_DIR}",
            "governed_calls": 0,
            "denied_calls": 0,
            "run_id": run_id,
        }
        sys.stderr.write(out["detail"] + "\n")
        print(json.dumps(out))
        return 0

    # Pair each completion with the arguments its matching start event carried, so a call
    # can be tested against the binding token rather than counted blind.
    calls = []
    pending_args: dict = {}
    for event in read_events(path):
        etype = event.get("type")
        data = event.get("data", {})
        name = data.get("tool_name", "")
        if not name.startswith(GOVERNED_PREFIX):
            continue
        if etype == "agent_tool_start":
            pending_args.setdefault(name, []).append(data.get("arguments", {}))
            continue
        if etype != "agent_tool_complete":
            continue
        args = pending_args.get(name, []).pop(0) if pending_args.get(name) else {}
        result = data.get("result", "")
        blob = json.dumps(args, ensure_ascii=False) + " " + str(result)
        calls.append(
            {
                "tool": name[len(GOVERNED_PREFIX):],
                "executed": executed(result),
                "bound": bool(BINDING_TOKEN) and BINDING_TOKEN in blob,
                "arguments": args,
                "result": result[:400],
            }
        )

    denied = [c for c in calls if not c["executed"]]
    bound = [c for c in calls if c["bound"]]
    bound_ok = [c for c in bound if c["executed"]]
    if not calls:
        status, detail = "UNKNOWN", "no governed tool calls observed in this run"
    elif denied:
        status = "DENIED"
        detail = f"{len(denied)} of {len(calls)} governed call(s) did not execute"
    elif not BINDING_TOKEN:
        status = "UNKNOWN"
        detail = "no binding token supplied; governance cannot be tied to this target"
    elif not bound_ok:
        status = "UNKNOWN"
        detail = (
            f"{len(calls)} governed call(s) executed but none named the gated target "
            f"{BINDING_TOKEN[:12]!r}"
        )
    else:
        status = "APPROVED"
        detail = f"{len(bound_ok)} governed call(s) executed naming the gated target"

    out = {
        "status": status,
        "source": "conductor-events",
        "detail": detail,
        "governed_calls": len(calls),
        "denied_calls": len(denied),
        "bound_calls": len(bound_ok),
        "bound_to_target": bool(bound_ok) and not denied,
        "binding_token": BINDING_TOKEN,
        "run_id": run_id,
        "event_log": path,
        "calls": calls,
    }
    sys.stderr.write(f"governance: {status} — {detail} (run {run_id})\n")
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
