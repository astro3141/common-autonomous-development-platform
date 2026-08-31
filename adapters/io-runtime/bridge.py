#!/usr/bin/env python3
"""Credential-free JSON bridge to IO's provider and persistent-session seams.

The bridge imports only IO execution primitives:

* ``agent_runner_providers.get_provider/list_providers``
* ``persistent_round_runner.open_persistent_session/send_round/close_persistent_session``
* ``agent_runner_env.build_filtered_env``
* provider-owned readiness probes

It imports no IO issue scheduler, labels, planner/control lane, reviewer lifecycle,
continuation policy, Control authority, or IO state machine.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import socketserver
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


CAPABILITY_GAP = "BACKEND_CAPABILITY_GAP"
MAX_REQUEST_BYTES = 16 * 1024 * 1024


class BridgeRefusal(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _sha256(value: object) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _require_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise BridgeRefusal("INVALID_REQUEST", f"{name} must be a non-empty string")
    return value


def _restricted_json(value: object, path: str = "") -> bool:
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, int) and not isinstance(value, bool):
        return -(2**53 - 1) <= value <= 2**53 - 1
    if isinstance(value, list):
        return all(_restricted_json(item, f"{path}/{index}") for index, item in enumerate(value))
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _restricted_json(item, f"{path}/{key}")
            for key, item in value.items()
        )
    return False


@dataclass
class TurnRecord:
    turn_ref: str
    op_key: str
    instruction_hash: str
    started_at: str
    result: dict[str, object] | None = None


@dataclass
class SessionRecord:
    session_ref: str
    spawn_op_key: str
    material_hash: str
    role: str
    runtime_profile: str
    provider: str
    model: str
    cwd: Path
    bootstrap_context: dict[str, object]
    io_session: Any
    provider_command: list[str]
    closed: bool = False
    bootstrap_delivered: bool = False
    active_turn: str | None = None
    turns: dict[str, TurnRecord] = field(default_factory=dict)


class BridgeState:
    def __init__(self, config_path: Path) -> None:
        self.config_path = config_path
        self.config = self._read_config(config_path)
        self.config_hash = _sha256(self.config)
        self.state_root = Path(_require_string(self.config.get("state_root"), "state_root"))
        self.io_checkout = Path(_require_string(self.config.get("io_checkout"), "io_checkout"))
        self.expected_io_commit = _require_string(
            self.config.get("expected_io_commit"), "expected_io_commit"
        )
        self.io_commit = self._verify_io_checkout()
        sys.path.insert(0, str(self.io_checkout / "src"))
        self._load_io()
        self.sessions: dict[str, SessionRecord] = {}
        self.spawn_ops: dict[str, str] = {}
        self.turn_ops: dict[str, tuple[str, str, str]] = {}
        self.turn_index: dict[str, tuple[str, TurnRecord]] = {}
        self.lock = threading.RLock()

    @staticmethod
    def _read_config(path: Path) -> dict[str, object]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BridgeRefusal(CAPABILITY_GAP, f"cannot read bridge config {path}: {exc}") from exc
        if not isinstance(value, dict):
            raise BridgeRefusal(CAPABILITY_GAP, "bridge config must be a JSON object")
        return value

    def _verify_io_checkout(self) -> str:
        source = self.io_checkout / "src" / "issue_orchestrator"
        if not source.is_dir():
            raise BridgeRefusal(
                CAPABILITY_GAP,
                f"IO checkout {self.io_checkout} has no src/issue_orchestrator",
            )
        try:
            completed = subprocess.run(
                ["git", "-C", str(self.io_checkout), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise BridgeRefusal(
                CAPABILITY_GAP,
                f"cannot establish the IO source commit for {self.io_checkout}: {exc}",
            ) from exc
        actual = completed.stdout.strip()
        if actual != self.expected_io_commit:
            raise BridgeRefusal(
                CAPABILITY_GAP,
                f"configured IO commit {self.expected_io_commit} but checkout is {actual}",
            )
        return actual

    def _load_io(self) -> None:
        try:
            from issue_orchestrator.domain.workspace_trust import (  # type: ignore[import-not-found]
                ApprovedRepositoryTrust,
                LaunchWorkspace,
                TrustAuthoritySource,
            )
            from issue_orchestrator.execution.agent_runner_env import (  # type: ignore[import-not-found]
                build_filtered_env,
            )
            from issue_orchestrator.execution.agent_runner_providers import (  # type: ignore[import-not-found]
                get_provider,
                list_providers,
            )
            from issue_orchestrator.execution.command_runner import (  # type: ignore[import-not-found]
                LocalCommandRunner,
            )
            from issue_orchestrator.execution.persistent_round_runner import (  # type: ignore[import-not-found]
                PersistentRoundError,
                PersistentRoundTimeoutError,
                close_persistent_session,
                open_persistent_session,
                persistent_round_failure_reason,
                send_round,
            )
        except Exception as exc:  # noqa: BLE001 - import failure is a capability result
            raise BridgeRefusal(CAPABILITY_GAP, f"cannot import IO execution seam: {exc}") from exc
        self.ApprovedRepositoryTrust = ApprovedRepositoryTrust
        self.LaunchWorkspace = LaunchWorkspace
        self.TrustAuthoritySource = TrustAuthoritySource
        self.build_filtered_env = build_filtered_env
        self.get_provider = get_provider
        self.list_providers = list_providers
        self.LocalCommandRunner = LocalCommandRunner
        self.PersistentRoundError = PersistentRoundError
        self.PersistentRoundTimeoutError = PersistentRoundTimeoutError
        self.close_persistent_session = close_persistent_session
        self.open_persistent_session = open_persistent_session
        self.persistent_round_failure_reason = persistent_round_failure_reason
        self.send_round = send_round

    def dispatch(self, request: dict[str, object], server: socketserver.BaseServer) -> object:
        operation = request.get("operation")
        if operation == "ping":
            return {"config_hash": self.config_hash, "io_commit": self.io_commit}
        if operation == "capabilities":
            return self.capabilities()
        if operation == "spawn":
            return self.spawn(request)
        if operation == "send_turn":
            return self.send_turn(request)
        if operation == "turn_result":
            return self.turn_result(_require_string(request.get("turn_ref"), "turn_ref"))
        if operation == "session_status":
            return self.session_status(_require_string(request.get("session_ref"), "session_ref"))
        if operation == "cancel":
            self.close(_require_string(request.get("session_ref"), "session_ref"), cancelled=True)
            return {"closed": True}
        if operation == "close":
            self.close(_require_string(request.get("session_ref"), "session_ref"), cancelled=False)
            return {"closed": True}
        if operation == "shutdown":
            self.close_all()
            threading.Thread(target=server.shutdown, daemon=True).start()
            return {"shutdown": True}
        raise BridgeRefusal("INVALID_REQUEST", f"unknown operation {operation!r}")

    def capabilities(self) -> dict[str, object]:
        runner = self.LocalCommandRunner()
        providers: list[dict[str, object]] = []
        for name in self.list_providers():
            provider = self.get_provider(name)
            readiness = provider.check_readiness(runner)
            providers.append(
                {
                    "provider": name,
                    "executable": provider.executable,
                    "version": provider.check_version(),
                    "readiness": readiness.state.value,
                    "readiness_detail": readiness.detail,
                }
            )
        return {
            "io_commit": self.io_commit,
            "providers": providers,
            "model_catalog": None,
            "execution": {
                "persistent_session": True,
                "turn_submission": True,
                "result_observation": True,
                "status_observation": True,
                "cancellation": True,
                "same_bridge_reacquisition": True,
                "bridge_restart_reacquisition": False,
            },
        }

    def spawn(self, request: dict[str, object]) -> dict[str, object]:
        op_key = _require_string(request.get("op_key"), "op_key")
        material_hash = _require_string(request.get("material_hash"), "material_hash")
        role = _require_string(request.get("role"), "role")
        runtime_profile = _require_string(request.get("runtime_profile"), "runtime_profile")
        cwd = Path(_require_string(request.get("cwd"), "cwd")).resolve()
        if not cwd.is_dir():
            raise BridgeRefusal(CAPABILITY_GAP, f"session cwd does not exist: {cwd}")
        raw_binding = request.get("binding")
        raw_bootstrap = request.get("bootstrap_context")
        if not isinstance(raw_binding, dict) or not isinstance(raw_bootstrap, dict):
            raise BridgeRefusal("INVALID_REQUEST", "binding and bootstrap_context must be objects")
        provider_name = _require_string(raw_binding.get("provider"), "binding.provider")
        model = _require_string(raw_binding.get("model"), "binding.model")
        raw_args = raw_binding.get("provider_args", {})
        if not isinstance(raw_args, dict) or any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in raw_args.items()
        ):
            raise BridgeRefusal("INVALID_REQUEST", "provider_args must be a string map")
        provider_args = dict(raw_args)

        with self.lock:
            existing_ref = self.spawn_ops.get(op_key)
            if existing_ref is not None:
                existing = self.sessions[existing_ref]
                if existing.material_hash != material_hash:
                    raise BridgeRefusal("OPERATION_CONFLICT", f"{op_key} has different spawn material")
                if not existing.io_session.is_live:
                    raise BridgeRefusal(
                        CAPABILITY_GAP,
                        f"{op_key} names a non-live IO session; IO cannot reacquire it after process loss",
                    )
                return self._spawn_observation(existing, reacquired=True)

        if provider_name not in self.list_providers():
            raise BridgeRefusal(
                CAPABILITY_GAP,
                f"IO {self.io_commit} does not register provider {provider_name!r}",
            )
        provider = self.get_provider(provider_name)
        if not provider.runs_interactively(**provider_args):
            raise BridgeRefusal(
                CAPABILITY_GAP,
                f"provider {provider_name!r} binding is not an IO persistent-session invocation",
            )
        launch_workspace = self._launch_workspace(provider, provider_args, cwd)
        try:
            command = provider.build_command(
                "",
                model,
                launch_workspace=launch_workspace,
                **provider_args,
            )
        except Exception as exc:  # noqa: BLE001 - provider owns validation vocabulary
            raise BridgeRefusal(CAPABILITY_GAP, f"IO provider command refused: {exc}") from exc

        session_dir = self.state_root / "sessions" / _sha256({"op_key": op_key})
        session_dir.mkdir(parents=True, exist_ok=True)
        try:
            io_session = self.open_persistent_session(
                command=command,
                working_dir=cwd,
                env=self.build_filtered_env(),
                recording_path=session_dir / "terminal-recording.jsonl",
                mirror_path=session_dir / "terminal.txt",
            )
        except Exception as exc:  # noqa: BLE001 - IO launch failure
            raise BridgeRefusal("RUNTIME_ERROR", f"IO persistent-session spawn failed: {exc}") from exc
        session_ref = f"io-process:{io_session.proc.pid}:{uuid.uuid4().hex}"
        record = SessionRecord(
            session_ref=session_ref,
            spawn_op_key=op_key,
            material_hash=material_hash,
            role=role,
            runtime_profile=runtime_profile,
            provider=provider_name,
            model=model,
            cwd=cwd,
            bootstrap_context=dict(raw_bootstrap),
            io_session=io_session,
            provider_command=command,
        )
        with self.lock:
            self.sessions[session_ref] = record
            self.spawn_ops[op_key] = session_ref
        return self._spawn_observation(record, reacquired=False)

    def _launch_workspace(self, provider: Any, provider_args: dict[str, str], cwd: Path) -> Any:
        if not provider.requires_workspace_trust(**provider_args):
            return self.LaunchWorkspace(working_directory=cwd)
        raw = self.config.get("workspace_trust")
        if not isinstance(raw, dict):
            raise BridgeRefusal(
                CAPABILITY_GAP,
                "IO Codex interactive execution requires an explicit workspace_trust authority",
            )
        approved_root = Path(
            _require_string(raw.get("approved_repository_root"), "approved_repository_root")
        )
        authority_source = Path(_require_string(raw.get("authority_source"), "authority_source"))
        authority_fingerprint = _require_string(
            raw.get("authority_fingerprint"), "authority_fingerprint"
        )
        source = self.TrustAuthoritySource(
            path=authority_source,
            fingerprint=authority_fingerprint,
        )
        approval = self.ApprovedRepositoryTrust(repository_root=approved_root, source=source)
        return self.LaunchWorkspace(working_directory=cwd, approved_trust=approval)

    def _spawn_observation(self, record: SessionRecord, *, reacquired: bool) -> dict[str, object]:
        return {
            "session_ref": record.session_ref,
            "pid": record.io_session.proc.pid,
            "provider": record.provider,
            "requested_model": record.model,
            "io_commit": self.io_commit,
            "reacquired": reacquired,
        }

    def send_turn(self, request: dict[str, object]) -> dict[str, object]:
        op_key = _require_string(request.get("op_key"), "op_key")
        session_ref = _require_string(request.get("session_ref"), "session_ref")
        instruction = _require_string(request.get("instruction"), "instruction")
        timeout = request.get("timeout_seconds")
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
            raise BridgeRefusal("INVALID_REQUEST", "timeout_seconds must be a positive integer")
        instruction_hash = _sha256({"instruction": instruction})

        with self.lock:
            prior = self.turn_ops.get(op_key)
            if prior is not None:
                prior_session, prior_hash, prior_turn = prior
                if prior_session != session_ref or prior_hash != instruction_hash:
                    raise BridgeRefusal("OPERATION_CONFLICT", f"{op_key} has different turn material")
                return {"turn_ref": prior_turn}
            record = self.sessions.get(session_ref)
            if record is None:
                raise BridgeRefusal(CAPABILITY_GAP, f"unknown IO session {session_ref}")
            if record.closed or not record.io_session.is_live:
                raise BridgeRefusal(CAPABILITY_GAP, f"IO session {session_ref} is not live")
            if record.active_turn is not None:
                raise BridgeRefusal("OPERATION_CONFLICT", f"IO session already has active turn {record.active_turn}")
            turn_ref = f"io-turn:{hashlib.sha256((session_ref + op_key).encode()).hexdigest()}"
            turn = TurnRecord(
                turn_ref=turn_ref,
                op_key=op_key,
                instruction_hash=instruction_hash,
                started_at=_now(),
            )
            record.turns[turn_ref] = turn
            record.active_turn = turn_ref
            self.turn_ops[op_key] = (session_ref, instruction_hash, turn_ref)
            self.turn_index[turn_ref] = (session_ref, turn)

        response_path = self._response_path(record, turn_ref)
        prompt = self._turn_prompt(record, instruction, response_path)
        try:
            response = self.send_round(
                record.io_session,
                prompt=prompt,
                response_file=response_path,
                timeout_seconds=float(timeout),
                role_label=record.role.lower(),
            )
            if not _restricted_json(response):
                raise BridgeRefusal(
                    "INVALID_RESPONSE",
                    "IO turn response is outside ADP's restricted JSON data model",
                )
            result = self._terminal_result(
                record,
                turn,
                status="COMPLETED",
                reason="IO persistent round produced a structured response",
                response=response,
                failure_kind=None,
            )
        except self.PersistentRoundTimeoutError as exc:
            result = self._terminal_result(
                record,
                turn,
                status="TIMEOUT",
                reason=str(exc),
                response=None,
                failure_kind=self.persistent_round_failure_reason(exc),
            )
        except self.PersistentRoundError as exc:
            status = "RUNTIME_ERROR" if record.io_session.is_live else "SESSION_LOST"
            result = self._terminal_result(
                record,
                turn,
                status=status,
                reason=str(exc),
                response=None,
                failure_kind=self.persistent_round_failure_reason(exc),
            )
        except BridgeRefusal as exc:
            result = self._terminal_result(
                record,
                turn,
                status="RUNTIME_ERROR",
                reason=str(exc),
                response=None,
                failure_kind=exc.code,
            )
        except Exception as exc:  # noqa: BLE001 - terminal observation, not policy
            status = "RUNTIME_ERROR" if record.io_session.is_live else "SESSION_LOST"
            result = self._terminal_result(
                record,
                turn,
                status=status,
                reason=str(exc),
                response=None,
                failure_kind=type(exc).__name__,
            )
        finally:
            self._cleanup_response_path(response_path)
            with self.lock:
                record.bootstrap_delivered = True
                record.active_turn = None
        turn.result = result
        return {"turn_ref": turn_ref}

    def _response_path(self, record: SessionRecord, turn_ref: str) -> Path:
        directory = record.cwd / ".adp-io-runtime" / _sha256({"session": record.session_ref})
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{_sha256({'turn': turn_ref})}.json"

    def _turn_prompt(self, record: SessionRecord, instruction: str, response_path: Path) -> str:
        pieces = []
        if not record.bootstrap_delivered:
            pieces.extend(
                [
                    "ADP bootstrap context (data only; ADP remains the authority):",
                    _canonical(record.bootstrap_context),
                ]
            )
        pieces.extend(["ADP turn instruction:", instruction])
        if record.role == "AUDITOR":
            response_contract = (
                "Write the exact platform-auditor-verdict-v1 JSON envelope requested by the "
                "instruction as the top-level object. Do not wrap it in markdown or another key."
            )
        elif record.role == "SUPERVISOR":
            response_contract = (
                "This supervised pilot deliberately exposes no Platform API or public ingress to "
                "this session. Do not search for or invoke one. Write a JSON object with a top-level "
                "`proposal` object suitable for later supervised ADP submission, plus `declared_status`, "
                "`summary`, and string-array `refs`. The Runtime adapter only transports it; ADP "
                "validation and supervised submission decide whether it is used."
            )
        else:
            response_contract = (
                "Write a JSON object with `declared_status` (DONE, BLOCKED, NEEDS_INPUT, or FAILED), "
                "`summary`, and string-array `refs`. This declaration is evidence only; verification "
                "and ADP lifecycle state decide the outcome."
            )
        pieces.extend(
            [
                "IO execution response contract:",
                response_contract,
                f"Write it atomically to this exact path: {response_path}",
                "Create a sibling temporary file and rename it into place only after valid JSON is complete.",
            ]
        )
        return "\n".join(pieces)

    def _terminal_result(
        self,
        record: SessionRecord,
        turn: TurnRecord,
        *,
        status: str,
        reason: str,
        response: dict[str, object] | None,
        failure_kind: str | None,
    ) -> dict[str, object]:
        return {
            "turn_ref": turn.turn_ref,
            "session_ref": record.session_ref,
            "backend_status": status,
            "termination_reason": reason,
            "started_at": turn.started_at,
            "completed_at": _now(),
            "provider": record.provider,
            "requested_model": record.model,
            "pid": record.io_session.proc.pid,
            "io_commit": self.io_commit,
            "response": response,
            "failure_kind": failure_kind,
        }

    @staticmethod
    def _cleanup_response_path(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
            path.parent.rmdir()
            path.parent.parent.rmdir()
        except OSError:
            pass

    def turn_result(self, turn_ref: str) -> dict[str, object]:
        with self.lock:
            indexed = self.turn_index.get(turn_ref)
            if indexed is None:
                raise BridgeRefusal(CAPABILITY_GAP, f"unknown IO turn {turn_ref}")
            _session_ref, turn = indexed
            if turn.result is None:
                raise BridgeRefusal("TURN_NOT_TERMINAL", f"IO turn {turn_ref} is still running")
            return turn.result

    def session_status(self, session_ref: str) -> dict[str, object]:
        with self.lock:
            record = self.sessions.get(session_ref)
            if record is None:
                return {
                    "session_ref": session_ref,
                    "state": "SESSION_LOST",
                    "pid": None,
                    "return_code": None,
                    "provider": None,
                    "requested_model": None,
                    "io_commit": self.io_commit,
                }
            return_code = record.io_session.proc.poll()
            state = "CLOSED" if record.closed else ("RUNNING" if return_code is None else "EXITED")
            return {
                "session_ref": session_ref,
                "state": state,
                "pid": record.io_session.proc.pid,
                "return_code": return_code,
                "provider": record.provider,
                "requested_model": record.model,
                "io_commit": self.io_commit,
            }

    def close(self, session_ref: str, *, cancelled: bool) -> None:
        with self.lock:
            record = self.sessions.get(session_ref)
        if record is None:
            raise BridgeRefusal(CAPABILITY_GAP, f"unknown IO session {session_ref}")
        if record.closed:
            return
        self.close_persistent_session(record.io_session)
        record.closed = True
        active = record.active_turn
        if active is not None:
            turn = record.turns[active]
            turn.result = self._terminal_result(
                record,
                turn,
                status="CANCELLED" if cancelled else "SESSION_LOST",
                reason="IO persistent session was cancelled" if cancelled else "IO persistent session was closed",
                response=None,
                failure_kind="cancelled" if cancelled else "closed",
            )

    def close_all(self) -> None:
        with self.lock:
            refs = list(self.sessions)
        for session_ref in refs:
            try:
                self.close(session_ref, cancelled=False)
            except Exception:
                pass


class BridgeHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            envelope = {"ok": False, "error_code": "REQUEST_TOO_LARGE", "message": "request too large"}
        else:
            try:
                request = json.loads(raw.decode("utf-8"))
                if not isinstance(request, dict):
                    raise BridgeRefusal("INVALID_REQUEST", "request must be an object")
                result = self.server.state.dispatch(request, self.server)  # type: ignore[attr-defined]
                envelope = {"ok": True, "result": result}
            except BridgeRefusal as exc:
                envelope = {"ok": False, "error_code": exc.code, "message": str(exc)}
            except Exception as exc:  # noqa: BLE001 - RPC boundary
                envelope = {
                    "ok": False,
                    "error_code": "BRIDGE_ERROR",
                    "message": f"{type(exc).__name__}: {exc}",
                }
        self.wfile.write((_canonical(envelope) + "\n").encode("utf-8"))


class ThreadingUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, socket_path: str, state: BridgeState) -> None:
        self.state = state
        super().__init__(socket_path, BridgeHandler)


def _rpc(socket_path: Path, request: dict[str, object], timeout: float = 10.0) -> dict[str, object]:
    payload = (_canonical(request) + "\n").encode("utf-8")
    chunks: list[bytes] = []
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(str(socket_path))
        client.sendall(payload)
        client.shutdown(socket.SHUT_WR)
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    response = json.loads(b"".join(chunks).decode("utf-8"))
    if not isinstance(response, dict):
        raise RuntimeError("bridge response was not an object")
    return response


def _serve(socket_path: Path, config_path: Path) -> int:
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    if socket_path.exists():
        socket_path.unlink()
    state = BridgeState(config_path)
    server = ThreadingUnixServer(str(socket_path), state)
    os.chmod(socket_path, 0o600)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        state.close_all()
        server.server_close()
        socket_path.unlink(missing_ok=True)
    return 0


def _ensure_server(socket_path: Path, config_path: Path) -> int:
    config = BridgeState._read_config(config_path)
    expected_hash = _sha256(config)
    if socket_path.exists():
        try:
            response = _rpc(socket_path, {"operation": "ping"}, timeout=2.0)
            result = response.get("result")
            if response.get("ok") is True and isinstance(result, dict):
                if result.get("config_hash") != expected_hash:
                    raise BridgeRefusal(
                        CAPABILITY_GAP,
                        "a live IO bridge owns this socket with different configuration",
                    )
                return 0
        except BridgeRefusal:
            raise
        except Exception:
            socket_path.unlink(missing_ok=True)

    log_path = socket_path.parent / "bridge.log"
    with log_path.open("ab", buffering=0) as log:
        subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "serve",
                "--socket",
                str(socket_path),
                "--config",
                str(config_path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
            close_fds=True,
        )
    deadline = time.monotonic() + 12
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            response = _rpc(socket_path, {"operation": "ping"}, timeout=1.0)
            result = response.get("result")
            if response.get("ok") is True and isinstance(result, dict):
                if result.get("config_hash") != expected_hash:
                    raise BridgeRefusal(CAPABILITY_GAP, "started bridge has a different config hash")
                return 0
        except Exception as exc:  # server may still be importing IO
            last_error = exc
            time.sleep(0.1)
    raise BridgeRefusal(CAPABILITY_GAP, f"IO bridge did not become ready: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("serve", "ensure-server"):
        child = sub.add_parser(command)
        child.add_argument("--socket", required=True, type=Path)
        child.add_argument("--config", required=True, type=Path)
    call = sub.add_parser("call")
    call.add_argument("--socket", required=True, type=Path)
    args = parser.parse_args()

    try:
        if args.command == "serve":
            return _serve(args.socket, args.config)
        if args.command == "ensure-server":
            return _ensure_server(args.socket, args.config)
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            raise BridgeRefusal("INVALID_REQUEST", "request must be an object")
        response = _rpc(args.socket, request, timeout=24 * 60 * 60)
        sys.stdout.write(_canonical(response))
        return 0
    except BridgeRefusal as exc:
        sys.stderr.write(f"{exc.code}: {exc}\n")
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        sys.stderr.write(f"BRIDGE_ERROR: {type(exc).__name__}: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
