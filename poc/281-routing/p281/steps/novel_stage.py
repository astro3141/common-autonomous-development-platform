"""Conductor script steps for the novel-shaped capability trial (deterministic parts).

usage:
  novel_stage.py stage                 copy the fixture entry state into the run's workspace
  novel_stage.py freeze                fix the draft: id + sha256, so reviewers judge one artifact
  novel_stage.py triage <max_repairs>  read the reviews, decide PASS or a bounded repair

Nothing here calls a model. The workflow's routing decisions are made by this script from files on
disk, which is the point of the trial: the models produce semantics, the graph edge is chosen
deterministically.
"""
import glob, hashlib, json, os, shutil, sys

sys.path.insert(0, "/work/p281")
import settings

RT = settings.runtime()
RUN = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
WS = f"{RT['paths']['workspace_root']}/{RUN}"
FIXTURES = "/work/p281/fixtures/novel"


def out(**kw):
    print(json.dumps(kw))


def cmd_stage():
    os.makedirs(WS, exist_ok=True)
    copied = []
    for name in ("entry.md", "contract_request.md"):
        shutil.copyfile(f"{FIXTURES}/{name}", f"{WS}/{name}")
        copied.append(name)
    # a repair round leaves findings behind; a fresh run must not inherit them
    for stale in ("findings.json", "draft.md", "draft_meta.json",
                  "review_story.json", "review_history.json", "review_cold.json"):
        if os.path.exists(f"{WS}/{stale}"):
            os.remove(f"{WS}/{stale}")
    out(status="OK", workspace=WS, staged=",".join(copied))


def cmd_freeze():
    p = f"{WS}/draft.md"
    if not os.path.isfile(p):
        out(status="MISSING", draft_id="", draft_sha256="", chars=0)
        return 0
    body = open(p, encoding="utf-8").read()
    sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
    n = len(glob.glob(f"{WS}/draft-*.md")) + 1
    frozen = f"{WS}/draft-{n:02d}.md"
    shutil.copyfile(p, frozen)          # the immutable copy reviewers are pointed at
    meta = {"draft_id": f"d{n:02d}", "draft_sha256": sha, "chars": len(body), "path": frozen}
    json.dump(meta, open(f"{WS}/draft_meta.json", "w"), indent=1)
    out(status="OK", **meta)


def read_review(name):
    p = f"{WS}/{name}"
    if not os.path.isfile(p):
        return {"usable": False, "why": "not written"}
    try:
        d = json.load(open(p, encoding="utf-8"))
    except ValueError:
        return {"usable": False, "why": "not JSON"}
    d.setdefault("usable", True)
    return d


def cmd_triage(max_repairs):
    story, history, cold = (read_review(f"review_{k}.json") for k in ("story", "history", "cold"))
    done = len(glob.glob(f"{WS}/findings-*.json"))          # repairs already asked for
    # Required reviews must be usable; the Cold Reader is advisory and may be missing entirely.
    missing = [n for n, r in (("story", story), ("history", history)) if not r.get("usable")]
    blocking = [f for r in (story, history)
                for f in (r.get("findings") or [])
                if f.get("severity") == "BLOCKING" and f.get("kind") != "NONE"]
    if missing:
        decision, reason = "BLOCK", f"required review unusable: {', '.join(missing)}"
    elif not blocking:
        decision, reason = "PASS", "no blocking finding in the required reviews"
    elif done >= int(max_repairs):
        decision, reason = "BLOCK", f"still blocking after {done} repair(s) — bound reached"
    else:
        decision, reason = "REPAIR", "; ".join(f.get("what", "")[:80] for f in blocking)[:300]
        json.dump({"findings": blocking}, open(f"{WS}/findings.json", "w"), ensure_ascii=False, indent=1)
        json.dump({"findings": blocking}, open(f"{WS}/findings-{done + 1}.json", "w"),
                  ensure_ascii=False, indent=1)
    meta = json.load(open(f"{WS}/draft_meta.json", encoding="utf-8")) if os.path.isfile(f"{WS}/draft_meta.json") else {}
    out(status="OK", decision=decision, reason=reason, repairs_done=done,
        blocking_count=len(blocking),
        cold_available="yes" if cold.get("usable") else "no",
        cold_continue_reading=str(cold.get("continue_reading", "")),
        draft_id=meta.get("draft_id", ""), draft_sha256=meta.get("draft_sha256", ""),
        chars=meta.get("chars", 0))


if __name__ == "__main__":
    a = sys.argv[1]
    {"stage": cmd_stage, "freeze": cmd_freeze,
     "triage": lambda: cmd_triage(sys.argv[2] if len(sys.argv) > 2 else 2)}[a]()
