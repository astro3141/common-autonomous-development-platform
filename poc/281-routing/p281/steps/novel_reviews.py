"""Run the reviewers at the same time — inside one Conductor step.

usage: novel_reviews.py <profile> <spec> [<spec> ...]
       spec = label:provider:login:route:prompt-file:expected-file:required|advisory

Why not a Conductor `parallel` group: Conductor has one (and a dynamic `for_each` too), but both
refuse script steps — measured on v0.1.37, `config/validator.py`. Every routed model step in this
stack *is* a script step, because the model runs through the routing/execution layer rather than
through Conductor's own provider clients. So concurrency for routed calls has to happen inside a
step, which is what this does, through steps/fanout.py: one subprocess per reviewer, started
together, each timed on its own.

It never fails the workflow: an advisory reviewer that dies is recorded as unusable, and the
deterministic triage decides what that means.
"""
import hashlib, json, os, sys

sys.path.insert(0, "/work/p281")
sys.path.insert(0, "/work/p281/steps")
import settings
import fanout

PY = os.environ.get("POC_PY", "/opt/venv/bin/python")
prof = sys.argv[1]
RUN = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
WS = f"{settings.runtime()['paths']['workspace_root']}/{RUN}"
LEDGER = f"{WS}/.fanout/reviews.json"     # per-member state, so a re-run resumes member by member

jobs = []
for spec in sys.argv[2:]:
    label, provider, login, route, prompt, expected, kind = spec.split(":")
    jobs.append({"key": label, "label": label, "provider": provider, "kind": kind,
                 "produces": f"{WS}/{expected}",
                 # the draft under review and the prompt are what make a finished review reusable
                 "inputs": [prompt, f"{WS}/draft_meta.json"],
                 "argv": [PY, "/work/p281/steps/agent_task.py", provider, route, label,
                          prompt, expected, prof, login]})

rows, wall = fanout.run_all(jobs, ledger=LEDGER)


def sha_file(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


out_rows, usable_required, failed = [], 0, []
for r in rows:
    try:
        res = json.loads(r["stdout"].strip().splitlines()[-1])
    except Exception:
        res = {"status": "FAILED", "produced": False,
               "error": (r["stderr"] or r["stdout"])[-200:]}
    ok = bool(res.get("produced"))
    if r["kind"] == "required" and ok:
        usable_required += 1
    if not ok:
        failed.append(r["label"])
    out_rows.append({"label": r["label"], "provider": r["provider"], "kind": r["kind"],
                     "status": res.get("status"), "produced": ok,
                     "started_at": r["started_at"], "ended_at": r["ended_at"],
                     "seconds": round(r["ended_at"] - r["started_at"], 2),
                     "reused": bool(r.get("reused")),
                     "attempts": res.get("attempts", r.get("attempts", 1)),
                     "run_id": res.get("run_id", "")})

# The receipt triage reads: which reviewer produced what, for *this* draft. Without it a review
# file left behind by an earlier round would still be on disk, and a reviewer that failed this
# round would be judged by its previous verdict (measured: a repaired draft passed on d01's
# reviews). Triage accepts a review only when this file reports it produced, with this sha256,
# and names the draft that was frozen for this round.
meta_path = f"{WS}/draft_meta.json"
meta = json.load(open(meta_path, encoding="utf-8")) if os.path.isfile(meta_path) else {}
receipt = {"draft_id": meta.get("draft_id", ""), "draft_sha256": meta.get("draft_sha256", ""),
           "members": {}}
for r, o in zip(rows, out_rows):
    key = r["label"].replace("review-", "")
    art = r.get("produces") or ""
    receipt["members"][key] = {"file": os.path.basename(art), "kind": r["kind"],
                               "status": o["status"], "produced": o["produced"],
                               "reused": o["reused"], "sha256": sha_file(art) if o["produced"] else ""}
json.dump(receipt, open(f"{WS}/reviews_round.json", "w"), ensure_ascii=False, indent=1)

print(json.dumps({
    "status": "OK",
    "reviewers": len(out_rows),
    "reused": sum(1 for x in out_rows if x["reused"]),
    "required_usable": usable_required,
    "failed": ",".join(failed),
    "wall_s": wall,
    "busy_s": round(sum(x["seconds"] for x in out_rows), 2),
    "longest_step_s": max((x["seconds"] for x in out_rows), default=0),
    # busy ÷ wall: 1.0 would mean they might as well have been sequential
    "overlap": fanout.overlap(rows, wall),
    "detail": json.dumps(out_rows, ensure_ascii=False),
}))
