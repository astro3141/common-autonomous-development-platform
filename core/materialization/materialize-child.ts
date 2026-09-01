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
import type { TaskRow } from "../store/domain-types.ts";
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
    // §19.5.1-analogue commit-time recheck (review finding 5): the snapshot's parent must exist
    // and be owned by the snapshot's own batch — validation never leases this across the gap.
    const parent = store.tasks.get(body.parent_intent.task_key);
    if (parent === undefined || parent.batch_id !== body.batch_id) {
      throw new MaterializationFailedError(
        `${body.parent_intent.task_key} is not a task of ${body.batch_id}; cross-batch materialisation is refused`,
      );
    }
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
  return store.materializations.forBatch(batch_id).map((snapshot) => operationView(store, snapshot));
}

/** One snapshot's phase projection — always keyed by the snapshot's own batch op identity. */
function operationView(
  store: PlatformStore,
  snapshot: StoredMaterializationSnapshot,
): MaterializationOperationView {
  const op_key = materializeChildOp(snapshot.batch_id, snapshot.materialization_id);
  const record = store.idempotency.get(op_key);
  const bound = boundChild(store, snapshot);
  if (record?.state === "FAILED") {
    return view(snapshot, op_key, "FAILED", null, false);
  }
  if (bound !== undefined) {
    return view(snapshot, op_key, "OBSERVED", bound.external_task_ref, bound.admitted_at !== null);
  }
  if (record?.state === "DONE") {
    // §13.4 context v2 / §8.4b (review 5493739663 R4) — a COMMITTED receipt ref is publication
    // provenance, not child identity: `task_ref` stays null until the exact TaskSource
    // round-trip commits the durable binding (OBSERVED).
    return view(snapshot, op_key, "COMMITTED_NOT_OBSERVED", null, false);
  }
  return view(snapshot, op_key, "INTENT", null, false);
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

/**
 * Review 5496784502 — durable binding corruption discovered while resolving a snapshot's child.
 * A dedicated type so the Coordinator's advance loop can converge it to the module's safe
 * conflict/pause, while every read-model and admission consumer stays a plain fail-closed throw.
 */
export class MaterializationBindingCorruptionError extends Error {}

/**
 * Resolves the one exactly-bound child of a snapshot, or `undefined` for genuine absence.
 *
 * Review 5496784502 — absence must be *proven*, not assumed: the sweep runs over every binding
 * claim in the Store (any batch), so a corrupt `materialization_id`, a bound row moved out of the
 * snapshot's batch, or a duplicate claim surfaces as corruption instead of downgrading to
 * `COMMITTED_NOT_OBSERVED`. When no claim names this snapshot, the DONE receipt's external ref is
 * used **only as a corruption-detection lookup hint** for the deterministic expected row — never
 * as child or admission authority (R4b): an unbound row at that ref stays ordinary absence, while
 * a non-null binding there that does not name this snapshot is an inconsistent durable chain.
 */
function boundChild(store: PlatformStore, snapshot: StoredMaterializationSnapshot) {
  const corrupt = (detail: string): never => {
    throw new MaterializationBindingCorruptionError(
      `materialisation ${snapshot.materialization_id} cannot resolve its child: ${detail}; ` +
        "the durable chain must be repaired before this projection is available",
    );
  };
  const claims = store.tasks
    .materializationClaims()
    .filter((task) => task.materialization_binding?.materialization_id === snapshot.materialization_id);
  if (claims.length > 1) {
    return corrupt(`duplicate binding claims (${claims.map((task) => task.task_key).join(", ")})`);
  }
  if (claims.length === 1) {
    const bound = claims[0]!;
    // The exact guard covers every leg, cross-batch included; an inexact claim fails closed.
    requireExactBindingAuthority(store, bound);
    return bound;
  }
  // Zero claims. Before declaring absence, check the deterministic expected row via the DONE
  // receipt ref — detection only, never authority.
  const record = store.idempotency.get(
    materializeChildOp(snapshot.batch_id, snapshot.materialization_id),
  );
  if (record?.state === "DONE") {
    const receipt = record.result as { external_task_ref?: unknown } | null | undefined;
    const ref = receipt?.external_task_ref;
    if (typeof ref === "string" && ref.length > 0) {
      const run = store.runs.require(store.batches.require(snapshot.batch_id).run_id);
      const expected = store.tasks.get(buildTaskKey(run.project_id, ref));
      if (expected !== undefined && expected.materialization_binding !== null) {
        return corrupt(
          `the expected child row ${expected.task_key} carries a binding that does not name this snapshot`,
        );
      }
      // Unbound row at the ref (or no row at all): the R4b boundary — ordinary absence.
    }
  }
  return undefined;
}

/**
 * §8.4b/§9.2g/§19.3c/§19.5 (review 5496386527 finding 1) — the one exact
 * snapshot ↔ binding ↔ task ↔ DONE-receipt equality check. A task's materialisation binding is
 * child identity, reservation exemption and D25 transfer authority *only* when every leg of the
 * chain agrees: the immutable snapshot the binding names (re-hashed on load), the binding's own
 * hash/source/parent/child-definition fields, the task's current body identity and external ref,
 * and the durable DONE receipt of the publish operation. Any missing, malformed or mismatched leg
 * throws — assembly and commit fail closed; nothing downgrades to INTENT, absence or OBSERVED.
 */
export function requireExactBindingAuthority(
  store: PlatformStore,
  task: TaskRow,
): StoredMaterializationSnapshot {
  const binding = task.materialization_binding;
  const fail = (leg: string): never => {
    throw new MaterializationBindingCorruptionError(
      `materialisation binding of ${task.task_key} is not the exact F authority (${leg}); ` +
        "the durable chain must be repaired before any admission may consume it",
    );
  };
  if (binding === null) return fail("binding missing");
  const snapshot = store.materializations.get(binding.materialization_id);
  if (snapshot === undefined) return fail("snapshot missing");
  if (snapshot.hash !== binding.materialization_hash) return fail("materialization_hash");
  if (snapshot.batch_id !== task.batch_id) return fail("batch");
  if (snapshot.body.task_source_id !== binding.task_source_id) return fail("task_source_id");
  if (snapshot.parent_task_key !== binding.parent_task_key) return fail("parent_task_key");
  if (snapshot.body.parent_intent.task_key !== binding.parent_task_key) return fail("parent intent");
  if (snapshot.body.child_definition_hash !== binding.child_definition_hash) {
    return fail("child_definition_hash");
  }
  if (task.external_snapshot.definition_hash !== binding.child_definition_hash) {
    return fail("task body identity");
  }
  const record = store.idempotency.get(
    materializeChildOp(snapshot.batch_id, snapshot.materialization_id),
  );
  if (record?.state !== "DONE") return fail("DONE receipt missing");
  const receipt = record.result as { materialization_id?: unknown; materialization_hash?: unknown; external_task_ref?: unknown } | null | undefined;
  if (
    receipt === null ||
    receipt === undefined ||
    receipt.materialization_id !== snapshot.materialization_id ||
    receipt.materialization_hash !== snapshot.hash ||
    receipt.external_task_ref !== task.external_task_ref
  ) {
    return fail("DONE receipt identity");
  }
  return snapshot;
}

/**
 * §19.3e (D24) — the pending-child dispatch predicate: any non-FAILED materialisation of this
 * parent whose child is not yet admitted blocks the parent's next Actor/rework external INTENT.
 */
export function pendingMaterializationsFor(
  store: PlatformStore,
  parent_task_key: string,
): readonly MaterializationOperationView[] {
  // Defensive by parent *association*, not by the parent's batch (review finding 5): even a
  // legacy/corrupt cross-batch snapshot still blocks this parent's Actor/rework dispatch.
  const pending: MaterializationOperationView[] = [];
  for (const snapshot of store.materializations.forParent(parent_task_key)) {
    const operation = operationView(store, snapshot);
    if (operation.phase !== "FAILED" && !operation.admitted) pending.push(operation);
  }
  return pending;
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

/**
 * §9.2g (D24, review finding 4) — the durable reservation-aware seat count every admission
 * consumer shares: validator V11, the §19.3a commit-time guard and the context v2 capacity
 * projection. Reserved seats are (a) every non-FAILED materialisation whose child is not yet
 * admitted and (b) each such operation's own unadmitted parent, counted once. `exclude_task_key`
 * names the admission target so the exact reserved parent (A) or the exact bound child (E)
 * consumes its own seat instead of being blocked by it — an unrelated A/E can never steal one.
 */
export function materializationReservedSeats(
  store: PlatformStore,
  batch_id: string,
  exclude_task_key?: string,
): number {
  let childSeats = 0;
  const parentSeats = new Set<string>();
  for (const snapshot of store.materializations.forBatch(batch_id)) {
    const operation = operationView(store, snapshot);
    if (operation.phase === "FAILED" || operation.admitted) continue;
    // §8.4b/§9.2g (review 5493739663 R4) — only the exact OBSERVED durable binding names the
    // child that may consume this seat. A COMMITTED receipt ref that happens to collide with a
    // pre-existing unbound task is publication provenance, never binding authority.
    const bound = operation.phase === "OBSERVED" ? boundChild(store, snapshot) : undefined;
    if (bound !== undefined && bound.task_key === exclude_task_key) {
      // The exact bound child consumes its own reserved seat.
    } else {
      childSeats += 1;
    }
    const parent = store.tasks.get(operation.parent_task_key);
    if (parent !== undefined && parent.admitted_at === null && operation.parent_task_key !== exclude_task_key) {
      parentSeats.add(operation.parent_task_key);
    }
  }
  return childSeats + parentSeats.size;
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
  for (const snapshot of store.materializations.forBatch(command.batch_id)) {
    // Review 5496784502 — a binding chain that cannot be resolved exactly is not an operation to
    // advance: recovery converges it to the module's safe conflict/pause with durable provenance,
    // never a re-published/re-observed step and never a silent skip.
    let operation: MaterializationOperationView;
    try {
      operation = operationView(store, snapshot);
    } catch (error) {
      if (error instanceof MaterializationBindingCorruptionError) {
        return pauseConflict(
          store,
          snapshot,
          materializeChildOp(snapshot.batch_id, snapshot.materialization_id),
          error.message,
        );
      }
      throw error;
    }
    if (operation.phase === "FAILED" || (operation.phase === "OBSERVED" && operation.admitted)) continue;
    if (operation.phase === "OBSERVED") continue; // awaiting the Supervisor's E decision

    if (operation.phase === "INTENT") {
      const unknown = store.decisions
        .read()
        .some(
          (entry) =>
            entry.kind === MATERIALIZATION_RECONCILE_UNKNOWN_KIND && entry.refKey === operation.op_key,
        );
      // A flagged UNKNOWN op stays read-only-reconcilable through the same single handler: an
      // exact COMMITTED converges, a target-authoritative NO_EFFECT authorizes the one same-op
      // retry, and anything unproven idempotently re-asserts UNKNOWN — never a bare-INTENT call.
      const step = unknown
        ? resolveAmbiguity(authorities, snapshot, operation.op_key, false)
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

/** Every COMMITTED receipt, on every path, binds exactly or it is nothing (review finding 3). */
function receiptBindsExactly(
  snapshot: StoredMaterializationSnapshot,
  receipt: ChildTaskMaterializationReceiptV1,
): boolean {
  return (
    receipt.materialization_id === snapshot.materialization_id &&
    receipt.materialization_hash === snapshot.hash &&
    typeof receipt.external_task_ref === "string" &&
    receipt.external_task_ref.length > 0
  );
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
    // CM3 — the effect is unproven either way; one shared handler decides, and nothing here
    // ever falls back to a retryable bare INTENT (review finding 2).
    return resolveAmbiguity(authorities, snapshot, op_key, false);
  }
  return acceptCommitted(store, snapshot, op_key, committed.receipt);
}

/** The one gate every COMMITTED result passes before DONE — direct, reconcile or retry path. */
function acceptCommitted(
  store: PlatformStore,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
  receipt: ChildTaskMaterializationReceiptV1,
): MaterializationStep {
  if (!receiptBindsExactly(snapshot, receipt)) {
    return pauseConflict(store, snapshot, op_key, "the COMMITTED receipt does not bind to this exact snapshot");
  }
  store.withTransaction(() => {
    store.idempotency.markDone(op_key, receipt as unknown as CanonicalValue);
  });
  return "MATERIALIZATION_PUBLISHED";
}

/**
 * §21 CM3 / §22 — the single ambiguous-outcome handler. Unless the reconciler proves an exact
 * `COMMITTED` or a target-authoritative `NO_EFFECT_CONFIRMED`, the operation is `UNKNOWN`:
 * journaled with same-op provenance and paused atomically. An unreadable reconciler proves
 * nothing and is therefore UNKNOWN too — never a licence to call `materialize_child` again.
 * `retry_authorized` marks the one bounded NO_EFFECT-authorized retry; if that retry is itself
 * ambiguous it lands back here with the authorization spent, so it can only go UNKNOWN.
 */
function resolveAmbiguity(
  authorities: MaterializationAuthorities,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
  retry_authorized: boolean,
): MaterializationStep | undefined {
  const { store, materializer } = authorities;
  if (materializer === undefined) return undefined;

  let answer;
  try {
    answer = materializer.reconcile_child_materialization(op_key);
  } catch {
    return markUnknown(store, snapshot, op_key);
  }

  if (answer.status === "COMMITTED") {
    if (!receiptBindsExactly(snapshot, answer.receipt)) {
      return pauseConflict(store, snapshot, op_key, "reconcile returned a receipt for a different snapshot");
    }
    return acceptCommitted(store, snapshot, op_key, answer.receipt);
  }
  if (answer.status === "NO_EFFECT_CONFIRMED") {
    if (retry_authorized) {
      // The authorization was already spent on a retry that came back ambiguous; treating a
      // second NO_EFFECT answer as a fresh licence would loop blind calls around ambiguity.
      return markUnknown(store, snapshot, op_key);
    }
    return publishAfterNoEffect(authorities, snapshot, op_key);
  }
  return markUnknown(store, snapshot, op_key);
}

/** The exactly-once NO_EFFECT-authorized same-op retry (review findings 2/3). */
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
    // The authorized retry was itself ambiguous: back through the one handler, retry spent.
    return resolveAmbiguity(authorities, snapshot, op_key, true);
  }
  return acceptCommitted(store, snapshot, op_key, committed.receipt);
}

/** UNKNOWN — same-op provenance + safe pause, atomically; the §9.2g F guard closes with it. */
function markUnknown(
  store: PlatformStore,
  snapshot: StoredMaterializationSnapshot,
  op_key: string,
): MaterializationStep {
  const alreadyFlagged = store.decisions
    .read()
    .some((entry) => entry.kind === MATERIALIZATION_RECONCILE_UNKNOWN_KIND && entry.refKey === op_key);
  const batch = store.batches.require(snapshot.batch_id);
  if (alreadyFlagged && batch.status === "PAUSED_SAFELY") return "MATERIALIZATION_UNKNOWN";
  if (batch.status === "PAUSED_SAFELY") {
    if (!alreadyFlagged) {
      store.withTransaction(() => {
        store.decisions.append({
          kind: MATERIALIZATION_RECONCILE_UNKNOWN_KIND,
          refKey: op_key,
          payload: { materialization_id: snapshot.materialization_id } as never,
        });
      });
    }
    return "MATERIALIZATION_UNKNOWN";
  }
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
    // CM5 (review 5496386527 finding 1) — a same-id row converges only when the whole durable
    // chain is exact; an inexact persisted binding is a conflict, never silent convergence.
    try {
      requireExactBindingAuthority(store, existing);
    } catch (error) {
      return pauseConflict(
        store,
        snapshot,
        op_key,
        error instanceof Error ? error.message : `${task_key} carries an inexact binding`,
      );
    }
    return undefined; // CM5 — already observed and exactly bound; nothing to do twice
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
