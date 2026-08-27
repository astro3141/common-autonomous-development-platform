/**
 * FakeWorkflowAdapter — scripted responses + call recording only (Spec §63, TD §25).
 *
 * No workflow engine, no event/callback machinery: observation is a plain `status()` poll,
 * matching the M0-6 placement decision. There is no public `observe()`.
 */

import type {
  WorkflowAdapter,
  WorkflowObservation,
} from "../adapters/interfaces/workflow-adapter.ts";
import type { VerificationEvidence } from "../adapters/interfaces/verification-adapter.ts";
import type {
  WorkflowControllerHandle,
  WorkflowHandle,
  WorkflowSpec,
} from "../adapters/interfaces/handles.ts";
import { ScriptedResponses, type FakeCall } from "./scripted.ts";

export class FakeWorkflowAdapter implements WorkflowAdapter {
  readonly calls: FakeCall[] = [];

  readonly handles = new ScriptedResponses<WorkflowHandle>();
  readonly observations = new ScriptedResponses<WorkflowObservation>();

  start(controller: WorkflowControllerHandle, workflow_spec: WorkflowSpec): WorkflowHandle {
    this.calls.push({ method: "start", args: [controller, workflow_spec] });
    return this.handles.take("start");
  }

  status(handle: WorkflowHandle): WorkflowObservation {
    this.calls.push({ method: "status", args: [handle] });
    return this.observations.take("status");
  }

  resume(handle: WorkflowHandle): void {
    this.calls.push({ method: "resume", args: [handle] });
  }

  cancel(handle: WorkflowHandle): void {
    this.calls.push({ method: "cancel", args: [handle] });
  }

  audit_decide(
    controller: WorkflowControllerHandle,
    handle: WorkflowHandle,
    verdict: string,
    evidence: readonly VerificationEvidence[],
  ): void {
    this.calls.push({ method: "audit_decide", args: [controller, handle, verdict, evidence] });
  }

  recover(handle: WorkflowHandle): void {
    this.calls.push({ method: "recover", args: [handle] });
  }
}
