/**
 * FakeRuntimeAdapter — scripted responses + call recording only (Spec §63, TD §25).
 * No session manager, no process, no network.
 */

import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeSessionStatus,
  RuntimeTurnHandle,
  WorkflowControllerHandle,
} from "../adapters/interfaces/handles.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import type {
  RuntimeAdapter,
  RuntimeOperationContextV1,
  RuntimeSpawnResult,
  RuntimeTurnResult,
} from "../adapters/interfaces/runtime-adapter.ts";
import { ScriptedResponses, type FakeCall } from "./scripted.ts";

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly calls: FakeCall[] = [];

  /** Scripted spawn results — with or without an enforcement receipt (TD §12.6). */
  readonly sessions = new ScriptedResponses<RuntimeSpawnResult>();
  readonly turns = new ScriptedResponses<RuntimeTurnHandle>();
  readonly turnResults = new ScriptedResponses<RuntimeTurnResult>();
  readonly sessionStatuses = new ScriptedResponses<RuntimeSessionStatus>();
  readonly controllers = new ScriptedResponses<WorkflowControllerHandle>();

  spawn_session(
    operation_context: RuntimeOperationContextV1,
    role: string,
    runtime_profile: RuntimeProfile,
    cwd: string,
    bootstrap_context: CanonicalObject,
    capability_grant: CapabilityGrant,
  ): RuntimeSpawnResult {
    this.calls.push({
      method: "spawn_session",
      args: [operation_context, role, runtime_profile, cwd, bootstrap_context, capability_grant],
    });
    return this.sessions.take("spawn_session");
  }

  send_turn(
    operation_context: RuntimeOperationContextV1,
    session_handle: RuntimeSessionHandle,
    instruction: string,
  ): RuntimeTurnHandle {
    this.calls.push({ method: "send_turn", args: [operation_context, session_handle, instruction] });
    return this.turns.take("send_turn");
  }

  get_turn_result(turn_handle: RuntimeTurnHandle): RuntimeTurnResult {
    this.calls.push({ method: "get_turn_result", args: [turn_handle] });
    return this.turnResults.take("get_turn_result");
  }

  get_session_status(session_handle: RuntimeSessionHandle): RuntimeSessionStatus {
    this.calls.push({ method: "get_session_status", args: [session_handle] });
    return this.sessionStatuses.take("get_session_status");
  }

  cancel_session(session_handle: RuntimeSessionHandle): void {
    this.calls.push({ method: "cancel_session", args: [session_handle] });
  }

  close_session(session_handle: RuntimeSessionHandle): void {
    this.calls.push({ method: "close_session", args: [session_handle] });
  }

  acquire_workflow_controller(): WorkflowControllerHandle {
    this.calls.push({ method: "acquire_workflow_controller", args: [] });
    return this.controllers.take("acquire_workflow_controller");
  }
}
