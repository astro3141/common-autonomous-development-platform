/**
 * ChildTaskMaterializationAdapterV1 (TD §8.1b, D24 — prospective MVP 3).
 *
 * The one bounded external-mutation interface of the child-materialisation contract: it creates
 * exactly one new task representation on the configured source, and nothing else — no update,
 * upsert, delete, close, label or dependency-graph mutation, and no repository/runtime/workflow
 * reach. It is configured from the Compiled Profile v3 `child_materializer` binding and called
 * only by the Coordinator after a validated immutable snapshot and a durable write-ahead INTENT
 * (I-TD2/I-TD9/I-TD10). Supervisor/Runtime/MCP sessions can never reach it and cannot
 * call it.
 *
 * Recovery semantics are exact (§21/§22 CM1–CM5):
 *
 *   NO_EFFECT_CONFIRMED  target-authoritative proof that this op_key produced no external effect.
 *                        The only answer that permits a same-op retry.
 *   COMMITTED(receipt)   the exact committed external identity for this op_key/hash.
 *   UNKNOWN              transient absence, eventual-consistency miss, unavailable observation,
 *                        or an inconclusive correlation. Never mapped from an ordinary 404 —
 *                        and never a licence to retry or mint a new materialization id.
 */

export interface ChildTaskMaterializationRequestV1 {
  readonly op_key: string;
  /** The accepted F Proposal's Platform-assigned `proposal_id`. */
  readonly materialization_id: string;
  /** The §8.4b immutable snapshot's envelope hash. */
  readonly materialization_hash: string;
  /** The exact §8.1a TaskDefinitionBodyV1 the Supervisor authored. */
  readonly task_definition_body: Readonly<Record<string, unknown>>;
}

export interface ChildTaskMaterializationReceiptV1 {
  readonly materialization_id: string;
  readonly materialization_hash: string;
  /** Adapter-assigned non-empty opaque ref; never supplied by the request or the Model. */
  readonly external_task_ref: string;
  /** Optional displayable opaque backend receipt reference (I-TD7 safe). */
  readonly backend_ref?: string;
}

export type ChildMaterializationReconcileResult =
  | { readonly status: "NO_EFFECT_CONFIRMED" }
  | { readonly status: "COMMITTED"; readonly receipt: ChildTaskMaterializationReceiptV1 }
  | { readonly status: "UNKNOWN" };

/**
 * A *definitive no-effect failure*: the adapter proves this op produced and will produce no
 * external effect. The only failure shape that may end an operation as FAILED and release its
 * reservation; every other throw leaves the INTENT for reconciliation.
 */
export class MaterializationFailedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "MaterializationFailedError";
  }
}

export interface ChildTaskMaterializationAdapterV1 {
  materialize_child(request: ChildTaskMaterializationRequestV1): {
    readonly status: "COMMITTED";
    readonly receipt: ChildTaskMaterializationReceiptV1;
  };
  reconcile_child_materialization(op_key: string): ChildMaterializationReconcileResult;
}
