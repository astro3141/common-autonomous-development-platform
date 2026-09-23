"""Controls for steps/fanout.py — does the overlap number mean what it says?

usage (agent container): /opt/venv/bin/python /work/p281/fanout_controls.py

Sleep processes only: no model call, no provider, no workspace. Written because the first version
of the trials measured overlap by stamping each child's end time when a sequential collection loop
reached it. With a slow child first, that reported 3.00 for a fan-out whose true overlap was 1.02 —
the number flattered exactly the thing it was supposed to test.
"""
import sys, time

sys.path.insert(0, "/work/p281/steps")
import fanout

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  — {detail}"))


def sleeper(sec):
    return [sys.executable, "-c", f"import time; time.sleep({sec})"]


# The case the review used, scaled down: one long child and two short ones, started together.
jobs = [{"key": "slow", "argv": sleeper(6)}, {"key": "a", "argv": sleeper(0.4)},
        {"key": "b", "argv": sleeper(0.4)}]
rows, wall = fanout.run_all(jobs)
ov = fanout.overlap(rows, wall)
by = {r["key"]: r for r in rows}
check("a long child does not stretch the short ones' end times",
      by["a"]["ended_at"] < 2 and by["b"]["ended_at"] < 2, rows)
check("overlap of 6s + 0.4s + 0.4s is near 1, not near 3", 1.0 <= ov <= 1.35, f"overlap={ov}")
check("wall time is the longest child, not their sum", 5.5 <= wall <= 8.5, f"wall={wall}")

# Equal children really do overlap: three 3-second sleeps should report ~3.
rows, wall = fanout.run_all([{"key": k, "argv": sleeper(3)} for k in ("x", "y", "z")])
ov = fanout.overlap(rows, wall)
check("three equal children report an overlap near 3", 2.6 <= ov <= 3.2, f"overlap={ov}")
check("… and take about one child's time", 2.8 <= wall <= 5.0, f"wall={wall}")

# One child failing must not disturb the others' measurement or their results.
rows, wall = fanout.run_all([
    {"key": "ok", "argv": [sys.executable, "-c", "print('fine')"]},
    {"key": "bad", "argv": [sys.executable, "-c", "import sys; sys.exit(3)"]},
])
by = {r["key"]: r for r in rows}
check("a failing child is reported with its own return code",
      by["bad"]["returncode"] == 3 and by["ok"]["returncode"] == 0, rows)
check("… and the healthy child's output is intact", by["ok"]["stdout"].strip() == "fine", rows)

# They are really started together, not one after another.
rows, wall = fanout.run_all([{"key": k, "argv": sleeper(2)} for k in "abcd"])
spread = max(r["started_at"] for r in rows) - min(r["started_at"] for r in rows)
check("all children start within a fraction of a second", spread < 0.5, f"spread={spread}")

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
