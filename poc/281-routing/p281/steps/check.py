"""Conductor script step: deterministic check of the outcome, independent of the agent's claim.

usage: check.py <target_path> <expected_content> <status>
PASS only if the adapter reported COMPLETED *and* the file holds exactly the expected bytes.
A DENIED result with the file absent is reported as DENIED (a governance outcome, not a failure
to retry elsewhere).
"""
import hashlib, json, os, sys

path, expected, status = sys.argv[1:4]
exists = os.path.isfile(path)
body = open(path, "rb").read() if exists else b""
matches = body.strip() == expected.encode()
if status == "COMPLETED" and matches:
    decision, reason = "PASS", "file present with expected content"
elif status == "DENIED" and not exists:
    decision, reason = "DENIED", "denied, and the file is absent"
elif status == "COMPLETED" and not matches:
    decision, reason = "BLOCK", "agent reported completion but the file does not match"
else:
    decision, reason = "BLOCK", f"status {status}, file {'present' if exists else 'absent'}"
print(json.dumps({"decision": decision, "reason": reason, "file_exists": exists,
                  "content_matches": matches,
                  "file_sha256": hashlib.sha256(body).hexdigest() if exists else ""}))
