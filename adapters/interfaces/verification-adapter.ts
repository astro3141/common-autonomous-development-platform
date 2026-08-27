/**
 * VerificationRunner / VerificationAdapter — Spec §37/§39, TD §15.
 *
 * The Evidence schema is TD §15.2 (`platform/verification-evidence` v1) verbatim. Core owns the
 * binding rules and the accepted-assurance policy (TD §15.2/§15.3); the adapter only produces
 * evidence.
 */

import type {
  TaskContractSnapshot,
  VerificationProfile,
  VerificationRunHandle,
} from "./handles.ts";
import type { RepositoryCanonicalSnapshot } from "./repository-adapter.ts";

export type VerificationResult = "PASS" | "FAIL" | "ERROR";

/** TD §15.2 — how strongly the evidence is backed. Self-reporting is always WORKER_REPORTED. */
export type AssuranceLevel =
  | "REEXECUTED"
  | "ARTIFACT_VERIFIED"
  | "LOG_VERIFIED"
  | "WORKER_REPORTED"
  | "INFERRED";

/** TD §15.2, schema `platform/verification-evidence` v1. */
export interface VerificationEvidence {
  readonly evidence_id: string;
  readonly check_id: string;
  readonly result: VerificationResult;
  readonly assurance_level: AssuranceLevel;
  /** Candidate SHA confirmed by the RepositoryAdapter. */
  readonly target_commit: string;
  /** `sha256:<lowercase-hex>` of the attempt's Task Contract Snapshot (TD §6). */
  readonly task_contract_hash: string;
  /** Producer identity; distinguishes a platform verifier run from a self-reported one. */
  readonly executor_identity: string;
  /** Adapter-owned reference to the run, admissible under I-TD7. */
  readonly run_reference?: string;
  readonly artifact_digest?: string;
  readonly log_digest?: string;
  readonly timestamp: string;
}

/**
 * TD §15.1a (M1-9) — the Platform's idempotency identity for one verification run.
 *
 * Exactly one field, and the same pattern as `RuntimeOperationContextV1` without being the same
 * type: a verification operation and a Runtime operation are different contracts. No metadata, no
 * headers, no trace bag, and deliberately no `WorkflowControllerHandle`/`WorkflowHandle` — a
 * verification backend that needs those obtains them itself, below this boundary.
 */
export interface VerificationOperationContextV1 {
  readonly op_key: string;
}

/**
 * TD §15.1a — what a start attempt resolved to. Two variants; there is no third.
 *
 * `BLOCKED` is an adapter *operation result*, never a Task/Attempt failure code: it is the adapter
 * authoritatively stating that **no external verification effect was started**, so the same
 * operation may simply be tried again later.
 */
export type VerificationStartResult =
  | { readonly kind: "STARTED"; readonly run_handle: VerificationRunHandle }
  | { readonly kind: "BLOCKED" };

/**
 * TD §15.1a — what a run looks like right now. Three variants; no backend state vocabulary and no
 * detail bag crosses this boundary.
 *
 * `COMPLETED` means the backend's execution is terminal and this is the evidence it produced — it
 * does **not** mean the verification passed. Required checks, accepted assurance and binding
 * validity stay Platform-owned judgements (TD §15.2/§15.3). `FAILED` is a whole-run infrastructure
 * failure, which Core maps to the existing `VERIFICATION_INFRA` semantics; it is a different thing
 * from a per-check `result: "ERROR"` inside evidence.
 */
export type VerificationRunObservation =
  | { readonly state: "RUNNING" }
  | { readonly state: "COMPLETED"; readonly evidence: readonly VerificationEvidence[] }
  | { readonly state: "FAILED" };

/**
 * TD §16.2 (M1-13) — the Platform's own Auditor verdict vocabulary, fixed by Core.
 *
 * It is declared here so the settlement contract can be typed without dragging a store type across
 * the boundary. A backend's own audit vocabulary (`PASS`/`FAIL`/`BLOCKED`, `INCONCLUSIVE`, …) is
 * *not* this: mapping happens inside the adapter, and no backend value ever becomes a Platform
 * verdict.
 */
export type PlatformAuditVerdict = "AUDIT_PASS" | "FIX_REQUIRED" | "HUMAN_REQUIRED";

/**
 * TD §16.3 (M1-13) — the Platform idempotency identity for one audit settlement.
 *
 * Its own type, like `VerificationOperationContextV1`, because settling an audit gate and starting
 * a verification run are different operations. Exactly one field; no controller, no workflow
 * handle, no metadata.
 */
export interface AuditSettlementOperationContextV1 {
  readonly op_key: string;
}

/**
 * TD §16.3 (M1-13) — what a settlement attempt resolved to. Three variants; no backend state
 * vocabulary crosses this boundary and there is no detail bag.
 *
 *   `SETTLED`     the adapter **re-observed its own backend** and proved the gate is settled with
 *                 the requested logical verdict for this run. A successful call is not this; an
 *                 echoed request is not this; model text is certainly not this.
 *   `CONFLICT`    the gate is settled, but with a different decision than the one requested.
 *   `UNAVAILABLE` the gate's state could not be authoritatively observed. Never inferred from the
 *                 adapter's own missing process memory — only from a failed observation.
 */
export type AuditSettlementResult =
  | { readonly kind: "SETTLED" }
  | { readonly kind: "UNAVAILABLE" }
  | { readonly kind: "CONFLICT" };

/**
 * Spec §37's VerificationRunner responsibility, in the concrete asynchronous form TD §15.1a fixes
 * for MVP 1. The backend set is unchanged (Local / CI / RemoteSandbox); what changed is that the
 * contract can now say "started, evidence later", which is what `IMPLEMENTING → VERIFYING →
 * AUDITING` requires. The synchronous `run_verification` is not part of the v1 callable surface:
 * two execution authorities would be one too many, and a synchronous backend simply returns a
 * terminal observation on the first look.
 */
export interface VerificationAdapter {
  /**
   * Same `op_key` with the same material input must resolve to the same logical run; the same
   * `op_key` with different material is a deterministic conflict (Spec §57 at this boundary).
   * How a backend enforces that is its own business.
   */
  start_verification(
    operation_context: VerificationOperationContextV1,
    verification_profile: VerificationProfile,
    repository_snapshot: RepositoryCanonicalSnapshot,
    task_contract_snapshot: TaskContractSnapshot,
    candidate_commit: string,
  ): VerificationStartResult;

  get_verification_result(run_handle: VerificationRunHandle): VerificationRunObservation;

  /**
   * TD §16.3 (M1-13) — settles the audit gate of the run this handle names.
   *
   * It lives here, and not on `WorkflowAdapter`, for a reason Core cannot work around: the backend
   * workflow identity and the trusted controller belong to whichever adapter *started* the run, and
   * Core only ever holds the opaque `VerificationRunHandle` (I-TD5/I-TD7). Asking Core to produce a
   * `WorkflowHandle` would mean asking it to look inside that handle.
   *
   * Backend v1 proves no dedup for its audit-decision primitive, so an implementation must observe
   * before it acts and re-observe after: `SETTLED` is a statement about the backend's state, never
   * about the call having returned.
   */
  settle_audit(
    operation_context: AuditSettlementOperationContextV1,
    run_handle: VerificationRunHandle,
    auditor_verdict: PlatformAuditVerdict,
    evidence: readonly VerificationEvidence[],
  ): AuditSettlementResult;
}
