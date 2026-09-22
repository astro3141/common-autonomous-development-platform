"""Summarise the ACP permission events in an acpx --format json transcript.

Prints, per permission request: the tool kind, the tool title/input the agent asked to run,
and the outcome acpx returned. Used to confirm that a "no file" result really came from a
refused request for that write, not from the agent never trying.
"""

import json
import sys


def find(o, key):
    if isinstance(o, dict):
        if key in o:
            return o[key]
        for v in o.values():
            r = find(v, key)
            if r is not None:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find(v, key)
            if r is not None:
                return r
    return None


def main() -> None:
    for path in sys.argv[1:]:
        label = path.rsplit("/", 1)[-1].removesuffix(".out")
        seen = False
        for line in open(path, encoding="utf-8"):
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            s = json.dumps(d)
            if "request_permission" not in s:
                continue
            seen = True
            tc = find(d, "toolCall") or {}
            kind = find(tc, "kind") or find(d, "kind")
            title = (tc.get("title") if isinstance(tc, dict) else None) or ""
            raw = find(tc, "rawInput") or find(d, "rawInput") or {}
            outcome = find(d, "outcome")
            esc = find(d, "permissionEscalation")
            print(f"  {label:18} kind={kind!s:8} title={title[:48]!r}")
            if raw:
                print(f"  {'':18} input={json.dumps(raw)[:110]}")
            if outcome is not None:
                print(f"  {'':18} outcome={json.dumps(outcome)[:110]}")
            if esc:
                print(f"  {'':18} escalation={json.dumps(esc)[:110]}")
        if not seen:
            print(f"  {label:18} (no permission request in transcript)")


if __name__ == "__main__":
    main()
