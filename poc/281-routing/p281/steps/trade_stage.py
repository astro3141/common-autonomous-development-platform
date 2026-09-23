"""Conductor script steps for the trading-shaped capability trial (deterministic parts).

usage:
  trade_stage.py packet            build the lanes' input packet, twice, and compare the hashes
  trade_stage.py baseline <lane>   compute the deterministic lane from the same packet
  trade_stage.py shapes-plan <spec...>   write the lane plan for the shape trial (one member per
                                   decision shape; a member may be a chain of steps)
  trade_stage.py score-forecast    grade lane H's own forecasts deterministically (no model)
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


def cmd_score_forecast():
    """Grade lane H's forecasts against the packet's own 20-day sign — deterministic, no model.

    This sits *inside* a lane, between two of its model calls: the shape of lane H is a forecast,
    a grade that no model produced, and then a decision that reads the grade.
    """
    packet = json.load(open(f"{WS}/packet.json", encoding="utf-8"))
    ret = {s["symbol"]: s["ret_20d"] for s in packet["universe"]}
    doc = json.load(open(f"{WS}/h_forecast.json", encoding="utf-8"))
    rows = []
    for f in doc.get("forecasts") or []:
        sym, direction = f.get("symbol"), f.get("direction")
        if sym not in ret or direction not in ("up", "down"):
            rows.append({"symbol": sym, "scored": False, "why": "not scorable from this packet"})
            continue
        realised = "up" if ret[sym] >= 0 else "down"
        rows.append({"symbol": sym, "scored": True, "direction": direction,
                     "realised_20d": realised, "hit": direction == realised,
                     "ret_20d": ret[sym]})
    scored = [r for r in rows if r["scored"]]
    hits = sum(1 for r in scored if r["hit"])
    json.dump({"stage": "score", "model_calls": 0, "scored": len(scored), "hits": hits,
               "hit_rate": round(hits / len(scored), 3) if scored else None, "rows": rows},
              open(f"{WS}/h_score.json", "w"), ensure_ascii=False, indent=1)
    out(status="OK", scored=len(scored), hits=hits, model_calls=0)


def cmd_shapes_plan(specs):
    """The lane plan for the shape trial: one member per *decision shape*, not per vendor.

    Each spec is `lane:provider:login:route`. What the steps of a lane are — a base with two
    overlays, a desk of roles, a forecast around a deterministic grade — is this workflow's
    knowledge; steps/tasks.py only runs the plan and keeps each step's record.
    """
    P = "/work/p281/prompts"
    shapes = {
        "D": [("model", f"{P}/shape-d1-mi.md", "d_overlay.json"),
              ("model", f"{P}/shape-d2-risk.md", "lane_D.json")],
        "E": [("model", f"{P}/shape-e-direct.md", "lane_E.json")],
        "F": [("model", f"{P}/shape-f1-analyst.md", "f_analysis.json"),
              ("model", f"{P}/shape-f2-risk.md", "f_risk.json"),
              ("model", f"{P}/shape-f3-pm.md", "lane_F.json")],
        "H": [("model", f"{P}/shape-h1-forecast.md", "h_forecast.json"),
              ("script", "score-forecast", "h_score.json"),
              ("model", f"{P}/shape-h2-decide.md", "lane_H.json")],
        "I": [("model", f"{P}/shape-i1-screen.md", "i_screen.json"),
              ("model", f"{P}/shape-i2-thesis.md", "i_thesis.json"),
              ("model", f"{P}/shape-i3-review.md", "lane_I.json")],
    }
    members = []
    for spec in specs:
        lane, provider, login, route = spec.split(":")
        steps = []
        for i, (kind, what, expected) in enumerate(shapes[lane], 1):
            if kind == "model":
                steps.append({"kind": "model", "name": f"{lane}{i}", "provider": provider,
                              "login": login, "route": route, "prompt": what,
                              "expected": expected})
            else:
                steps.append({"kind": "script", "name": f"{lane}{i}-{what}", "expected": expected,
                              "argv": [os.environ.get("POC_PY", "/opt/venv/bin/python"),
                                       "/work/p281/steps/trade_stage.py", what]})
        members.append({"label": lane, "steps": steps})
    path = f"{WS}/lanes_plan.json"
    json.dump({"members": members}, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    out(status="OK", plan=path, members=len(members),
        model_steps=sum(1 for m in members for st in m["steps"] if st["kind"] == "model"),
        script_steps=sum(1 for m in members for st in m["steps"] if st["kind"] == "script"))


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
    # A lane that was planned and produced nothing must not simply disappear from the comparison.
    # Measured: a five-shape cycle lost one lane at its first step and still reported "5/5 valid",
    # because this step counted the files it could see rather than the lanes the run set out to
    # decide. The plan is the workflow's own, so it is read here.
    planned = []
    try:
        plan = json.load(open(f"{WS}/lanes_plan.json", encoding="utf-8"))
        planned = [m["label"] for m in plan.get("members") or []]
    except Exception:
        pass
    have = {r["lane"] for r in rows}
    for label in planned:
        if label not in have:
            rows.append({"lane": label, "status": "MISSING", "why": "the lane produced no proposal",
                         "gross": 0, "ret": None, "excess": None, "positions": 0})
    json.dump({"packet_sha256": sha, "benchmark_next": nxt["BENCH"], "lanes": rows},
              open(f"{WS}/report.json", "w"), ensure_ascii=False, indent=1)
    valid = [r for r in rows if r["status"] == "VALID"]
    best = max(valid, key=lambda r: r["ret"], default=None)
    out(status="OK", lanes=len(rows), valid=len(valid),
        invalid=",".join(r["lane"] for r in rows if r["status"] == "INVALID"),
        missing=",".join(r["lane"] for r in rows if r["status"] == "MISSING"),
        best_lane=(best or {}).get("lane", ""), best_ret=str((best or {}).get("ret", "")),
        packet_sha256=sha, report=json.dumps(rows, ensure_ascii=False)[:1500])


if __name__ == "__main__":
    {"packet": cmd_packet, "evaluate": cmd_evaluate,
     "baseline": lambda: cmd_baseline(sys.argv[2] if len(sys.argv) > 2 else "base"),
     "score-forecast": cmd_score_forecast,
     "shapes-plan": lambda: cmd_shapes_plan(sys.argv[2:])}[sys.argv[1]]()
