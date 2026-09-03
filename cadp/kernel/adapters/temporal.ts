/**
 * Temporal TargetAdapterV1 (TD §6.4 continuation target): `WORK_START` with
 * `NATIVE_KEY` (workflow_id = cadp-work-<effect_id>) inside the namespace retention
 * horizon, `REJECT_DUPLICATE` + `CONFLICT_POLICY_FAIL`. COMMITTED only after
 * `DescribeWorkflowExecution` returns a TARGET-RETURNED memo matching
 * `{cadp_effect_id, cadp_args_digest}` — the StartWorkflow response alone never
 * yields COMMITTED, and the requested memo is never copied into the receipt (C34).
 */

import { Cas } from "../cas.ts";
import { jcsDigest } from "../canonical.ts";
import type { SubjectBinding, TargetRef } from "../records.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";

/** Transport seam over the Temporal SDK client (scripted in conformance tests). */
export interface TemporalTransport {
  describeNamespace(): Promise<{ namespace_id: string; retention_s: number }>;
  start(input: {
    workflow_id: string;
    workflow_type: string;
    task_queue: string;
    args: unknown[];
    memo: Record<string, unknown>;
  }): Promise<
    | { kind: "started"; run_id: string }
    | { kind: "already_started"; run_id?: string }
    | { kind: "rejected"; grpc_status: string; detail: string } // INVALID_ARGUMENT / PERMISSION_DENIED / NOT_FOUND(ns)
    | { kind: "ambiguous"; detail: string }
  >;
  /** Persistence-backed describe; returns the target-returned memo. */
  describe(workflow_id: string, run_id?: string): Promise<
    | { kind: "found"; run_id: string; memo: Record<string, unknown>; status: string }
    | { kind: "not_found" }
    | { kind: "ambiguous"; detail: string }
  >;
}

export class TemporalAdapter implements TargetAdapterV1 {
  readonly transport: TemporalTransport;
  readonly cas: Cas;
  readonly namespace: string;
  readonly horizon_s: number;

  constructor(transport: TemporalTransport, cas: Cas, namespace: string, horizon_s: number) {
    this.transport = transport;
    this.cas = cas;
    this.namespace = namespace;
    this.horizon_s = horizon_s;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: "WORKFLOW",
      authority_ref: `temporal:${this.namespace}`,
      operations: [
        {
          operation_kind: "WORK_START",
          material_schema: "cadp.work-start.v1",
          available: true,
          idempotency: "NATIVE_KEY",
          idempotency_horizon_s: this.horizon_s,
          dispatch_precondition: "NATIVE_CAS",
          reconcile: "BY_OPERATION_REF",
          no_effect_proof_supported: true,
        },
      ],
    };
  }

  serialization_domain(): string {
    return `temporal:${this.namespace}`;
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    const ns = await this.transport.describeNamespace();
    if (ns.retention_s !== this.horizon_s) {
      throw new Error(`temporal namespace retention ${ns.retention_s}s != configured idempotency horizon ${this.horizon_s}s`);
    }
    return {
      target_ref: { authority_ref: `temporal:${this.namespace}`, target_type: "WORKFLOW", target_id: ns.namespace_id },
      claim: { namespace_id: ns.namespace_id, retention_s: ns.retention_s },
    };
  }

  async current_revision(_subject: SubjectBinding): Promise<RevisionRead> {
    return { availability: "UNKNOWN" };
  }

  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind !== "WORK_START") return;
    const argsKey = material["args_cas_key"];
    if (typeof argsKey !== "string") throw new MaterialIncomplete("WORK_START material requires args_cas_key");
    const argsBytes = this.cas.get(argsKey);
    const args = JSON.parse(Buffer.from(argsBytes).toString("utf8")) as unknown;
    const digest = material["args_digest"];
    if (typeof digest !== "string" || jcsDigest(args).value !== digest) {
      throw new MaterialIncomplete("args bytes do not re-digest to material.args_digest");
    }
  }

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(
    effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    _operation: string,
    material: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const workflowId = String(material["workflow_id"]);
    const argsDigest = String(material["args_digest"]);
    const args = JSON.parse(Buffer.from(this.cas.get(String(material["args_cas_key"]))).toString("utf8")) as unknown;
    const memo = { cadp_effect_id: effect_id, cadp_args_digest: argsDigest };
    let started: Awaited<ReturnType<TemporalTransport["start"]>>;
    try {
      started = await this.transport.start({
        workflow_id: workflowId,
        workflow_type: String(material["workflow_type"] ?? "cadpWork"),
        task_queue: String(material["task_queue"]),
        args: [args],
        memo,
      });
    } catch (error) {
      return { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
    switch (started.kind) {
      case "started": {
        // ACCEPTED_TRANSPORT only; COMMITTED requires the target-returned memo (§6.4).
        const described = await this.transport.describe(workflowId, started.run_id);
        return this.#describeToDispatch(described, effect_id, argsDigest, started.run_id);
      }
      case "already_started": {
        // AMBIGUOUS: the existing run must be PROVEN to be this effect via memo, never assumed.
        const described = await this.transport.describe(workflowId);
        return this.#describeToDispatch(described, effect_id, argsDigest, undefined);
      }
      case "rejected":
        return { kind: "REJECTED_NO_EFFECT", proof_claim: { grpc_status: started.grpc_status, detail: started.detail } };
      case "ambiguous":
        return { kind: "AMBIGUOUS", raw_observation: started.detail };
    }
  }

  #describeToDispatch(
    described: Awaited<ReturnType<TemporalTransport["describe"]>>,
    effect_id: string,
    argsDigest: string,
    run_id: string | undefined,
  ): DispatchResult {
    if (described.kind === "found") {
      if (described.memo["cadp_effect_id"] === effect_id && described.memo["cadp_args_digest"] === argsDigest) {
        return {
          kind: "ACCEPTED",
          target_operation_ref: described.run_id,
          // The receipt memo comes from the Describe response, never from the request.
          receipt_claim: { run_id: described.run_id, memo: described.memo, status: described.status },
        };
      }
      return { kind: "AMBIGUOUS", raw_observation: `MEMO_MISMATCH: workflow id occupied by memo ${JSON.stringify(described.memo).slice(0, 200)}` };
    }
    if (described.kind === "not_found") {
      return { kind: "AMBIGUOUS", raw_observation: `describe NOT_FOUND after start${run_id !== undefined ? ` (run ${run_id})` : ""}` };
    }
    return { kind: "AMBIGUOUS", raw_observation: described.detail };
  }

  async reconcile(
    effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    _operation: string,
    material: Record<string, unknown>,
    context?: { admitted_at?: string },
  ): Promise<ReconcileResult> {
    const workflowId = String(material["workflow_id"]);
    const argsDigest = String(material["args_digest"]);
    let described: Awaited<ReturnType<TemporalTransport["describe"]>>;
    try {
      described = await this.transport.describe(workflowId);
    } catch (error) {
      return { kind: "UNKNOWN", unknown_reason: error instanceof Error ? error.message : String(error) };
    }
    if (described.kind === "found") {
      if (described.memo["cadp_effect_id"] === effect_id && described.memo["cadp_args_digest"] === argsDigest) {
        return {
          kind: "COMMITTED",
          target_operation_ref: described.run_id,
          receipt_claim: { run_id: described.run_id, memo: described.memo, status: described.status },
        };
      }
      // Same id, other effect: the PEP records RECEIPT_MATERIAL_MISMATCH via receipt binding.
      return { kind: "UNKNOWN", unknown_reason: `MEMO_MISMATCH: ${JSON.stringify(described.memo).slice(0, 200)}` };
    }
    if (described.kind === "not_found") {
      // Inside the retention horizon Temporal's NOT_FOUND is authoritative; outside it is not
      // (§6.4). The caller supplies the horizon judgment via admission age; the adapter is
      // conservative when it cannot prove the read fell inside the horizon.
      return this.#notFoundResult(context?.admitted_at);
    }
    return { kind: "UNKNOWN", unknown_reason: described.detail };
  }

  #notFoundResult(admittedAt: string | undefined): ReconcileResult {
    if (typeof admittedAt === "string") {
      const age = Date.now() - Date.parse(admittedAt);
      if (age < this.horizon_s * 1000) {
        return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { describe: "NOT_FOUND", inside_retention: true, horizon_s: this.horizon_s } };
      }
      return { kind: "UNKNOWN", unknown_reason: "RETENTION_EXPIRED" };
    }
    return { kind: "UNKNOWN", unknown_reason: "NOT_FOUND but retention window unprovable" };
  }

  receipt_binds(_operation: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    const memo = receipt["memo"] as Record<string, unknown> | undefined;
    return memo?.["cadp_args_digest"] === material["args_digest"];
  }
}
