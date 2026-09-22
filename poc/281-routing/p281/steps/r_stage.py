"""Conductor script step: move files between #280's run directory and the agents' workspace.

The agents can write only through the Preloop MCP server, which serves /ws. #280's
deterministic steps read and write /research/artifacts/runs/<run id>. This step bridges the
two, deterministically, and never edits content.

  r_stage.py in      reference fixture              → /ws/<run>/
  r_stage.py review  candidate + both verifications → /ws/<run>/   (for the reviewer)
  r_stage.py back    /ws/<run>/review.json          → run directory (input-verify re-hashes it)
"""
import hashlib, json, os, shutil, sys
from pathlib import Path
sys.path.insert(0, "/work/p281")
import settings

run = os.environ.get("CONDUCTOR_SELF_RUN_ID", "manual")
ws = Path(settings.runtime()["paths"]["workspace_root"]) / run; ws.mkdir(parents=True, exist_ok=True)
rd = Path("/research/artifacts/runs") / run
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
mode = sys.argv[1]
moved = []
if mode == "in":
    src = Path("/research/artifacts/reference-fixture.json")
    shutil.copyfile(src, ws / src.name); moved.append(src.name)
elif mode == "review":
    for n in ("candidate.json", "verification.primary.json", "verification.independent.json"):
        shutil.copyfile(rd / n, ws / n); moved.append(n)
elif mode == "back":
    src = ws / "review.json"
    if not src.is_file():
        print(json.dumps({"ok": False, "moved": [], "reason": "reviewer produced no review.json"})); sys.exit(0)
    rd.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, rd / "review.json"); moved.append("review.json")
print(json.dumps({"ok": True, "moved": moved, "reason": "",
                  "hashes": {n: sha(ws / n) for n in moved}}))
