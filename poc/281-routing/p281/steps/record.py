"""Conductor script step: record one routed execution in MLflow (REST, no client library).

Reads the execute and check outputs as JSON on stdin. Vendor-neutral: provider and model are
recorded as data. Tagged with conductor.run_id, the same attribute Conductor's own OTel traces
carry (#278 F1), so the run and its trace join on it.
"""
import json, os, sys, time, urllib.request

MLFLOW = os.environ.get("MLFLOW_URL", "http://mlflow:5000")
EXPERIMENT = "p281-routing"
d = json.load(sys.stdin)
ex, ck, rt = d.get("execute"), d.get("check"), d.get("route") or {}

def call(path, body=None, method="POST"):
    r = urllib.request.Request(MLFLOW + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=20))

def record():
    try:
        exp_id = call(f"/api/2.0/mlflow/experiments/get-by-name?experiment_name={EXPERIMENT}", method="GET")["experiment"]["experiment_id"]
    except urllib.error.HTTPError:
        exp_id = call("/api/2.0/mlflow/experiments/create", {"name": EXPERIMENT})["experiment_id"]

    now = int(time.time() * 1000)
    cid = os.environ.get("CONDUCTOR_SELF_RUN_ID", "")

    if ex is None:
        # HOLD: the router started nothing. That decision is a result too, so it is recorded.
        rid = call("/api/2.0/mlflow/runs/create", {"experiment_id": exp_id, "start_time": now,
                   "run_name": f"{cid}-hold"})["run"]["info"]["run_id"]
        call("/api/2.0/mlflow/runs/log-batch", {"run_id": rid, "tags": [
            {"key": k, "value": str(v)[:5000]} for k, v in {
                "conductor.run_id": cid, "provider": "none", "status": "HOLD",
                "gate.decision": "NOT_RUN", "route.decision": rt.get("decision"),
                "route.reason": rt.get("reason"), "route.evaluated": rt.get("evaluated"),
                "evidence_dir": rt.get("evidence_dir")}.items()]})
        call("/api/2.0/mlflow/runs/update", {"run_id": rid, "status": "FINISHED",
             "end_time": int(time.time() * 1000)})
        return {"mlflow_run_id": rid, "experiment_id": exp_id, "record_error": ""}

    run = call("/api/2.0/mlflow/runs/create", {"experiment_id": exp_id, "start_time": now,
               "run_name": ex["run_id"]})["run"]["info"]
    rid = run["run_id"]
    tags = {"conductor.run_id": os.environ.get("CONDUCTOR_SELF_RUN_ID", ""),
            "provider": ex["provider"], "model_route": ex.get("model_route", ""), "status": ex["status"], "gate.decision": ck["decision"],
            "gate.reason": ck["reason"], "model.session_reported": ex["model_session_reported"],
            "model.adapter_reported": ex["model_adapter_reported"], "model.served": ex["model_served"],
            "evidence_dir": ex["evidence_dir"], "file_sha256": ck["file_sha256"],
            "route.decision": rt.get("decision", "manual"), "route.reason": rt.get("reason", "provider given as input"),
            "route.evaluated": rt.get("evaluated", "")}
    call("/api/2.0/mlflow/runs/log-batch", {"run_id": rid,
         "params": [{"key": "provider", "value": ex["provider"]}, {"key": "native_tools", "value": "false"}],
         "tags": [{"key": k, "value": str(v)[:5000]} for k, v in tags.items()],
         # a missing measurement is omitted, not recorded as 0
         "metrics": [{"key": k, "value": float(v), "timestamp": now, "step": 0}
                     for k, v in {**(ex.get("measurements") or {}),
                                  "approvals_requested": ex.get("approvals_requested"),
                                  "mcp_rule_denials": ex.get("mcp_rule_denials")}.items()
                     if isinstance(v, (int, float)) and not isinstance(v, bool)]})
    # The adapter's full result as an artifact (served by the tracking server's artifact proxy).
    res = os.path.join(ex["evidence_dir"], "result.json")
    if os.path.exists(res):
        urllib.request.urlopen(urllib.request.Request(
            f"{MLFLOW}/api/2.0/mlflow-artifacts/artifacts/{exp_id}/{rid}/artifacts/result.json",
            data=open(res, "rb").read(), method="PUT"), timeout=20)
    call("/api/2.0/mlflow/runs/update", {"run_id": rid, "status": "FINISHED",
         "end_time": int(time.time() * 1000)})
    return {"mlflow_run_id": rid, "experiment_id": exp_id, "record_error": ""}


# Recording is observation. Its failure is reported, never allowed to change the run's outcome:
# the step always exits 0 and the workflow routes on the Gate decision as before (#278 N5).
try:
    out = record()
except Exception as e:
    out = {"mlflow_run_id": "", "experiment_id": "", "record_error": f"{type(e).__name__}: {e}"[:300]}
print(json.dumps(out))
