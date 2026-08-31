/**
 * Atomic transition commit (TD §18.2, §19.3, §19.3a, §20).
 *
 * Each command owns exactly one `BEGIN IMMEDIATE` transaction and, inside it:
 *
 *   read the current durable rows → derive the read-model → evaluate the guard →
 *   append the `state_transition` journal entry → write every row → commit
 *
 * The journal append comes before the row writes only because a HELD/FAILED row must reference
 * the entry that explains it; both are in the same transaction, so a failure anywhere rolls the
 * whole transition back and no half-held task can survive.
 *
 * Nothing here calls an adapter. Every external fact is a typed argument.
 */

import type { TaskContractBuildResult } from "../contract/builder.ts";
import type { PendingDecisionV1 } from "../humandecision/types.ts";
import { subjectKey } from "../humandecision/pending-decision.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { SELECTION_STALE } from "./types.ts";
import {
  isTerminalTask,
  type AttemptState,
  type BatchRow,
  type BatchState,
  type ExternalTaskSnapshotV1,
  type SelectionBindingV1,
  type TaskRow,
  type TaskSelectionFields,
  type TaskState,
} from "../store/domain-types.ts";
import {
  admissionBecomesClosed,
  assertAdmissible,
  pipelineHasActor,
} from "./admission.ts";
import { nextAttemptOutcome } from "./attempt-transitions.ts";
import { nextBatchOutcome, type BatchTaskCounts } from "./batch-transitions.ts";
import type { BatchOutcome } from "./types.ts";
import { illegal, TransitionError } from "./errors.ts";
import { blockedByDecision, isReasonCode, type AttemptFact, type BatchFact } from "./types.ts";

/** TD §18.2 — the transition journal kind. Distinct from Batch 7's `decision_validation`. */
export const STATE_TRANSITION_KIND = "state_transition";

export interface StateChange {
  readonly from: string;
  readonly to: string;
}

export interface TransitionRecord {
  readonly seq: number;
  readonly ref: string;
}

export interface TransitionResult {
  readonly transition: TransitionRecord;
  readonly task?: TaskRow;
  readonly batch?: BatchRow;
}

// --- discovery ---------------------------------------------------------------------------

export interface DiscoverTaskCommand {
  readonly task_key: string;
  readonly batch_id: string;
  readonly project_id: string;
  readonly external_task_ref: string;
  readonly external_snapshot: ExternalTaskSnapshotV1;
}

/** Records a newly observed task in `DISCOVERED`. Admission is a separate decision. */
export function commitTaskDiscovery(
  store: PlatformStore,
  command: DiscoverTaskCommand,
): TransitionResult {
  return store.withTransaction(() => {
    const transition = appendTransition(store, {
      primary_entity_key: command.task_key,
      task: { from: "-", to: "DISCOVERED" },
    });
    const task = store.tasks.discover(command);
    return { transition, task };
  });
}

// --- admission ----------------------------------------------------------------------------

export interface AdmissionCommand {
  readonly task_key: string;
  readonly selection: TaskSelectionFields;
  /** TD §7.1a (M1-6) — the declared scope id this selection chose. */
  readonly repository_scope_id: string;
  /** TD §19.3a (M1-7) — the authoritative facts this selection was validated against. */
  readonly selection_binding: SelectionBindingV1;
  /** Caller-supplied observation time for the admission marker. */
  readonly admitted_at: string;
  /**
   * TD §8.4a — the Coordinator's direct-HARD-dependency fact, recomputed for this commit. A plain
   * boolean on purpose: no fact bundle, no dependency object graph, and no adapter import here.
   */
  readonly hard_dependencies_clear: boolean;
  /**
   * Present for the human-gate path (TD §17.3): the task must currently be HELD by exactly this
   * decision, and the transition ref is written back into its resolution.
   */
  readonly resolved_decision_id?: string;
  /**
   * MVP 3 (Spec §47/§68) — present for a `START_SUBFLOW` admission: the child is linked to this
   * parent, and an ACTIVE parent is suspended in the same transaction. A parent that is already
   * HELD keeps its own blocker — suspension never erases a held reason.
   */
  readonly subflow_parent_task_key?: string;
}

/**
 * `DISCOVERED → SELECTED`, or `HELD(BLOCKED_BY_DECISION:<id>) → SELECTED` after a resolved Human
 * Gate. Both paths run the same commit-time durable admission guard (§19.3a).
 */
export function commitAdmission(store: PlatformStore, command: AdmissionCommand): TransitionResult {
  return store.withTransaction(() => {
    const task = store.tasks.require(command.task_key);
    const batch = store.batches.require(task.batch_id);

    // §9.2e/§19.3a (M1-7) — a HELD(SELECTION_STALE) task is reselecting, not being admitted.
    const reselection =
      task.platform_state === "HELD" && task.state_reason?.code === SELECTION_STALE;
    if (reselection) {
      if (task.admitted_at === null) {
        throw illegal(`${task.task_key} is SELECTION_STALE without an admission marker`);
      }
      if (store.attempts.current(task.task_key) !== undefined) {
        throw illegal(`${task.task_key} still has a non-terminal attempt`);
      }
    } else if (command.resolved_decision_id === undefined) {
      if (task.platform_state !== "DISCOVERED") {
        throw illegal(`admission requires DISCOVERED, not ${task.platform_state}`);
      }
    } else {
      if (task.platform_state !== "HELD") {
        throw illegal(`a gated admission requires HELD, not ${task.platform_state}`);
      }
      const expected = blockedByDecision(command.resolved_decision_id);
      if (task.state_reason?.code !== expected) {
        throw new TransitionError(
          "COMMAND_INVALID",
          `${task.task_key} is not held by ${command.resolved_decision_id}`,
        );
      }
    }

    // Same durable recheck for both paths — Batch 7's V11 pass is not taken on trust.
    const compiled = store.batchView.compiledProfileFor(batch.batch_id);
    assertAdmissible({
      view: store.batchView.project(batch.batch_id),
      policy: compiled.effective.policy.batch_policy,
      // §9.2e — a reselection re-uses the slot it already holds, so neither `max_tasks` nor
      // `admission_closed` is consumed again; concurrency and the writable slot still are.
      admission_closed: reselection ? false : batch.admission_closed,
      consumes_admission_slot: !reselection,
      pipeline_has_actor: pipelineHasActor(compiled, command.selection.pipeline_id),
      hard_dependencies_clear: command.hard_dependencies_clear,
    });

    const transition = appendTransition(store, {
      primary_entity_key: task.task_key,
      task: { from: task.platform_state, to: "SELECTED" },
      pending_decision_id: command.resolved_decision_id ?? null,
    });

    const selection = {
      selection: command.selection,
      repository_scope_id: command.repository_scope_id,
      selection_binding: command.selection_binding,
    };
    const updated = store.tasks.write(task.task_key, {
      platform_state: "SELECTED",
      selection,
      // §19.3a — reselection replaces the whole selection; `admitted_at` is left as it was.
      ...(reselection ? { replace_selection: true, clear_reason: true } : {}),
      ...(reselection ? {} : { admitted_at: command.admitted_at }),
    });

    // Filling the batch closes admission in the very transaction that filled it (§19.3a).
    // A reselection consumed no new slot, so it can never be what closes admission.
    let currentBatch = batch;
    if (
      !reselection &&
      admissionBecomesClosed(
        store.batchView.admitted(batch.batch_id),
        compiled.effective.policy.batch_policy,
      )
    ) {
      currentBatch = store.batches.closeAdmission(batch.batch_id);
    }

    if (command.resolved_decision_id !== undefined) {
      store.pendingDecisions.recordAppliedTransition(command.resolved_decision_id, transition.seq);
    }

    if (command.subflow_parent_task_key !== undefined) {
      linkSubflowParent(store, task.task_key, command.subflow_parent_task_key);
    }

    return { transition, task: store.tasks.require(task.task_key), batch: currentBatch };
  });
}

/**
 * MVP 3 — links an admitted subflow child to its parent and suspends an ACTIVE parent
 * (Spec §47: Parent Task → SUSPENDED). Runs inside the admission transaction: a subflow whose
 * parent cannot be linked is not admitted at all.
 */
function linkSubflowParent(store: PlatformStore, childKey: string, parentKey: string): void {
  if (childKey === parentKey) throw illegal(`${childKey} cannot be its own subflow parent`);
  const child = store.tasks.require(childKey);
  const parent = store.tasks.require(parentKey);
  if (parent.batch_id !== child.batch_id) {
    throw illegal(`subflow parent ${parentKey} is not in ${child.batch_id}`);
  }
  if (
    parent.platform_state !== "ACTIVE" &&
    parent.platform_state !== "HELD" &&
    parent.platform_state !== "SUSPENDED"
  ) {
    throw illegal(`subflow parent ${parentKey} is ${parent.platform_state}; nothing to suspend`);
  }

  store.tasks.write(childKey, { platform_state: child.platform_state, parent_task_key: parentKey });
  if (parent.platform_state === "ACTIVE") {
    appendTransition(store, {
      primary_entity_key: parentKey,
      task: { from: "ACTIVE", to: "SUSPENDED" },
    });
    store.tasks.write(parentKey, { platform_state: "SUSPENDED" });
  }
}

/**
 * MVP 3 — `SUSPENDED → ACTIVE`. Explicitly by a validated `RESUME_PARENT` Proposal, or by the
 * Coordinator when every subflow child has COMPLETED (Spec §47: Child PASS → Parent RESUME).
 * The parent's Attempt was never touched by the suspension, so nothing else changes.
 */
export function commitParentResume(store: PlatformStore, parentTaskKey: string): TransitionResult {
  return store.withTransaction(() => {
    const parent = store.tasks.require(parentTaskKey);
    if (parent.platform_state !== "SUSPENDED") {
      throw illegal(`resume requires SUSPENDED, not ${parent.platform_state}`);
    }
    const transition = appendTransition(store, {
      primary_entity_key: parentTaskKey,
      task: { from: "SUSPENDED", to: "ACTIVE" },
    });
    return { transition, task: store.tasks.write(parentTaskKey, { platform_state: "ACTIVE" }) };
  });
}

/**
 * TD §19.3a (M1-7) — `SELECTED → HELD(SELECTION_STALE)`.
 *
 * Reached only when activation's equality gate fails, i.e. *before* any contract artifact is
 * built. Selection fields, the binding and `admitted_at` are all left in place: the task is still
 * the same admitted task, it simply needs a fresh Supervisor decision for the world as it is now.
 */
export interface SelectionStaleCommand {
  readonly task_key: string;
  /** Generic provenance of what disagreed; only values admissible under I-TD7. */
  readonly mismatch: CanonicalObject;
}

export function commitSelectionStale(
  store: PlatformStore,
  command: SelectionStaleCommand,
): TransitionResult {
  return store.withTransaction(() => {
    const task = store.tasks.require(command.task_key);
    if (task.platform_state !== "SELECTED") {
      throw illegal(`a stale selection requires SELECTED, not ${task.platform_state}`);
    }
    if (store.attempts.current(task.task_key) !== undefined) {
      throw illegal(`${task.task_key} already has a non-terminal attempt`);
    }

    const transition = appendTransition(store, {
      primary_entity_key: task.task_key,
      task: { from: "SELECTED", to: "HELD" },
      reason_code: SELECTION_STALE,
      mismatch: command.mismatch,
    });
    const updated = store.tasks.write(task.task_key, {
      platform_state: "HELD",
      reason: { code: SELECTION_STALE, log_seq: transition.seq },
    });
    return { transition, task: updated };
  });
}

/**
 * TD §19.3/§24 — the two ways activation can fail after the selection binding still held.
 *
 * Both are reached only once the activation transaction has already rolled back, so neither can
 * leave a half-built contract behind: the failure transition is its own small transaction whose
 * only writes are the task's state, its reason, and the journal entry the reason points at.
 * Selection provenance is deliberately kept — it is the historical record of what was attempted.
 */
export interface ActivationFailureCommand {
  readonly task_key: string;
  /** Generic detail for the journal; values admissible under I-TD7 only. */
  readonly detail: CanonicalObject;
}

/**
 * A contract that could not be *constructed* even though its authoritative inputs were valid —
 * a missing declared source, a capture failure, a malformed artifact. TD §24 makes this terminal:
 * the task failed, and re-running it needs a new decision rather than a retry.
 */
export function commitContractBuildFailure(
  store: PlatformStore,
  command: ActivationFailureCommand,
): TransitionResult {
  return commitActivationFailure(store, command, "FAILED", "CONTRACT_BUILD_ERROR");
}

/**
 * The current Backend no longer satisfies the capability requirements (§9.2 V10, re-checked at
 * §12.7 step 7). Not a failure of the task: a Backend condition can change back, so TD §19.3 holds
 * the task instead of failing it. Nothing here retries, selects a backend or asks a human.
 */
export function commitBackendIncompatible(
  store: PlatformStore,
  command: ActivationFailureCommand,
): TransitionResult {
  return commitActivationFailure(store, command, "HELD", "POLICY_BACKEND_INCOMPATIBLE");
}

function commitActivationFailure(
  store: PlatformStore,
  command: ActivationFailureCommand,
  to: "FAILED" | "HELD",
  reason_code: string,
): TransitionResult {
  return store.withTransaction(() => {
    const task = store.tasks.require(command.task_key);
    if (task.platform_state !== "SELECTED") {
      throw illegal(`an activation failure requires SELECTED, not ${task.platform_state}`);
    }
    if (store.attempts.current(task.task_key) !== undefined) {
      throw illegal(`${task.task_key} already has a non-terminal attempt`);
    }

    const transition = appendTransition(store, {
      primary_entity_key: task.task_key,
      task: { from: "SELECTED", to },
      reason_code,
      mismatch: command.detail,
    });
    const updated = store.tasks.write(task.task_key, {
      platform_state: to,
      reason: { code: reason_code, log_seq: transition.seq },
    });
    return { transition, task: updated };
  });
}

/** A validated `CLOSE_BATCH`: admission stops, running tasks are untouched (TD §19.3a). */
export function commitBatchAdmissionClose(store: PlatformStore, batchId: string): TransitionResult {
  return store.withTransaction(() => {
    const batch = store.batches.require(batchId);
    const transition = appendTransition(store, {
      primary_entity_key: batch.batch_id,
      batch: { from: batch.status, to: batch.status },
      reason_code: "ADMISSION_CLOSED",
    });
    return { transition, batch: store.batches.closeAdmission(batchId) };
  });
}

/** `DISCOVERED → DEFERRED`. Only before admission; never a general-purpose cancel (§19.3). */
export function commitTaskDeferral(store: PlatformStore, taskKey: string): TransitionResult {
  return store.withTransaction(() => {
    const task = store.tasks.require(taskKey);
    if (task.platform_state !== "DISCOVERED") {
      throw illegal(`DEFER requires DISCOVERED, not ${task.platform_state}`);
    }
    const transition = appendTransition(store, {
      primary_entity_key: taskKey,
      task: { from: task.platform_state, to: "DEFERRED" },
    });
    // admitted_at is not touched: a deferral never gives back consumed admission.
    return { transition, task: store.tasks.write(taskKey, { platform_state: "DEFERRED" }) };
  });
}

// --- contract activation -------------------------------------------------------------------

export interface ContractActivationCommand {
  readonly task_key: string;
  readonly attempt_key: string;
  readonly n: number;
  /**
   * Runs inside the transition transaction and returns the completed Batch 6 build. Batch 8 never
   * rebuilds a contract, re-hashes a definition or re-derives a grant — it only persists what the
   * builder produced, and running it here is what puts the contract-source blobs in the same
   * transaction (TD §10.2).
   */
  readonly build: () => TaskContractBuildResult;
}

/** `SELECTED → ACTIVE` plus the first Attempt, its contract snapshot and both grants — atomically. */
export function commitContractActivation(
  store: PlatformStore,
  command: ContractActivationCommand,
): TransitionResult {
  return store.withTransaction(() => {
    const task = store.tasks.require(command.task_key);
    if (task.platform_state !== "SELECTED") {
      throw illegal(`activation requires SELECTED, not ${task.platform_state}`);
    }
    if (store.attempts.current(task.task_key) !== undefined) {
      throw illegal(`${task.task_key} already has a non-terminal attempt`);
    }

    const built = command.build();

    const transition = appendTransition(store, {
      primary_entity_key: command.attempt_key,
      task: { from: "SELECTED", to: "ACTIVE" },
      attempt: { from: "-", to: "READY" },
    });

    store.contracts.put(built.contract);
    const updated = store.tasks.write(task.task_key, { platform_state: "ACTIVE" });
    store.attempts.create({
      attempt_key: command.attempt_key,
      task_key: task.task_key,
      n: command.n,
      contract_snapshot_id: built.contract.body.snapshot_id,
      base_head: built.contract.body.base_head,
    });
    store.grants.put(built.actor_grant, { kind: "ATTEMPT", attempt_key: command.attempt_key });
    store.grants.put(built.auditor_grant, { kind: "ATTEMPT", attempt_key: command.attempt_key });

    return { transition, task: updated };
  });
}

// --- attempt lifecycle ------------------------------------------------------------------------

export interface AttemptCommand {
  readonly attempt_key: string;
  readonly fact: AttemptFact;
  /** Required when the outcome parks the task on a human decision (`needs_human_decision`). */
  readonly decision?: PendingDecisionCreation;
  /**
   * TD §19.3e step 9a — extra durable writes that must land in *this* transition's transaction.
   *
   * READY→IMPLEMENTING has to commit the turn reference, the turn operation's DONE and the state
   * change together, or a crash between them would leave a started turn with no attempt to own it.
   * Same convention as `ContractActivationCommand.build`: a callback, run inside the transaction,
   * so nothing new has to be threaded through the state machine. It returns nothing and cannot
   * influence the outcome — the guard has already decided by the time it runs.
   *
   * M1-14 — it receives the journal entry this transition just appended, because §17.1e's
   * `applied_transition_ref` has to name that entry and be written in the same transaction as the
   * transition it describes. Callers that do not need it simply ignore the argument.
   */
  readonly within?: (transition: TransitionRecord) => void;
}

export interface AttemptTransitionResult extends TransitionResult {
  readonly attempt_state: AttemptState;
  readonly decision_id?: string;
}

/** Applies one observed fact to the attempt and, where TD requires it, to its task. */
export function commitAttemptFact(
  store: PlatformStore,
  command: AttemptCommand,
): AttemptTransitionResult {
  return store.withTransaction(() => {
    const attempt = store.attempts.require(command.attempt_key);
    const task = store.tasks.require(attempt.task_key);
    const batch = store.batches.require(task.batch_id);
    const compiled = store.batchView.compiledProfileFor(batch.batch_id);

    const outcome = nextAttemptOutcome(attempt, command.fact, {
      max_rework: compiled.effective.policy.batch_policy.max_rework,
    });

    if (outcome.needs_human_decision === true && command.decision === undefined) {
      throw new TransitionError(
        "COMMAND_INVALID",
        "this outcome parks the task on a human decision, which must be created in the same transaction",
      );
    }

    const decisionId = command.decision?.decision.decision_id;
    // A task parked on a decision is held *by that decision* (§17.2 blocking calculation).
    const taskReason =
      outcome.task_state === "HELD" && decisionId !== undefined
        ? blockedByDecision(decisionId)
        : outcome.task_reason_code;

    const transition = appendTransition(store, {
      primary_entity_key: attempt.attempt_key,
      task:
        outcome.task_state === undefined
          ? null
          : { from: task.platform_state, to: outcome.task_state },
      attempt: { from: attempt.state, to: outcome.attempt_state },
      reason_code: outcome.attempt_reason_code ?? taskReason ?? null,
      pending_decision_id: decisionId ?? null,
    });

    if (command.decision !== undefined) {
      openDecision(store, command.decision);
    }
    command.within?.(transition);

    store.attempts.write(attempt.attempt_key, {
      state: outcome.attempt_state,
      candidate_commit: outcome.candidate_commit,
      rework_count: outcome.rework_count,
      reason:
        outcome.attempt_reason_code === undefined
          ? undefined
          : { code: assertReason(outcome.attempt_reason_code), log_seq: transition.seq },
    });

    let updatedTask = task;
    if (outcome.task_state !== undefined) {
      updatedTask = store.tasks.write(task.task_key, {
        platform_state: outcome.task_state,
        reason:
          taskReason === undefined
            ? undefined
            : { code: assertReason(taskReason), log_seq: transition.seq },
      });
    }

    return {
      transition,
      task: updatedTask,
      attempt_state: outcome.attempt_state,
      ...(decisionId === undefined ? {} : { decision_id: decisionId }),
    };
  });
}

// --- pending decisions ---------------------------------------------------------------------------

export interface PendingDecisionCreation {
  readonly decision: PendingDecisionV1;
  /** Opaque adapter channel (TD §21.1). Delivery itself belongs to a later batch. */
  readonly channel: string;
}

export interface PendingDecisionResult extends TransitionResult {
  readonly decision_id: string;
  readonly op_key: string;
}

/**
 * Opens a decision that parks its subject: the hold/wait state, the decision row, the outbox
 * enqueue and the journal entry all commit together or not at all (TD §18.2, §43).
 */
export function commitPendingDecision(
  store: PlatformStore,
  creation: PendingDecisionCreation,
): PendingDecisionResult {
  return store.withTransaction(() => {
    const body = creation.decision;
    const subject = body.subject;

    let taskBefore: TaskRow | undefined;
    let batchBefore: BatchRow | undefined;
    if (subject.kind === "TASK") {
      taskBefore = store.tasks.require(subject.task_key);
      if (isTerminalTask(taskBefore.platform_state)) {
        throw illegal(`${subject.task_key} is ${taskBefore.platform_state} and cannot be held`);
      }
    } else if (subject.kind === "BATCH") {
      batchBefore = store.batches.require(subject.batch_id);
    }

    const transition = appendTransition(store, {
      primary_entity_key: subjectKey(subject),
      task:
        taskBefore === undefined
          ? null
          : { from: taskBefore.platform_state, to: "HELD" },
      reason_code: blockedByDecision(body.decision_id),
      pending_decision_id: body.decision_id,
    });

    const opKey = openDecision(store, creation);

    let updatedTask: TaskRow | undefined;
    if (taskBefore !== undefined) {
      updatedTask = store.tasks.write(taskBefore.task_key, {
        platform_state: "HELD",
        reason: { code: blockedByDecision(body.decision_id), log_seq: transition.seq },
      });
    }

    return {
      transition,
      task: updatedTask,
      batch: batchBefore,
      decision_id: body.decision_id,
      op_key: opKey,
    };
  });
}

/**
 * Opens (or dedups) the decision row and enqueues its single notification.
 *
 * M1-12 — this is the *only* path by which a PendingDecision is opened alongside a transition.
 * A caller that needs one passes `decision`, and §17.2's blocking representation then applies
 * uniformly whatever the causal fact was: the task is held by the decision, and the cause stays
 * where causes live — the transition entry, the attempt's own reason, and the decision's
 * `created_from` provenance.
 */
function openDecision(store: PlatformStore, creation: PendingDecisionCreation): string {
  const body = creation.decision;
  store.pendingDecisions.open(body);

  // §17.2: one idempotent notification per decision. Batch 8 enqueues; it never delivers.
  const opKey = `op:${subjectKey(body.subject)}:report-pending:${body.decision_id}`;
  store.outbox.enqueue({
    op_key: opKey,
    channel: creation.channel,
    payload: {
      event: "PENDING_DECISION",
      decision_id: body.decision_id,
      category: body.category,
      subject_kind: body.subject.kind,
      subject_ref: subjectKey(body.subject),
      blocking_scope: body.blocking_scope,
    },
  });
  return opKey;
}

/** Resolves a decision and records the human's answer. No transition is implied (TD §17.3). */
export function commitDecisionResolution(
  store: PlatformStore,
  decisionId: string,
  resolution: PendingDecisionV1["resolution"],
): TransitionResult {
  if (resolution === null) {
    throw new TransitionError("COMMAND_INVALID", "a resolution is required");
  }
  return store.withTransaction(() => {
    const transition = appendTransition(store, {
      primary_entity_key: decisionId,
      reason_code: "DECISION_RESOLVED",
      pending_decision_id: decisionId,
    });
    store.pendingDecisions.resolve(decisionId, resolution);
    return { transition };
  });
}

// --- batch / run ---------------------------------------------------------------------------------

export interface BatchCommand {
  readonly batch_id: string;
  readonly fact: BatchFact;
  /**
   * TD §20.2 (MVP1-B13) — extra durable writes that must land in *this* transition's transaction.
   *
   * Same convention and the same constraints as `AttemptCommand.within`: it runs inside the
   * transaction, after the guard has decided, and cannot influence the outcome. §20.2 requires the
   * batch-complete summary to be enqueued with the completion itself, and §20 lets the run's own
   * status follow in the same breath — neither should be able to survive a rolled-back completion.
   */
  readonly within?: (transition: TransitionRecord, outcome: BatchOutcome) => void;
}

export function commitBatchFact(store: PlatformStore, command: BatchCommand): TransitionResult {
  return store.withTransaction(() => {
    const batch = store.batches.require(command.batch_id);
    const outcome = nextBatchOutcome(batch, command.fact, batchCounts(store, batch));

    const transition = appendTransition(store, {
      primary_entity_key: batch.batch_id,
      batch: { from: batch.status, to: outcome.batch_state },
    });

    const updated = store.batches.setStatus(batch.batch_id, outcome.batch_state as BatchState);
    if (outcome.pause_run) store.runs.setStatus(batch.run_id, "PAUSED_SAFELY");
    command.within?.(transition, outcome);
    return { transition, batch: updated };
  });
}

function batchCounts(store: PlatformStore, batch: BatchRow): BatchTaskCounts {
  const tasks = store.tasks.inBatch(batch.batch_id);
  const admitted = tasks.filter((task) => task.admitted_at !== null);
  const blocking = admitted.reduce(
    (total, task) => total + store.pendingDecisions.openFor(task.task_key).length,
    store.pendingDecisions.openFor(batch.batch_id).length,
  );
  return {
    admitted_non_terminal: admitted.filter((task) => !isTerminalTask(task.platform_state)).length,
    active: countState(tasks, "ACTIVE"),
    selected: countState(tasks, "SELECTED"),
    open_blocking_decisions: blocking,
  };
}

const countState = (tasks: readonly TaskRow[], state: TaskState): number =>
  tasks.filter((task) => task.platform_state === state).length;

// --- journal ----------------------------------------------------------------------------------------

interface TransitionEntry {
  readonly primary_entity_key: string;
  readonly task?: StateChange | null;
  readonly attempt?: StateChange | null;
  readonly batch?: StateChange | null;
  readonly reason_code?: string | null;
  readonly pending_decision_id?: string | null;
  /** TD §19.3a — mismatch provenance for a SELECTION_STALE hold. Generic fields only. */
  readonly mismatch?: CanonicalObject;
}

/** One entry per transition — task and attempt changes share it rather than being split. */
function appendTransition(store: PlatformStore, entry: TransitionEntry): TransitionRecord {
  const appended = store.decisions.append({
    kind: STATE_TRANSITION_KIND,
    refKey: entry.primary_entity_key,
    payload: {
      primary_entity_key: entry.primary_entity_key,
      task: (entry.task ?? null) as unknown as CanonicalObject | null,
      attempt: (entry.attempt ?? null) as unknown as CanonicalObject | null,
      batch: (entry.batch ?? null) as unknown as CanonicalObject | null,
      reason_code: entry.reason_code ?? null,
      pending_decision_id: entry.pending_decision_id ?? null,
      ...(entry.mismatch === undefined ? {} : { mismatch: entry.mismatch }),
    } as unknown as CanonicalObject,
  });
  return { seq: appended.seq, ref: `transition:${appended.seq}` };
}

function assertReason(code: string): string {
  if (!isReasonCode(code)) {
    throw new TransitionError("REASON_REQUIRED", `${code} is not a §24 taxonomy reason`);
  }
  return code;
}
