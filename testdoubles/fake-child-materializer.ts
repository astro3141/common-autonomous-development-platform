/**
 * FakeChildMaterializer — the §8.1b semantic stub (D24).
 *
 * The fake honours the exact contract: one committed external representation per
 * `op_key + materialization_hash`, the same receipt on every same-op call, `NO_EFFECT_CONFIRMED`
 * only as an explicit target-authoritative script, and `UNKNOWN` for everything unproven. Tests
 * move one external fact at a time by scripting the next answer.
 */

import {
  MaterializationFailedError,
  type ChildMaterializationReconcileResult,
  type ChildTaskMaterializationAdapterV1,
  type ChildTaskMaterializationRequestV1,
  type ChildTaskMaterializationReceiptV1,
} from "../adapters/interfaces/child-materialization-adapter.ts";

export class FakeChildMaterializer implements ChildTaskMaterializationAdapterV1 {
  readonly calls: string[] = [];
  readonly #committed = new Map<string, ChildTaskMaterializationReceiptV1>();
  #next = 0;

  /** When set, the next materialize_child throws this once (crash-window scripting). */
  failNextWith: Error | undefined;
  /** When set, reconcile answers this instead of deriving from committed state. */
  reconcileAnswer: ChildMaterializationReconcileResult | undefined;
  /** Ref prefix for committed children; tests read receipts back through the store. */
  refPrefix = "CHILD-";

  materialize_child(request: ChildTaskMaterializationRequestV1): {
    readonly status: "COMMITTED";
    readonly receipt: ChildTaskMaterializationReceiptV1;
  } {
    this.calls.push(`materialize:${request.op_key}`);
    if (this.failNextWith !== undefined) {
      const failure = this.failNextWith;
      this.failNextWith = undefined;
      throw failure;
    }
    const existing = this.#committed.get(request.op_key);
    if (existing !== undefined) {
      if (existing.materialization_hash !== request.materialization_hash) {
        throw new MaterializationFailedError(`${request.op_key} was committed with a different hash`);
      }
      return { status: "COMMITTED", receipt: existing };
    }
    const receipt: ChildTaskMaterializationReceiptV1 = {
      materialization_id: request.materialization_id,
      materialization_hash: request.materialization_hash,
      external_task_ref: `${this.refPrefix}${++this.#next}`,
    };
    this.#committed.set(request.op_key, receipt);
    return { status: "COMMITTED", receipt };
  }

  reconcile_child_materialization(op_key: string): ChildMaterializationReconcileResult {
    this.calls.push(`reconcile:${op_key}`);
    if (this.reconcileAnswer !== undefined) return this.reconcileAnswer;
    const committed = this.#committed.get(op_key);
    if (committed !== undefined) return { status: "COMMITTED", receipt: committed };
    // An honest fake answers UNKNOWN for anything it cannot prove — absence is not proof.
    return { status: "UNKNOWN" };
  }

  /** The committed receipt for an op, for tests that play the TaskSource side. */
  committedReceipt(op_key: string): ChildTaskMaterializationReceiptV1 | undefined {
    return this.#committed.get(op_key);
  }
}
