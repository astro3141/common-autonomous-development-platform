"""Remove old runs — as whole runs, never in pieces.

usage (inside the agent container):
  cleanup.py [--days N] [--keep N] [--apply] [--include-orphans] [--json]

A run leaves three traces, and they only make sense together:

  evidence/ui-runs/<ui id>/     what the screen shows: meta, log, Conductor's event log
  <workspace_root>/<run>…       the directory the model worked in
  evidence/p281/<run>-<label>-<provider>/   the adapter's request and ACP events

Deleting by date, directory by directory, would leave a run listed on the screen with its
artifacts gone. This groups the three by the Conductor run id and removes a group or nothing.

Nothing is deleted unless --apply is given: the default prints what would go.

A run is kept, whatever its age, when
  * it is still running, or its launcher is alive;
  * Preloop has a pending approval under its workspace;
  * it carries a `keep` file (evidence/ui-runs/<id>/keep), i.e. the operator marked it;
  * it is inside the retention window (--days, default 14) or among the newest --keep (default 20).

Traces with no run to belong to (from before the screen existed) are reported as orphans and are
only removed with --include-orphans.
"""
import json, os, re, shutil, sys, time
from pathlib import Path

sys.path.insert(0, "/work/p281")
import settings
import run_workflow

RT = settings.runtime()
WS = Path(RT["paths"]["workspace_root"])
EVID = Path(RT["paths"]["evidence_root"])          # /work/evidence/p281
RUNS = run_workflow.RUNS                            # /work/evidence/ui-runs
RUN_ID = re.compile(r"^[0-9a-f]{8}")


def pending_workspaces():
    """Workspaces Preloop is waiting on — never remove those runs. approvals.py prints the list."""
    import subprocess
    # Not knowing must never license deletion: anything other than a clean list stops the run.
    # (Measured: with only the exception caught, a reader that exited non-zero produced an empty
    # list and the removal went ahead.)
    try:
        p = subprocess.run([sys.executable, "/work/p281/approvals.py"], capture_output=True, text=True, timeout=60)
    except Exception as e:
        raise SystemExit(f"could not run the approvals reader ({e}); nothing was removed")
    if p.returncode != 0:
        raise SystemExit(f"the approvals reader failed (exit {p.returncode}: "
                         f"{(p.stderr or '').strip()[-200:]}); nothing was removed")
    try:
        rows = json.loads(p.stdout)
    except ValueError:
        raise SystemExit("the approvals reader did not return a list; nothing was removed")
    if not isinstance(rows, list):
        raise SystemExit("the approvals reader did not return a list; nothing was removed")
    return [a.get("cwd") or "" for a in rows]


def started_from_id(ui_id, fallback):
    """The id carries the start time (YYYYmmdd-HHMMSS-xxxxxx). File times do not survive a copy
    or a restore, so they are only a fallback."""
    m = re.match(r"^(\d{8})-(\d{6})-", ui_id)
    if not m:
        return fallback
    try:
        return time.mktime(time.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S"))
    except ValueError:
        return fallback


def ui_runs():
    out = []
    for meta in sorted(RUNS.glob("*/meta.json")):
        try:
            m = json.loads(meta.read_text())
        except Exception:
            continue
        v = run_workflow.view(m)
        out.append({"ui_id": v["ui_id"], "state": v.get("state"),
                    "started_at": started_from_id(v["ui_id"], m.get("started_at", 0)),
                    "conductor_run": v.get("conductor_run"), "dir": meta.parent,
                    "keep": (meta.parent / "keep").exists()})
    # the older flat form: <ui id>.json next to <ui id>.log
    for j in sorted(RUNS.glob("*.json")):
        out.append({"ui_id": j.stem, "state": "finished",
                    "started_at": started_from_id(j.stem, j.stat().st_mtime),
                    "conductor_run": None, "dir": None, "files": [j, j.with_suffix(".log")],
                    "keep": False})
    return out


def traces_for(conductor_run):
    if not conductor_run:
        return []
    t = []
    for base in (WS, EVID):
        if base.is_dir():
            t += [p for p in base.iterdir() if p.name.startswith(conductor_run)]
    return t


def main():
    a = sys.argv[1:]
    days = int(a[a.index("--days") + 1]) if "--days" in a else 14
    keep_n = int(a[a.index("--keep") + 1]) if "--keep" in a else 20
    apply = "--apply" in a
    orphans_too = "--include-orphans" in a
    as_json = "--json" in a

    runs = sorted(ui_runs(), key=lambda r: r["started_at"], reverse=True)
    pend = pending_workspaces()
    cutoff = time.time() - days * 86400
    known = set()
    removable, kept = [], []
    for i, r in enumerate(runs):
        if r["conductor_run"]:
            known.add(r["conductor_run"])
        why = None
        if r["state"] == "running":
            why = "still running"
        elif r["keep"]:
            why = "marked keep"
        elif i < keep_n:
            why = f"among the newest {keep_n}"
        elif r["started_at"] >= cutoff:
            why = f"newer than {days} days"
        elif r["conductor_run"] and any(c.startswith(f"{WS}/{r['conductor_run']}") for c in pend):
            why = "an approval is pending under its workspace"
        if why:
            kept.append({"ui_id": r["ui_id"], "why": why})
            continue
        paths = ([r["dir"]] if r["dir"] else []) + list(r.get("files", [])) + traces_for(r["conductor_run"])
        removable.append({"ui_id": r["ui_id"], "conductor_run": r["conductor_run"],
                          "started_at": r["started_at"], "paths": [str(p) for p in paths if p.exists()]})

    orphans = []
    for base in (WS, EVID):
        if not base.is_dir():
            continue
        for p in sorted(base.iterdir()):
            m = RUN_ID.match(p.name)
            if m and m.group(0) not in known:
                orphans.append(str(p))

    removed = []
    if apply:
        for r in removable:
            for p in r["paths"]:
                shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)
            removed.append(r["ui_id"])
        if orphans_too:
            for p in orphans:
                shutil.rmtree(p, ignore_errors=True)

    result = {"apply": apply, "days": days, "keep": keep_n,
              "kept": kept, "removable": removable, "orphans": orphans, "removed": removed,
              "orphans_removed": orphans if (apply and orphans_too) else []}
    if as_json:
        print(json.dumps(result, indent=1))
        return 0

    print(f"retention: newest {keep_n} runs and anything from the last {days} days are kept\n")
    print(f"keeping {len(kept)} runs" + (":" if kept else ""))
    for k in kept[:10]:
        print(f"  {k['ui_id']}  ({k['why']})")
    if len(kept) > 10:
        print(f"  … and {len(kept) - 10} more")
    print(f"\n{'removed' if apply else 'would remove'} {len(removable)} runs, with their workspace and evidence:")
    for r in removable:
        print(f"  {r['ui_id']}  conductor {r['conductor_run'] or '—'}")
        for p in r["paths"]:
            print(f"      {p}")
    if orphans:
        print(f"\n{len(orphans)} traces belong to no run on the screen (from before it existed):")
        for p in orphans[:10]:
            print(f"      {p}")
        if len(orphans) > 10:
            print(f"      … and {len(orphans) - 10} more")
        print("  they are removed only with --include-orphans"
              + (" — removed" if (apply and orphans_too) else ""))
    if not apply:
        print("\nnothing was deleted. Add --apply to do it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
