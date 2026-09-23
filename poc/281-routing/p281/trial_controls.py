"""Controls for the five defects found in the capability-trial steps — each one reproduced first.

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
        members[n] = {"file": f"review_{n}.json", "kind": "required",
                      "status": "COMPLETED" if produced else "FAILED",
                      "produced": produced and exists,
                      "sha256": ns.sha_file(f"{ws}/review_{n}.json") if exists else ""}
    if not no_receipt:
        json.dump({"draft_id": receipt_draft, "draft_sha256": meta["draft_sha256"],
                   "members": members}, open(f"{ws}/reviews_round.json", "w"))
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
    specs = ["review-story:claude:claude:direct:/work/p281/prompts/novel-review-story.md:review_story.json:required",
             "review-history:codex:codex:direct:/work/p281/prompts/novel-review-history.md:review_history.json:required",
             "review-cold:grok:grok:direct:/work/p281/prompts/novel-cold.md:review_cold.json:advisory"]

    for label, fail, want_triage in (("every reviewer produced", "", "PASS"),
                                     ("a required reviewer failed", "review-history", "BLOCK")):
        root = tempfile.mkdtemp(prefix="p281-step-")
        ws = os.path.join(root, "ws", "ctlrun")
        os.makedirs(ws)
        ns = load("/work/p281/steps/novel_stage.py", f"ns_{fail or 'all'}", ws)
        open(f"{ws}/draft.md", "w").write("a draft\n")
        ns.cmd_freeze()
        meta = json.load(open(f"{ws}/draft_meta.json"))

        res = run_step("/work/p281/steps/novel_reviews.py", f"nr_{fail or 'all'}",
                       ["research-default", *specs], ws, ok, fail)
        check(f"{label}: the step ran", res.get("status"), "OK")
        rec_path = f"{ws}/reviews_round.json"
        check(f"{label}: a receipt was written", os.path.isfile(rec_path), True)
        rec = json.load(open(rec_path)) if os.path.isfile(rec_path) else {}
        check(f"{label}: the receipt names this draft", rec.get("draft_id"), meta["draft_id"])
        if fail:
            check(f"{label}: the failed reviewer is not counted",
                  (rec.get("members", {}).get("history", {}).get("produced"),
                   res.get("required_usable")), (False, 1))
        else:
            check(f"{label}: each member carries its file's sha256",
                  rec.get("members", {}).get("story", {}).get("sha256"),
                  ns.sha_file(f"{ws}/review_story.json"))
            check(f"{label}: the reviewers overlapped", isinstance(res.get("overlap"), float), True)

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
    specs = ["base:deterministic:none:none:none:none",
             "ai:model:codex:codex:direct:/work/p281/prompts/trade-lane.md",
             "ai2:model:claude:claude:direct:/work/p281/prompts/trade-lane2.md"]
    res = run_step("/work/p281/steps/trade_lanes.py", "tl_step", ["research-default", *specs],
                   ws, doc, fail="lane-ai2")
    check("the step ran", res.get("status"), "OK")
    check("three lanes, two of them produced", (res.get("lanes"), res.get("produced")), (3, 2))
    check("the failed lane is named and alone", res.get("failed"), "ai2")
    check("the deterministic lane needed no model", os.path.isfile(f"{ws}/lane_base.json"), True)
    shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    controls_triage()
    controls_reviews_step()
    controls_lanes_step()
    controls_lanes()
    controls_roles()
    controls_record_and_screen()
    print(f"\n{len(PASS)}/{len(PASS) + len(FAIL)} controls passed")
    sys.exit(1 if FAIL else 0)
