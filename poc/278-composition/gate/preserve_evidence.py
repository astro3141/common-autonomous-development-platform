"""Preserve the decision record and the evidence behind it (probe R2).

Measured in F21: the terminal run record is durable but coarse, while the event log that the
governance fact is derived from lives in TMPDIR and did not survive a container recreation.
So the decision was durable and its evidence was not.

This step runs after the Gate and before the terminal steps, copying both the evidence object
and the run's event log into the workspace. It is one workflow step, not an adapter: it owns
no state, makes no decision, and changes nothing about the run.
"""

import glob
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(os.environ.get("POC_DIR", "/work"))
EVENT_DIR = Path(os.environ.get("CONDUCTOR_EVENT_DIR", "/tmp/conductor"))
run_id = os.environ.get("CONDUCTOR_SELF_RUN_ID", "unknown")

payload = sys.stdin.read()
out_dir = ROOT / "evidence" / "runs" / run_id
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "evidence.json").write_text(payload, encoding="utf-8")

copied = []
for src in glob.glob(str(EVENT_DIR / f"conductor-*-{run_id}.events.jsonl")):
    dst = out_dir / Path(src).name
    shutil.copy2(src, dst)
    copied.append(dst.name)

result = {
    "preserved_dir": str(out_dir.relative_to(ROOT)),
    "event_logs_copied": len(copied),
    "evidence_bytes": len(payload),
}
sys.stderr.write(f"preserve_evidence: {json.dumps(result)}\n")
print(json.dumps(result))
