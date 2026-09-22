"""Conductor script step: one model task through the routing/execution layer.

usage: agent_task.py <provider> <model_route> <label> <prompt-file> <expected-file>
The prompt file may use {WS} for the run's shared workspace (/ws/<conductor run id>), which
every model step of the run shares, so a later step can read what an earlier one wrote.
Writes are only possible through the Preloop MCP server (native write/shell are removed);
Preloop's rules decide them. Emits the normalized result flat for Conductor.
"""
import json, os, subprocess, sys

provider, model_route, label, prompt_file, expected = sys.argv[1:6]
run = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
ws = f"/ws/{run}"
os.makedirs(ws, exist_ok=True)
run_id = f"{run}-{label}-{provider}"
evid = f"/work/evidence/p281/{run_id}"
os.makedirs(evid, exist_ok=True)
req = {"run_id": run_id, "provider": provider, "model_route": model_route or "preloop_gateway",
       "cwd": ws, "timeout_ms": 600000, "native_tools": False, "evidence_dir": evid,
       "prompt": open(prompt_file, encoding="utf-8").read().replace("{WS}", ws)}
rp = os.path.join(evid, "request.json")
json.dump(req, open(rp, "w"), indent=1)
p = subprocess.run(["node", "/work/p281/run-agent.mjs", rp], capture_output=True, text=True,
                   env={**os.environ, "NODE_NO_WARNINGS": "1"})
try:
    r = json.loads(p.stdout.strip().splitlines()[-1])
except Exception:
    r = {"status": "FAILED", "failure": {"message": (p.stderr or p.stdout)[-400:]}}
q = ((r.get("turn") or {}).get("_meta") or {}).get("quota") or {}
meas = {"total_tokens": (q.get("token_count") or {}).get("totalTokens"), "wall_ms": r.get("wall_ms")}
exp_path = os.path.join(ws, expected)
print(json.dumps({
    "status": r.get("status", "FAILED"),
    "provider": provider,
    "model_route": r.get("model_route") or model_route,
    "run_id": run_id,
    "workspace": ws,
    "produced_path": exp_path,
    "produced": os.path.isfile(exp_path),
    "model_session_reported": (r.get("model") or {}).get("session_reported") or "",
    "model_adapter_reported": ",".join(m.get("model", "") for m in q.get("model_usage", [])),
    "model_served": (r.get("model") or {}).get("served") or "unknown",
    "approvals_requested": sum(1 for x in r.get("permissions", []) if x.get("routed") == "preloop_approval"),
    "mcp_rule_denials": len(r.get("mcp_denials", [])),
    "retryable_elsewhere": bool(r.get("retryable_elsewhere")),
    "evidence_dir": evid,
    # missing measurements are omitted, never 0
    "measurements": {k: v for k, v in meas.items() if isinstance(v, (int, float)) and not isinstance(v, bool)},
}))
