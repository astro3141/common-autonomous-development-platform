"""Adversarial containment probe for the IO bridge response path (review 5501935839).

Loads the production ``bridge.py`` module directly (no IO checkout needed for these methods),
fabricates one live session record around a scripted ``send_round``, and drives the exact
reviewer counterexamples through the real ``send_turn``/``_response_path``/``_cleanup_response_path``
code. Prints one JSON verdict object; exit code 0 only when every case holds.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
import types
from pathlib import Path

BRIDGE_PATH = Path(sys.argv[1])
WORK = Path(sys.argv[2])

spec = importlib.util.spec_from_file_location("adp_io_bridge", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
sys.modules["adp_io_bridge"] = bridge
spec.loader.exec_module(bridge)  # type: ignore[union-attr]


class ProbeRoundError(Exception):
    pass


class ProbeRoundTimeout(ProbeRoundError):
    pass


def make_state() -> tuple[object, list[str], dict[str, object]]:
    state = bridge.BridgeState.__new__(bridge.BridgeState)
    state.sessions = {}
    state.spawn_ops = {}
    state.turn_ops = {}
    state.turn_index = {}
    state.lock = threading.RLock()
    state.io_commit = "probe"
    state.PersistentRoundError = ProbeRoundError
    state.PersistentRoundTimeoutError = ProbeRoundTimeout
    state.persistent_round_failure_reason = lambda exc: type(exc).__name__
    calls: list[str] = []
    hooks: dict[str, object] = {"during": None}

    def send_round(io_session, *, prompt, response_file, timeout_seconds, role_label):
        calls.append(str(response_file))
        response = {"declared_status": "DONE", "summary": "probe", "refs": []}
        Path(response_file).write_text(json.dumps(response), encoding="utf-8")
        during = hooks.get("during")
        if callable(during):
            during(Path(response_file))
        return response

    state.send_round = send_round
    return state, calls, hooks


def make_record(session_ref: str, cwd: Path):
    io_session = types.SimpleNamespace(is_live=True, proc=types.SimpleNamespace(pid=4242))
    return bridge.SessionRecord(
        session_ref=session_ref,
        spawn_op_key=f"op:{session_ref}:spawn",
        material_hash="m",
        role="ACTOR",
        runtime_profile="probe",
        provider="probe-provider",
        model="probe-model",
        cwd=cwd,
        bootstrap_context={},
        io_session=io_session,
        provider_command=["probe"],
        bootstrap_delivered=True,
    )


def run_turn(state, session_ref: str, op_key: str) -> dict[str, object]:
    turn_ref = state.send_turn(
        {
            "op_key": op_key,
            "session_ref": session_ref,
            "instruction": "probe instruction",
            "timeout_seconds": 30,
        }
    )["turn_ref"]
    return state.turn_result(turn_ref)


def snapshot(directory: Path) -> list[str]:
    return sorted(str(p.relative_to(directory)) for p in directory.rglob("*"))


def main() -> int:
    verdict: dict[str, object] = {}
    ok = True

    def check(name: str, passed: bool, detail: str = "") -> None:
        nonlocal ok
        verdict[name] = "PASS" if passed else f"FAIL {detail}"
        ok = ok and passed

    # --- Case 1: top-level symlink escape --------------------------------------------------------
    ws1 = WORK / "case1" / "workspace"
    ext1 = WORK / "case1" / "external"
    ws1.mkdir(parents=True)
    ext1.mkdir(parents=True)
    (ws1 / ".adp-io-runtime").symlink_to(ext1)
    state, calls, _ = make_state()
    state.sessions["s1"] = make_record("s1", ws1)
    result = run_turn(state, "s1", "op:probe:turn:1")
    check(
        "top_level_symlink_blocked",
        result["backend_status"] == "RUNTIME_ERROR"
        and result["response"] is None
        and calls == [],
        f"status={result['backend_status']} calls={calls}",
    )
    check("top_level_external_untouched", snapshot(ext1) == [], f"external={snapshot(ext1)}")
    check(
        "top_level_session_not_wedged",
        state.sessions["s1"].active_turn is None,
        "active_turn survived",
    )

    # --- Case 2: nested session-directory symlink ------------------------------------------------
    ws2 = WORK / "case2" / "workspace"
    ext2 = WORK / "case2" / "external"
    ws2.mkdir(parents=True)
    ext2.mkdir(parents=True)
    (ws2 / ".adp-io-runtime").mkdir()
    session_dir = bridge._sha256({"session": "s2"})
    (ws2 / ".adp-io-runtime" / session_dir).symlink_to(ext2)
    state2, calls2, _ = make_state()
    state2.sessions["s2"] = make_record("s2", ws2)
    result2 = run_turn(state2, "s2", "op:probe:turn:2")
    check(
        "nested_symlink_blocked",
        result2["backend_status"] == "RUNTIME_ERROR" and calls2 == [],
        f"status={result2['backend_status']} calls={calls2}",
    )
    check("nested_external_untouched", snapshot(ext2) == [], f"external={snapshot(ext2)}")

    # --- Case 3: ordinary valid path -------------------------------------------------------------
    ws3 = WORK / "case3" / "workspace"
    ws3.mkdir(parents=True)
    state3, calls3, _ = make_state()
    state3.sessions["s3"] = make_record("s3", ws3)
    result3 = run_turn(state3, "s3", "op:probe:turn:3")
    inside = len(calls3) == 1 and calls3[0].startswith(str(ws3.resolve()))
    check(
        "normal_path_completes",
        result3["backend_status"] == "COMPLETED" and inside,
        f"status={result3['backend_status']} calls={calls3}",
    )
    check(
        "normal_path_cleaned_up",
        snapshot(ws3) == [],
        f"leftover={snapshot(ws3)}",
    )

    # --- Case 4a: pre-existing response-target symlink -------------------------------------------
    ws4 = WORK / "case4" / "workspace"
    ext4 = WORK / "case4" / "external"
    ws4.mkdir(parents=True)
    ext4.mkdir(parents=True)
    target = ext4 / "target.json"
    target.write_text("external evidence must survive", encoding="utf-8")
    session_dir4 = ws4 / ".adp-io-runtime" / bridge._sha256({"session": "s4"})
    session_dir4.mkdir(parents=True)
    # The turn_ref (and so the response filename) is deterministic from session+op.
    turn_ref4 = "io-turn:" + bridge.hashlib.sha256(("s4" + "op:probe:turn:4").encode()).hexdigest()
    planted = session_dir4 / f"{bridge._sha256({'turn': turn_ref4})}.json"
    planted.symlink_to(target)
    state4, calls4, _ = make_state()
    state4.sessions["s4"] = make_record("s4", ws4)
    result4 = run_turn(state4, "s4", "op:probe:turn:4")
    check(
        "planted_target_removed_not_followed",
        result4["backend_status"] == "COMPLETED"
        and target.read_text(encoding="utf-8") == "external evidence must survive"
        and len(calls4) == 1,
        f"status={result4['backend_status']} external={target.read_text(encoding='utf-8')!r}",
    )

    # --- Case 4b: mid-turn swap of the session directory -----------------------------------------
    ws5 = WORK / "case5" / "workspace"
    ext5 = WORK / "case5" / "external"
    ws5.mkdir(parents=True)
    ext5.mkdir(parents=True)
    sentinel = None

    def swap(response_file: Path) -> None:
        nonlocal sentinel
        # A lingering workspace process replaces the session directory with an external symlink
        # after the model wrote its response but before the bridge cleans up.
        parent = response_file.parent
        moved = ext5 / "hijacked"
        parent.rename(moved)
        parent.symlink_to(ext5)
        sentinel = ext5 / "sentinel.json"
        sentinel.write_text("must survive cleanup", encoding="utf-8")

    state5, _calls5, hooks5 = make_state()
    hooks5["during"] = swap
    state5.sessions["s5"] = make_record("s5", ws5)
    result5 = run_turn(state5, "s5", "op:probe:turn:5")
    check(
        "midturn_swap_cleanup_stands_down",
        sentinel is not None
        and sentinel.exists()
        and sentinel.read_text(encoding="utf-8") == "must survive cleanup"
        and result5["backend_status"] == "COMPLETED",
        f"status={result5['backend_status']}",
    )

    print(json.dumps(verdict, sort_keys=True))
    return 0 if ok else 1


sys.exit(main())
