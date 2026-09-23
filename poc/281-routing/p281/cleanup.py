"""Remove old runs — as whole runs, never in pieces.

usage (inside the agent container):
  cleanup.py [--days N] [--keep N] [--apply] [--include-orphans] [--json]

A run leaves three traces, and they only make sense together:

  evidence/ui-runs/<ui id>/     what the screen shows: meta, log, Conductor's event log
  <workspace_root>/<run>…       the directory the model worked in
  evidence/p281/<run>-<label>-<provider>/   the adapter's request and ACP events

Deleting by date, directory by directory, would leave a run listed on the screen with its
artifacts gone. This groups the three by the Conductor run id and removes a group or nothing:
every path of a run is first moved aside, and only a group that moved completely is deleted. A
group that could not be moved in full is put back.

Nothing is deleted unless --apply is given: the default prints what would go.

A run is kept, whatever its age, when
  * the screen still calls it running, or its launcher process is alive (the launcher may not have
    written the final state yet, so the state alone is not enough);
  * Preloop has a pending approval under its workspace;
  * it carries a `keep` file (evidence/ui-runs/<id>/keep), i.e. the operator marked it;
  * it is inside the retention window (--days, default 14) or among the newest --keep (default 20).

Traces with no run to belong to are reported as orphans and are only removed with
--include-orphans — and they are held to the same protections: a pending approval under them, a
recent modification, or any run whose state could not be read at all stops them being removed.

Not knowing is never a licence to delete: if the list of pending approvals is not complete, or a
run's metadata cannot be read, nothing is removed.
"""
import json, os, re, shutil, subprocess, sys, time
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
    """Every workspace Preloop is waiting on. A partial answer stops the whole run."""
    try:
        p = subprocess.run([sys.executable, "/work/p281/approvals.py", "--all"],
                           capture_output=True, text=True, timeout=120)
    except Exception as e:
        raise SystemExit(f"could not run the approvals reader ({e}); nothing was removed")
    if p.returncode != 0:
        raise SystemExit(f"the approvals reader failed (exit {p.returncode}: "
                         f"{(p.stderr or '').strip()[-200:]}); nothing was removed")
    try:
        d = json.loads(p.stdout)
    except ValueError:
        raise SystemExit("the approvals reader did not return JSON; nothing was removed")
    if not isinstance(d, dict) or not isinstance(d.get("items"), list):
        raise SystemExit("the approvals reader did not return a list; nothing was removed")
    if not d.get("complete"):
        raise SystemExit("the list of pending approvals is not complete "
                         f"({d.get('error', 'more pages than expected')}); nothing was removed")
    return [a.get("cwd") or "" for a in d["items"]]


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
    """Every run on the screen, plus how many could not be read at all."""
    out, unreadable = [], 0
    for meta in sorted(RUNS.glob("*/meta.json")):
        try:
            m = json.loads(meta.read_text())
            v = run_workflow.view(m)
        except Exception:
            unreadable += 1
            continue
        out.append({"ui_id": v["ui_id"], "state": v.get("state"),
                    "started_at": started_from_id(v["ui_id"], m.get("started_at", 0)),
                    # the launcher may still be writing the final state, whatever the log says
                    "alive": run_workflow.launcher_alive(m),
                    "conductor_run": v.get("conductor_run"), "dir": meta.parent,
                    "keep": (meta.parent / "keep").exists()})
    for j in sorted(RUNS.glob("*.json")):       # the older flat form: <ui id>.json and <ui id>.log
        out.append({"ui_id": j.stem, "state": "finished",
                    "started_at": started_from_id(j.stem, j.stat().st_mtime), "alive": False,
                    "conductor_run": None, "dir": None, "files": [j, j.with_suffix(".log")],
                    "keep": False})
    return out, unreadable


def traces_for(conductor_run):
    if not conductor_run:
        return []
    t = []
    for base in (WS, EVID):
        if base.is_dir():
            t += [p for p in base.iterdir() if p.name.startswith(conductor_run)]
    return t


def trash_for(path):
    """A holding place on the same mount: /ws and the workspace are different filesystems."""
    p = Path(path)
    base = WS if str(p).startswith(str(WS)) else Path("/work/evidence")
    d = base / ".cleanup-trash"
    d.mkdir(parents=True, exist_ok=True)
    return d


def remove_group(paths):
    """All or nothing: move every path aside first, put them back if one fails, delete only then.

    `os.rename`, never `shutil.move`: move falls back to copy-then-delete across mounts, and a
    failure in the middle of that leaves half a directory behind with no way back. The holding
    place is chosen on the same mount as the path (trash_for), so a rename is all that is needed —
    and if it is not possible, that is a failure to report, not something to work around."""
    moved = []
    try:
        for p in paths:
            dest = trash_for(p) / f"{int(time.time())}-{os.getpid()}-{Path(p).name}"
            os.rename(p, dest)
            moved.append((p, dest))
    except Exception as e:
        for original, dest in reversed(moved):
            try:
                os.rename(dest, original)
            except Exception as back:
                return False, f"{e}; and putting {dest} back failed: {back}"
        return False, str(e)
    for _, dest in moved:
        if dest.is_dir():
            shutil.rmtree(dest, ignore_errors=True)
        else:
            try:
                dest.unlink()
            except OSError:
                pass
    return True, ""


def main():
    a = sys.argv[1:]
    days = int(a[a.index("--days") + 1]) if "--days" in a else 14
    keep_n = int(a[a.index("--keep") + 1]) if "--keep" in a else 20
    apply = "--apply" in a
    orphans_too = "--include-orphans" in a
    as_json = "--json" in a

    all_runs, unreadable = ui_runs()
    runs = sorted(all_runs, key=lambda r: r["started_at"], reverse=True)
    pend = pending_workspaces()
    cutoff = time.time() - days * 86400

    def approval_under(prefix):
        return any(c == prefix or c.startswith(prefix + "-") or c.startswith(prefix + "/") for c in pend)

    known = set()
    removable, kept = [], []
    for i, r in enumerate(runs):
        if r["conductor_run"]:
            known.add(r["conductor_run"])
        why = None
        if r["state"] == "running":
            why = "still running"
        elif r["alive"]:
            why = "its launcher is still alive"
        elif r["keep"]:
            why = "marked keep"
        elif i < keep_n:
            why = f"among the newest {keep_n}"
        elif r["started_at"] >= cutoff:
            why = f"newer than {days} days"
        elif r["conductor_run"] and approval_under(f"{WS}/{r['conductor_run']}"):
            why = "an approval is pending under its workspace"
        if why:
            kept.append({"ui_id": r["ui_id"], "why": why})
            continue
        paths = ([r["dir"]] if r["dir"] else []) + list(r.get("files", [])) + traces_for(r["conductor_run"])
        removable.append({"ui_id": r["ui_id"], "conductor_run": r["conductor_run"],
                          "started_at": r["started_at"], "paths": [str(p) for p in paths if p.exists()]})

    # Orphans belong to runs too: /ws/<run>-execute and evidence/p281/<run>-execute-codex are one
    # run's traces. Grouping them by the run id is what keeps a protected workspace from having
    # its evidence deleted beside it.
    groups = {}
    for base in (WS, EVID):
        if not base.is_dir():
            continue
        for p in sorted(base.iterdir()):
            if p.name == ".cleanup-trash":
                continue
            m = RUN_ID.match(p.name)
            if not m or m.group(0) in known:
                continue
            groups.setdefault(m.group(0), []).append(p)

    orphans, orphans_kept = [], []
    for run_id, paths in sorted(groups.items()):
        why = None
        if unreadable:
            why = f"{unreadable} run(s) on the screen could not be read — their traces cannot be told apart"
        elif any(approval_under(str(p)) for p in paths):
            why = "an approval is pending under it"
        elif any(p.stat().st_mtime >= cutoff for p in paths):
            why = f"changed within {days} days"
        if why:
            orphans_kept.append({"run": run_id, "paths": [str(p) for p in paths], "why": why})
        else:
            orphans.append({"run": run_id, "paths": [str(p) for p in paths]})

    removed, failed, orphans_removed = [], [], []
    if apply:
        for r in removable:
            ok, err = remove_group(r["paths"])
            (removed if ok else failed).append({"ui_id": r["ui_id"], "error": err} if not ok else r["ui_id"])
        if orphans_too:
            for g in orphans:                      # a run's traces go together here as well
                ok, err = remove_group(g["paths"])
                if not ok:
                    failed.append({"path": f"orphan {g['run']}", "error": err})
                else:
                    orphans_removed.append(g["run"])

    result = {"apply": apply, "days": days, "keep": keep_n, "unreadable_runs": unreadable,
              "kept": kept, "removable": removable, "orphans": orphans, "orphans_kept": orphans_kept,
              "removed": removed, "failed": failed,
              "orphans_removed": orphans_removed}
    if as_json:
        print(json.dumps(result, indent=1))
        return 1 if failed else 0

    print(f"retention: newest {keep_n} runs and anything from the last {days} days are kept\n")
    if unreadable:
        print(f"WARNING: {unreadable} run(s) could not be read; orphans are kept because of it\n")
    print(f"keeping {len(kept)} runs" + (":" if kept else ""))
    for k in kept[:10]:
        print(f"  {k['ui_id']}  ({k['why']})")
    if len(kept) > 10:
        print(f"  … and {len(kept) - 10} more")
    print(f"\n{'removed' if apply else 'would remove'} {len(removed) if apply else len(removable)} runs, "
          f"with their workspace and evidence:")
    for r in removable:
        print(f"  {r['ui_id']}  conductor {r['conductor_run'] or '—'}")
        for p in r["paths"]:
            print(f"      {p}")
    if orphans or orphans_kept:
        print(f"\n{len(orphans) + len(orphans_kept)} traces belong to no run on the screen:")
        for g in orphans[:10]:
            print(f"      run {g['run']}: " + ", ".join(g["paths"]))
        for k in orphans_kept[:10]:
            print(f"      run {k['run']}: " + ", ".join(k["paths"]) + f"  (kept: {k['why']})")
        print("  they are removed only with --include-orphans"
              + (" — removed" if (apply and orphans_too and orphans) else ""))
    if failed:
        print(f"\n{len(failed)} could NOT be removed and were left as they were:")
        for f in failed:
            print(f"      {f.get('ui_id') or f.get('path')}: {f['error']}")
    if not apply:
        print("\nnothing was deleted. Add --apply to do it.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
