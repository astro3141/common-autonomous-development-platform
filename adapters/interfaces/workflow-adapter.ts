/**
 * WorkflowAdapter — Spec §30, TD §14.1/§14.2.
 *
 * Observation placement (TD §14.2, M0-6): the adapter primitive is `status(handle)` returning a
 * normalized `WorkflowObservation`. `observe(handle)` is a **Coordinator-side** poll operation and
 * is deliberately absent from this interface.
 */

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import type { VerificationEvidence } from "./verification-adapter.ts";
import type { WorkflowControllerHandle, WorkflowHandle, WorkflowSpec } from "./handles.ts";

/**
 * TD §14.2 — normalized, Core-facing observation. The adapter maps backend-native state into
 * this shape; the vocabularies of `state`/`stage` are not fixed by the documents and are carried
 * as opaque strings rather than an invented enum.
 */
export interface WorkflowObservation {
  readonly state: string;
  readonly stage: string;
  readonly attempt: number;
  readonly terminal?: boolean;
  /** Backend references admissible under I-TD7 (TD §6.1). */
  readonly refs: CanonicalObject;
}

/** TD §16.2 — the audit verdict handed to the gate primitive. */
export type AuditVerdict = string;

/**
 * Controller placement (TD §13.3/§14.1/§16.3, M0-8 — W-B+): `start` and `audit_decide` are the two
 * calls the backend requires trusted context for, so they take the `WorkflowControllerHandle`
 * explicitly — Core passes the handle and never issues identity (I-TD5). The remaining operations
 * take no controller: the adapter resolves ownership through the controller association it made
 * with the `WorkflowHandle` at `start`. That association is adapter-owned state; the handle Core
 * holds is an opaque, non-identity value (I-TD7).
 */
export interface WorkflowAdapter {
  start(
    controller: WorkflowControllerHandle,
    workflow_spec: WorkflowSpec,
  ): WorkflowHandle;

  /** The single observation primitive (TD §14.2). Core polls this and re-checks before any transition. */
  status(handle: WorkflowHandle): WorkflowObservation;

  resume(handle: WorkflowHandle): void;

  cancel(handle: WorkflowHandle): void;

  /**
   * The adapter must be able to check the supplied controller against the handle's original
   * association at the backend-authoritative boundary; a mismatch is never handled fail-open.
   */
  audit_decide(
    controller: WorkflowControllerHandle,
    handle: WorkflowHandle,
    verdict: AuditVerdict,
    evidence: readonly VerificationEvidence[],
  ): void;

  recover(handle: WorkflowHandle): void;
}
