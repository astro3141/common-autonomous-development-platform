"""Conductor script steps for the trading-shaped capability trial (deterministic parts).

usage:
  trade_stage.py packet            build the lanes' input packet, twice, and compare the hashes
  trade_stage.py baseline <lane>   compute the deterministic lane from the same packet
  trade_stage.py evaluate          validate every lane, score them, write the comparison report

The packet the lanes see never contains `next_session`: the scoring returns are held back, exactly
as a forward experiment would hold them back. The scorer reads them from the fixture afterwards.

Validation is deterministic and identical for every lane — schema, universe, weight bounds, gross
exposure, and grounding (every cited id must exist in the packet). A lane that fails validation is
INVALID; that is a result, not an error, and it does not touch the other lanes.
"""
import hashlib, json, math, os, sys

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


def cmd_baseline(lane_id):
    """Momentum baseline: the three best 20-day returns, equal weight, nothing else.

    A trading decision, so it is a step of this workflow — it used to be computed inside the
    fan-out that ran the model lanes, which made the platform's concurrency step carry one
    domain's policy. It makes no model call, so a cycle always has a baseline even when every
    model lane fails.
    """
    packet = json.load(open(f"{WS}/packet.json", encoding="utf-8"))
    top = sorted(packet["universe"], key=lambda s: s["ret_20d"], reverse=True)[:3]
    w = round(min(packet["constraints"]["max_weight_per_symbol"], 0.75 / len(top)), 4)
    doc = {"lane": lane_id, "policy": "momentum20-top3-equal-weight", "model_calls": 0,
           "targets": [{"symbol": s["symbol"], "weight": w} for s in top],
           "rationale": "결정론 기준선: 20일 수익률 상위 3종목 동일 비중", "refs": []}
    json.dump(doc, open(f"{WS}/lane_{lane_id}.json", "w"), ensure_ascii=False, indent=1)
    out(status="OK", lane=lane_id, positions=len(top), weight=w, model_calls=0)


def validate(lane_id, doc, packet):
    """Same checks for a model lane and a deterministic one.

    Everything a lane wrote is treated as untrusted shape: a proposal that is not an object, a
    target that is not an object, a symbol that is not a string, a weight that is NaN — each is a
    finding about that lane, never an exception that ends the evaluation of the others.
    """
    symbols = {s["symbol"] for s in packet["universe"]}
    source_ids = {e["source_id"] for e in packet["evidence"]}
    c = packet["constraints"]
    errs = []
    if not isinstance(doc, dict):
        return [f"the proposal is a {type(doc).__name__}, not an object"], 0.0
    targets = doc.get("targets")
    if not isinstance(targets, list) or not targets:
        return ["no targets"], 0.0
    gross = 0.0
    seen = []
    for i, t in enumerate(targets):
        if not isinstance(t, dict):
            errs.append(f"target {i} is a {type(t).__name__}, not an object")
            continue
        sym, w = t.get("symbol"), t.get("weight")
        if not isinstance(sym, str):
            errs.append(f"target {i}: symbol is not a string")
            continue
        seen.append(sym)
        if sym not in symbols:
            errs.append(f"{sym}: not in the universe")
            continue
        if not isinstance(w, (int, float)) or isinstance(w, bool):
            errs.append(f"{sym}: weight is not a number")
            continue
        if not math.isfinite(w):
            # JSON parsers accept NaN and Infinity; a weight that is neither is not a weight
            errs.append(f"{sym}: weight is not finite ({w})")
            continue
        if w < c["min_weight"] or w > c["max_weight_per_symbol"]:
            errs.append(f"{sym}: weight {w} outside [{c['min_weight']}, {c['max_weight_per_symbol']}]")
        gross += float(w)
    if gross > c["max_gross"] + 1e-9:
        errs.append(f"gross {gross:.3f} over {c['max_gross']}")
    refs = doc.get("refs") or []
    if not isinstance(refs, list):
        errs.append("refs is not a list")
        refs = []
    for ref in refs:
        if not isinstance(ref, str) or ref not in source_ids:
            errs.append(f"cited {ref!r}, which the packet does not contain")
    if len(set(seen)) != len(seen):
        errs.append("the same symbol appears twice")
    calls = doc.get("model_calls", 0)
    if not isinstance(calls, int) or isinstance(calls, bool) or calls < 0:
        errs.append(f"model_calls {calls!r} is not a count")
    return errs, gross


def cmd_evaluate():
    full, packet, _, sha = build_packet()
    nxt = full["next_session"]["returns"]
    rows = []
    for name in sorted(os.listdir(WS)):
        if not name.startswith("lane_") or not name.endswith(".json"):
            continue
        lane_id = name[5:-5]
        # One lane's file can be anything at all; whatever it is, it stays one lane's result. An
        # unexpected shape that reaches an exception is that lane's INVALID, so the cycle still
        # compares the lanes that did produce a proposal (measured: `[]`, `{"targets":[null]}` and
        # a non-numeric model_calls each used to end the whole evaluation).
        try:
            try:
                doc = json.load(open(f"{WS}/{name}", encoding="utf-8"))
            except ValueError:
                rows.append({"lane": lane_id, "status": "INVALID", "why": "not JSON",
                             "gross": 0, "ret": None, "excess": None, "positions": 0})
                continue
            errs, gross = validate(lane_id, doc, packet)
            positions = len(doc.get("targets") or []) if isinstance(doc, dict) else 0
            if errs:
                rows.append({"lane": lane_id, "status": "INVALID", "why": "; ".join(errs)[:200],
                             "gross": round(gross, 3), "ret": None, "excess": None,
                             "positions": positions})
                continue
            ret = sum(float(t["weight"]) * nxt.get(t["symbol"], 0.0) for t in doc["targets"])
            rows.append({"lane": lane_id, "status": "VALID", "why": "",
                         "gross": round(gross, 3), "ret": round(ret, 5),
                         "excess": round(ret - nxt["BENCH"] * gross, 5),
                         "positions": positions,
                         "model_calls": int(doc.get("model_calls", 0)),
                         "refs": ",".join(doc.get("refs") or [])})
        except Exception as e:
            rows.append({"lane": lane_id, "status": "INVALID",
                         "why": f"unreadable proposal: {type(e).__name__}: {e}"[:200],
                         "gross": 0, "ret": None, "excess": None, "positions": 0})
    json.dump({"packet_sha256": sha, "benchmark_next": nxt["BENCH"], "lanes": rows},
              open(f"{WS}/report.json", "w"), ensure_ascii=False, indent=1)
    valid = [r for r in rows if r["status"] == "VALID"]
    best = max(valid, key=lambda r: r["ret"], default=None)
    out(status="OK", lanes=len(rows), valid=len(valid),
        invalid=",".join(r["lane"] for r in rows if r["status"] == "INVALID"),
        best_lane=(best or {}).get("lane", ""), best_ret=str((best or {}).get("ret", "")),
        packet_sha256=sha, report=json.dumps(rows, ensure_ascii=False)[:1500])


if __name__ == "__main__":
    {"packet": cmd_packet, "evaluate": cmd_evaluate,
     "baseline": lambda: cmd_baseline(sys.argv[2] if len(sys.argv) > 2 else "base")}[sys.argv[1]]()
