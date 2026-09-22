"""Read the generated settings (config/generated/, produced by cfg.py). Shared by the step scripts.

Falls back to the built-in defaults when nothing has been generated yet, so an unconfigured
checkout still runs the way it did before the settings model existed.
"""
import json, os
from pathlib import Path

ROOT = Path(os.environ.get("P281_ROOT", "/work"))
GEN = ROOT / "config" / "generated"

DEFAULT_RUNTIME = {
    "preloop": {"api_url": "http://api:8000", "mcp_url": "http://console/mcp/v1"},
    "mlflow": {"url": "http://mlflow:5000"},
    "egress": {"proxy": "http://egress:8888", "no_proxy": ["console", "api", "gateway", "mlflow", "localhost", "127.0.0.1"]},
    "paths": {"workspace_root": "/ws", "evidence_root": "/work/evidence/p281", "observations": "/obs", "logins_root": "/route"},
}


def runtime():
    try:
        return json.loads((GEN / "runtime.json").read_text())
    except Exception:
        return DEFAULT_RUNTIME


def profile(name):
    """The generated profile, or None if it does not exist (callers must fail, not guess)."""
    p = GEN / "profiles" / f"{name}.json"
    return json.loads(p.read_text()) if p.is_file() else None


def egress_env(rt=None):
    rt = rt or runtime()
    e = rt["egress"]; np = ",".join(e.get("no_proxy") or [])
    return {"HTTPS_PROXY": e["proxy"], "https_proxy": e["proxy"], "HTTP_PROXY": e["proxy"],
            "http_proxy": e["proxy"], "NO_PROXY": np, "no_proxy": np}
