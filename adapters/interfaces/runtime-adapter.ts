/**
 * RuntimeAdapter — Spec §27/§28, TD §13.
 *
 * Method names are the Spec's own, so the surface can be compared to the document literally.
 * No backend mapping lives here (TD §13.1 is mapping-only and belongs to a production adapter).
 */

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import type { CapabilityEnforcementReceipt } from "./capability.ts";
import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeSessionStatus,
  RuntimeTurnHandle,
  WorkflowControllerHandle,
} from "./handles.ts";

/** TD §13.2 — how the turn ended, as reported by the backend. */
export type RuntimeBackendStatus =
  | "COMPLETED"
  | "CANCELLED"
  | "TIMEOUT"
  | "RUNTIME_ERROR"
  | "SESSION_LOST";

/** TD §13.2 — who vouches for the session identity. A model may never assert this itself. */
export type IdentityAuthority = "BACKEND" | "UNKNOWN";

/** TD §13.2 — where the structured result came from. */
export type ResultChannelKind = "RUNTIME_RESULT_CHANNEL" | "STRUCTURED_PROTOCOL" | "TURN_TEXT";

/** TD §13.2 — the model's own claim. Never authoritative (I-TD3). */
export type DeclaredStatus = "DONE" | "BLOCKED" | "NEEDS_INPUT" | "FAILED";

export interface RuntimeResultProvenance {
  /** Backend identifier string owned by the adapter; Core does not interpret it. */
  readonly runtime_backend: string;
  readonly identity_authority: IdentityAuthority;
  readonly result_channel: ResultChannelKind;
}

export interface RuntimeStructuredOutput {
  /** Structured protocol identifier owned by the adapter; Core does not interpret it. */
  readonly protocol: string;
  readonly body: CanonicalObject;
}

export interface ModelDeclaredOutcome {
  readonly declared_status: DeclaredStatus;
  readonly summary: string;
  readonly refs: readonly string[];
}

/**
 * TD §13.2a (v1.5, PROSPECTIVE) — the measurement observation a v2 turn result carries.
 *
 * Everything is availability-honest: a backend that does not report provider/model/usage/cost
 * yields `UNKNOWN`, and nothing is inferred from profile names, elapsed time or price tables.
 * This is a measurement/evidence source only — never Task success, Verification PASS, retry or
 * transition authority.
 */
export interface RuntimeExecutionObservationV1 {
  readonly op_key: string;
  readonly role: string;
  readonly runtime_profile: string;
  readonly actual: {
    readonly provider:
      | { readonly availability: "REPORTED"; readonly value: string }
      | { readonly availability: "UNKNOWN" };
    readonly model:
      | { readonly availability: "REPORTED"; readonly value: string }
      | { readonly availability: "UNKNOWN" };
  };
  readonly timing: { readonly started_at: string; readonly completed_at: string };
  readonly usage:
    | {
        readonly kind: "REPORTED";
        readonly quantities: Readonly<Record<string, { readonly value: number; readonly unit: string }>>;
      }
    | { readonly kind: "UNKNOWN" };
  readonly cost:
    | { readonly kind: "REPORTED"; readonly value: string; readonly currency: string }
    | { readonly kind: "UNKNOWN" };
}

/**
 * TD §13.2 — schema `platform/runtime-turn-result` v1 (v2 adds `execution_observation`).
 *
 * `model_declared_outcome` is always non-authoritative; `structured_output` is absent when the
 * adapter could not collect a structured result, in which case `result_channel` is `TURN_TEXT`.
 */
export interface RuntimeTurnResult {
  readonly session_handle: RuntimeSessionHandle;
  readonly turn_handle: RuntimeTurnHandle;
  readonly backend_status: RuntimeBackendStatus;
  /** Backend wording, opaque to Core. */
  readonly termination_reason: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly provenance: RuntimeResultProvenance;
  readonly structured_output?: RuntimeStructuredOutput;
  readonly model_declared_outcome?: ModelDeclaredOutcome;
  /** Backend references admissible under I-TD7; stored only as adapter metadata (TD §6.1). */
  readonly backend_native_refs?: CanonicalObject;
  /** TD §13.2a — present when the adapter speaks v2. Measurement source, never authority. */
  readonly execution_observation?: RuntimeExecutionObservationV1;
}

/**
 * TD §12.6 / §13.1 (M0-7) — the concrete result of a successful `spawn_session`.
 *
 * Spec §27 is a minimum interface: the method identity and spawn semantics are unchanged and the
 * session handle is still what the caller gets; TD adds the enforcement receipt to the same
 * result so that it is bound to *this* spawn rather than fetched afterwards.
 *
 * Presence of `enforcement_receipt` is governed solely by the Backend Capability Manifest's
 * `receipt_supported` — there is deliberately no `UNSUPPORTED` value here, because that would be
 * a second source of truth. With `receipt_supported: true` the receipt must be present and its
 * `session_handle` must equal `session_handle` below; a miss is fail-closed and no turn is sent.
 */
export interface RuntimeSpawnResult {
  readonly session_handle: RuntimeSessionHandle;
  readonly enforcement_receipt?: CapabilityEnforcementReceipt;
}

/**
 * TD §13 (M1-8) — the Platform's idempotency identity, carried into an external Runtime operation.
 *
 * Exactly one field. It exists so a write-ahead INTENT (§21) and the call it guards share one
 * identity, which is what lets a same-op retry re-acquire instead of duplicating. It is not Model
 * input, not a Task Contract field, not a hashed artifact, and deliberately not a metadata bag:
 * no `headers`, no trace context, no `AdapterContext<T>`.
 */
export interface RuntimeOperationContextV1 {
  readonly op_key: string;
}

/**
 * TD §19.3e step 0 (RA-4) — the read-only answer to "may an external Runtime operation start at
 * all?", asked before the first INTENT is written.
 *
 * Exactly two states. `BLOCKED` carries adapter-owned reason strings that Core never parses,
 * branches on, or maps to a §24 reason code: a blocked preflight is not a lifecycle event, it just
 * means nothing happens this time round. There is deliberately no health score, no severity, no
 * remediation hint and no check registry — this is not an environment-health framework.
 */
export type RuntimePreflightOutcome =
  | { readonly status: "READY" }
  | { readonly status: "BLOCKED"; readonly reasons: readonly string[] };

/** The seam itself. A function, not an interface, because it has exactly one operation. */
export type RuntimePreflight = () => RuntimePreflightOutcome;

export interface RuntimeAdapter {
  spawn_session(
    operation_context: RuntimeOperationContextV1,
    role: string,
    runtime_profile: RuntimeProfile,
    cwd: string,
    bootstrap_context: CanonicalObject,
    capability_grant: CapabilityGrant,
  ): RuntimeSpawnResult;

  send_turn(
    operation_context: RuntimeOperationContextV1,
    session_handle: RuntimeSessionHandle,
    instruction: string,
  ): RuntimeTurnHandle;

  get_turn_result(turn_handle: RuntimeTurnHandle): RuntimeTurnResult;

  get_session_status(session_handle: RuntimeSessionHandle): RuntimeSessionStatus;

  cancel_session(session_handle: RuntimeSessionHandle): void;

  close_session(session_handle: RuntimeSessionHandle): void;

  /** TD §13.3 — Core never issues trusted identity; it only receives an opaque handle. */
  acquire_workflow_controller(): WorkflowControllerHandle;
}
