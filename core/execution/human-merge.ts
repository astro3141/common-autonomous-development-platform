/**
 * MVP 1 Human Merge (TD §19.4a–§19.4i; MVP1-B12).
 *
 * Three narrow operations, and between them the Platform does exactly three things: it records an
 * approval, it observes the repository, and it settles the lifecycle from what it observed.
 *
 *   `requestMergeApproval`       READY_TO_MERGE → the question
 *   `applyResolvedMergeApproval` the answer → APPROVED_FOR_MANUAL_MERGE, or the rejection branch
 *   `observeHumanMerge`          the repository's own facts → MERGED, or a mismatch
 *
 * Two separations do the real work. **A human approval is permission, not a fact**: it authorizes
 * a manual merge and asserts nothing about Git HEAD, the audit, the candidate or the contract —
 * each of which is re-read from its own authority immediately before the approval is applied,
 * because an answer can arrive hours later (Spec §50). And **`MERGED` is a repository fact**: no
 * "I merged it" message enters any branch, and the Platform performs no merge itself.
 *
 * `validateDecisionAfterResolvedHumanGate` is deliberately not used. It authorizes a *Proposal*,
 * keyed on `category == HUMAN_GATE_APPROVAL` and a stored `gate_proposal`, and a MERGE_APPROVAL has
 * neither. Widening it to fit would make one authorization path answer two different questions.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type { ContractSourceReader, TaskContractV1Body } from "../contract/types.ts";
import {
  buildMergeApproval,
  buildMergeMismatchDecision,
  buildMergeRejectDecision,
  mergeApprovalRemainsValid,
  mergeDecisionCause,
  MERGE_APPROVAL_OPTIONS,
} from "../humandecision/merge-decision.ts";
import { hashPendingDecision } from "../humandecision/pending-decision.ts";
import type { PendingDecisionV1 } from "../humandecision/types.ts";
import type { ProfileSource } from "../profile/types.ts";
import {
  commitAttemptFact,
  commitBatchFact,
  commitPendingDecision,
  type PendingDecisionCreation,
} from "../statemachine/transition-commit.ts";
import type { AuditRecordRow, TaskAttemptRow, TaskRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { TaskSourceV1 } from "../tasksource/types.ts";
import { assembleDriftObservation } from "./assemble-drift-observation.ts";
import { applyDriftStop, type DriftStopOutcome } from "./drift-lifecycle.ts";
import { evaluateStageBoundaryDrift } from "./stage-boundary-drift.ts";
import { loadFrozenAuditorCapability } from "./start-auditing.ts";
import { ExecutionStartError } from "./start-implementation.ts";

/** TD §19.4a — the answer that authorizes anything. The other one is `REJECT`. */
const APPROVE = "APPROVE";

export interface MergeApprovalAuthorities {
  readonly store: PlatformStore;
}

/** TD §19.4c F4 — approval additionally runs the §11 merge boundary, which needs the read seams. */
export interface HumanMergeAuthorities extends MergeApprovalAuthorities {
  readonly repository: RepositoryAdapter;
  readonly profiles: ProfileSource;
  readonly taskSource: TaskSourceV1;
  readonly contractSources: ContractSourceReader;
}

// --- opening the question -------------------------------------------------------------------------

export interface RequestMergeApprovalCommand {
  readonly attempt_key: string;
  /** Caller-allocated ULID (TD §17.1). */
  readonly decision_id: string;
  readonly report_channel: string;
}

export type RequestMergeApprovalOutcome =
  /** The question is open and the task is blocked on it. */
  | { readonly kind: "MERGE_APPROVAL_OPEN"; readonly decision_id: string; readonly transition_seq: number }
  /** §17.1c — the same attempt and candidate already asked it. Nothing was opened twice. */
  | { readonly kind: "ALREADY_OPEN"; readonly decision_id: string };

/**
 * TD §19.4a — asks whether this candidate may be merged by hand.
 *
 * The audit basis is looked up rather than supplied: an approval that referenced an audit the
 * Platform cannot find would be a question about nothing.
 */
export function requestMergeApproval(
  authorities: MergeApprovalAuthorities,
  command: RequestMergeApprovalCommand,
): RequestMergeApprovalOutcome {
  const { store } = authorities;
  const attempt = store.attempts.require(command.attempt_key);
  const task = store.tasks.require(attempt.task_key);
  if (attempt.state !== "READY_TO_MERGE") {
    throw new ExecutionStartError(`a merge approval requires READY_TO_MERGE, not ${attempt.state}`);
  }

  const candidate_commit = attempt.candidate_commit as string;
  const audit = auditPassFor(store, attempt);
  const decision = buildMergeApproval({
    decision_id: command.decision_id,
    task_key: task.task_key,
    attempt_key: attempt.attempt_key,
    candidate_commit,
    audit_id: audit.audit_id,
  });

  // §17.1c — the dedup check comes before the task's own state on purpose. Opening this question
  // is what makes the task `HELD`, so a second Coordinator pass necessarily finds a held task;
  // treating that as an error would turn "I already asked" into a failure.
  const existing = store.pendingDecisions.byDedupKey(decision.dedup_key);
  if (existing !== undefined) {
    return { kind: "ALREADY_OPEN", decision_id: existing.body.decision_id };
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }

  // §17.2 — the decision row, the outbox notification and the block are one transaction. Delivery
  // is a later batch's concern and is never a precondition for the record existing.
  const opened = commitPendingDecision(store, { decision, channel: command.report_channel });
  return {
    kind: "MERGE_APPROVAL_OPEN",
    decision_id: opened.decision_id,
    transition_seq: opened.transition.seq,
  };
}

/** TD §19.4b — is this OPEN question still about something real? Pure, over already-read facts. */
export function mergeApprovalStillValid(store: PlatformStore, decision: PendingDecisionV1): boolean {
  const cause = mergeDecisionCause(decision);
  if (cause === undefined) return false;
  const attempt = store.attempts.get(cause.attempt_key);
  const task = store.tasks.get(decision.subject.kind === "TASK" ? decision.subject.task_key : "");
  if (task === undefined) return false;
  const current = store.attempts.current(task.task_key);

  return mergeApprovalRemainsValid(cause.candidate_commit, {
    source_attempt_state: attempt?.state,
    current_candidate_commit: attempt?.candidate_commit ?? undefined,
    audit_pass_intact: auditPassIntact(store, decision, cause),
    newer_attempt_exists: current !== undefined && current.attempt_key !== cause.attempt_key,
    task_state: task.platform_state,
  });
}

// --- applying the answer ---------------------------------------------------------------------------

export interface ApplyMergeApprovalCommand {
  readonly decision_id: string;
  /** Caller-allocated ULID for the decision a REJECT — or a drift stop — opens. */
  readonly follow_up_decision_id?: string;
  readonly report_channel?: string;
}

export type ApplyMergeApprovalOutcome =
  /** §19.4c(4) — the approval applied. The human may now merge, outside the Platform. */
  | {
      readonly kind: "APPROVED_FOR_MANUAL_MERGE";
      readonly attempt_key: string;
      readonly transition_seq: number;
    }
  /** §19.4d — the human declined this candidate; the follow-up question is open. */
  | {
      readonly kind: "MERGE_REJECTED";
      readonly attempt_key: string;
      readonly decision_id: string;
      readonly transition_seq: number;
    }
  /** §19.4c(3) — the durable basis the approval rests on no longer coheres. */
  | {
      readonly kind: "HELD";
      readonly attempt_key: string;
      readonly reason_code: "RECOVERY_CONFLICT";
      readonly transition_seq: number;
    }
  /** §11.4 — the merge boundary refused. Existing M1-11/M1-12 lifecycle. */
  | DriftStopOutcome;

/**
 * TD §19.4c — the one narrow entry point for a resolved MERGE_APPROVAL.
 *
 * The record is validated first and fails closed: a record-integrity failure is a caller-contract
 * error, not repository drift, so it throws rather than inventing a reason code.
 */
export function applyResolvedMergeApproval(
  authorities: HumanMergeAuthorities,
  command: ApplyMergeApprovalCommand,
): ApplyMergeApprovalOutcome {
  const { store } = authorities;
  const record = store.pendingDecisions.require(command.decision_id);
  const decision = record.body;
  const cause = requireMergeApprovalRecord(record.body, record.record_hash);

  const attempt = store.attempts.require(cause.attempt_key);
  const task = store.tasks.require(attempt.task_key);
  if (decision.subject.kind !== "TASK" || decision.subject.task_key !== task.task_key) {
    throw conflict(`${decision.decision_id} is not a decision about ${task.task_key}`);
  }

  return decision.resolution?.chosen_option === APPROVE
    ? approve(authorities, { decision, attempt, task, candidate: cause.candidate_commit, command })
    : reject(store, { decision, attempt, task, candidate: cause.candidate_commit, command });
}

/** §19.4c(1) — everything about the record itself, before anything about the world. */
function requireMergeApprovalRecord(
  body: PendingDecisionV1,
  record_hash: string | null,
): { readonly attempt_key: string; readonly candidate_commit: string } {
  if (body.status !== "RESOLVED") {
    throw conflict(`decision ${body.decision_id} is ${body.status}, not RESOLVED`);
  }
  if (body.category !== "MERGE_APPROVAL") {
    throw conflict(`decision ${body.decision_id} is a ${body.category}, not a merge approval`);
  }
  if (record_hash === null || record_hash !== hashPendingDecision(body)) {
    throw conflict(`decision ${body.decision_id} does not carry a valid terminal record hash`);
  }
  if (body.blocking_scope !== "TASK_ONLY") {
    throw conflict(`decision ${body.decision_id} has scope ${body.blocking_scope}`);
  }
  const chosen = body.resolution?.chosen_option;
  if (chosen === null || chosen === undefined || !MERGE_APPROVAL_OPTIONS.includes(chosen)) {
    throw conflict(`decision ${body.decision_id} was not resolved with an offered option`);
  }
  const cause = mergeDecisionCause(body);
  if (cause === undefined) {
    throw conflict(`decision ${body.decision_id} carries no merge provenance`);
  }
  return cause;
}

interface Branch {
  readonly decision: PendingDecisionV1;
  readonly attempt: TaskAttemptRow;
  readonly task: TaskRow;
  readonly candidate: string;
  readonly command: ApplyMergeApprovalCommand;
}

/**
 * TD §19.4c(2) — F1–F4, and nothing else.
 *
 * V1–V11 are not reused: there is no Proposal here, and this is not Proposal authorization.
 * `automatic_merge`'s V10 requirements are not re-run either — MVP 1 performs no Platform merge, so
 * requiring the capability for one would be asking about an operation that never happens.
 * Verification evidence is not re-evaluated: the rows are immutable and the settled audit record is
 * immutable, so the answer cannot move; a *policy* change is already F4's business.
 */
function approve(
  authorities: HumanMergeAuthorities,
  branch: Branch,
): ApplyMergeApprovalOutcome {
  const { store } = authorities;
  const { attempt, task, decision } = branch;

  // F1 — this is still the current attempt, still awaiting a merge, still about this candidate.
  const current = store.attempts.current(task.task_key);
  const coherent =
    attempt.state === "READY_TO_MERGE" &&
    attempt.candidate_commit === branch.candidate &&
    current !== undefined &&
    current.attempt_key === attempt.attempt_key;

  // F2 — the settled AUDIT_PASS the approval was granted on is still there and still about this.
  const audit = coherent ? auditBasis(store, decision, branch) : undefined;
  // F3 — and it judged the contract this attempt is bound to.
  const bound =
    audit !== undefined &&
    audit.task_contract_hash === store.contracts.hashOf(attempt.contract_snapshot_id);

  if (!coherent || !bound) {
    const held = commitAttemptFact(store, {
      attempt_key: attempt.attempt_key,
      fact: { kind: "EXECUTION_HELD", reason_code: "RECOVERY_CONFLICT" },
    });
    // §19.4g — the human's answer is not rewritten. It stays RESOLVED and unapplied.
    return {
      kind: "HELD",
      attempt_key: attempt.attempt_key,
      reason_code: "RECOVERY_CONFLICT",
      transition_seq: held.transition.seq,
    };
  }

  // F4 — the §11 merge boundary, run once, by the existing production stack.
  const contract = requireContract(store, attempt);
  const drift = evaluateStageBoundaryDrift(
    assembleDriftObservation(authorities, {
      boundary: "READY_TO_MERGE_TO_APPROVED_FOR_MANUAL_MERGE",
      attempt,
      contract,
      compiled: store.batchView.compiledProfileFor(task.batch_id),
      auditor_grant: loadFrozenAuditorCapability(store, attempt.attempt_key, contract),
    }),
  );
  if (drift.kind !== "CONTINUE") {
    return applyDriftStop(store, {
      attempt_key: attempt.attempt_key,
      task_key: task.task_key,
      outcome: drift,
      ...(branch.command.follow_up_decision_id === undefined
        ? {}
        : { decision_id: branch.command.follow_up_decision_id }),
      ...(branch.command.report_channel === undefined
        ? {}
        : { report_channel: branch.command.report_channel }),
    });
  }

  // §19.4c(4) — one transaction: the transition, the task's return to ACTIVE, and the record of
  // which transition applied the human's answer (§17.1e).
  const applied = commitAttemptFact(store, {
    attempt_key: attempt.attempt_key,
    fact: { kind: "MANUAL_MERGE_APPROVED" },
    within: (transition) => {
      store.pendingDecisions.recordAppliedTransition(decision.decision_id, transition.seq);
    },
  });
  return {
    kind: "APPROVED_FOR_MANUAL_MERGE",
    attempt_key: attempt.attempt_key,
    transition_seq: applied.transition.seq,
  };
}

/**
 * TD §19.4d — a rejection declines *this candidate*; it does not invalidate the attempt, and it
 * does not run the merge boundary, because nothing is being authorized to cross it.
 */
function reject(store: PlatformStore, branch: Branch): ApplyMergeApprovalOutcome {
  const { attempt, task, decision } = branch;
  const follow_up = requireFollowUp(store, buildMergeRejectDecision, {
    attempt,
    task,
    candidate: branch.candidate,
    decision_id: branch.command.follow_up_decision_id,
    channel: branch.command.report_channel,
  });

  const existing = store.pendingDecisions.byDedupKey(follow_up.decision.dedup_key);
  if (existing !== undefined) {
    throw conflict(`${attempt.attempt_key} already has a follow-up decision for ${branch.candidate}`);
  }

  // M1-12 — the cause (`MERGE_REJECTED`) is the transition fact; the task's current reason names
  // the decision that is blocking it now. One transaction for both.
  const committed = commitAttemptFact(store, {
    attempt_key: attempt.attempt_key,
    fact: { kind: "MANUAL_MERGE_REJECTED" },
    decision: follow_up,
    within: (transition) => {
      store.pendingDecisions.recordAppliedTransition(decision.decision_id, transition.seq);
    },
  });
  return {
    kind: "MERGE_REJECTED",
    attempt_key: attempt.attempt_key,
    decision_id: follow_up.decision.decision_id,
    transition_seq: committed.transition.seq,
  };
}

// --- observing the repository ------------------------------------------------------------------------

export interface ObserveHumanMergeAuthorities extends MergeApprovalAuthorities {
  readonly repository: RepositoryAdapter;
}

export interface ObserveHumanMergeCommand {
  readonly attempt_key: string;
  /** Caller-allocated ULID for the decision a mismatch opens. */
  readonly decision_id?: string;
  readonly report_channel?: string;
}

export type ObserveHumanMergeOutcome =
  /** The canonical branch could not be read, or has not moved. Nothing durable changed. */
  | { readonly kind: "NO_OBSERVATION"; readonly attempt_key: string }
  | { readonly kind: "MERGED"; readonly attempt_key: string; readonly transition_seq: number }
  /** §19.4h — canonical moved and the candidate is not in it. `paused` marks unsafe lineage. */
  | {
      readonly kind: "MERGE_MISMATCH";
      readonly attempt_key: string;
      readonly decision_id: string;
      readonly paused: boolean;
      readonly transition_seq: number;
    };

/**
 * TD §19.4e — the three-way projection, in a fixed order, using only the two existing primitives.
 *
 * The base-equality branch precedes the lineage call deliberately: the candidate is a confirmed
 * child of `base_head` (§19.3), so when canonical is still at the base the candidate cannot be its
 * ancestor and the lineage call could only answer `false`. Skipping it changes no outcome and
 * spends one fewer read.
 *
 * Nothing a person says about having merged is an input to any branch.
 */
export function observeHumanMerge(
  authorities: ObserveHumanMergeAuthorities,
  command: ObserveHumanMergeCommand,
): ObserveHumanMergeOutcome {
  const { store } = authorities;
  const attempt = store.attempts.require(command.attempt_key);
  const task = store.tasks.require(attempt.task_key);
  if (attempt.state !== "APPROVED_FOR_MANUAL_MERGE") {
    throw new ExecutionStartError(
      `a merge observation requires APPROVED_FOR_MANUAL_MERGE, not ${attempt.state}`,
    );
  }
  const candidate = attempt.candidate_commit as string;

  let head: string;
  try {
    head = authorities.repository.snapshot_canonical().head;
  } catch {
    // An unreadable canonical proves nothing. It is not a mismatch and it is not a merge.
    return { kind: "NO_OBSERVATION", attempt_key: attempt.attempt_key };
  }

  if (head === candidate) return merged(store, attempt);
  if (head === attempt.base_head) {
    // Nothing has happened yet; the attempt keeps waiting for the person.
    return { kind: "NO_OBSERVATION", attempt_key: attempt.attempt_key };
  }

  let contains: boolean;
  try {
    contains = authorities.repository.verify_lineage(candidate, head);
  } catch {
    return { kind: "NO_OBSERVATION", attempt_key: attempt.attempt_key };
  }
  if (contains) return merged(store, attempt);

  return mismatch(authorities, { attempt, task, candidate, head, command });
}

function merged(store: PlatformStore, attempt: TaskAttemptRow): ObserveHumanMergeOutcome {
  const committed = commitAttemptFact(store, {
    attempt_key: attempt.attempt_key,
    fact: { kind: "MERGE_OBSERVED", canonical_contains_candidate: true },
  });
  return { kind: "MERGED", attempt_key: attempt.attempt_key, transition_seq: committed.transition.seq };
}

/**
 * TD §19.4h — the mismatch, classified deterministically with one further lineage read.
 *
 * `verify_lineage(base, head)` true means canonical advanced normally from this attempt's own base
 * and only the candidate is missing: an explicable task-level conflict. False means the attempt's
 * base is no longer in canonical history at all — Spec §52's lineage case — so the batch is stopped
 * as well. The batch pause is committed **first**: if the second write then fails, the safe state
 * is the one that survives.
 */
function mismatch(
  authorities: ObserveHumanMergeAuthorities,
  input: {
    readonly attempt: TaskAttemptRow;
    readonly task: TaskRow;
    readonly candidate: string;
    readonly head: string;
    readonly command: ObserveHumanMergeCommand;
  },
): ObserveHumanMergeOutcome {
  const { store } = authorities;
  let explicable: boolean;
  try {
    explicable = authorities.repository.verify_lineage(input.attempt.base_head, input.head);
  } catch {
    // The safety classification could not be made, so nothing is classified at all.
    return { kind: "NO_OBSERVATION", attempt_key: input.attempt.attempt_key };
  }

  const follow_up = requireFollowUp(store, buildMergeMismatchDecision, {
    attempt: input.attempt,
    task: input.task,
    candidate: input.candidate,
    decision_id: input.command.decision_id,
    channel: input.command.report_channel,
  });

  const existing = store.pendingDecisions.byDedupKey(follow_up.decision.dedup_key);
  if (existing !== undefined) {
    throw conflict(
      `${input.attempt.attempt_key} already has a recovery decision for ${input.candidate}`,
    );
  }

  if (!explicable) {
    // Spec §52 — the base is gone from canonical history. Stop the batch before anything else, so
    // a later failure cannot leave "lineage corruption observed, batch still RUNNING".
    commitBatchFact(store, {
      batch_id: input.task.batch_id,
      fact: { kind: "CIRCUIT_BREAKER", also_pause_run: false },
    });
  }

  const committed = commitAttemptFact(store, {
    attempt_key: input.attempt.attempt_key,
    fact: { kind: "MERGE_MISMATCH_OBSERVED" },
    decision: follow_up,
  });
  return {
    kind: "MERGE_MISMATCH",
    attempt_key: input.attempt.attempt_key,
    decision_id: follow_up.decision.decision_id,
    paused: !explicable,
    transition_seq: committed.transition.seq,
  };
}

// --- shared reads --------------------------------------------------------------------------------------

/** The settled `AUDIT_PASS` cycle for this attempt's current candidate (TD §18.1c). */
function auditPassFor(store: PlatformStore, attempt: TaskAttemptRow): AuditRecordRow {
  const record = store.auditRecords
    .forAttempt(attempt.attempt_key)
    .find(
      (row) => row.candidate_commit === attempt.candidate_commit && row.verdict === "AUDIT_PASS",
    );
  if (record === undefined) {
    throw new ExecutionStartError(
      `${attempt.attempt_key} has no settled AUDIT_PASS record for its candidate`,
    );
  }
  return record;
}

/** F2 — the record the decision actually names, re-read and re-bound. */
function auditBasis(
  store: PlatformStore,
  decision: PendingDecisionV1,
  branch: Branch,
): AuditRecordRow | undefined {
  const audit_id = decision.evidence_refs[0];
  if (audit_id === undefined) return undefined;
  const record = store.auditRecords.get(audit_id);
  if (record === undefined) return undefined;
  const bound =
    record.verdict === "AUDIT_PASS" &&
    record.attempt_key === branch.attempt.attempt_key &&
    record.candidate_commit === branch.candidate;
  return bound ? record : undefined;
}

const auditPassIntact = (
  store: PlatformStore,
  decision: PendingDecisionV1,
  cause: { readonly attempt_key: string; readonly candidate_commit: string },
): boolean => {
  const audit_id = decision.evidence_refs[0];
  if (audit_id === undefined) return false;
  const record = store.auditRecords.get(audit_id);
  return (
    record !== undefined &&
    record.verdict === "AUDIT_PASS" &&
    record.attempt_key === cause.attempt_key &&
    record.candidate_commit === cause.candidate_commit
  );
};

/**
 * The follow-up a REJECT or a mismatch opens. Both bind to the same immutable audit record the
 * approval did, so the human is answering about the same cycle either way.
 */
function requireFollowUp(
  store: PlatformStore,
  build: typeof buildMergeRejectDecision,
  input: {
    readonly attempt: TaskAttemptRow;
    readonly task: TaskRow;
    readonly candidate: string;
    readonly decision_id: string | undefined;
    readonly channel: string | undefined;
  },
): PendingDecisionCreation {
  if (input.decision_id === undefined || input.channel === undefined) {
    throw new ExecutionStartError(
      `${input.attempt.attempt_key} needs an allocated decision id and a report channel for its follow-up`,
    );
  }
  return {
    decision: build({
      decision_id: input.decision_id,
      task_key: input.task.task_key,
      attempt_key: input.attempt.attempt_key,
      candidate_commit: input.candidate,
      audit_id: auditPassFor(store, input.attempt).audit_id,
    }),
    channel: input.channel,
  };
}

function requireContract(store: PlatformStore, attempt: TaskAttemptRow): TaskContractV1Body {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  return envelope.body as unknown as TaskContractV1Body;
}

const conflict = (detail: string): ExecutionStartError => new ExecutionStartError(detail);
