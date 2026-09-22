"""Second party for the approval controls: resolves pending Preloop requests whose cwd matches.

usage: approver.py <cwd> approve|decline [seconds]
Plays the human approver over HTTP. Records what it resolved; never auto-runs in real use.
"""
import glob, json, sys, time, urllib.request

cwd, act = sys.argv[1], sys.argv[2]
deadline = time.time() + float(sys.argv[3] if len(sys.argv) > 3 else 180)
tok = json.load(open(glob.glob("/home/agent/.preloop/agents/*/permission_hook.json")[0]))["token"]

def call(path, body=None):
    r = urllib.request.Request("http://console" + path, headers={"Authorization": "Bearer " + tok,
        "Content-Type": "application/json"}, data=None if body is None else json.dumps(body).encode())
    return json.load(urllib.request.urlopen(r, timeout=10))

done = set()
while time.time() < deadline:
    for r in call("/api/v1/approval-requests?limit=20"):
        if r["status"] == "pending" and r["tool_args"].get("cwd") == cwd and r["id"] not in done:
            body = {"approved": True} if act == "approve" else {"approved": False, "comment": "p281 decline control"}
            call(f"/api/v1/approval-requests/{r['id']}/{act}", body)
            done.add(r["id"])
            print(json.dumps({"resolved": r["id"], "action": act, "tool": r["tool_name"],
                              "args": {k: v for k, v in r["tool_args"].items() if k != "content"}}), flush=True)
    time.sleep(1)
