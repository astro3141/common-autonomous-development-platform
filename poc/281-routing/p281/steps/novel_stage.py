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


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


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
    # A new round judges a new draft: the previous round's reviews are removed here, so a reviewer
    # that fails this round cannot leave an older verdict behind for triage to read.
    for stale in ("review_story.json", "review_history.json", "review_cold.json",
                  "reviews_round.json"):
        if os.path.exists(f"{WS}/{stale}"):
            os.remove(f"{WS}/{stale}")
    meta = {"draft_id": f"d{n:02d}", "draft_sha256": sha, "chars": len(body), "path": frozen}
    json.dump(meta, open(f"{WS}/draft_meta.json", "w"), indent=1)
    out(status="OK", **meta)


VERDICTS = ("PASS", "REPAIR")
SEVERITIES = ("BLOCKING", "MINOR")


def shape_error(d, required):
    """What is wrong with this review document, or "" when nothing is.

    A required review must be a review: an object, with a verdict this workflow knows and a
    non-empty findings list whose entries carry a kind and a severity. `{}` is not a review, and
    neither is a file that parsed but says nothing — both are unusable, which blocks.
    """
    if not isinstance(d, dict):
        return "not a JSON object"
    if not required:
        return ""
    if d.get("usable") is False:
        return "the reviewer reported itself unusable"
    if d.get("verdict") not in VERDICTS:
        return f"verdict {d.get('verdict')!r} is not one of {'/'.join(VERDICTS)}"
    fs = d.get("findings")
    if not isinstance(fs, list) or not fs:
        return "findings missing or empty"
    for i, f in enumerate(fs):
        if not isinstance(f, dict):
            return f"finding {i} is not an object"
        if not isinstance(f.get("kind"), str) or not f["kind"].strip():
            return f"finding {i} has no kind"
        if f.get("severity") not in SEVERITIES:
            return f"finding {i} severity {f.get('severity')!r} is not one of {'/'.join(SEVERITIES)}"
    return ""


def read_review(name, round_member=None, required=False):
    """Read one review, and accept it only as this round's own result.

    Three things have to hold, and each was a way to pass on an older verdict:
      * the reviews step of *this* round reports the member as produced (round_member),
      * the file on disk is still the one that step saw (sha256), and
      * the document is shaped like a review (shape_error).
    """
    p = f"{WS}/{name}"
    if round_member is None:
        return {"usable": False, "why": "this round's reviews step did not report this reviewer"}
    if not round_member.get("produced"):
        return {"usable": False, "why": f"this round: {round_member.get('status') or 'not produced'}"}
    if not os.path.isfile(p):
        return {"usable": False, "why": "not written"}
    if sha_file(p) != round_member.get("sha256"):
        return {"usable": False, "why": "changed since this round's reviews step wrote it"}
    try:
        d = json.load(open(p, encoding="utf-8"))
    except ValueError:
        return {"usable": False, "why": "not JSON"}
    bad = shape_error(d, required)
    if bad:
        return {"usable": False, "why": bad}
    d["usable"] = True
    return d


def read_round(meta):
    """This round's reviews-step receipt, or None when it does not belong to this draft."""
    p = f"{WS}/reviews_round.json"
    if not os.path.isfile(p):
        return None
    try:
        r = json.load(open(p, encoding="utf-8"))
    except ValueError:
        return None
    if not isinstance(r, dict) or not isinstance(r.get("members"), dict):
        return None
    if r.get("draft_id") != meta.get("draft_id") or r.get("draft_sha256") != meta.get("draft_sha256"):
        return None                      # a receipt for another draft is not this round's
    return r


def cmd_triage(max_repairs):
    meta = json.load(open(f"{WS}/draft_meta.json", encoding="utf-8")) if os.path.isfile(f"{WS}/draft_meta.json") else {}
    rnd = read_round(meta)
    members = (rnd or {}).get("members") or {}
    story, history, cold = (read_review(f"review_{k}.json", members.get(k), required=k != "cold")
                            for k in ("story", "history", "cold"))
    done = len(glob.glob(f"{WS}/findings-*.json"))          # repairs already asked for
    # Required reviews must be usable; the Cold Reader is advisory and may be missing entirely.
    missing = [f"{n} ({r.get('why')})" for n, r in (("story", story), ("history", history))
               if not r.get("usable")]
    if rnd is None:
        missing = missing or ["no reviews receipt for this draft"]
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
