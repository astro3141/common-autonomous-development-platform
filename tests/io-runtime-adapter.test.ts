import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
} from "../adapters/interfaces/handles.ts";
import {
  BackendCapabilityGap,
  IO_AUDITOR_VERDICT_PROTOCOL,
  IO_SUPERVISOR_PROPOSAL_PROTOCOL,
  IORuntimeAdapter,
  IORuntimeOperationConflict,
  ioPilotManifests,
  type IOBridgeCapabilities,
  type IORuntimeAdapterConfig,
  type IORuntimeTransport,
  type IOSessionObservation,
  type IOSpawnObservation,
  type IOSpawnRequest,
  type IOTerminalTurnObservation,
  type IOTurnObservation,
  type IOTurnRequest,
} from "../adapters/io-runtime/index.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import { validateManifestSet } from "../core/capability/manifest-set.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IO_SHA = "ba3cde2a06896ce8e3d38da076be1fbea3311fe3";
const GRANT = { grant_id: "g" } as unknown as CapabilityGrant;

const capabilities = (readiness: IOBridgeCapabilities["providers"][number]["readiness"] = "ready"): IOBridgeCapabilities => ({
  io_commit: IO_SHA,
  providers: [
    {
      provider: "claude-code",
      executable: "claude",
      version: "2.1.221",
      readiness,
      readiness_detail: readiness,
    },
    {
      provider: "codex",
      executable: "codex",
      version: "codex-cli 0.151.0",
      readiness: "ready",
      readiness_detail: "ready",
    },
  ],
  model_catalog: null,
  execution: {
    persistent_session: true,
    turn_submission: true,
    result_observation: true,
    status_observation: true,
    cancellation: true,
    same_bridge_reacquisition: true,
    bridge_restart_reacquisition: false,
  },
});

const config = (overrides: Partial<IORuntimeAdapterConfig> = {}): IORuntimeAdapterConfig => ({
  adapter_instance_id: "io-pilot",
  io_checkout: "/io",
  expected_io_commit: IO_SHA,
  python_executable: "/io/.venv/bin/python",
  state_root: "/host/io-state",
  default_cwd: "/project",
  turn_timeout_seconds: 900,
  profiles: {
    supervisor: { provider: "claude-code", model: "opus", provider_args: { effort: "high" } },
    actor: { provider: "codex", model: "gpt-5.6-codex" },
    auditor: { provider: "claude-code", model: "opus" },
  },
  ...overrides,
});

class FakeIOTransport implements IORuntimeTransport {
  readonly spawns: IOSpawnRequest[] = [];
  readonly turns: IOTurnRequest[] = [];
  readonly cancelled: string[] = [];
  readonly closed: string[] = [];
  capabilitiesValue = capabilities();
  response: CanonicalObject = {
    declared_status: "DONE",
    summary: "done",
    refs: [],
  };

  capabilities(): IOBridgeCapabilities {
    return this.capabilitiesValue;
  }

  spawn(request: IOSpawnRequest): IOSpawnObservation {
    this.spawns.push(request);
    return {
      session_ref: `io-process:${this.spawns.length}`,
      pid: 1000 + this.spawns.length,
      provider: request.binding.provider,
      requested_model: request.binding.model,
      io_commit: IO_SHA,
      reacquired: false,
    };
  }

  sendTurn(request: IOTurnRequest): IOTurnObservation {
    this.turns.push(request);
    return { turn_ref: `io-turn:${this.turns.length}` };
  }

  turnResult(turn_ref: string): IOTerminalTurnObservation {
    const turn = this.turns[Number(turn_ref.split(":")[1]) - 1];
    assert.notEqual(turn, undefined);
    const spawn = this.spawns.find((entry, index) => `io-process:${index + 1}` === turn!.session_ref);
    assert.notEqual(spawn, undefined);
    return {
      turn_ref,
      session_ref: turn!.session_ref,
      backend_status: "COMPLETED",
      termination_reason: "response collected",
      started_at: "2026-09-01T00:00:00.000Z",
      completed_at: "2026-09-01T00:00:01.000Z",
      provider: spawn!.binding.provider,
      requested_model: spawn!.binding.model,
      pid: 1001,
      io_commit: IO_SHA,
      response: this.response,
      failure_kind: null,
    };
  }

  sessionStatus(session_ref: string): IOSessionObservation {
    return {
      session_ref,
      state: "RUNNING",
      pid: 1001,
      return_code: null,
      provider: "claude-code",
      requested_model: "opus",
      io_commit: IO_SHA,
    };
  }

  cancel(session_ref: string): void {
    this.cancelled.push(session_ref);
  }

  close(session_ref: string): void {
    this.closed.push(session_ref);
  }
}

function spawn(
  adapter: IORuntimeAdapter,
  role: string,
  profile: string,
  op = `op:${role.toLowerCase()}:spawn`,
): RuntimeSessionHandle {
  return adapter.spawn_session(
    { op_key: op },
    role,
    profile as unknown as RuntimeProfile,
    role === "SUPERVISOR" ? "" : "/project/worktree",
    { role } as CanonicalObject,
    GRANT,
  ).session_handle;
}

test("IO-RA-1: advertises only the exact configured matrix backed by IO's live registry", () => {
  const transport = new FakeIOTransport();
  const adapter = new IORuntimeAdapter(config(), transport);
  const advertised = adapter.capabilityAdvertisement();
  assert.equal(advertised.io_commit, IO_SHA);
  assert.equal(advertised.model_catalog, null);
  assert.deepEqual(advertised.profiles, config().profiles);
  assert.equal(advertised.execution.bridge_restart_reacquisition, false);
  assert.deepEqual(advertised.providers.map((entry) => entry.provider), ["claude-code", "codex"]);
});

test("IO-RA-2: Gemini and Grok fail closed even when a host CLI happens to be installed", () => {
  for (const provider of ["gemini-cli", "grok"]) {
    const adapter = new IORuntimeAdapter(
      config({ profiles: { unsupported: { provider, model: "latest" } } }),
      new FakeIOTransport(),
    );
    assert.throws(
      () => adapter.capabilityAdvertisement(),
      (error: unknown) =>
        error instanceof BackendCapabilityGap &&
        error.message.includes("BACKEND_CAPABILITY_GAP") &&
        error.message.includes(provider),
    );
  }
});

test("IO-RA-3: same-op spawn reacquires locally and contradictory material is refused", () => {
  const transport = new FakeIOTransport();
  const adapter = new IORuntimeAdapter(config(), transport);
  const first = spawn(adapter, "ACTOR", "actor");
  const again = spawn(adapter, "ACTOR", "actor");
  assert.deepEqual(again, first);
  assert.equal(transport.spawns.length, 1);
  assert.throws(
    () =>
      adapter.spawn_session(
        { op_key: "op:actor:spawn" },
        "ACTOR",
        "actor" as unknown as RuntimeProfile,
        "/different",
        {} as CanonicalObject,
        GRANT,
      ),
    IORuntimeOperationConflict,
  );
});

test("IO-RA-4: provider/process are observed; requested model is retained but actual stays UNKNOWN", () => {
  const transport = new FakeIOTransport();
  transport.response = {
    declared_status: "DONE",
    summary: "implemented",
    refs: ["commit:abc"],
  };
  const adapter = new IORuntimeAdapter(config(), transport);
  const session = spawn(adapter, "ACTOR", "actor");
  const turn = adapter.send_turn({ op_key: "op:actor:turn:1" }, session, "implement");
  const result = adapter.get_turn_result(turn);
  assert.equal(result.backend_status, "COMPLETED");
  assert.equal(result.provenance.identity_authority, "BACKEND");
  assert.equal(result.provenance.result_channel, "STRUCTURED_PROTOCOL");
  assert.deepEqual(result.execution_observation?.actual.provider, {
    availability: "REPORTED",
    value: "codex",
  });
  assert.deepEqual(result.execution_observation?.actual.model, { availability: "UNKNOWN" });
  assert.deepEqual(result.execution_observation?.actual.binding_ref, {
    availability: "UNKNOWN",
  });
  assert.equal(result.backend_native_refs?.["requested_model"], "gpt-5.6-codex");
  assert.deepEqual(result.execution_observation?.usage, { kind: "UNKNOWN" });
  assert.deepEqual(result.execution_observation?.cost, { kind: "UNKNOWN" });
  assert.equal(result.model_declared_outcome?.summary, "implemented");
});

test("IO-RA-5: Supervisor proposal and Auditor verdict are transport only, with distinct protocols", () => {
  const transport = new FakeIOTransport();
  const adapter = new IORuntimeAdapter(config(), transport);

  transport.response = { proposal: { variant: "NO_ACTION", rationale: "bounded" } };
  const supervisor = spawn(adapter, "SUPERVISOR", "supervisor");
  const supervisorTurn = adapter.send_turn({ op_key: "op:s:turn:1" }, supervisor, "propose");
  assert.equal(
    adapter.get_turn_result(supervisorTurn).structured_output?.protocol,
    IO_SUPERVISOR_PROPOSAL_PROTOCOL,
  );

  transport.response = { verdict: "AUDIT_PASS", findings: [], reviewed: {} };
  const auditor = spawn(adapter, "AUDITOR", "auditor");
  const auditorTurn = adapter.send_turn({ op_key: "op:audit:turn:1" }, auditor, "audit");
  assert.equal(
    adapter.get_turn_result(auditorTurn).structured_output?.protocol,
    IO_AUDITOR_VERDICT_PROTOCOL,
  );
});

test("IO-RA-6: cancellation/close delegate to IO, while workflow control is an explicit gap", () => {
  const transport = new FakeIOTransport();
  const adapter = new IORuntimeAdapter(config(), transport);
  const session = spawn(adapter, "ACTOR", "actor");
  adapter.cancel_session(session);
  adapter.close_session(session);
  assert.deepEqual(transport.cancelled, ["io-process:1"]);
  assert.deepEqual(transport.closed, ["io-process:1"]);
  assert.throws(
    () => adapter.acquire_workflow_controller(),
    (error: unknown) => error instanceof BackendCapabilityGap,
  );
});

test("IO-RA-7: preflight blocks an installed-but-unauthenticated selected provider", () => {
  const transport = new FakeIOTransport();
  transport.capabilitiesValue = capabilities("auth_expired");
  const adapter = new IORuntimeAdapter(config(), transport);
  const preflight = adapter.preflight();
  assert.equal(preflight.status, "BLOCKED");
  assert.match(preflight.status === "BLOCKED" ? preflight.reasons.join(" ") : "", /auth_expired/);
});

test("IO-RA-8: pilot manifest claims no grant enforcement and preserves Backend v1 workflow", () => {
  const validated = validateManifestSet(
    ioPilotManifests({ backend_instance_id: "backend-v1" }, config()),
  );
  assert.equal(validated.runtime.body.adapter_id, "issue-orchestrator-runtime");
  assert.equal(validated.runtime.body.receipt_supported, false);
  assert.equal(
    validated.runtime.body.capability_enforcement["repository.merge"]?.deny,
    "UNENFORCEABLE_CAPABILITY_BOUNDARY",
  );
  assert.equal(validated.workflow.body.adapter_id, ["durable", "jobs", "workflow"].join("-"));
});

test("IO-RA-9: Python bridge imports execution seams only, never IO control-plane modules", () => {
  const source = readFileSync(join(ROOT, "adapters/io-runtime/bridge.py"), "utf8");
  for (const seam of [
    "agent_runner_providers",
    "persistent_round_runner",
    "agent_runner_env",
    "command_runner",
  ]) {
    assert.match(source, new RegExp(`from issue_orchestrator\\.execution\\.${seam} import`));
  }
  for (const forbiddenImport of [
    "issue_orchestrator.control",
    "issue_orchestrator.infra.orchestrator",
    "persistent_session_exchange",
    "review_exchange_runner",
  ]) {
    assert.equal(source.includes(`from ${forbiddenImport}`), false, forbiddenImport);
  }
});
