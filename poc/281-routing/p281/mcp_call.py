"""Call one tool through Preloop's MCP endpoint as a given agent principal. No model involved.
usage: mcp_call.py claude|codex <tool> '<json args>'"""
import json, os, sys, tomllib, urllib.request
who, tool, args = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
if who == "claude":
    tok = json.load(open(os.path.expanduser("~/.claude.json")))["mcpServers"]["preloop"]["headers"]["Authorization"]
else:
    tok = tomllib.load(open(os.path.expanduser("~/.codex/config.toml"), "rb"))["mcp_servers"]["preloop"]["http_headers"]["Authorization"]
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": tok}
def call(m, p, i, sid=None):
    h = dict(H)
    if sid: h["mcp-session-id"] = sid
    r = urllib.request.urlopen(urllib.request.Request("http://console/mcp/v1", data=json.dumps(
        {"jsonrpc": "2.0", "id": i, "method": m, "params": p}).encode(), headers=h), timeout=60)
    b = r.read().decode()
    return r.headers.get("mcp-session-id"), json.loads(b.split("data: ", 1)[1] if "data: " in b else b)
sid, _ = call("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "p281", "version": "0"}}, 1)
_, d = call("tools/call", {"name": tool, "arguments": args}, 2, sid)
r = d.get("result", d)
print(json.dumps({"isError": r.get("isError"), "text": " ".join(c.get("text", "") for c in r.get("content", []))[:200]} if "content" in r else r)[:400])
