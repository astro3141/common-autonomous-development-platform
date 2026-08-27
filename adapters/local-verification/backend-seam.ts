/**
 * The Backend v1 read/advance seam (MVP1-B8 §23).
 *
 * `WorkflowAdapter.status` returns a normalized `WorkflowObservation` whose whole point is that Core
 * cannot read backend detail out of it. Per-check verification facts *are* backend detail, so they
 * come through this narrow seam instead — which is deliberately **not** Core, **not** the generic
 * `WorkflowAdapter`, and not exported as lifecycle vocabulary. It wraps behaviour the backend
 * already exposes publicly (its workflow status projection and its stage control operation); it
 * never reads the backend's store files.
 *
 * A `CIValidationAdapter` would have no use for any of this, which is exactly why it lives here.
 */


/**
 * What a `VerificationRunHandle` actually is for Backend v1: the backend's workflow id plus the
 * request material this adapter froze when it started the run.
 *
 * The frozen material rides in the handle because the backend's public status projection does not
 * return the start request — `shapeStatus` returns the workflow, its stages and its worktree, and
 * nothing of `candidate_commit` or the contract hash. Since the handle is adapter-owned, opaque to
 * Core and already persisted as an I-TD7-admissible projection, carrying them here makes a
 * restarted adapter able to rebuild the binding without asking Core or encoding data into a
 * display name. Every member is a plain value, admissible under I-TD7.
 */
export interface VerificationRunRefV1 {
  readonly workflow_id: string;
  /** The Platform verify operation key this run was started under. */
  readonly request_id: string;
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
}

/**
 * One check's execution facts, as the backend records them.
 *
 * `process_state` is the authoritative OS-child outcome; `provider_state` is only meaningful for
 * model activities and is `OK` by definition for a local argv check. `verification_level` is
 * carried so a test can prove it is *ignored* — the backend populates it from a decision payload,
 * not from execution, so it can never be Platform assurance provenance.
 */
export interface BackendStageStatus {
  readonly stage_id: string;
  /** What the adapter named the stage at start: the verification profile's check id. */
  readonly stage_name: string;
  readonly stage_state: string;
  /** Which attempt of this stage the facts belong to; the control operation targets it. */
  readonly current_attempt: number | null;
  readonly process_state: string | null;
  readonly provider_state: string | null;
  /** Terminal timestamp of this check's execution record. */
  readonly finished_at: string | null;
  readonly verification_level?: string | null;
}

/**
 * The workflow as this adapter needs to read it back, including the request it froze at start.
 * Reading those fields back is how a stateless adapter recovers the candidate and contract binding
 * after a restart — they are its own frozen values, not backend-authored claims.
 */
export interface BackendVerificationStatus {
  readonly workflow_id: string;
  readonly workflow_state: string;
  /** Where the checks actually ran. */
  readonly worktree: string | null;
  readonly stages: readonly BackendStageStatus[];
}

/**
 * The audit gate's own state, as the backend records it (M1-13).
 *
 * Two fields, because two questions decide everything the settlement contract needs: has the gate
 * been settled at all, and — if so — with which decision. `verdict` is the **backend's own value**,
 * never a Platform verdict; mapping in both directions stays inside this directory.
 */
export interface BackendAuditGateStatus {
  readonly settled: boolean;
  readonly verdict: string | null;
}

export interface VerificationBackendSeam {
  inspect_verification_workflow(run: VerificationRunRefV1): BackendVerificationStatus;

  /**
   * Reads the audit gate back (M1-13). This is what makes `SETTLED` a statement about the backend
   * rather than about a call returning, and it is why the adapter can observe before it acts: the
   * backend's audit primitive proves no request dedup, so a blind retry could settle twice.
   */
  inspect_audit_gate(run: VerificationRunRefV1): BackendAuditGateStatus;

  /**
   * Marks a check's stage as verified so the backend's linear pipeline releases the next one. The
   * backend records its own progression marker for this; that marker is not a Platform fact and is
   * never read back as one (§16). The caller has already established PASS itself.
   */
  approve_verified_stage(
    run: VerificationRunRefV1,
    stage: { readonly stage_id: string; readonly attempt: number },
  ): void;
}
