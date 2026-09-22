"""Test step for the #278 PoC vertical slice.

Runs the fixture's pytest suite and emits ONE JSON object on stdout describing
only *observed* facts (exit code, counts, artifact digest). Logs go to stderr so
stdout stays parseable under Conductor's strict script-output mode.

Exits with pytest's own exit code so Conductor's built-in `exit_code` is real.
"""

import hashlib
import json
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixture"
# The interpreter running this script is the one Conductor was configured with
# (POC_PY), so the same file works on the Windows host and in the Linux container.
PYTHON = Path(sys.executable)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "report.xml"
        proc = subprocess.run(
            [str(PYTHON), "-m", "pytest", "-q", f"--junit-xml={report}", str(FIXTURE / "tests")],
            cwd=str(FIXTURE),
            capture_output=True,
            text=True,
        )
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)

        totals = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
        if report.exists():
            suite = ET.parse(report).getroot()
            node = suite.find("testsuite") if suite.tag == "testsuites" else suite
            for key in totals:
                totals[key] = int(node.get(key, 0))

    evidence = {
        "tests_exit_code": proc.returncode,
        "tests_total": totals["tests"],
        "tests_failed": totals["failures"] + totals["errors"],
        "tests_skipped": totals["skipped"],
        "artifact_sha256": sha256(FIXTURE / "src" / "slugify.py"),
        "artifact_path": "fixture/src/slugify.py",
    }
    print(json.dumps(evidence))
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
