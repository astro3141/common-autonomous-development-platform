/**
 * Bounded child-task materialisation (TD §5.3a/§8.4b/§9.2g/§17.3/§19.3e/§21/§22, D24 — MVP 3).
 *
 * The authority chain is exactly the landed one:
 *
 *     validated F Proposal
 *     → immutable snapshot + idempotency INTENT (+ decision provenance) in one transaction
 *     → ChildTaskMaterializationAdapterV1.materialize_child, outside the transaction
 *     → COMMITTED receipt durable as the operation's DONE result
 *     → same configured TaskSource fresh round-trip, exact body/hash equality
 *     → §8.4 DISCOVERED row + immutable ChildMaterializationBindingV1, one transaction
 *
 * Publication is never admission: no Attempt, no Grant, no Task Contract, no parent suspension
 * happens anywhere in this module. `NO_EFFECT_CONFIRMED` alone permits a same-op retry; `UNKNOWN`
 * pauses the batch with same-op provenance and blocks every new F INTENT until the operation
 * reaches a terminal idempotency state — a mis-cleared pause does not reopen it (§9.2g). Nothing
 * here ever mints a second materialization id or fabricates a replacement child.
 */

import {
  MaterializationFailedError,
  type ChildTaskMaterializationAdapterV1,
  type ChildTaskMaterializationReceiptV1,
} from "../../adapters/interfaces/child-materialization-adapter.ts";
import { canonicalize, type CanonicalValue } from "../schemas/canonical-json.ts";
import { taskKey as buildTaskKey } from "../schemas/identifiers.ts";
import {
  commitBatchFact,
  commitMaterializedChildDiscovery,
  type TransitionRecord,
} from "../statemachine/transition-commit.ts";
import { blockedByDecision, materializationRejected, subflowChildOf } from "../statemachine/types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { StoredMaterializationSnapshot } from "../store/materialization-store.ts";
import { TaskSourceError } from "../tasksource/errors.ts";
import { normalizeTaskDefinition } from "../tasksource/task-definition.ts";
import type { TaskSourceV1 } from "../tasksource/types.ts";
import {
  materializeChildOp,
  type SealedMaterializationSnapshot,
} from "./snapshot.ts";

export const MATERIALIZATION_INTENT_KIND = "materialization_intent";
export const MATERIALIZATION_RECONCILE_UNKNOWN_KIND = "materialization_reconcile_unknown";

export interface MaterializationAuthorities {
  readonly store: PlatformStore;
  readonly taskSource: TaskSourceV1;
  /** Absent when the Compiled Profile v3 feature is unavailable. */
  readonly materializer?: ChildTaskMaterializationAdapterV1;
}

// --- accepted F → durable snapshot + write-ahead INTENT ------------------------------------------

export interface MaterializationIntentCommand {
  readonly sealed: SealedMaterializationSnapshot;
  /** §17.3 — present when a resolved F Human Gate applies this acceptance. */
  readonly resolved_decision_id?: string;
  /** §17.3 — restore the gate-held parent to its exact tagged origin in the same transaction. */
  readonly restore_parent_origin?: "DISCOVERED" | "ACTIVE";
}

/**
 * One transaction: immutable snapshot + `materialization_intent` provenance + idempotency INTENT
 * (+ gate application ref + parent origin restore). The adapter call is never inside it.
 */
export function commitMaterializationIntent(
  store: PlatformStore,
  command: MaterializationIntentCommand,
): { readonly op_key: string; readonly transition: TransitionRecord } {
  const body = command.sealed.body;
  const op_key = materializeChildOp(body.batch_id, body.materialization_id);
  return store.withTransaction(() => {
    store.materializations.put(command.sealed);
    const entry = store.decisions.append({
      kind: MATERIALIZATION_INTENT_KIND,
      refKey: op_key,
      payload: {
        materialization_id: body.materialization_id,
        batch_id: body.batch_id,
        parent_task_key: body.parent_intent.task_key,
        child_definition_hash: body.child_definition_hash,
      } as never,
    });
    store.idempotency.beginIntent(op_key);
    if (command.resolved_decision_id !== undefined) {
      store.pendingDecisions.recordAppliedTransition(command.resolved_decision_id, entry.seq);
      const parent = store.tasks.require(body.parent_intent.task_key);
      if (parent.state_reason?.code !== blockedByDecision(command.resolved_decision_id)) {
        throw new MaterializationFailedError(
          `${parent.task_key} is not held by ${command.resolved_decision_id}`,
        );
      }
      store.tasks.write(parent.task_key, {
        platform_state: command.restore_parent_origin ?? "DISCOVERED",
        clear_reason: true,
      });
    }
    return { op_key, transition: { seq: entry.seq, ref: `transition:${entry.seq}` } };
  });
}

// --- durable read models --------------------------------------------------------------------------

export type MaterializationPhase = "INTENT" | "COMMITTED_NOT_OBSERVED" | "OBSERVED" | "FAILED";

export interface MaterializationOperationView {
  readonly materialization_id: string;
  readonly parent_task_key: string;
  readonly child_definition_hash: string;
  readonly phase: MaterializationPhase;
  readonly task_ref: string | null;
  readonly op_key: string;
  /** OBSERVED only — whether the bound child has already been admitted. */
  readonly admitted: boolean;
}

/** The exact read-only projection of one batch's materialisation operations. */
export function materializationOperations(
  store: PlatformStore,
  batch_id: string,
): readonly MaterializationOperationView[] {
  return store.materializations.forBatch(batch_id).map((snapshot) => {
    const op_key = materializeChildOp(batch_id, snapshot.materialization_id);
    const record = store.idempotency.get(op_key);
    const bound = boundChild(store, snapshot);
    if (record?.state === "FAILED") {
      return view(snapshot, op_key, "FAILED", null, false);
    }
    if (bound !== undefined) {
      return view(snapshot, op_key, "OBSERVED", bound.external_task_ref, bound.admitted_at !== null);
    }
    if (record?.state === "DONE") {
      const receipt = record.result as unknown as ChildTaskMaterializationReceiptV1 | undefined;
      return view(snapshot, op_key, "COMMITTED_NOT_OBSERVED", receipt?.external_task_ref ?? null, false);
    }
    return view(snapshot, op_key, "INTENT", null, false);
  });
}

function view(
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
  phase: MaterializationPhase,
  task_ref: string | null,
  admitted: boolean,
): MaterializationOperationView {
  return {
    materialization_id: snapshot.materialization_id,
    parent_task_key: snapshot.parent_task_key,
    child_definition_hash: snapshot.body.child_definition_hash,
    phase,
    task_ref,
    op_key,
    admitted,
  };
}

function boundChild(store: PlatformStore, snapshot: StoredMaterializationSnapshot) {
  return store.tasks
    .inBatch(snapshot.batch_id)
    .find((task) => task.materialization_binding?.materialization_id === snapshot.materialization_id);
}

/**
 * §19.3e (D24) — the pending-child dispatch predicate: any non-FAILED materialisation of this
 * parent whose child is not yet admitted blocks the parent's next Actor/rework external INTENT.
 */
export function pendingMaterializationsFor(
  store: PlatformStore,
  parent_task_key: string,
): readonly MaterializationOperationView[] {
  const parent = store.tasks.get(parent_task_key);
  if (parent === undefined) return [];
  return materializationOperations(store, parent.batch_id).filter(
    (operation) =>
      operation.parent_task_key === parent_task_key &&
      operation.phase !== "FAILED" &&
      !operation.admitted,
  );
}

/** §9.2g — true while an op is INTENT with same-op UNKNOWN provenance journaled. */
export function hasUnresolvedUnknown(store: PlatformStore, batch_id: string): boolean {
  return materializationOperations(store, batch_id).some(
    (operation) =>
      operation.phase === "INTENT" &&
      store.decisions
        .read()
        .some(
          (entry) =>
            entry.kind === MATERIALIZATION_RECONCILE_UNKNOWN_KIND && entry.refKey === operation.op_key,
        ),
  );
}

/** §9.2g — the F local-guard/reservation facts, derived from durable exact state only. */
export function materializationBatchFacts(
  store: PlatformStore,
  batch_id: string,
): {
  readonly has_unresolved_unknown_materialization: boolean;
  readonly unadmitted_materialized_child_count: number;
} {
  const operations = materializationOperations(store, batch_id);
  return {
    has_unresolved_unknown_materialization: hasUnresolvedUnknown(store, batch_id),
    unadmitted_materialized_child_count: operations.filter(
      (operation) => operation.phase !== "FAILED" && !operation.admitted,
    ).length,
  };
}

// --- the bounded external step -------------------------------------------------------------------

export type MaterializationStep =
  | "MATERIALIZATION_PUBLISHED"
  | "MATERIALIZATION_OBSERVED"
  | "MATERIALIZATION_FAILED"
  | "MATERIALIZATION_UNKNOWN"
  | "MATERIALIZATION_CONFLICT";

/**
 * Advances at most one materialisation operation of one batch by one bounded external step
 * (publish, reconcile, or round-trip). Restart-deterministic: every judgement derives from the
 * immutable snapshot + idempotency + task binding, so CM1–CM5 converge without duplicates.
 */
export function advanceMaterializations(
  authorities: MaterializationAuthorities,
  command: { readonly run_id: string; readonly batch_id: string; readonly observed_at: string },
): MaterializationStep | undefined {
  const { store } = authorities;
  for (const operation of materializationOperations(store, command.batch_id)) {
    if (operation.phase === "FAILED" || (operation.phase === "OBSERVED" && operation.admitted)) continue;
    if (operation.phase === "OBSERVED") continue; // awaiting the Supervisor's E decision

    const snapshot = store.materializations.require(operation.materialization_id);

    if (operation.phase === "INTENT") {
      const unknown = store.decisions
        .read()
        .some(
          (entry) =>
            entry.kind === MATERIALIZATION_RECONCILE_UNKNOWN_KIND && entry.refKey === operation.op_key,
        );
      const step = unknown
        ? reconcileIntent(authorities, snapshot, operation.op_key)
        : publish(authorities, snapshot, operation.op_key);
      if (step !== undefined) return step;
      continue;
    }

    // COMMITTED_NOT_OBSERVED — resume the exact TaskSource round-trip with the stored receipt.
    const record = store.idempotency.get(operation.op_key);
    const receipt = record?.result as unknown as ChildTaskMaterializationReceiptV1 | undefined;
    if (receipt === undefined) continue;
    const step = roundTrip(authorities, snapshot, receipt, command.observed_at);
    if (step !== undefined) return step;
  }
  return undefined;
}

/** CM2 — the same-op adapter call after a durable INTENT. */
function publish(
  authorities: MaterializationAuthorities,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
): MaterializationStep | undefined {
  const { store, materializer } = authorities;
  if (materializer === undefined) return undefined; // feature unavailable; nothing to actuate

  let committed;
  try {
    committed = materializer.materialize_child({
      op_key,
      materialization_id: snapshot.materialization_id,
      materialization_hash: snapshot.hash,
      task_definition_body: snapshot.body.child_definition_body,
    });
  } catch (error) {
    if (error instanceof MaterializationFailedError) {
      // The only failure that ends the operation: target-authoritative proof of no effect.
      return failDefinitively(store, snapshot, op_key, error.message);
    }
    // CM3 — the effect is unproven either way; reconcile through the same op identity.
    return reconcileIntent(authorities, snapshot, op_key);
  }

  const receipt = committed.receipt;
  if (
    receipt.materialization_id !== snapshot.materialization_id ||
    receipt.materialization_hash !== snapshot.hash ||
    receipt.external_task_ref.length === 0
  ) {
    return pauseConflict(store, snapshot, op_key, "the adapter receipt does not bind to this exact snapshot");
  }
  store.withTransaction(() => {
    store.idempotency.markDone(op_key, receipt as unknown as CanonicalValue);
  });
  return "MATERIALIZATION_PUBLISHED";
}

/** §21 CM3 / §22 — the same-op reconciliation with exact D24 answer semantics. */
function reconcileIntent(
  authorities: MaterializationAuthorities,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
): MaterializationStep | undefined {
  const { store, materializer } = authorities;
  if (materializer === undefined) return undefined;

  let answer;
  try {
    answer = materializer.reconcile_child_materialization(op_key);
  } catch {
    return undefined; // an unreadable reconciler proves nothing; try again later
  }

  if (answer.status === "COMMITTED") {
    if (
      answer.receipt.materialization_id !== snapshot.materialization_id ||
      answer.receipt.materialization_hash !== snapshot.hash
    ) {
      return pauseConflict(store, snapshot, op_key, "reconcile returned a receipt for a different snapshot");
    }
    store.withTransaction(() => {
      store.idempotency.markDone(op_key, answer.receipt as unknown as CanonicalValue);
    });
    return "MATERIALIZATION_PUBLISHED";
  }
  if (answer.status === "NO_EFFECT_CONFIRMED") {
    // Authoritative no-effect: the same op may be called again. The INTENT simply stands.
    return publishAfterNoEffect(authorities, snapshot, op_key);
  }
  // UNKNOWN — no blind retry, no second identity: the batch pauses with same-op provenance, and
  // the §9.2g guard keeps every new F INTENT closed until this op reaches a terminal state.
  const alreadyFlagged = store.decisions
    .read()
    .some((entry) => entry.kind === MATERIALIZATION_RECONCILE_UNKNOWN_KIND && entry.refKey === op_key);
  const batch = store.batches.require(snapshot.batch_id);
  if (alreadyFlagged && batch.status === "PAUSED_SAFELY") return undefined;
  commitBatchFact(store, {
    batch_id: snapshot.batch_id,
    fact: { kind: "CIRCUIT_BREAKER", also_pause_run: false },
    within: () => {
      if (!alreadyFlagged) {
        store.decisions.append({
          kind: MATERIALIZATION_RECONCILE_UNKNOWN_KIND,
          refKey: op_key,
          payload: { materialization_id: snapshot.materialization_id } as never,
        });
      }
    },
  });
  return "MATERIALIZATION_UNKNOWN";
}

function publishAfterNoEffect(
  authorities: MaterializationAuthorities,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
): MaterializationStep | undefined {
  const { store, materializer } = authorities;
  if (materializer === undefined) return undefined;
  let committed;
  try {
    committed = materializer.materialize_child({
      op_key,
      materialization_id: snapshot.materialization_id,
      materialization_hash: snapshot.hash,
      task_definition_body: snapshot.body.child_definition_body,
    });
  } catch (error) {
    if (error instanceof MaterializationFailedError) {
      return failDefinitively(store, snapshot, op_key, error.message);
    }
    return undefined; // still unproven; the INTENT stands for the next pass
  }
  store.withTransaction(() => {
    store.idempotency.markDone(op_key, committed.receipt as unknown as CanonicalValue);
  });
  return "MATERIALIZATION_PUBLISHED";
}

/** CM4/CM5 — the exact TaskSource round-trip and the one-transaction DISCOVERED+binding commit. */
function roundTrip(
  authorities: MaterializationAuthorities,
  snapshot: StoredMaterializationSnapshot,
  receipt: ChildTaskMaterializationReceiptV1,
  observed_at: string,
): MaterializationStep | undefined {
  const { store, taskSource } = authorities;

  let raw;
  try {
    raw = taskSource.get_task(receipt.external_task_ref);
  } catch (error) {
    if (error instanceof TaskSourceError && error.reason === "TASK_NOT_FOUND") {
      // Visibility delay: the DONE receipt is preserved and the same ref re-observed later.
      return undefined;
    }
    return undefined; // unreadable source: observe again later, never guess
  }

  let definition;
  try {
    definition = normalizeTaskDefinition(
      {
        task_ref: raw.task_ref,
        version: raw.version,
        ...(raw.definition_hash === undefined ? {} : { definition_hash: raw.definition_hash }),
        body: raw.body,
      },
      "/materialized_child",
    );
  } catch {
    return pauseConflict(store, snapshot, materializeChildOp(snapshot.batch_id, snapshot.materialization_id), "the published child failed normalization");
  }

  const exact =
    definition.task_ref === receipt.external_task_ref &&
    definition.definition_hash === snapshot.body.child_definition_hash &&
    canonicalize(definition.body as never) === canonicalize(snapshot.body.child_definition_body as never);
  const op_key = materializeChildOp(snapshot.batch_id, snapshot.materialization_id);
  if (!exact) {
    return pauseConflict(store, snapshot, op_key, "the round-trip body/hash does not equal the snapshot");
  }

  const run = store.runs.require(store.batches.require(snapshot.batch_id).run_id);
  const task_key = buildTaskKey(run.project_id, receipt.external_task_ref);
  const existing = store.tasks.get(task_key);
  if (existing !== undefined) {
    const binding = existing.materialization_binding;
    if (binding === null || binding.materialization_id !== snapshot.materialization_id) {
      return pauseConflict(store, snapshot, op_key, `${task_key} exists without this exact binding`);
    }
    return undefined; // CM5 — already observed and bound; nothing to do twice
  }

  const external_state = taskSource.get_task_state(receipt.external_task_ref);
  commitMaterializedChildDiscovery(store, {
    task_key,
    batch_id: snapshot.batch_id,
    project_id: run.project_id,
    external_task_ref: receipt.external_task_ref,
    external_snapshot: {
      external_state,
      version: definition.version,
      definition_hash: definition.definition_hash,
      observed_at,
    },
    binding: {
      materialization_id: snapshot.materialization_id,
      materialization_hash: snapshot.hash,
      task_source_id: snapshot.body.task_source_id,
      parent_task_key: snapshot.parent_task_key,
      child_definition_hash: snapshot.body.child_definition_hash,
    },
  });
  return "MATERIALIZATION_OBSERVED";
}

/** §8.4b — definitive no-effect: FAILED + reservation released + parent held for replanning. */
function failDefinitively(
  store: PlatformStore,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
  detail: string,
): MaterializationStep {
  store.withTransaction(() => {
    store.idempotency.markFailed(op_key, { detail } as unknown as CanonicalValue);
    const parent = store.tasks.get(snapshot.parent_task_key);
    if (parent !== undefined && (parent.platform_state === "DISCOVERED" || parent.platform_state === "ACTIVE")) {
      const entry = store.decisions.append({
        kind: "state_transition",
        refKey: parent.task_key,
        payload: {
          primary_entity_key: parent.task_key,
          task: { from: parent.platform_state, to: "HELD" },
          reason_code: "TASK_MATERIALIZATION_FAILED",
        } as never,
      });
      store.tasks.write(parent.task_key, {
        platform_state: "HELD",
        reason: { code: "TASK_MATERIALIZATION_FAILED", log_seq: entry.seq },
      });
    }
  });
  return "MATERIALIZATION_FAILED";
}

function pauseConflict(
  store: PlatformStore,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
  detail: string,
): MaterializationStep {
  const batch = store.batches.require(snapshot.batch_id);
  if (batch.status !== "PAUSED_SAFELY") {
    commitBatchFact(store, {
      batch_id: snapshot.batch_id,
      fact: { kind: "CIRCUIT_BREAKER", also_pause_run: false },
      within: () => {
        store.decisions.append({
          kind: "materialization_conflict",
          refKey: op_key,
          payload: { detail, reason_code: "TASK_MATERIALIZATION_CONFLICT" } as never,
        });
      },
    });
  }
  return "MATERIALIZATION_CONFLICT";
}

// --- §17.3 gate integration ----------------------------------------------------------------------

/** Parks the F parent on the exact open gate decision (Rule A), freezing its tagged origin. */
export function holdParentForMaterializationGate(
  store: PlatformStore,
  command: { readonly parent_task_key: string; readonly decision_id: string },
): void {
  store.withTransaction(() => {
    const parent = store.tasks.require(command.parent_task_key);
    if (parent.platform_state !== "DISCOVERED" && parent.platform_state !== "ACTIVE") {
      throw new MaterializationFailedError(
        `${parent.task_key} is ${parent.platform_state}; only a DISCOVERED or ACTIVE parent gates an F`,
      );
    }
    const entry = store.decisions.append({
      kind: "state_transition",
      refKey: parent.task_key,
      payload: {
        primary_entity_key: parent.task_key,
        task: { from: parent.platform_state, to: "HELD" },
        reason_code: blockedByDecision(command.decision_id),
      } as never,
    });
    store.tasks.write(parent.task_key, {
      platform_state: "HELD",
      reason: { code: blockedByDecision(command.decision_id), log_seq: entry.seq },
    });
  });
}

/** REJECT — zero external effect; the parent asks for a replan under the exact refused decision. */
export function applyRejectedMaterializationGate(
  store: PlatformStore,
  command: { readonly parent_task_key: string; readonly decision_id: string },
): void {
  store.withTransaction(() => {
    const parent = store.tasks.require(command.parent_task_key);
    if (parent.state_reason?.code !== blockedByDecision(command.decision_id)) {
      throw new MaterializationFailedError(
        `${parent.task_key} is not held by ${command.decision_id}`,
      );
    }
    const entry = store.decisions.append({
      kind: "state_transition",
      refKey: parent.task_key,
      payload: {
        primary_entity_key: parent.task_key,
        task: { from: "HELD", to: "HELD" },
        reason_code: materializationRejected(command.decision_id),
      } as never,
    });
    store.pendingDecisions.recordAppliedTransition(command.decision_id, entry.seq);
    store.tasks.write(parent.task_key, {
      platform_state: "HELD",
      reason: { code: materializationRejected(command.decision_id), log_seq: entry.seq },
    });
  });
}

/** Keeps the module's only subflowChildOf import meaningful for future relation reads. */
export const boundSubflowChildOf = subflowChildOf;
