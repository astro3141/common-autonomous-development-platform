"""Settings model: one source of truth, generated per-solution settings, explicit apply state.

usage (inside the agent container, with /opt/venv/bin/python):
  cfg.py validate            check config/environment.yaml and config/profiles/*.yaml
  cfg.py generate            write config/generated/ (runtime.json, profiles/<name>.json)
  cfg.py apply [--dry-run]   apply what lives in another solution (Preloop tool policy + MCP scan)
  cfg.py status              JSON: per target, saved / applied / apply_failed / changed_since_apply

Layers
  environment  config/environment.yaml      addresses and paths — set at install time
  profile      config/profiles/<name>.yaml  providers + order, route, login, quota limits,
                                            tool policy, execution limits, recording — set per profile
  workflow     p281/workflows/*.yaml        task steps and `-i profile=<name>` — set per task

Sources are edited (by hand or by the UI); config/generated/ is derived and never edited. Every
generated file records the hash of the source it came from, so "saved" and "applied" can be told
apart: a target is `applied` only when what was last applied came from the current source.
"""
import hashlib, json, os, posixpath, subprocess, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(os.environ.get("P281_ROOT", "/work"))
CFG = ROOT / "config"
GEN = CFG / "generated"
STATE = GEN / "state.json"

# What the execution layer (run-agent.mjs PROVIDERS) supports: provider → allowed routes.
KNOWN_PROVIDERS = {
    "claude": {"direct", "preloop_gateway"},
    "codex": {"direct", "preloop_gateway"},
    "grok": {"direct"},
}
WINDOWS = {"session", "weekly"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def load_yaml(p):
    return yaml.safe_load(p.read_text(encoding="utf-8")) or {}


def sources():
    env_p = CFG / "environment.yaml"
    profs = sorted((CFG / "profiles").glob("*.yaml"))
    return env_p, profs


# ---------------------------------------------------------------------------- validate
FSMCP_ROOT = "/ws"   # what cadp278-fsmcp serves (docker/fsmcp.Dockerfile); the agents can write only there


def validate_env(env):
    errs = []
    ws = (env.get("paths") or {}).get("workspace_root") or ""
    # normalise first: "/ws/../data" is /data. A non-normal spelling is rejected outright, so the
    # value every consumer joins paths onto is the one checked here.
    norm = posixpath.normpath(ws) if ws else ""
    if ws and (ws.rstrip("/") != norm or not (norm == FSMCP_ROOT or norm.startswith(FSMCP_ROOT + "/"))):
        errs.append(f"environment: paths.workspace_root {ws!r} must be {FSMCP_ROOT} or below it — "
                    "the filesystem MCP server serves only that directory")
    for sect, keys in {"preloop": ["api_url", "mcp_url"], "mlflow": ["url"], "egress": ["proxy"],
                       "paths": ["workspace_root", "evidence_root", "observations", "logins_root"]}.items():
        for k in keys:
            if not isinstance((env.get(sect) or {}).get(k), str) or not env[sect][k]:
                errs.append(f"environment: {sect}.{k} missing")
    return errs


def validate_profile(p, name, env):
    errs, warns = [], []
    if p.get("name") != name:
        errs.append(f"profile {name}: `name` must be {name!r} (the file name)")
    provs = p.get("providers")
    if not isinstance(provs, list) or not provs:
        errs.append(f"profile {name}: providers must be a non-empty list")
        provs = []
    seen = set()
    for i, pr in enumerate(provs):
        n, r = (pr or {}).get("name"), (pr or {}).get("route")
        if n not in KNOWN_PROVIDERS:
            errs.append(f"profile {name}: providers[{i}] unknown provider {n!r}")
            continue
        if n in seen:
            errs.append(f"profile {name}: provider {n} listed twice")
        seen.add(n)
        if r not in KNOWN_PROVIDERS[n]:
            errs.append(f"profile {name}: {n} does not support route {r!r} (supports {sorted(KNOWN_PROVIDERS[n])})")
        if r == "direct":
            login = pr.get("login") or n
            if not (Path(env.get("paths", {}).get("logins_root", "/route")) / login).exists():
                warns.append(f"profile {name}: {n} login '{login}' not present — needs account connection")
    q = p.get("quota") or {}
    if not (isinstance(q.get("max_age_s"), int) and q["max_age_s"] > 0):
        errs.append(f"profile {name}: quota.max_age_s must be a positive integer")
    for w in q.get("require_windows") or []:
        if w not in WINDOWS:
            errs.append(f"profile {name}: unknown window {w!r}")
    for w, v in (q.get("max_used_percent") or {}).items():
        if w not in WINDOWS or not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 < v <= 100:
            errs.append(f"profile {name}: max_used_percent.{w} must be a number in (0, 100]")
    t = p.get("tools") or {}
    if not isinstance(t.get("native_tools"), bool):
        errs.append(f"profile {name}: tools.native_tools must be true/false")
    pol = t.get("preloop_policy")
    if pol and not (ROOT / pol).is_file():
        errs.append(f"profile {name}: tools.preloop_policy {pol} not found")
    if not isinstance((p.get("execution") or {}).get("timeout_ms"), int):
        errs.append(f"profile {name}: execution.timeout_ms must be an integer")
    if not (p.get("record") or {}).get("mlflow_experiment"):
        errs.append(f"profile {name}: record.mlflow_experiment missing")
    return errs, warns


def cmd_validate(quiet=False):
    env_p, profs = sources()
    errs, warns = [], []
    try:
        env = load_yaml(env_p)
        errs += validate_env(env)
    except Exception as e:
        env = {}
        errs.append(f"environment: unreadable ({e})")
    policies = {}
    for pp in profs:
        try:
            prof = load_yaml(pp)
            e2, w2 = validate_profile(prof, pp.stem, env)
            pol = (prof.get("tools") or {}).get("preloop_policy")
            if pol:
                policies.setdefault(pol, []).append(pp.stem)
        except Exception as e:
            e2, w2 = [f"profile {pp.stem}: unreadable ({e})"], []
        errs += e2; warns += w2
    # Preloop 0.15.0 applies one policy per account: two profiles naming different policies would
    # overwrite each other on apply, and whichever ran last would silently govern both.
    if len(policies) > 1:
        errs.append("profiles name different Preloop policies ("
                    + "; ".join(f"{k}: {', '.join(v)}" for k, v in policies.items())
                    + ") — Preloop applies one policy per account; use one policy for all profiles")
    out = {"ok": not errs, "errors": errs, "warnings": warns,
           "profiles": [p.stem for p in profs]}
    if not quiet:
        print(json.dumps(out, indent=1))
    return out


# ---------------------------------------------------------------------------- generate
def load_state():
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {"targets": {}}


def save_state(st):
    GEN.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(st, indent=1))


def write_generated(path, obj, source_sha):
    body = {"_generated": {"from_source_sha256": source_sha, "at": now(),
                           "note": "generated by p281/cfg.py — edit config/*.yaml instead"}, **obj}
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(body, indent=1).encode()
    path.write_bytes(data)
    return sha_bytes(data)


def cmd_generate(quiet=False):
    v = cmd_validate(quiet=True)
    if not v["ok"]:
        print(json.dumps({"ok": False, "errors": v["errors"]}, indent=1))
        return 1
    st = load_state()
    env_p, profs = sources()
    env_raw = env_p.read_bytes(); env = yaml.safe_load(env_raw)
    env_sha = sha_bytes(env_raw)
    g = write_generated(GEN / "runtime.json", env, env_sha)
    st["targets"]["runtime"] = {"kind": "generated", "source": str(env_p.relative_to(ROOT)),
                                "source_sha256": env_sha, "generated_sha256": g, "generated_at": now()}
    referenced = {}
    for pp in profs:
        raw = pp.read_bytes(); p = yaml.safe_load(raw); src = sha_bytes(raw)
        routing = {
            "candidates": [x["name"] for x in p["providers"]],
            "model_route": {x["name"]: x["route"] for x in p["providers"]},
            "login": {x["name"]: x.get("login") or x["name"] for x in p["providers"]},
            "max_age_s": p["quota"]["max_age_s"],
            "require_windows": p["quota"].get("require_windows") or [],
            "max_used_percent": p["quota"].get("max_used_percent") or {},
        }
        g = write_generated(GEN / "profiles" / f"{pp.stem}.json", {
            "name": p["name"], "description": p.get("description", ""),
            "routing": routing, "tools": p["tools"], "execution": p["execution"], "record": p["record"],
        }, src)
        st["targets"][f"profile:{pp.stem}"] = {"kind": "generated", "source": str(pp.relative_to(ROOT)),
                                              "source_sha256": src, "generated_sha256": g, "generated_at": now()}
        pol = (p.get("tools") or {}).get("preloop_policy")
        if pol:
            key = f"preloop-policy:{pol}"
            t = st["targets"].setdefault(key, {"kind": "applied", "source": pol})
            t["source_sha256"] = sha_bytes((ROOT / pol).read_bytes())
            referenced.setdefault(key, []).append(pp.stem)
    # used_by is recomputed from the current profiles; a policy no profile names any more is
    # dropped from the targets, so `apply` can never re-apply it (A → B → A must end on A)
    for key in [k for k in st["targets"] if k.startswith("preloop-policy:")]:
        if key in referenced:
            st["targets"][key]["used_by"] = referenced[key]
        else:
            del st["targets"][key]
    save_state(st)
    if not quiet:
        print(json.dumps({"ok": True, "generated": sorted(k for k, v in st["targets"].items() if v["kind"] == "generated")}, indent=1))
    return 0


# ---------------------------------------------------------------------------- apply
def preloop_token():
    r = subprocess.run(["preloop", "auth", "token"], capture_output=True, text=True, timeout=30)
    tok = (r.stdout or "").strip().split()
    if r.returncode or not tok:
        raise RuntimeError("preloop CLI not logged in (preloop auth token failed)")
    return tok[-1]


def preloop_call(env, method, path, token):
    req = urllib.request.Request(env["preloop"]["api_url"] + path, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                                 data=b"" if method == "POST" else None)
    return json.load(urllib.request.urlopen(req, timeout=60))


def cmd_apply(dry_run=False):
    if cmd_generate(quiet=True) != 0:
        print(json.dumps({"ok": False, "results": {}, "error": "generate failed — run validate"}))
        return 1
    st = load_state()
    env = load_yaml(CFG / "environment.yaml")
    results = {}
    for key, t in st["targets"].items():
        if t.get("kind") != "applied" or not key.startswith("preloop-policy:") or not t.get("used_by"):
            continue
        pol = t["source"]
        src = sha_bytes((ROOT / pol).read_bytes())
        # Preloop holds ONE policy per account. "Already applied" means: the policy active on the
        # account is this file at this content — not merely that this file was applied once.
        # (A → B → A must apply A again: B replaced it.)
        # Skipped only when the last apply of this content finished both stages (policy + scan).
        active = st.get("preloop_active") or {}
        if (active.get("policy") == pol and active.get("sha256") == src and active.get("scan") == "done"
                and not t.get("apply_error")):
            results[key] = "already applied"
            continue
        if dry_run:
            results[key] = "would apply"
            continue
        t["last_attempt_at"] = now()
        # From here until `policy apply` reports success, which policy is on the account is not
        # known (a timeout may still have replaced it). Record that before calling, so neither an
        # error nor a crash leaves an older policy recorded as active.
        st["preloop_active"] = {"policy": None, "unknown_since": t["last_attempt_at"], "attempted": pol}
        save_state(st)
        stage = "policy"
        try:
            r = subprocess.run(["preloop", "policy", "apply", str(ROOT / pol)], capture_output=True,
                               text=True, timeout=120)
            if r.returncode:
                raise RuntimeError((r.stderr or r.stdout).strip()[-300:])
            # The policy is on the account now, whatever happens to the scan.
            st["preloop_active"] = {"policy": pol, "sha256": src, "applied_at": now(), "scan": "pending"}
            t.update({"applied_sha256": src, "applied_at": st["preloop_active"]["applied_at"]})
            save_state(st)
            # Preloop 0.15.0 does not expose a new MCP server's tools until it is scanned.
            stage = "scan"
            token = preloop_token()
            servers = {s["name"]: s["id"] for s in preloop_call(env, "GET", "/api/v1/mcp-servers", token)}
            scanned = []
            for s in (load_yaml(ROOT / pol).get("mcp_servers") or []):
                if s.get("name") in servers:
                    preloop_call(env, "POST", f"/api/v1/mcp-servers/{servers[s['name']]}/scan", token)
                    scanned.append(s["name"])
            st["preloop_active"].update({"scan": "done", "scanned_at": now()})
            t.update({"apply_error": "", "scanned": scanned})
            results[key] = "applied"
        except Exception as e:
            if stage == "scan":
                st["preloop_active"]["scan"] = "failed"
            t["apply_error"] = f"{stage} stage: {type(e).__name__}: {e}"[:400]
            results[key] = "apply failed" if stage == "policy" else "policy applied, scan failed"
    save_state(st)
    print(json.dumps({"ok": all(v in ("applied", "already applied", "would apply") for v in results.values()),
                      "results": results}, indent=1))
    return 0


# ---------------------------------------------------------------------------- status
def cmd_status():
    """Per target: saved (source present and valid), applied, apply_failed, changed_since_apply.

    A generated target is in effect once generated from the current source (consumers read it on
    their next run). An applied target is in effect only when the last successful apply came from
    the current source."""
    st = load_state()
    active = st.get("preloop_active") or {}
    v = cmd_validate(quiet=True)
    env_p, profs = sources()
    rows = []
    cur = {"runtime": sha_bytes(env_p.read_bytes())}
    for pp in profs:
        cur[f"profile:{pp.stem}"] = sha_bytes(pp.read_bytes())
        pol = ((yaml.safe_load(pp.read_bytes()) or {}).get("tools") or {}).get("preloop_policy")
        if pol and (ROOT / pol).is_file():
            cur[f"preloop-policy:{pol}"] = sha_bytes((ROOT / pol).read_bytes())
    for key, src in sorted(cur.items()):
        t = st["targets"].get(key, {})
        if key.startswith("preloop-policy:"):
            pol = key.split(":", 1)[1]
            if t.get("apply_error"):
                s = "apply_failed"        # the error names the stage (policy / scan)
            elif active.get("policy") == pol and active.get("sha256") == src and active.get("scan") == "done":
                s = "applied"
            elif not active.get("policy") and active.get("unknown_since"):
                s = "unknown"             # an apply was interrupted; which policy is active is not known
            elif active.get("policy") and active.get("policy") != pol:
                s = "replaced"            # another policy is active on the account now
            elif t.get("applied_sha256"):
                s = "changed_since_apply"
            else:
                s = "saved"
            rows.append({"target": key, "state": s, "applied_at": t.get("applied_at"),
                         "error": t.get("apply_error") or "", "used_by": t.get("used_by", []),
                         "active_on_account": active.get("policy") or ("unknown" if active.get("unknown_since") else None),
                         "scan": active.get("scan") if active.get("policy") == pol else None})
        else:
            s = "applied" if t.get("source_sha256") == src else ("changed_since_apply" if t else "saved")
            rows.append({"target": key, "state": s, "applied_at": t.get("generated_at"), "error": ""})
    print(json.dumps({"valid": v["ok"], "errors": v["errors"], "warnings": v["warnings"], "targets": rows}, indent=1))
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    sys.exit({"validate": lambda: 0 if cmd_validate()["ok"] else 1,
              "generate": cmd_generate,
              "apply": lambda: cmd_apply("--dry-run" in sys.argv),
              "status": cmd_status}[cmd]())
