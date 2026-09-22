"""Re-measure the gated artifact at DECISION time (probe G1 fix).

The Gate must stay a pure function, so it cannot hash a file itself. This step does
the I/O immediately before the Gate runs and hands both digests into the evidence, so
the Gate can require that the artifact it is deciding about is the artifact that was
tested. Without it, `artifact.sha256` is a record of a past measurement and nothing
notices if the file changes afterwards (measured: G1).
"""

import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("POC_DIR", "/work"))
TARGET = ROOT / "fixture" / "src" / "slugify.py"

expected = sys.argv[1] if len(sys.argv) > 1 else ""
actual = hashlib.sha256(TARGET.read_bytes()).hexdigest() if TARGET.exists() else ""

out = {
    "artifact_sha256_at_decision": actual,
    "artifact_matches_tested": bool(actual) and actual == expected,
    "artifact_path": str(TARGET.relative_to(ROOT)),
}
sys.stderr.write(
    f"verify_artifact: tested={expected[:12]} decision={actual[:12]} "
    f"match={out['artifact_matches_tested']}\n"
)
print(json.dumps(out))
