"""Controls for the trial steps: the defects review found, and the platform/workflow boundary.

usage: trial_controls.py            (no model call, no network; fake inputs only)

Every control drives the real function from the real module with a synthetic workspace, so it
fails if the fix is reverted. What each group pins:

  triage    a review only counts for the draft it was written for, and only when this round's
            reviews step reports it produced — an older verdict, an emptied file and a document
            that is not a review all block instead of passing
  lanes     one lane's malformed proposal is that lane's INVALID, never the end of the cycle's
            evaluation; NaN is not a weight
  roles     a role is bound only to a provider the router found eligible in this run
  record    a blocked run is recorded as a blocked execution, not as "the router started nothing"
  screen    every recording step's MLflow result reaches the run screen
  boundary  the platform's fan-out capability carries no domain rule, and the workflow's steps
            carry the judgements (CONTRACT.md)
  recorder  a run with several executions is recorded as several runs, one per execution
  reduced   a smaller composition may drop recording and the screen — never what the stack's
            guarantees rest on — and a run that loses a capability is refused, not silently run
"""
import importlib.util, json, os, re, shutil, sys, tempfile

sys.path.insert(0, "/work/p281")
sys.path.insert(0, "/work/p281/steps")

PASS, FAIL = [], []


def check(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))
    print(f"  {'ok  ' if got == want else 'FAIL'}  {name:<58} {got!r}" +
          ("" if got == want else f"  (expected {want!r})"))


def load(path, name, ws):
    """Import a step module with its workspace pointed at a temporary directory."""
    os.environ["CONDUCTOR_SELF_RUN_ID"] = os.path.basename(ws)
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    m.WS = ws
    return m


# ---------------------------------------------------------------- triage
def triage_case(label, *, receipt_draft="d02", produced=True, story=None, history=None,
                tamper=False, no_receipt=False):
    """Freeze d01, review it, repair, freeze d02 — then vary what this round produced."""
    root = tempfile.mkdtemp(prefix="p281-triage-")
    ws = os.path.join(root, "run")
    os.makedirs(ws)
    ns = load("/work/p281/steps/novel_stage.py", "novel_stage_ctl", ws)

    open(f"{ws}/draft.md", "w").write("first draft\n")
    ns.cmd_freeze()                                       # d01
    good = {"reviewer": "story", "usable": True, "verdict": "PASS",
            "findings": [{"kind": "NONE", "severity": "MINOR", "what": "fine"}]}
    for n in ("story", "history"):
        json.dump({**good, "reviewer": n}, open(f"{ws}/review_{n}.json", "w"))
    open(f"{ws}/draft.md", "w").write("repaired draft\n")
    ns.cmd_freeze()                                       # d02 — a new round
    meta = json.load(open(f"{ws}/draft_meta.json"))

    members = {}
    for n, doc in (("story", story), ("history", history)):
        if doc is not None:
            json.dump(doc, open(f"{ws}/review_{n}.json", "w"))
        exists = os.path.isfile(f"{ws}/review_{n}.json")
        members[n] = {"artifact": f"review_{n}.json",
                      "status": "COMPLETED" if produced else "FAILED",
                      "produced": produced and exists,
                      "sha256": ns.sha_file(f"{ws}/review_{n}.json") if exists else ""}
    if not no_receipt:
        ctx = meta["draft_sha256"] if receipt_draft == "d02" else "an earlier draft's sha256"
        json.dump({"context": ctx, "members": members},
                  open(f"{ws}/reviews_round.json", "w"))
    if tamper:
        json.dump({**good, "verdict": "PASS", "findings": [{"kind": "NONE", "severity": "MINOR"}]},
                  open(f"{ws}/review_story.json", "w"))

    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ns.cmd_triage("1")
    shutil.rmtree(root, ignore_errors=True)
    return json.loads(buf.getvalue().strip().splitlines()[-1])["decision"]


def controls_triage():
    print("triage — a review counts only for this round's draft")
    ok = {"reviewer": "x", "usable": True, "verdict": "PASS",
          "findings": [{"kind": "NONE", "severity": "MINOR", "what": "fine"}]}
    blocking = {"reviewer": "x", "usable": True, "verdict": "REPAIR",
                "findings": [{"kind": "FACT_ERROR", "severity": "BLOCKING", "what": "wrong"}]}
    check("this round reviewed d02 and found nothing", triage_case("a", story=ok, history=ok), "PASS")
    # the defect: d01's reviews were still on disk, so a failed reviewer passed on the old verdict
    check("a required reviewer failed this round", triage_case("b", produced=False), "BLOCK")
    check("required reviews are empty objects", triage_case("c", story={}, history={}), "BLOCK")
    check("a required review has no findings", triage_case("d", story={"verdict": "PASS", "findings": []},
                                                           history=ok), "BLOCK")
    check("a finding carries no severity", triage_case("e", story={"verdict": "PASS", "findings": [{"kind": "NONE"}]},
                                                       history=ok), "BLOCK")
    check("the receipt names an earlier draft", triage_case("f", receipt_draft="d01", story=ok, history=ok), "BLOCK")
    check("no receipt from this round at all", triage_case("g", no_receipt=True, story=ok, history=ok), "BLOCK")
    check("the file changed after the reviews step", triage_case("h", story=ok, history=ok, tamper=True), "BLOCK")
    check("a blocking finding still repairs", triage_case("i", story=blocking, history=ok), "REPAIR")


# ---------------------------------------------------------------- lanes
def controls_lanes():
    print("lanes — a malformed proposal is one lane's result")
    root = tempfile.mkdtemp(prefix="p281-lanes-")
    ws = os.path.join(root, "run")
    os.makedirs(ws)
    ts = load("/work/p281/steps/trade_stage.py", "trade_stage_ctl", ws)
    _, packet, body, _ = ts.build_packet()
    open(f"{ws}/packet.json", "w", encoding="utf-8").write(body)
    syms = [s["symbol"] for s in packet["universe"]][:3]
    good = {"lane": "base", "model_calls": 0, "refs": [],
            "targets": [{"symbol": s, "weight": 0.2} for s in syms]}
    broken = {
        "empty_list": [],
        "null_target": {"targets": [None]},
        "bad_calls": {"targets": [{"symbol": syms[0], "weight": 0.2}], "model_calls": "two"},
        "nan_weight": {"targets": [{"symbol": syms[0], "weight": float("nan")}]},
        "symbol_list": {"targets": [{"symbol": [syms[0]], "weight": 0.2}]},
        "refs_string": {"targets": [{"symbol": syms[0], "weight": 0.2}], "refs": "EV-001"},
    }
    json.dump(good, open(f"{ws}/lane_base.json", "w"))
    for name, doc in broken.items():
        json.dump(doc, open(f"{ws}/lane_{name}.json", "w"))
    open(f"{ws}/lane_syntax.json", "w").write("{not json")

    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ts.cmd_evaluate()
    res = json.loads(buf.getvalue().strip().splitlines()[-1])
    rows = {r["lane"]: r for r in json.loads(res["report"])}
    check("the evaluation finished at all", res["status"], "OK")
    check("the sound lane is still scored", rows.get("base", {}).get("status"), "VALID")
    for name in list(broken) + ["syntax"]:
        check(f"{name} is that lane's INVALID", rows.get(name, {}).get("status"), "INVALID")
    check("a report was written", os.path.isfile(f"{ws}/report.json"), True)
    check("the comparison still names a best lane", res["best_lane"], "base")
    shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------- roles
def controls_roles():
    print("roles — a role is bound only to a provider the router admitted")
    import subprocess
    root = tempfile.mkdtemp(prefix="p281-roles-")
    ev = os.path.join(root, "route")
    os.makedirs(ev)

    def run(evaluated, args=("architect=codex", "author=claude", "cold=grok")):
        if evaluated is not None:
            json.dump({"decision": "ROUTE", "provider": "grok", "reason": "x",
                       "evaluated": evaluated}, open(f"{ev}/decision.json", "w"))
        elif os.path.isfile(f"{ev}/decision.json"):
            os.remove(f"{ev}/decision.json")
        p = subprocess.run(["/opt/venv/bin/python", "/work/p281/steps/roles.py",
                            "research-default", ev, *args], capture_output=True, text=True)
        return json.loads(p.stdout.strip().splitlines()[-1])

    all_ok = [{"provider": p, "eligible": True, "why": "within limits"}
              for p in ("codex", "claude", "grok")]
    r = run(all_ok)
    check("every provider eligible → bound", (r["ok"], r["author_provider"]), ("yes", "claude"))
    # the defect: quota exhausted on two vendors, their roles were still returned as ok
    exhausted = [{"provider": "codex", "eligible": False, "why": "exhausted: weekly 99% >= 80%"},
                 {"provider": "claude", "eligible": False, "why": "exhausted: session 95% >= 80%"},
                 {"provider": "grok", "eligible": True, "why": "within limits"}]
    r = run(exhausted)
    check("exhausted providers are not bound", (r["ok"], r["author_provider"], r["architect_provider"]),
          ("no", "", ""))
    check("the eligible one is still bound", r["cold_provider"], "grok")
    check("the reason travels with it", "exhausted" in r["ineligible"], True)
    r = run([{"provider": "codex", "eligible": True, "why": ""}])
    check("a provider the router did not evaluate", (r["ok"], r["author_provider"]), ("no", ""))
    r = run(None)
    check("no router evaluation to read → fail closed", r["ok"], "no")
    r = run(all_ok, args=("author=gemini",))
    check("a provider the profile does not carry", (r["ok"], r["missing"].split(" ")[0]),
          ("no", "author:gemini"))
    shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------- record + screen
def controls_record_and_screen():
    print("record / screen — a blocked run is recorded as one, and every record reaches the screen")
    y = open("/work/p281/workflows/novel-a.yaml", encoding="utf-8").read()
    block = y.split("- name: record_block", 1)[1].split("- name: record_hold", 1)[0]
    check("record_block sends an execute record", "'execute'" in block, True)
    check("record_block sends the triage reason", "triage.output.reason" in block, True)
    check("record_hold still sends none (a real HOLD)",
          "'execute'" in y.split("- name: record_hold", 1)[1].split("routes:", 1)[0], False)

    src = open("/work/p281/run_workflow.py", encoding="utf-8").read()
    conds = re.findall(r'elif t == "script_completed" and (.+?):\n', src)
    cond = next((c for c in conds if "record" in c), "")
    for step in ("record", "record_hold", "record_pass", "record_block", "record_cycle"):
        check(f"the screen reads {step}", bool(eval(cond, {"d": {"agent_name": step}, "str": str})), True)
    check("an unrelated step is not read as a record",
          bool(eval(cond, {"d": {"agent_name": "route"}, "str": str})), False)


# ------------------------------------------------- the fan-out steps, with the real fanout module
# Why this exists: the triage controls build `reviews_round.json` themselves, so they never call
# the step that writes it. A review of the published tree found `novel_reviews.py` calling
# `fanout.run_all(jobs, ledger=…)` against a `run_all(jobs)` — the step died with a TypeError
# before a single reviewer started, and nothing here noticed. These controls run the real step
# modules with the real `fanout`, replacing only the interpreter that would start a model call.
STUB = '''#!/bin/sh
# stands in for the step's interpreter: $1 is the script it would have run
shift
label=$3; expected=$5
if [ "$label" = "$CTL_FAIL" ]; then echo '{"status":"FAILED","produced":false}'; exit 1; fi
printf '%s' "$CTL_DOC" > "$CTL_WS/$expected"
echo '{"status":"COMPLETED","produced":true,"run_id":"ctl"}'
'''


def run_step(path, name, argv, ws, doc, fail=""):
    """Import and run a fan-out step with its workspace and its child interpreter faked."""
    import contextlib, io, types
    root = os.path.dirname(os.path.dirname(ws))
    stub = os.path.join(root, "stub.sh")
    with open(stub, "w", newline="\n") as f:
        f.write(STUB)
    os.chmod(stub, 0o755)

    fake = types.ModuleType("settings")
    fake.runtime = lambda: {"paths": {"workspace_root": os.path.dirname(ws),
                                      "evidence_root": os.path.join(root, "evidence")}}
    fake.profile = lambda n=None: {}
    saved_settings, saved_argv = sys.modules.get("settings"), sys.argv
    sys.modules["settings"] = fake
    os.environ.update({"CONDUCTOR_SELF_RUN_ID": os.path.basename(ws), "POC_PY": stub,
                       "CTL_WS": ws, "CTL_DOC": doc, "CTL_FAIL": fail})
    sys.argv = [name, *argv]
    buf = io.StringIO()
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        m = importlib.util.module_from_spec(spec)
        sys.modules[name] = m
        with contextlib.redirect_stdout(buf):
            spec.loader.exec_module(m)
        return json.loads(buf.getvalue().strip().splitlines()[-1])
    except Exception as e:                       # a broken step is the finding, not a crash here
        return {"status": f"{type(e).__name__}: {e}"}
    finally:
        sys.argv = saved_argv
        if saved_settings is not None:
            sys.modules["settings"] = saved_settings
        for k in ("POC_PY", "CTL_WS", "CTL_DOC", "CTL_FAIL"):
            os.environ.pop(k, None)


def controls_reviews_step():
    print("reviews step — the real step, the real fanout, no model call")
    ok = json.dumps({"reviewer": "x", "usable": True, "verdict": "PASS",
                     "findings": [{"kind": "NONE", "severity": "MINOR", "what": "fine"}]})
    specs = ["story:claude:claude:direct:/work/p281/prompts/novel-review-story.md:review_story.json",
             "history:codex:codex:direct:/work/p281/prompts/novel-review-history.md:review_history.json",
             "cold:grok:grok:direct:/work/p281/prompts/novel-cold.md:review_cold.json"]

    for label, fail, want_triage in (("every reviewer produced", "", "PASS"),
                                     ("a required reviewer failed", "history", "BLOCK")):
        root = tempfile.mkdtemp(prefix="p281-step-")
        ws = os.path.join(root, "ws", "ctlrun")
        os.makedirs(ws)
        ns = load("/work/p281/steps/novel_stage.py", f"ns_{fail or 'all'}", ws)
        open(f"{ws}/draft.md", "w").write("a draft\n")
        ns.cmd_freeze()
        meta = json.load(open(f"{ws}/draft_meta.json"))

        res = run_step("/work/p281/steps/tasks.py", f"nr_{fail or 'all'}",
                       ["reviews_round.json", meta["draft_sha256"], "research-default", *specs],
                       ws, ok, fail)
        check(f"{label}: the step ran", res.get("status"), "OK")
        rec_path = f"{ws}/reviews_round.json"
        check(f"{label}: a receipt was written", os.path.isfile(rec_path), True)
        rec = json.load(open(rec_path)) if os.path.isfile(rec_path) else {}
        check(f"{label}: the receipt carries this draft's context", rec.get("context"),
              meta["draft_sha256"])
        if fail:
            check(f"{label}: the failed member is reported, the others produced",
                  (rec.get("members", {}).get("history", {}).get("produced"),
                   res.get("produced"), res.get("failed")), (False, 2, "history"))
        else:
            check(f"{label}: each member carries its file's sha256",
                  rec.get("members", {}).get("story", {}).get("sha256"),
                  ns.sha_file(f"{ws}/review_story.json"))
            check(f"{label}: the capability reports an overlap", isinstance(res.get("overlap"), float), True)
            check(f"{label}: the capability names no domain rule",
                  ("required" in json.dumps(res)) or ("advisory" in json.dumps(res)), False)

        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ns.cmd_triage("1")
        check(f"{label}: triage then decides", json.loads(buf.getvalue().strip().splitlines()[-1])["decision"],
              want_triage)
        shutil.rmtree(root, ignore_errors=True)


def controls_lanes_step():
    print("lanes step — the real step, the real fanout, no model call")
    root = tempfile.mkdtemp(prefix="p281-lanestep-")
    ws = os.path.join(root, "ws", "ctlrun")
    os.makedirs(ws)
    ts = load("/work/p281/steps/trade_stage.py", "ts_step", ws)
    _, packet, body, _ = ts.build_packet()
    open(f"{ws}/packet.json", "w", encoding="utf-8").write(body)
    syms = [s["symbol"] for s in packet["universe"]][:2]
    doc = json.dumps({"lane": "ai", "model_calls": 1, "refs": [],
                      "targets": [{"symbol": s, "weight": 0.2} for s in syms]})
    ts.cmd_baseline("base")                      # the workflow's own step, no model call
    specs = ["ai:codex:codex:direct:/work/p281/prompts/trade-lane.md:lane_ai.json",
             "ai2:claude:claude:direct:/work/p281/prompts/trade-lane2.md:lane_ai2.json"]
    res = run_step("/work/p281/steps/tasks.py", "tl_step",
                   ["lanes_round.json", "packet-sha", "research-default", *specs],
                   ws, doc, fail="ai2")
    check("the step ran", res.get("status"), "OK")
    check("two model lanes, one produced", (res.get("tasks"), res.get("produced")), (2, 1))
    check("the failed lane is named and alone", res.get("failed"), "ai2")
    check("the deterministic lane needed no model", os.path.isfile(f"{ws}/lane_base.json"), True)
    check("the receipt carries the cycle's packet",
          json.load(open(f"{ws}/lanes_round.json")).get("context"), "packet-sha")
    shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------- the recorder
def controls_recorder():
    """Drive the real recorder with its network calls captured, so nothing is written anywhere."""
    print("recorder — one MLflow run per execution, under the run's own")
    import importlib.util
    spec = importlib.util.spec_from_file_location("record_ctl", "/work/p281/steps/record.py")
    rec = importlib.util.module_from_spec(spec)
    sys.modules["record_ctl"] = rec
    spec.loader.exec_module(rec)

    sent = []
    ids = iter(f"rid{n}" for n in range(1, 99))

    def fake_call(path, body=None, method="POST"):
        sent.append((path, body))
        if "get-by-name" in path:
            return {"experiment": {"experiment_id": "7"}}
        if path.endswith("runs/create"):
            return {"run": {"info": {"run_id": next(ids)}}}
        return {}
    rec.call = fake_call
    rec.put_artifact = lambda *a: None

    def ex(run_id, provider, status="COMPLETED", tokens=None):
        return {"run_id": run_id, "provider": provider, "status": status, "model_route": "direct",
                "model_session_reported": "default", "model_adapter_reported": "",
                "model_served": "unknown", "evidence_dir": "/nowhere", "profile": "research-default",
                "approvals_requested": 0, "mcp_rule_denials": 0,
                "measurements": {"total_tokens": tokens} if tokens else {}}

    root = tempfile.mkdtemp(prefix="p281-rec-")
    receipt = os.path.join(root, "lanes_round.json")
    json.dump({"context": "packet-sha", "members": {
        "ai": {"provider": "codex", "produced": True, "result": ex("run-ai", "codex", tokens=11)},
        "ai2": {"provider": "claude", "produced": False,
                "result": ex("run-ai2", "claude", status="FAILED")}}},
        open(receipt, "w"))
    check_ = {"decision": "CYCLE", "reason": "best ai", "file_sha256": "abc"}
    route = {"decision": "ROUTE", "reason": "codex: within limits", "profile": "research-default"}

    def runs_of():
        return [b for p, b in sent if p.endswith("runs/create")]

    def tags_of(rid):
        for p, b in sent:
            if p.endswith("log-batch") and b.get("run_id") == rid:
                return {t["key"]: t["value"] for t in b.get("tags", [])}
        return {}

    def metrics_of(rid):
        for p, b in sent:
            if p.endswith("log-batch") and b.get("run_id") == rid:
                return {m["key"]: m["value"] for m in b.get("metrics", [])}
        return {}

    # one execution: unchanged — a single run named after it
    sent.clear()
    out = rec.record({"execute": ex("solo", "claude"), "check": check_, "route": route})
    check("one execution is still one run", (out["executions"], out["children"]), (1, 0))
    check("the run is named after the execution",
          [r["run_name"] for r in runs_of()], ["solo"])
    check("it carries the gate decision", tags_of(out["mlflow_run_id"]).get("gate.decision"), "CYCLE")

    # several: a parent and a child per execution
    sent.clear()
    out = rec.record({"receipts": [receipt], "check": check_, "route": route,
                      "measurements": {"valid_lanes": 3}})
    check("both lanes are recorded", (out["executions"], out["children"]), (2, 2))
    parent = out["mlflow_run_id"]
    kids = [r["run_id"] for p, r in sent if p.endswith("log-batch")
            and r["run_id"] != parent]
    check("each child points at the parent",
          sorted({tags_of(k).get("mlflow.parentRunId") for k in kids}), [parent])
    check("each child keeps its own provider",
          sorted(tags_of(k).get("provider") for k in kids), ["claude", "codex"])
    check("each child keeps its member name",
          sorted(tags_of(k).get("member") for k in kids), ["ai", "ai2"])
    check("a lane's own numbers stay with the lane",
          [metrics_of(k).get("total_tokens") for k in kids if tags_of(k).get("member") == "ai"], [11.0])
    check("the parent carries the run's numbers", metrics_of(parent).get("valid_lanes"), 3.0)
    check("the parent says how many executions there were",
          (metrics_of(parent).get("executions"), metrics_of(parent).get("executions_completed")),
          (2.0, 1.0))
    check("one failed lane makes the run partial", tags_of(parent).get("status"), "PARTIAL")
    check("no execution is counted twice",
          rec.record({"execute": ex("run-ai", "codex"), "receipts": [receipt],
                      "check": check_, "route": route})["executions"], 2)

    # nothing ran at all
    sent.clear()
    out = rec.record({"check": check_, "route": route})
    check("a run the router held is still recorded",
          (out["executions"], tags_of(out["mlflow_run_id"]).get("status")), (0, "HOLD"))

    # a receipt that cannot be read is reported, not guessed at
    out = rec.record({"execute": ex("solo", "claude"), "receipts": ["/nowhere/x.json"],
                      "check": check_, "route": route})
    check("an unreadable receipt is named in the error",
          ("x.json" in out["record_error"], out["executions"]), (True, 1))
    shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------- the boundary itself
DOMAIN_WORDS = ("review", "reviewer", "lane", "draft", "packet", "chapter", "trading", "novel",
                "required", "advisory", "blocking", "verdict")


def controls_boundary():
    print("boundary — the capability knows no domain, the workflow keeps the judgement")
    cap = open("/work/p281/steps/tasks.py", encoding="utf-8").read()
    body = "\n".join(l for l in cap.splitlines()
                     if not l.lstrip().startswith("#") and "Conductor" not in l)
    body = body.split('"""', 2)[-1].lower()          # code only, not the module's explanation
    found = sorted({w for w in DOMAIN_WORDS if w in body})
    check("no domain vocabulary in the capability's code", found, [])
    for name, path, want in (
            ("what is required", "/work/p281/steps/novel_stage.py", "required"),
            ("what a valid proposal is", "/work/p281/steps/trade_stage.py", "INVALID"),
            ("the deterministic baseline", "/work/p281/steps/trade_stage.py", "momentum20")):
        check(f"the workflow still owns: {name}", want in open(path, encoding="utf-8").read(), True)
    check("nothing imports the removed fan-out wrappers",
          any(os.path.exists(p) for p in ("/work/p281/steps/novel_reviews.py",
                                          "/work/p281/steps/trade_lanes.py")), False)
    y = open("/work/p281/workflows/novel-a.yaml", encoding="utf-8").read()
    check("the reviews step names the capability", "steps/tasks.py" in y, True)
    check("the triage step is told what is required", '"story,history"' in y, True)


# ---------------------------------------------------------------- a reduced composition
def controls_composition():
    print("reduced — what a composition may drop, and what a run is refused for")
    sys.path.insert(0, "/work/p281")
    import capabilities

    def caps(**avail):
        base = {"tool_rights": True, "approvals": True, "egress": True, "record": True,
                "admission": True}
        base.update(avail)
        return {k: {"available": v, "required": k in ("tool_rights", "approvals", "egress"),
                    "without_it": "", "detail": ""} for k, v in base.items()}

    check("everything there → nothing missing",
          capabilities.missing(caps()), [])
    check("no recording, and no one said so → refused",
          capabilities.missing(caps(record=False)), ["record"])
    check("no recording, said so → allowed",
          capabilities.missing(caps(record=False), need_record=False), [])
    check("no tool rights → refused even with the opt-in",
          capabilities.missing(caps(tool_rights=False), need_record=False), ["tool_rights"])
    check("no egress → refused even with the opt-in",
          capabilities.missing(caps(egress=False), need_record=False), ["egress"])
    check("stale quota is reported, not a refusal (the router holds the run itself)",
          capabilities.missing(caps(admission=False), need_record=False), [])

    import yaml                                   # the compose file itself, not a guess at it
    svcs = (yaml.safe_load(open("/work/docker/compose.poc.yaml", encoding="utf-8"))
            or {}).get("services") or {}
    optional = sorted(n for n, v in svcs.items() if (v or {}).get("profiles"))
    check("only these services are optional", optional, ["hub", "mlflow", "ops"])
    for must in ("egress", "toolsvc", "fsmcp", "quota", "agent"):
        check(f"{must} can never be dropped", must in optional, False)

    up = open("/work/scripts/up.sh", encoding="utf-8").read()
    for name in ("full", "no-record", "runtime"):
        check(f"up.sh knows the {name} composition", f"  {name})" in up or f"  {name})" in up, True)
    check("an unknown composition is refused", "unknown composition:" in up, True)
    check("a composition that drops a service also stops it", "rm -sf $drop" in up, True)
    down = open("/work/scripts/down.sh", encoding="utf-8").read()
    check("down takes everything, whatever was up", 'COMPOSE_PROFILES="record,ui"' in down, True)


if __name__ == "__main__":
    controls_boundary()
    controls_composition()
    controls_recorder()
    controls_triage()
    controls_reviews_step()
    controls_lanes_step()
    controls_lanes()
    controls_roles()
    controls_record_and_screen()
    print(f"\n{len(PASS)}/{len(PASS) + len(FAIL)} controls passed")
    sys.exit(1 if FAIL else 0)
