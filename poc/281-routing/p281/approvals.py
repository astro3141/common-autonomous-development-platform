"""List pending Preloop approval requests (read-only) for the ops API — runs in the agent container.

Approving or declining is deliberately NOT offered here: that stays in Preloop's own console, with
the operator's login. (On Preloop OSS 0.15.0 the agent's own token could approve too — an open
item; this reader uses it only to list.)

  approvals.py          prints a JSON list of the pending requests (the screen reads this)
  approvals.py --all    prints {"complete": true|false, "items": [...], "error": "…"}

The API answers one page at a time (`limit`, `skip`, default 50) and orders by request time, so
asking for the first page alone is not "the pending ones": fifty decided requests are enough to
hide one that is waiting. This asks for `status=pending` and keeps asking until a page comes back
short. Callers that delete things (p281/cleanup.py) must use --all and stop unless `complete`.
"""
import glob, json, os, sys, urllib.error, urllib.request
from datetime import datetime, timezone
sys.path.insert(0, "/work/p281")
import settings

PAGE = 100
MAX_PAGES = 100          # a hard stop; beyond this the answer is reported as incomplete


def fetch_pending():
    tok = json.load(open(glob.glob(os.path.expanduser("~/.preloop/agents/*/permission_hook.json"))[0]))["token"]
    api = settings.runtime()["preloop"]["api_url"]
    now = datetime.now(timezone.utc)
    out, skip = [], 0
    for _ in range(MAX_PAGES):
        url = f"{api}/api/v1/approval-requests?status=pending&limit={PAGE}&skip={skip}"
        rows = json.load(urllib.request.urlopen(
            urllib.request.Request(url, headers={"Authorization": "Bearer " + tok}), timeout=20))
        if not isinstance(rows, list):
            raise ValueError("unexpected answer from the approvals API")
        for r in rows:
            if r.get("status") != "pending":
                continue
            exp = r.get("expires_at")
            if exp and datetime.fromisoformat(exp).replace(tzinfo=timezone.utc) < now:
                continue      # Preloop leaves expired requests "pending"; do not show them as waiting
            args = r.get("tool_args") or {}
            out.append({"id": r["id"], "tool": r.get("tool_name"), "requested_at": r.get("requested_at"),
                        "expires_at": exp, "cwd": args.get("cwd"),
                        "target": args.get("file_path") or args.get("path") or args.get("command")
                                  or (args.get("_acp_locations") or [None])[0],
                        "source": args.get("_preloop_source")})
        if len(rows) < PAGE:
            return out, True          # a short page means the end
        skip += PAGE
    return out, False                 # ran out of pages: the answer is not complete


if __name__ == "__main__":
    full = "--all" in sys.argv[1:]
    try:
        items, complete = fetch_pending()
    except Exception as e:
        if full:
            print(json.dumps({"complete": False, "items": [], "error": f"{type(e).__name__}: {e}"}))
            sys.exit(0)
        raise
    print(json.dumps({"complete": complete, "items": items} if full else items))
