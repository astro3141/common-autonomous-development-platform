/**
 * The Backend v1 runtime gateway seam (TD §13.1, §30.2 RA-1/RA-2/RA-3 — IG-2).
 *
 * Everything OpenClaw-shaped stops below this interface. Above it, `OpenClawRuntimeAdapter`
 * implements the generic `RuntimeAdapter` semantics — operation identity, same-op reacquire,
 * result-channel arming and envelope assembly — and below it, a production binding talks to the
 * measured backend primitives (`AcpRuntime.ensureSession`, `startTurn`, the session store).
 *
 * Every value crossing this seam is **credential-free** (I-TD5/I-TD7): the session reference is the
 * RA-1a `(agent_id, session_id)` pair, never a raw session credential or authorization value.
 * Resolution back to the backend's trusted credential happens inside the binding and stays in its
 * process memory.
 */

/** RA-1a — the adapter-derived, Platform-safe session reference. Both members are credential-free. */
export interface GatewaySessionRef {
  readonly agent_id: string;
  readonly session_id: string;
}

/**
 * RA-2a — the terminal projection of one turn, in the backend's own vocabulary already mapped to
 * the envelope's `backend_status` domain. `RUNNING` is not part of it: a running turn has no
 * terminal projection, and `turn_status` answers `undefined` for it instead of inventing one.
 */
export interface GatewayTurnStatus {
  readonly backend_status: "COMPLETED" | "CANCELLED" | "TIMEOUT" | "RUNTIME_ERROR" | "SESSION_LOST";
  /** Backend wording, opaque upstream. */
  readonly termination_reason: string;
  /** Adapter-observed timestamps (RA-2a: the backend has no native ones). */
  readonly started_at: string;
  readonly completed_at: string;
}

export interface GatewayEnsureSessionRequest {
  /** The Platform operation identity, for the binding's own idempotency records only. */
  readonly op_key: string;
  readonly role: string;
  /** The Project Profile's `runtime_profile` string, resolved by the binding to a backend agent. */
  readonly runtime_profile: string;
  readonly cwd: string;
}

/**
 * The narrow surface the adapter needs. One implementation binds to an installed backend; a test
 * scripts it. There is deliberately no event stream, no store access and no config surface here.
 */
export interface OpenClawGatewaySeam {
  /**
   * Ensures a managed session exists for this request and returns its Platform-safe reference.
   * The backend owns identity: the same logical request re-acquires the same session (M1-8), and
   * the binding never mints identity of its own (I-TD5).
   */
  ensure_session(request: GatewayEnsureSessionRequest): GatewaySessionRef;

  /**
   * Starts one turn with the caller-supplied `request_id` (the Platform op_key — RA-1b). The
   * backend proves no dedup for it, so the *caller* must never call this twice for the same
   * accepted request (TD §19.3e T2/T3 own that refusal).
   */
  start_turn(session: GatewaySessionRef, request_id: string, instruction: string): void;

  /**
   * The terminal projection of a turn, or `undefined` while it is running or when this process
   * cannot observe it at all (the live turn tracking is process-local — RA-2a). `undefined` is an
   * honest "not observable", never an error and never a fabricated terminal state.
   */
  turn_status(session: GatewaySessionRef, request_id: string): GatewayTurnStatus | undefined;

  /** The backend's own session projection, opaque upstream. */
  session_status(session: GatewaySessionRef): Record<string, unknown>;

  cancel_session(session: GatewaySessionRef): void;

  close_session(session: GatewaySessionRef): void;

  /**
   * RA-3 — the Managed Platform-Controller Session's reference. The binding starts or re-acquires
   * it; its trusted identity is host-issued and never crosses this seam.
   */
  controller_session(): GatewaySessionRef;
}

/** An operation the gateway could not answer. Adapter-local; Core sees only fail-closed behaviour. */
export class GatewayUnavailable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "GatewayUnavailable";
  }
}
