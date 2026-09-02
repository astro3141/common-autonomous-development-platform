"""Adversarial response-transport probe for the IO bridge (reviews 5501935839 + 5502523861).

Loads the production ``bridge.py`` and drives the real ``send_turn`` /
``_TurnResponseChannel`` code with a scripted ``send_round`` that emulates the pinned IO
runner's ``response_reader`` branch (poll the reader, never touch ``response_file``). The
"model" delivers over the actual per-turn unix socket, so correlation, duplicate/stale/
malformed rejection, and the pre-write TOCTOU chronology are exercised against the exact
production transport. Prints one JSON verdict; exit 0 only when every case holds.
"""

from __future__ import annotations

import importlib.util
import json
import socket as socketlib
import sys
import threading
import time
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


def deliver(socket_path: str, raw: bytes) -> str:
    """The model side: connect to the turn socket, send bytes, return the reply."""
    client = socketlib.socket(socketlib.AF_UNIX, socketlib.SOCK_STREAM)
    client.settimeout(5.0)
    try:
        client.connect(socket_path)
        client.sendall(raw)
        client.shutdown(socketlib.SHUT_WR)
        reply = client.recv(4096)
        return reply.decode("utf-8", errors="replace")
    finally:
        client.close()


def socket_path_from_prompt(prompt: str) -> str:
    for line in prompt.splitlines():
        if "nc -U " in line:
            return line.split("nc -U ", 1)[1].split(" <", 1)[0].strip()
    raise AssertionError("prompt carries no response-socket instruction")


def make_state(state_root: Path) -> tuple[object, list[dict[str, object]], dict[str, object]]:
    state = bridge.BridgeState.__new__(bridge.BridgeState)
    state.state_root = state_root
    state.sessions = {}
    state.spawn_ops = {}
    state.turn_ops = {}
    state.turn_index = {}
    state.lock = threading.RLock()
    state.io_commit = "probe"
    state.PersistentRoundError = ProbeRoundError
    state.PersistentRoundTimeoutError = ProbeRoundTimeout
    state.persistent_round_failure_reason = lambda exc: type(exc).__name__
    calls: list[dict[str, object]] = []
    hooks: dict[str, object] = {"model": None}

    def send_round(io_session, *, prompt, response_file, timeout_seconds, role_label, response_reader=None):
        # Emulates the pinned runner's mailbox branch exactly: with a reader supplied, the
        # response file is never unlinked/read/written (log-string + stat only in the real one).
        calls.append({"response_file": str(response_file), "reader": response_reader is not None})
        if response_reader is None:
            raise AssertionError("bridge must run send_round in the response_reader branch")
        model = hooks.get("model")
        if callable(model):
            model(prompt)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            got = response_reader()
            if got is not None:
                return got
            time.sleep(0.01)
        raise ProbeRoundTimeout("no mailbox delivery before the probe deadline")

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


RESPONSE = {"declared_status": "DONE", "summary": "probe", "refs": []}


def main() -> int:
    verdict: dict[str, object] = {}
    ok = True

    def check(name: str, passed: bool, detail: str = "") -> None:
        nonlocal ok
        verdict[name] = "PASS" if passed else f"FAIL {detail}"
        ok = ok and passed

    # --- Case 1: fileless normal turn — zero workspace response-file effect ----------------------
    ws1 = WORK / "case1" / "workspace"
    sr1 = WORK / "case1" / "state"
    ws1.mkdir(parents=True)
    sr1.mkdir(parents=True)
    state1, calls1, hooks1 = make_state(sr1)
    state1.sessions["s1"] = make_record("s1", ws1)
    hooks1["model"] = lambda prompt: deliver(
        socket_path_from_prompt(prompt), json.dumps(RESPONSE).encode()
    )
    result1 = run_turn(state1, "s1", "op:probe:turn:1")
    placeholder1 = Path(str(calls1[0]["response_file"]))
    check(
        "fileless_normal_completes",
        result1["backend_status"] == "COMPLETED" and result1["response"] == RESPONSE,
        f"status={result1['backend_status']}",
    )
    check(
        "no_workspace_response_file",
        snapshot(ws1) == [] and not placeholder1.exists(),
        f"workspace={snapshot(ws1)} placeholder={placeholder1}",
    )
    # The channel lives in a fresh unpredictable host temp directory — outside every
    # model-prompted workspace and outside state_root — so nothing can be pre-planted at it.
    check(
        "channel_outside_workspace_and_state",
        not str(placeholder1).startswith(str(ws1)) and not str(placeholder1).startswith(str(sr1)),
        f"placeholder={placeholder1}",
    )

    # --- Case 2: the reviewer's pre-write TOCTOU chronology is unreachable -----------------------
    # The old attack surface is planted AND swapped mid-turn, exactly between channel preparation
    # and the response delivery — and none of it matters, because the actual response I/O is a
    # connected-descriptor read, not a pathname write.
    ws2 = WORK / "case2" / "workspace"
    ext2 = WORK / "case2" / "external"
    sr2 = WORK / "case2" / "state"
    ws2.mkdir(parents=True)
    ext2.mkdir(parents=True)
    sr2.mkdir(parents=True)
    (ws2 / ".adp-io-runtime").symlink_to(ext2)  # legacy top-level plant
    sentinel = ext2 / "sentinel.txt"
    sentinel.write_text("must stay byte-identical", encoding="utf-8")
    state2, calls2, hooks2 = make_state(sr2)
    state2.sessions["s2"] = make_record("s2", ws2)

    def model2(prompt: str) -> None:
        path = socket_path_from_prompt(prompt)
        # 2. before the actual response delivery: swap the channel directory aside and point the
        #    prompted pathname at the external dir, planting a decoy under the socket's name.
        #    (The rename target stays a short sibling so the probe's own client connect stays
        #    under the AF_UNIX path limit — an artifact of the probe, not of the bridge.)
        socket_name = Path(path).name
        channel_dir = Path(path).parent
        hijacked = channel_dir.parent / f"hj-{channel_dir.name[-8:]}"
        channel_dir.rename(hijacked)
        channel_dir.symlink_to(ext2)
        (ext2 / socket_name).write_text("decoy that must survive", encoding="utf-8")
        # 3. the delivery still reaches the bridge: the listener owns the bound descriptor
        #    inside the renamed directory; the pathname no longer matters for the bridge.
        reply = deliver(str(hijacked / socket_name), json.dumps(RESPONSE).encode())
        assert "accepted" in reply, reply

    hooks2["model"] = model2
    result2 = run_turn(state2, "s2", "op:probe:turn:2")
    check(
        "prewrite_swap_turn_completes",
        result2["backend_status"] == "COMPLETED" and result2["response"] == RESPONSE,
        f"status={result2['backend_status']}",
    )
    check(
        "prewrite_swap_external_intact",
        sentinel.read_text(encoding="utf-8") == "must stay byte-identical"
        and (ext2 / "r.sock").read_text(encoding="utf-8") == "decoy that must survive",
        "external mutated",
    )
    check(
        "prewrite_swap_no_response_json_anywhere",
        not any(name.endswith(".json") for name in snapshot(ws2))
        and not any(name.endswith(".json") for name in snapshot(ext2)),
        f"ws={snapshot(ws2)} ext={snapshot(ext2)}",
    )

    # --- Case 3: duplicate delivery never becomes a second result --------------------------------
    ws3 = WORK / "case3" / "workspace"
    sr3 = WORK / "case3" / "state"
    ws3.mkdir(parents=True)
    sr3.mkdir(parents=True)
    state3, _calls3, hooks3 = make_state(sr3)
    state3.sessions["s3"] = make_record("s3", ws3)
    replies: list[str] = []

    def model3(prompt: str) -> None:
        path = socket_path_from_prompt(prompt)
        replies.append(deliver(path, json.dumps(RESPONSE).encode()))
        replies.append(deliver(path, json.dumps({"declared_status": "DONE", "summary": "imposter", "refs": []}).encode()))

    hooks3["model"] = model3
    result3 = run_turn(state3, "s3", "op:probe:turn:3")
    check(
        "duplicate_delivery_rejected",
        result3["backend_status"] == "COMPLETED"
        and result3["response"] == RESPONSE
        and "accepted" in replies[0]
        and "already delivered" in replies[1],
        f"replies={replies} response={result3['response']}",
    )

    # --- Case 4: malformed delivery never becomes COMPLETED --------------------------------------
    ws4 = WORK / "case4" / "workspace"
    sr4 = WORK / "case4" / "state"
    ws4.mkdir(parents=True)
    sr4.mkdir(parents=True)
    state4, _calls4, hooks4 = make_state(sr4)
    state4.sessions["s4"] = make_record("s4", ws4)
    malformed_replies: list[str] = []
    hooks4["model"] = lambda prompt: malformed_replies.append(
        deliver(socket_path_from_prompt(prompt), b"this is not json")
    )
    result4 = run_turn(state4, "s4", "op:probe:turn:4")
    check(
        "malformed_delivery_times_out",
        result4["backend_status"] == "TIMEOUT" and "rejected" in (malformed_replies[0] if malformed_replies else ""),
        f"status={result4['backend_status']} replies={malformed_replies}",
    )

    # --- Case 5: stale delivery cannot satisfy a later turn --------------------------------------
    ws5 = WORK / "case5" / "workspace"
    sr5 = WORK / "case5" / "state"
    ws5.mkdir(parents=True)
    sr5.mkdir(parents=True)
    state5, _calls5, hooks5 = make_state(sr5)
    state5.sessions["s5"] = make_record("s5", ws5)
    first_socket: list[str] = []
    hooks5["model"] = lambda prompt: first_socket.append(socket_path_from_prompt(prompt))
    result5a = run_turn(state5, "s5", "op:probe:turn:5a")  # no delivery → TIMEOUT, channel closed
    stale_outcome: str
    try:
        stale_outcome = deliver(first_socket[0], json.dumps({"declared_status": "DONE", "summary": "stale", "refs": []}).encode())
    except OSError as exc:
        stale_outcome = f"connect refused: {exc}"
    second_socket: list[str] = []

    def model5b(prompt: str) -> None:
        second_socket.append(socket_path_from_prompt(prompt))
        deliver(second_socket[0], json.dumps(RESPONSE).encode())

    hooks5["model"] = model5b
    result5b = run_turn(state5, "s5", "op:probe:turn:5b")
    check(
        "stale_delivery_cannot_cross_turns",
        result5a["backend_status"] == "TIMEOUT"
        and ("refused" in stale_outcome or "rejected" in stale_outcome)
        and result5b["backend_status"] == "COMPLETED"
        and result5b["response"] == RESPONSE
        and second_socket[0] != first_socket[0],
        f"stale={stale_outcome!r} 5a={result5a['backend_status']} 5b={result5b['backend_status']}",
    )
    check(
        "timeout_releases_active_turn",
        state5.sessions["s5"].active_turn is None,
        "active_turn survived",
    )

    print(json.dumps(verdict, sort_keys=True))
    return 0 if ok else 1


sys.exit(main())
