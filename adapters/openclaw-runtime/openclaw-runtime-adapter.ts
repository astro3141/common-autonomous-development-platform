/**
 * OpenClawRuntimeAdapter — the Backend v1 RuntimeAdapter (TD §13, §30.2; IG-2).
 *
 * The adapter owns the generic semantics the TD closed and the gateway seam cannot:
 *
 *   - **Operation identity (M1-8).** The same `op_key` with the same material input re-acquires
 *     the same logical session; the same `op_key` with different material is a deterministic,
 *     fail-closed conflict. The check is durable-free here — the backend's `ensureSession` is the
 *     authoritative reacquire — but the adapter still refuses a contradictory reuse it can see.
 *   - **Result channel arming (RA-2b).** Before a turn starts, the adapter arms the session's
 *     result slot with the turn's own request id; after the turn is terminal it collects only
 *     what matches the turn it armed. The model never supplies identity.
 *   - **Envelope assembly (§13.2).** `get_turn_result` returns the `platform/runtime-turn-result`
 *     envelope with `identity_authority: BACKEND` and the structured output the channel carried,
 *     or `TURN_TEXT` provenance when there was none. A running or unobservable turn throws
 *     `TurnNotObservable` — a fabricated terminal state is exactly what I-TD3 forbids.
 *   - **No receipt.** Backend v1 measured `receipt_supported = false` (§30.2 RA-1), so a
 *     conforming spawn result carries no `enforcement_receipt`, ever. Synthesizing one from
 *     configuration intent is forbidden (§19.3d).
 */

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import { canonicalize } from "../../core/schemas/canonical-json.ts";
import type { CapabilityGrant, RuntimeProfile, RuntimeSessionHandle, RuntimeSessionStatus, RuntimeTurnHandle, WorkflowControllerHandle } from "../interfaces/handles.ts";
import type {
  RuntimeAdapter,
  RuntimeOperationContextV1,
  RuntimeSpawnResult,
  RuntimeTurnResult,
} from "../interfaces/runtime-adapter.ts";
import { RuntimeResultChannel, withCollectedResult } from "../runtime-result-channel/index.ts";
import type { GatewaySessionRef, OpenClawGatewaySeam } from "./gateway-seam.ts";

/** The backend identifier this adapter reports in envelope provenance. */
export const OPENCLAW_RUNTIME_BACKEND = "openclaw-v1";

/** A turn that has no terminal projection yet (or at all, after a restart — RA-2a). */
export class TurnNotObservable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TurnNotObservable";
  }
}

/** Same-op reuse with different material input — fail-closed, never a silent alias (M1-8). */
export class RuntimeOperationConflict extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RuntimeOperationConflict";
  }
}

interface SessionHandleValue {
  readonly agent_id: string;
  readonly session_id: string;
}

interface TurnHandleValue extends SessionHandleValue {
  readonly request_id: string;
}

const sessionRefKey = (ref: GatewaySessionRef): string => `${ref.agent_id}:${ref.session_id}`;

export interface OpenClawRuntimeAdapterDependencies {
  readonly gateway: OpenClawGatewaySeam;
  /** RA-2b — the host-owned result channel, rooted outside every repository. */
  readonly channel: RuntimeResultChannel;
}

export class OpenClawRuntimeAdapter implements RuntimeAdapter {
  readonly #gateway: OpenClawGatewaySeam;
  readonly #channel: RuntimeResultChannel;
  /** Process-local same-op material record. The backend remains the reacquire authority. */
  readonly #spawns = new Map<string, { readonly material: string; readonly ref: GatewaySessionRef }>();
  /** Which turn each session's result slot is armed for, so a *new* turn can retire the old slot. */
  readonly #armed = new Map<string, string>();

  constructor(dependencies: OpenClawRuntimeAdapterDependencies) {
    this.#gateway = dependencies.gateway;
    this.#channel = dependencies.channel;
  }

  spawn_session(
    operation_context: RuntimeOperationContextV1,
    role: string,
    runtime_profile: RuntimeProfile,
    cwd: string,
    bootstrap_context: CanonicalObject,
    capability_grant: CapabilityGrant,
  ): RuntimeSpawnResult {
    const material = canonicalize({
      role,
      runtime_profile,
      cwd,
      bootstrap_context,
      capability_grant,
    } as unknown as CanonicalObject);

    const seen = this.#spawns.get(operation_context.op_key);
    if (seen !== undefined && seen.material !== material) {
      throw new RuntimeOperationConflict(
        `${operation_context.op_key} was spawned with different material inputs`,
      );
    }

    const ref =
      seen?.ref ??
      this.#gateway.ensure_session({
        op_key: operation_context.op_key,
        role,
        runtime_profile: runtime_profile as unknown as string,
        cwd,
      });
    this.#spawns.set(operation_context.op_key, { material, ref });

    const handle: SessionHandleValue = { agent_id: ref.agent_id, session_id: ref.session_id };
    // `receipt_supported = false` (§30.2 RA-1): a conforming result carries no receipt. The grant's
    // application means are backend configuration intent and are deliberately not reported as fact.
    return { session_handle: handle as unknown as RuntimeSessionHandle };
  }

  send_turn(
    operation_context: RuntimeOperationContextV1,
    session_handle: RuntimeSessionHandle,
    instruction: string,
  ): RuntimeTurnHandle {
    const session = session_handle as unknown as SessionHandleValue;
    const ref: GatewaySessionRef = { agent_id: session.agent_id, session_id: session.session_id };
    const key = sessionRefKey(ref);
    // A previous turn's slot on this session is retired only when a *new* turn arrives — by then
    // the lifecycle has consumed its result into durable records, so nothing an authoritative
    // record references still lives only on the slot (I-TD12). After a restart the previous turn
    // is unknown; arming then fails closed rather than guessing which slot to destroy.
    const previous = this.#armed.get(key);
    if (previous !== undefined && previous !== operation_context.op_key) {
      this.#channel.close(key, previous);
      this.#armed.delete(key);
    }
    // RA-2b — arm before the backend turn starts. If arming fails the turn is never started, the
    // INTENT stays unresolved, and no handle is invented (§21).
    this.#channel.arm(key, operation_context.op_key);
    this.#armed.set(key, operation_context.op_key);
    this.#gateway.start_turn(ref, operation_context.op_key, instruction);
    const handle: TurnHandleValue = { ...session, request_id: operation_context.op_key };
    return handle as unknown as RuntimeTurnHandle;
  }

  get_turn_result(turn_handle: RuntimeTurnHandle): RuntimeTurnResult {
    const turn = turn_handle as unknown as TurnHandleValue;
    const ref: GatewaySessionRef = { agent_id: turn.agent_id, session_id: turn.session_id };
    const status = this.#gateway.turn_status(ref, turn.request_id);
    if (status === undefined) {
      throw new TurnNotObservable(`${turn.request_id} has no terminal projection`);
    }

    const base: RuntimeTurnResult = {
      session_handle: { agent_id: turn.agent_id, session_id: turn.session_id } as unknown as RuntimeSessionHandle,
      turn_handle,
      backend_status: status.backend_status,
      termination_reason: status.termination_reason,
      started_at: status.started_at,
      completed_at: status.completed_at,
      provenance: {
        runtime_backend: OPENCLAW_RUNTIME_BACKEND,
        identity_authority: "BACKEND",
        result_channel: "TURN_TEXT",
      },
      // §13.2a v2 — an honest observation: the measured backend reports no provider/model/usage,
      // so every one of those is UNKNOWN rather than inferred (no alias promotion, no back-derived
      // cost). Timing is the adapter's own observation, as RA-2a records.
      execution_observation: {
        op_key: turn.request_id,
        role: "UNKNOWN",
        runtime_profile: turn.agent_id,
        actual: { provider: { availability: "UNKNOWN" }, model: { availability: "UNKNOWN" } },
        timing: { started_at: status.started_at, completed_at: status.completed_at },
        usage: { kind: "UNKNOWN" },
        cost: { kind: "UNKNOWN" },
      },
    };
    const collected = this.#channel.collect(sessionRefKey(ref), turn.request_id);
    return withCollectedResult(base, collected);
  }

  get_session_status(session_handle: RuntimeSessionHandle): RuntimeSessionStatus {
    const session = session_handle as unknown as SessionHandleValue;
    return this.#gateway.session_status({
      agent_id: session.agent_id,
      session_id: session.session_id,
    }) as unknown as RuntimeSessionStatus;
  }

  cancel_session(session_handle: RuntimeSessionHandle): void {
    const session = session_handle as unknown as SessionHandleValue;
    this.#gateway.cancel_session({ agent_id: session.agent_id, session_id: session.session_id });
  }

  close_session(session_handle: RuntimeSessionHandle): void {
    const session = session_handle as unknown as SessionHandleValue;
    this.#gateway.close_session({ agent_id: session.agent_id, session_id: session.session_id });
  }

  acquire_workflow_controller(): WorkflowControllerHandle {
    const ref = this.#gateway.controller_session();
    // I-TD7 — the handle is a credential-free reference to the managed controller session. The trusted
    // identity behind it never leaves the gateway binding.
    return {
      controller_agent_id: ref.agent_id,
      controller_session_id: ref.session_id,
    } as unknown as WorkflowControllerHandle;
  }
}
