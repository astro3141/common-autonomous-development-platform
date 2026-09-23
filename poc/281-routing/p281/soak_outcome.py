"""One line about how a soak cycle ended. usage: soak_outcome.py <ui-id>"""
import json, subprocess, sys

v = json.loads(subprocess.run(["/opt/venv/bin/python", "/work/p281/run_workflow.py", "show",
                               sys.argv[1]], capture_output=True, text=True, cwd="/work").stdout
              or "{}")
o = v.get("output") or {}
print(json.dumps({
    "state": v.get("state"), "exit": v.get("exit"), "ended_at": v.get("terminated_at"),
    # why it ended there — an unattended cycle that holds every night is only useful with this
    "reason": (v.get("termination_reason") or "")[:160],
    "valid": o.get("valid"), "failed": o.get("failed_lanes") or o.get("failed_shapes") or "",
    "overlap": o.get("lane_overlap"), "model_calls": o.get("model_calls"),
    "record_error": (o.get("record_error") or "")[:80],
    "mlflow": bool((v.get("mlflow") or {}).get("run_id")),
    "capabilities_at_start": v.get("capabilities"),
}, ensure_ascii=False))
