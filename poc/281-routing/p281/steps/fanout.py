"""Start several subprocesses together and measure each one's own start and end.

Used by the capability trials (steps/novel_reviews.py, steps/trade_lanes.py), which need real
concurrency because Conductor's `parallel` / `for_each` groups refuse script steps (v0.1.37) and
every routed model call here is a script step.

Why this exists as its own module: the first version of both trials collected the children with a
sequential loop of `communicate()` and stamped the end time when the loop reached each child. With
a slow child first, every later child was recorded as ending when the slow one did — measured, a
100 s + 1 s + 1 s fan-out reported a concurrency of 3.00 where the true overlap was 1.02. A
measurement that flatters the thing being measured is worse than none, so the waiting is done in a
thread per child and each child stamps its own end.
"""
import subprocess, threading, time


def run_all(jobs):
    """jobs: [{"key": str, "argv": [..], **extra}] → (rows, wall_s)

    Each row carries the job's extras plus: started_at, ended_at (offsets in seconds from the
    first start), stdout, stderr, returncode.
    """
    t0 = time.time()
    rows = [dict(j) for j in jobs]
    threads = []

    def work(row):
        row["started_at"] = round(time.time() - t0, 2)
        p = subprocess.Popen(row["argv"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out, err = p.communicate()
        row["ended_at"] = round(time.time() - t0, 2)      # this child's own end, not the loop's
        row["stdout"], row["stderr"], row["returncode"] = out, err, p.returncode

    for row in rows:
        t = threading.Thread(target=work, args=(row,), daemon=True)
        threads.append(t)
        t.start()
    for t in threads:
        t.join()
    return rows, round(time.time() - t0, 2)


def overlap(rows, wall):
    """How much the children really overlapped: busy time ÷ wall time.

    1.0 means they might as well have run one after another; N means N were busy throughout.
    """
    busy = sum(r["ended_at"] - r["started_at"] for r in rows)
    return round(busy / wall, 2) if wall else 0.0
