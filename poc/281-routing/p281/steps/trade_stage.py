"""Conductor script steps for the trading-shaped capability trial (deterministic parts).

usage:
  trade_stage.py packet            build the lanes' input packet, twice, and compare the hashes
  trade_stage.py evaluate          validate every lane, score them, write the comparison report

The packet the lanes see never contains `next_session`: the scoring returns are held back, exactly
as a forward experiment would hold them back. The scorer reads them from the fixture afterwards.

Validation is deterministic and identical for every lane — schema, universe, weight bounds, gross
exposure, and grounding (every cited id must exist in the packet). A lane that fails validation is
INVALID; that is a result, not an error, and it does not touch the other lanes.
"""
import hashlib, json, os, sys

sys.path.insert(0, "/work/p281")
import settings

RT = settings.runtime()
RUN = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
WS = f"{RT['paths']['workspace_root']}/{RUN}"
FIXTURE = "/work/p281/fixtures/trading/packet.json"


def out(**kw):
    print(json.dumps(kw))


def build_packet():
    full = json.load(open(FIXTURE, encoding="utf-8"))
    packet = {k: v for k, v in full.items() if k != "next_session"}
    body = json.dumps(packet, ensure_ascii=False, sort_keys=True, indent=1)
    return full, packet, body, hashlib.sha256(body.encode("utf-8")).hexdigest()


def cmd_packet():
    os.makedirs(WS, exist_ok=True)
    _, _, body, sha1 = build_packet()
    _, _, _, sha2 = build_packet()          # built twice: a packet that is not reproducible is a bug
    open(f"{WS}/packet.json", "w", encoding="utf-8").write(body)
    for stale in os.listdir(WS):
        if stale.startswith("lane_") or stale == "report.json":
            os.remove(f"{WS}/{stale}")
    out(status="OK", workspace=WS, packet_sha256=sha1,
        deterministic="yes" if sha1 == sha2 else "no",
        symbols=len(json.loads(body)["universe"]))


def validate(lane_id, doc, packet):
    """Same checks for a model lane and a deterministic one."""
    symbols = {s["symbol"] for s in packet["universe"]}
    source_ids = {e["source_id"] for e in packet["evidence"]}
    c = packet["constraints"]
    errs = []
    targets = doc.get("targets")
    if not isinstance(targets, list) or not targets:
        return ["no targets"], 0.0
    gross = 0.0
    for t in targets:
        sym, w = t.get("symbol"), t.get("weight")
        if sym not in symbols:
            errs.append(f"{sym}: not in the universe")
            continue
        if not isinstance(w, (int, float)) or isinstance(w, bool):
            errs.append(f"{sym}: weight is not a number")
            continue
        if w < c["min_weight"] or w > c["max_weight_per_symbol"]:
            errs.append(f"{sym}: weight {w} outside [{c['min_weight']}, {c['max_weight_per_symbol']}]")
        gross += float(w)
    if gross > c["max_gross"] + 1e-9:
        errs.append(f"gross {gross:.3f} over {c['max_gross']}")
    for ref in doc.get("refs") or []:
        if ref not in source_ids:
            errs.append(f"cited {ref}, which the packet does not contain")
    if len({t.get("symbol") for t in targets}) != len(targets):
        errs.append("the same symbol appears twice")
    return errs, gross


def cmd_evaluate():
    full, packet, _, sha = build_packet()
    nxt = full["next_session"]["returns"]
    rows = []
    for name in sorted(os.listdir(WS)):
        if not name.startswith("lane_") or not name.endswith(".json"):
            continue
        lane_id = name[5:-5]
        try:
            doc = json.load(open(f"{WS}/{name}", encoding="utf-8"))
        except ValueError:
            rows.append({"lane": lane_id, "status": "INVALID", "why": "not JSON",
                         "gross": 0, "ret": None, "excess": None, "positions": 0})
            continue
        errs, gross = validate(lane_id, doc, packet)
        if errs:
            rows.append({"lane": lane_id, "status": "INVALID", "why": "; ".join(errs)[:200],
                         "gross": round(gross, 3), "ret": None, "excess": None,
                         "positions": len(doc.get("targets") or [])})
            continue
        ret = sum(float(t["weight"]) * nxt.get(t["symbol"], 0.0) for t in doc["targets"])
        rows.append({"lane": lane_id, "status": "VALID", "why": "",
                     "gross": round(gross, 3), "ret": round(ret, 5),
                     "excess": round(ret - nxt["BENCH"] * gross, 5),
                     "positions": len(doc["targets"]),
                     "model_calls": int(doc.get("model_calls", 0)),
                     "refs": ",".join(doc.get("refs") or [])})
    json.dump({"packet_sha256": sha, "benchmark_next": nxt["BENCH"], "lanes": rows},
              open(f"{WS}/report.json", "w"), ensure_ascii=False, indent=1)
    valid = [r for r in rows if r["status"] == "VALID"]
    best = max(valid, key=lambda r: r["ret"], default=None)
    out(status="OK", lanes=len(rows), valid=len(valid),
        invalid=",".join(r["lane"] for r in rows if r["status"] == "INVALID"),
        best_lane=(best or {}).get("lane", ""), best_ret=str((best or {}).get("ret", "")),
        packet_sha256=sha, report=json.dumps(rows, ensure_ascii=False)[:1500])


if __name__ == "__main__":
    {"packet": cmd_packet, "evaluate": cmd_evaluate}[sys.argv[1]]()
