"""What this stack can do right now — probed, not declared.

usage: capabilities.py [--json] [--missing [--allow-unrecorded]]   (in the agent container)

A composition may leave a service out (scripts/up.sh --composition), and a service that is
supposed to be there can also be down. Both come to the same question for a run that is about to
start: *which capabilities does the stack have at this moment*. So this asks the services
themselves rather than reading a name someone wrote down — a declared composition can be stale,
a probe cannot.

Each capability answers with what a caller needs to decide: whether it is there, and what depends
on it. What to do about a missing one is not decided here (CONTRACT.md): `run_workflow.py` refuses
to start a run without the capabilities a run cannot be honest without, and takes an explicit
opt-in for recording, which a run can do without as long as someone says so.
"""
import json, sys, urllib.error, urllib.request

sys.path.insert(0, "/work/p281")
import settings

RT = settings.runtime()


def http(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def probe():
    mcp = RT["preloop"]["mcp_url"]
    caps = {}

    # Tool rights. 401 without a credential is the MCP proxy answering: it is up and it is
    # refusing, which is exactly what it must do.
    code = http(mcp)
    caps["tool_rights"] = {
        "available": code == 401,
        "detail": f"Preloop MCP answered {code or 'nothing'}",
        "without_it": "no governed file tools, and no decision on a native tool call",
        "required": True}

    api = http(RT["preloop"]["api_url"] + "/api/v1/openapi.json")
    caps["approvals"] = {
        "available": api == 200,
        "detail": f"Preloop api answered {api or 'nothing'}",
        "without_it": "a permission request cannot be answered, so every one of them is a denial",
        "required": True}

    # Egress. The proxy must be reachable *and* still refuse what is not a provider.
    prov = http("http://egress:8888", timeout=5)
    caps["egress"] = {
        "available": prov != 0,
        "detail": f"allowlist proxy answered {prov or 'nothing'}",
        "without_it": "no route to any provider; nothing can run",
        "required": True}

    ml = http(RT["mlflow"]["url"] + "/health")
    caps["record"] = {
        "available": ml == 200,
        "detail": f"MLflow answered {ml or 'nothing'}",
        "without_it": "runs still execute, but nothing about them is recorded or comparable",
        "required": False}

    # The screen is deliberately not probed here: it is reached from the host, not from inside
    # this network, and no run needs it. scripts/up.sh reports it from where it is reachable.

    try:
        import datetime as d
        r = json.load(open("/obs/codex.raw.json", encoding="utf-8"))
        age = (d.datetime.now(d.timezone.utc)
               - d.datetime.fromisoformat(r["collected_at"].replace("Z", "+00:00"))).total_seconds()
        fresh = r.get("exit") == 0 and age < 600
        detail = f"last observation {round(age)}s old"
    except Exception as e:
        fresh, detail = False, f"no observation ({type(e).__name__})"
    caps["admission"] = {
        "available": fresh, "detail": detail,
        "without_it": "the router sees no quota, calls every provider unknown, and holds the run",
        "required": False}
    return caps


def missing(caps=None, need_record=True):
    """The capabilities a run cannot start without, given whether it insists on being recorded."""
    caps = caps or probe()
    out = [k for k, c in caps.items() if c["required"] and not c["available"]]
    if need_record and not caps["record"]["available"]:
        out.append("record")
    return out


if __name__ == "__main__":
    caps = probe()
    if "--missing" in sys.argv:
        # one answer for every caller that has to decide whether a run may start
        gone = missing(caps, need_record="--allow-unrecorded" not in sys.argv)
        print(json.dumps({"missing": gone,
                          "why": {k: caps[k]["without_it"] for k in gone},
                          "detail": {k: caps[k]["detail"] for k in gone}}, ensure_ascii=False))
        sys.exit(0)
    if "--json" in sys.argv:
        print(json.dumps(caps, ensure_ascii=False))
    else:
        for k, c in caps.items():
            mark = "yes" if c["available"] else ("MISSING" if c["required"] else "no")
            print(f"  {k:<12} {mark:<8} {c['detail']}")
            if not c["available"]:
                print(f"               → {c['without_it']}")
    sys.exit(1 if missing(caps, need_record=False) else 0)
