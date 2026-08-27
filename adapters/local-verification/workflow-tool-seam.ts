/**
 * The concrete Backend v1 verification seam: the backend's `workflow` tool, translated.
 *
 * This is the narrowest possible production implementation of `VerificationBackendSeam`. It builds
 * two requests the backend already accepts — `action: "status"` and `action: "approve"` — and reads
 * back the fields the evidence mapper needs. It does not open a store file, run a shell, resolve an
 * owner or hold any state: ownership is re-resolved by the backend from the trusted tool context
 * the transport already carries (RA-3), so no controller logic is duplicated here.
 *
 * Everything backend-shaped stops at this file. Above it, `LocalVerificationAdapter` sees only the
 * generic seam types, and Core sees only `VerificationRunObservation`.
 */

import type {
  BackendAuditGateStatus,
  BackendStageStatus,
  BackendVerificationStatus,
  VerificationBackendSeam,
  VerificationRunRefV1,
} from "./backend-seam.ts";

/**
 * How a `workflow` tool call is made. One method, deliberately: the transport owns the trusted
 * context and the wire format, and this seam owns only what to ask and how to read the answer.
 * A caller supplies the production transport; a test supplies one that returns a captured payload.
 */
export interface WorkflowToolTransport {
  invoke(request: Readonly<Record<string, unknown>>): unknown;
}

/** The backend rejects unknown control request ids; this is the accepted grammar. */
const CONTROL_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Why the stage was released. Recorded by the backend for operators; not a Platform fact. */
const APPROVAL_REASON = "platform verification check passed";

export class WorkflowToolVerificationSeam implements VerificationBackendSeam {
  readonly #transport: WorkflowToolTransport;

  constructor(transport: WorkflowToolTransport) {
    this.#transport = transport;
  }

  inspect_verification_workflow(run: VerificationRunRefV1): BackendVerificationStatus {
    const payload = this.#transport.invoke({
      action: "status",
      workflowId: run.workflow_id,
    });
    return readStatus(payload, run.workflow_id);
  }

  approve_verified_stage(
    run: VerificationRunRefV1,
    stage: { readonly stage_id: string; readonly attempt: number },
  ): void {
    // Deterministic per (run, stage, attempt): a retry of the same advancement presents the same
    // control request id rather than a fresh one.
    const requestId = `${run.request_id}:approve:${stage.stage_id}:${stage.attempt}`;
    if (!CONTROL_REQUEST_ID.test(requestId)) {
      throw new BackendSeamError(`control request id is not acceptable: ${requestId}`);
    }
    this.#transport.invoke({
      action: "approve",
      workflowId: run.workflow_id,
      stageId: stage.stage_id,
      attempt: stage.attempt,
      requestId,
      reason: APPROVAL_REASON,
    });
  }

  /**
   * Reads the audit gate out of the same public status projection (M1-13). The gate's decision is
   * the backend's own record of what it settled with; a projection that carries no audit section
   * is a gate that has not been settled, which is a fact, not a failure.
   */
  inspect_audit_gate(run: VerificationRunRefV1): BackendAuditGateStatus {
    const payload = this.#transport.invoke({
      action: "status",
      workflowId: run.workflow_id,
    });
    const status = asObject(payload, "workflow status");
    if (asString(status["workflowId"], "workflowId") !== run.workflow_id) {
      throw new BackendSeamError(`status is for another workflow, not ${run.workflow_id}`);
    }
    const audit = status["audit"];
    if (audit === undefined || audit === null) return { settled: false, verdict: null };

    const record = asObject(audit, "workflow status audit");
    const verdict = optionalString(record["verdict"]);
    // Settled means the backend recorded a decision. A section with no decision in it is not one.
    return verdict === null ? { settled: false, verdict: null } : { settled: true, verdict };
  }
}

/** A backend answer that cannot be read as a workflow status. Always fail-closed upstream. */
export class BackendSeamError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "BackendSeamError";
  }
}

// --- reading the answer ---------------------------------------------------------------------

/**
 * Translates the backend's public status projection. Only the fields the seam contract declares are
 * read; the rest of the projection — completed stages, decisions, checkpoints, audit summaries — is
 * deliberately left where it is. A payload that is not that shape is rejected rather than
 * half-interpreted, so a malformed or denied answer becomes a structural failure upstream.
 */
function readStatus(payload: unknown, expected_workflow_id: string): BackendVerificationStatus {
  const status = asObject(payload, "workflow status");
  const workflow_id = asString(status["workflowId"], "workflowId");
  if (workflow_id !== expected_workflow_id) {
    throw new BackendSeamError(`status is for ${workflow_id}, not ${expected_workflow_id}`);
  }
  const stages = status["stages"];
  if (!Array.isArray(stages)) throw new BackendSeamError("workflow status has no stages");

  return {
    workflow_id,
    workflow_state: asString(status["workflowState"], "workflowState"),
    worktree: optionalString(asObject(status["repository"] ?? {}, "repository")["worktree"]),
    stages: stages.map((stage, index) => readStage(stage, index)),
  };
}

function readStage(value: unknown, index: number): BackendStageStatus {
  const stage = asObject(value, `stages/${index}`);
  const finished = optionalString(stage["finishedAt"]);
  return {
    stage_id: asString(stage["stageId"], `stages/${index}/stageId`),
    stage_name: asString(stage["stageName"], `stages/${index}/stageName`),
    stage_state: asString(stage["stageState"], `stages/${index}/stageState`),
    current_attempt: optionalInteger(stage["currentAttempt"]),
    process_state: optionalString(stage["processState"]),
    provider_state: optionalString(stage["providerState"]),
    // The terminal timestamp of this check's execution record.
    finished_at: finished,
    // Carried only so the mapper can be proven to ignore it (§10).
    verification_level: optionalString(stage["verificationLevel"]),
  };
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BackendSeamError(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BackendSeamError(`${where} is not a non-empty string`);
  }
  return value;
}

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const optionalInteger = (value: unknown): number | null =>
  Number.isInteger(value) ? (value as number) : null;
