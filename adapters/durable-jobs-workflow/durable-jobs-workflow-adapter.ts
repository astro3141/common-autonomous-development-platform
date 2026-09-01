/**
 * DurableJobsWorkflowAdapter — the Backend v1 WorkflowAdapter (TD §14.1, M0-8; IG-3).
 *
 * Mapping only. Each generic operation is one `workflow` tool invocation through the same
 * one-method `WorkflowToolTransport` seam the verification stack already uses; the transport owns
 * the trusted context and the wire, this adapter owns which request to build and how to read the
 * answer. No policy, no store, no Platform vocabulary.
 *
 * Controller placement is M0-8's: `start` and `audit_decide` take the controller explicitly, and
 * the adapter checks it against the transport's own controller binding — the backend re-derives
 * ownership from the trusted tool context anyway (RA-3, fail-closed at the backend boundary), so
 * the check here is an early, deterministic refusal, not a second authority. The remaining
 * operations resolve ownership through the association made at `start`.
 *
 * The live request grammar of the backend's `workflow` tool is a backend fact this adapter
 * isolates; its live round-trip is deferred backend validation (STATUS §5.2), and everything here
 * fails closed on an answer it cannot read.
 */

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import { canonicalize } from "../../core/schemas/canonical-json.ts";
import type {
  WorkflowControllerHandle,
  WorkflowHandle,
  WorkflowSpec,
} from "../interfaces/handles.ts";
import type { VerificationEvidence } from "../interfaces/verification-adapter.ts";
import type {
  AuditVerdict,
  WorkflowAdapter,
  WorkflowObservation,
} from "../interfaces/workflow-adapter.ts";
import type { WorkflowToolTransport } from "../local-verification/workflow-tool-seam.ts";

/** A backend answer that cannot be read, or a controller that does not match. Fail-closed. */
export class WorkflowAdapterError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WorkflowAdapterError";
  }
}

interface WorkflowHandleValue {
  readonly workflow_id: string;
}

export interface DurableJobsWorkflowAdapterDependencies {
  readonly transport: WorkflowToolTransport;
  /**
   * The credential-free reference of the controller session this transport speaks as (I-TD7),
   * resolved **lazily at call time** so it can come from the Runtime adapter's own
   * `acquire_workflow_controller()` — the one authority that actually issues the handle (TD §13.3;
   * finding 2: a value hard-coded at composition time contradicted the handle the Runtime
   * returns, so the two adapters could never agree in production). Explicit controller arguments
   * are checked against this resolution; the trusted identity itself stays behind the transport.
   */
  readonly controller_binding: () => CanonicalObject;
}

export class DurableJobsWorkflowAdapter implements WorkflowAdapter {
  readonly #transport: WorkflowToolTransport;
  readonly #controllerBinding: () => string;
  /** Adapter-owned association: which controller each started workflow belongs to (TD §13.3). */
  readonly #associations = new Map<string, string>();

  constructor(dependencies: DurableJobsWorkflowAdapterDependencies) {
    this.#transport = dependencies.transport;
    this.#controllerBinding = () => canonicalize(dependencies.controller_binding());
  }

  start(controller: WorkflowControllerHandle, workflow_spec: WorkflowSpec): WorkflowHandle {
    this.#requireController(controller, "start");
    const spec = workflow_spec as unknown as Record<string, unknown>;
    const request_id = spec["request_id"];
    if (typeof request_id !== "string" || request_id.length === 0) {
      throw new WorkflowAdapterError("a workflow spec carries no request_id");
    }
    const payload = this.#transport.invoke({ action: "start", requestId: request_id, spec });
    const workflow_id = readString(asObject(payload, "start result"), "workflowId");
    this.#associations.set(workflow_id, this.#controllerBinding());
    return { workflow_id } as unknown as WorkflowHandle;
  }

  status(handle: WorkflowHandle): WorkflowObservation {
    const workflow_id = this.#workflowId(handle);
    const status = asObject(
      this.#transport.invoke({ action: "status", workflowId: workflow_id }),
      "workflow status",
    );
    if (readString(status, "workflowId") !== workflow_id) {
      throw new WorkflowAdapterError(`status is for another workflow, not ${workflow_id}`);
    }
    const stages = Array.isArray(status["stages"]) ? (status["stages"] as unknown[]) : [];
    const current = stages
      .map((stage) => asObject(stage, "stage"))
      .find((stage) => stage["stageState"] === "RUNNING" || stage["stageState"] === "PENDING");
    const state = readString(status, "workflowState");
    return {
      state,
      stage: current === undefined ? "" : String(current["stageName"] ?? current["stageId"] ?? ""),
      attempt: Number.isInteger(current?.["currentAttempt"]) ? (current?.["currentAttempt"] as number) : 1,
      terminal: state === "COMPLETED" || state === "FAILED" || state === "CANCELLED",
      refs: { workflow_id },
    };
  }

  resume(handle: WorkflowHandle): void {
    this.#transport.invoke({ action: "resume", workflowId: this.#workflowId(handle) });
  }

  cancel(handle: WorkflowHandle): void {
    this.#transport.invoke({ action: "cancel", workflowId: this.#workflowId(handle) });
  }

  audit_decide(
    controller: WorkflowControllerHandle,
    handle: WorkflowHandle,
    verdict: AuditVerdict,
    evidence: readonly VerificationEvidence[],
  ): void {
    this.#requireController(controller, "audit_decide");
    const workflow_id = this.#workflowId(handle);
    const association = this.#associations.get(workflow_id);
    if (association !== undefined && association !== this.#controllerBinding()) {
      // Never fail-open on a mismatch (M0-8). An absent association after a restart is not a
      // mismatch — the backend's own owner-equality gate is the authority either way (RA-3).
      throw new WorkflowAdapterError(`${workflow_id} belongs to a different controller`);
    }
    this.#transport.invoke({
      action: "audit_decide",
      workflowId: workflow_id,
      verdict,
      evidence: evidence.map((item) => ({
        checkId: item.check_id,
        result: item.result,
        verificationLevel: item.assurance_level,
        targetCommit: item.target_commit,
      })),
    });
  }

  recover(handle: WorkflowHandle): void {
    // Record-level recovery is the backend's own reconciler; a re-observation is what the generic
    // operation can honestly do (capability doc §2: recovery scan runs per pass).
    this.status(handle);
  }

  #workflowId(handle: WorkflowHandle): string {
    const value = handle as unknown as WorkflowHandleValue;
    if (typeof value.workflow_id !== "string" || value.workflow_id.length === 0) {
      throw new WorkflowAdapterError("a workflow handle carries no workflow id");
    }
    return value.workflow_id;
  }

  #requireController(controller: WorkflowControllerHandle, operation: string): void {
    const supplied = canonicalize(controller as unknown as CanonicalObject);
    if (supplied !== this.#controllerBinding()) {
      throw new WorkflowAdapterError(
        `${operation} was called with a controller this transport does not speak as`,
      );
    }
  }
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowAdapterError(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowAdapterError(`${field} is not a non-empty string`);
  }
  return value;
}
