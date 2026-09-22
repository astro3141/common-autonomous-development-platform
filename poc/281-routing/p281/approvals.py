"""List pending Preloop approval requests (read-only) for the ops API — runs in the agent container.

Approving or declining is deliberately NOT offered here: that stays in Preloop's own console, with
the operator's login. (On Preloop OSS 0.15.0 the agent's own token could approve too — an open
item; this reader uses it only to list.)
"""
import glob, json, os, sys, urllib.request
from datetime import datetime, timezone
sys.path.insert(0, "/work/p281")
import settings

tok = json.load(open(glob.glob(os.path.expanduser("~/.preloop/agents/*/permission_hook.json"))[0]))["token"]
api = settings.runtime()["preloop"]["api_url"]
rows = json.load(urllib.request.urlopen(urllib.request.Request(
    f"{api}/api/v1/approval-requests?limit=50", headers={"Authorization": "Bearer " + tok}), timeout=20))
now = datetime.now(timezone.utc)
out = []
for r in rows:
    if r.get("status") != "pending":
        continue
    exp = r.get("expires_at")
    if exp and datetime.fromisoformat(exp).replace(tzinfo=timezone.utc) < now:
        continue          # Preloop leaves expired requests "pending"; do not show them as waiting
    args = r.get("tool_args") or {}
    out.append({"id": r["id"], "tool": r.get("tool_name"), "requested_at": r.get("requested_at"),
                "expires_at": exp, "cwd": args.get("cwd"),
                "target": args.get("file_path") or args.get("path") or args.get("command") or (args.get("_acp_locations") or [None])[0],
                "source": args.get("_preloop_source")})
print(json.dumps(out))
