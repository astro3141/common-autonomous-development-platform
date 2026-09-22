"""Conductor script step: run one task through the routing/execution layer.

usage: execute.py <provider> <file_name> <content>
Knows nothing about any vendor: it builds the common request, calls run-agent.mjs, and
re-emits the normalized result as one flat JSON object for Conductor's output schema.
"""
import json, os, subprocess, sys

provider, file_name, content = sys.argv[1:4]
model_route = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "preloop_gateway"
run = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
run_id = f"{run}-{provider}"
cwd = f"/ws/{run_id}"
os.makedirs(cwd, exist_ok=True)
evid = f"/work/evidence/p281/{run_id}"
req = {
    "run_id": run_id, "provider": provider, "cwd": cwd, "timeout_ms": 400000,
    "native_tools": False, "evidence_dir": evid, "model_route": model_route,
    "prompt": (f"Create a file named {file_name} in the directory {cwd} containing exactly: "
               f"{content}. Use the write_file tool from the preloop MCP server with the "
               f"absolute path. Do not do anything else."),
}
os.makedirs(evid, exist_ok=True)
rp = os.path.join(evid, "request.json")
json.dump(req, open(rp, "w"), indent=1)
p = subprocess.run(["node", "/work/p281/run-agent.mjs", rp], capture_output=True, text=True,
                   env={**os.environ, "NODE_NO_WARNINGS": "1"})
try:
    r = json.loads(p.stdout.strip().splitlines()[-1])
except Exception:
    r = {"status": "FAILED", "failure": {"message": (p.stderr or p.stdout)[-400:]}}
q = ((r.get("turn") or {}).get("_meta") or {}).get("quota") or {}
out = {
    "status": r.get("status", "FAILED"),
    "provider": provider,
    "model_route": r.get("model_route") or model_route,
    "run_id": run_id,
    "workspace": cwd,
    "target_path": f"{cwd}/{file_name}",
    "model_session_reported": (r.get("model") or {}).get("session_reported") or "",
    "model_adapter_reported": ",".join(m.get("model", "") for m in q.get("model_usage", [])),
    "model_served": (r.get("model") or {}).get("served") or "unknown",
    # missing is recorded as missing, never as 0
    "total_tokens": (q.get("token_count") or {}).get("totalTokens"),
    "approvals_requested": sum(1 for x in r.get("permissions", []) if x.get("routed") == "preloop_approval"),
    "mcp_rule_denials": len(r.get("mcp_denials", [])),
    "retryable_elsewhere": bool(r.get("retryable_elsewhere")),
    "wall_ms": r.get("wall_ms"),
    "evidence_dir": evid,
    "ledger_error": r.get("ledger_error") or "",
}
# Measurements go in an object whose fields are optional (Conductor allows optional fields only
# inside objects): one the adapter did not report is left out, never recorded as 0.
meas = {k: out.pop(k) for k in ("total_tokens", "wall_ms")}
out["measurements"] = {k: v for k, v in meas.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
print(json.dumps(out))
