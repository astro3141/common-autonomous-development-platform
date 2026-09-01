/**
 * State machine inputs (TD §19, §20).
 *
 * Every precondition Batch 8 evaluates arrives as an already-observed, typed fact. There is no
 * `Record<string, unknown>` bag and no adapter handle: the state machine cannot reach a backend
 * even by accident, and a model's self-report has nowhere to enter — note that no fact below
 * carries a `declared_status` (I-TD3).
 */

import type { AttemptState, BatchState, TaskState } from "../store/domain-types.ts";

export type { AttemptState, BatchState, TaskState };

/** TD §24 codes this batch can attach to a HELD/FAILED row. Not a new taxonomy — a subset. */
export const TRANSITION_REASON_CODES = [
  "RUNTIME_FAILED",
  "CAPABILITY_BOUNDARY_CHANGED",
  "VERIFICATION_FAILED",
  "VERIFICATION_INFRA",
  "AUDIT_HUMAN_REQUIRED",
  /**
   * TD §16.2 (M1-13) — **one** unusable Auditor structured-result observation: no structured
   * output, the wrong protocol, a malformed envelope, or `reviewed.*` that does not bind. It is
   * retryable, and for the same candidate it permits exactly one `auditor-turn-2`.
   */
  "AUDIT_INVALID",
  /**
   * TD §16.2 (M1-13) — the *second* unusable observation for the same candidate. The retry is
   * spent, so this is terminal for that audit cycle: no third turn, no settlement, no record.
   * Deliberately distinct from `AUDIT_INVALID`, which is the retryable observation itself.
   */
  "AUDIT_UNUSABLE",
  /**
   * TD §16.3 (M1-13) — a *valid* Auditor verdict exists, but the audit gate's settlement could
   * not be authoritatively established. Never re-read as `FIX_REQUIRED`: the Auditor said what it
   * said, and what failed is the Platform's ability to prove the gate settled.
   */
  "AUDIT_GATE_UNAVAILABLE",
  "REWORK_LIMIT",
  "CONTRACT_DRIFT",
  /**
   * TD §19.3a (M1-7) — the pre-Attempt selection basis no longer matches the authoritative
   * TaskDefinition or canonical head. Distinct from `CONTRACT_DRIFT`, which is §11's post-Attempt
   * concept and is driven by `contract_drift_policy` at stage boundaries.
   */
  "SELECTION_STALE",
  /**
   * TD §11.3/§11.4/§24 (M1-11) — the boundary could not determine *whether* drift exists, because
   * an authoritative current value could not be read. Deliberately distinct from `CONTRACT_DRIFT`,
   * which means a difference was actually observed: "I proved it changed" and "I could not tell"
   * are different facts, and neither may be recorded as the other.
   */
  "DRIFT_CHECK_UNAVAILABLE",
  "CONTRACT_BUILD_ERROR",
  "REPOSITORY_CONFLICT",
  "HUMAN_MERGE_MISMATCH",
  "RECOVERY_CONFLICT",
  "EXTERNAL_CLOSED",
  "MERGE_REJECTED",
  "POLICY_BACKEND_INCOMPATIBLE",
  /**
   * TD §17.4/§24 — the causal fact on an Attempt a person's fresh-snapshot choice invalidated:
   * the old Attempt may not continue, and the successor is a fresh `START_TASK` Proposal.
   */
  "REATTEMPT_REQUESTED",
  /** §8.4b/§24 (D24) — definitive no-effect adapter failure; the snapshot stays as audit. */
  "TASK_MATERIALIZATION_FAILED",
  /** §8.4b/§21/§22 (D24) — effect or exact round-trip could not be established; no guessing. */
  "TASK_MATERIALIZATION_UNOBSERVABLE",
  /** §8.4b/§24 (D24) — same identity/ref with a different snapshot/body/parent binding. */
  "TASK_MATERIALIZATION_CONFLICT",
] as const;

export type TransitionReasonCode = (typeof TRANSITION_REASON_CODES)[number];

/** `BLOCKED_BY_DECISION:<decision_id>` (TD §19.1) — the one parameterized reason. */
export const BLOCKED_BY_DECISION = "BLOCKED_BY_DECISION";

export const blockedByDecision = (decisionId: string): string =>
  `${BLOCKED_BY_DECISION}:${decisionId}`;

/** TD §19.3a (M1-7) — the pre-Attempt staleness hold reason. */
export const SELECTION_STALE = "SELECTION_STALE";

/**
 * TD §17.4/§24 — `REATTEMPT_REQUIRED:<decision_id>`: a next-owner/re-entry reason, never execution
 * authority. It is resolved by a fresh `START_TASK` Proposal handled as a `RESELECTION` (§9.2e).
 */
export const REATTEMPT_REQUIRED = "REATTEMPT_REQUIRED";
export const reattemptRequired = (decisionId: string): string =>
  `${REATTEMPT_REQUIRED}:${decisionId}`;
export function isReattemptRequired(value: string | undefined): boolean {
  if (value === undefined || !value.startsWith(`${REATTEMPT_REQUIRED}:`)) return false;
  return value.slice(REATTEMPT_REQUIRED.length + 1).length > 0;
}

/** TD §17.4/§24 — `ABANDONED_BY_DECISION:<decision_id>`: the exact resolved ABANDON's terminal reason. */
export const ABANDONED_BY_DECISION = "ABANDONED_BY_DECISION";
export const abandonedByDecision = (decisionId: string): string =>
  `${ABANDONED_BY_DECISION}:${decisionId}`;

/** §17.3/§24 (D24) — `MATERIALIZATION_REJECTED:<decision_id>`: a human refused the exact F publish. */
export const MATERIALIZATION_REJECTED = "MATERIALIZATION_REJECTED";
export const materializationRejected = (decisionId: string): string =>
  `${MATERIALIZATION_REJECTED}:${decisionId}`;

/** TD §18.1f/§19.5 — `SUBFLOW_CHILD:<child_task_key>`: the parent SUSPENDED row's exact cause. */
export const SUBFLOW_CHILD = "SUBFLOW_CHILD";
export const subflowChild = (childTaskKey: string): string => `${SUBFLOW_CHILD}:${childTaskKey}`;
export function subflowChildOf(reason: string | undefined): string | undefined {
  if (reason === undefined || !reason.startsWith(`${SUBFLOW_CHILD}:`)) return undefined;
  const child = reason.slice(SUBFLOW_CHILD.length + 1);
  return child.length === 0 ? undefined : child;
}

/**
 * True for a fixed §24 code or one of the three parameterized forms
 * (`BLOCKED_BY_DECISION:`, `REATTEMPT_REQUIRED:`, `ABANDONED_BY_DECISION:`, `SUBFLOW_CHILD:`).
 * Nothing else is a reason.
 */
export function isReasonCode(value: string): boolean {
  if ((TRANSITION_REASON_CODES as readonly string[]).includes(value)) return true;
  for (const prefix of [BLOCKED_BY_DECISION, REATTEMPT_REQUIRED, ABANDONED_BY_DECISION, SUBFLOW_CHILD, MATERIALIZATION_REJECTED]) {
    if (value.startsWith(`${prefix}:`) && value.slice(prefix.length + 1).length > 0) return true;
  }
  return false;
}

// --- attempt facts ------------------------------------------------------------------

/**
 * Authoritative facts a caller has already observed. Booleans are claims about the *world*, so a
 * `false` is rejected by the guard rather than reinterpreted.
 */
export type AttemptFact =
  /** §19.3 READY→IMPLEMENTING: workspace exists and the enforcement receipt matched the grant. */
  | { readonly kind: "EXECUTION_STARTED"; readonly workspace_created: boolean; readonly receipt_valid: boolean }
  /** §19.3 IMPLEMENTING→VERIFYING — repository facts only; no model report is consulted. */
  | {
      readonly kind: "CANDIDATE_OBSERVED";
      readonly candidate_commit: string;
      readonly lineage_valid: boolean;
      readonly tracked_clean: boolean;
    }
  /**
   * §19.3 IMPLEMENTING — the repository says there is no usable candidate: no commit, a commit that
   * is not a child of `base_head`, or a workspace that is not tracked-clean. Carries no detail
   * because the guard is not re-evaluated here; the caller already asked the RepositoryAdapter.
   */
  | { readonly kind: "CANDIDATE_REJECTED" }
  /** §19.3 VERIFYING→AUDITING: every required check produced accepted, bound evidence. */
  | { readonly kind: "VERIFICATION_PASSED" }
  /**
   * §19.3/§16.1 (M1-10) — the Auditor's own session exists and its first turn was accepted. The
   * attempt only enters `AUDITING` on this fact, so there is never an audit in progress whose turn
   * the Platform cannot name.
   */
  | { readonly kind: "AUDIT_STARTED"; readonly session_ready: boolean; readonly receipt_valid: boolean }
  | { readonly kind: "VERIFICATION_FAILED"; readonly infrastructure: boolean }
  /** §16.2 verdict. §16.3's gate commit is the caller's precondition, not a model utterance. */
  | {
      readonly kind: "AUDIT_DECIDED";
      readonly verdict: "AUDIT_PASS" | "FIX_REQUIRED" | "HUMAN_REQUIRED";
      readonly drift_clear: boolean;
    }
  /**
   * §19.5.2 (D22, MVP 3) — the frozen RESUME_PARENT terminal-success predicate held: the child
   * Contract is subflow v2 with a current binding, every required verification evidence is PASS
   * and bound to this exact candidate/Contract, the audit settled AUDIT_PASS for the same cycle,
   * and no blocker/drift/recovery/circuit condition stands. Booleans are the caller's *observed*
   * predicate legs — a false one is rejected, never reinterpreted. No repository operation exists
   * on this path at all.
   */
  | {
      readonly kind: "FOUNDATION_SUCCEEDED";
      readonly subflow_binding_current: boolean;
      readonly required_checks_bound: boolean;
      readonly settlement_is_pass: boolean;
      readonly blockers_clear: boolean;
    }
  /** §19.3 REWORKING→IMPLEMENTING. */
  | { readonly kind: "REWORK_STARTED"; readonly snapshot_valid: boolean }
  /** §19.4 — a human APPROVE. Explicitly not a merge. */
  | { readonly kind: "MANUAL_MERGE_APPROVED" }
  | { readonly kind: "MANUAL_MERGE_REJECTED" }
  /** §19.3 MVP 2 automatic merge start; the Gate preconditions are the caller's observation. */
  | { readonly kind: "AUTOMATIC_MERGE_STARTED"; readonly gate_preconditions_met: boolean }
  /** §19.4 — canonical observation, the only thing that may produce MERGED. */
  | { readonly kind: "MERGE_OBSERVED"; readonly canonical_contains_candidate: boolean }
  /** §19.4 — canonical moved in a way the approval does not explain. */
  | { readonly kind: "MERGE_MISMATCH_OBSERVED" }
  /** §11.1 INVALIDATE_AT_BOUNDARY, or an explicit human decision. */
  | { readonly kind: "CONTRACT_DRIFT_INVALIDATED" }
  /** Any §24 hold that leaves the attempt where it is and parks the task. */
  /**
   * TD §17.4 — a resolved non-merge decision's deterministic lifecycle application. The caller has
   * already validated the record, re-read every named authority and matched the exact
   * category × origin × option mapping row; the guard owns only the source-state legality and the
   * resulting states. Resolution itself is never a lifecycle effect — this fact is.
   */
  | { readonly kind: "RESOLVED_DECISION_APPLIED"; readonly application: ResolvedDecisionApplication }
  | { readonly kind: "EXECUTION_HELD"; readonly reason_code: TransitionReasonCode }
  /** Unrecoverable: the attempt terminates and the task fails with it (§19.2 I4). */
  | { readonly kind: "ATTEMPT_FAILED"; readonly reason_code: TransitionReasonCode };

/** What one attempt fact resolves to. The commit function writes exactly this. */
/**
 * TD §17.4 — the five deterministic applications of the current v1 category × origin × option
 * mapping. Each names its exact effect; there is deliberately no generic "resolve any decision"
 * shape, and an unmapped combination has no representation here at all.
 */
export type ResolvedDecisionApplication =
  /** `AUDIT_DECISION` × `REQUEST_REWORK`: AUDITING→REWORKING + task HELD→ACTIVE. */
  | { readonly kind: "AUDIT_REWORK" }
  /** Any mapped `ABANDON`: the non-terminal source Attempt and its Task both FAIL. */
  | { readonly kind: "ABANDON"; readonly decision_id: string }
  /**
   * `REATTEMPT_WITH_NEW_SNAPSHOT` over a non-terminal source: the source is INVALIDATED with the
   * category's §17.4 causal reason and the task re-enters via `REATTEMPT_REQUIRED:<id>`.
   */
  | {
      readonly kind: "REATTEMPT";
      readonly decision_id: string;
      readonly attempt_reason: "REATTEMPT_REQUESTED" | "RECOVERY_CONFLICT";
    }
  /** `CONTRACT_DECISION` × `ALLOW_FROZEN_SNAPSHOT_TO_COMPLETE`: task HELD→ACTIVE, Attempt untouched. */
  | { readonly kind: "ALLOW_FROZEN" }
  /** `CONTRACT_DECISION` × `INVALIDATE_ATTEMPT`: INVALIDATED(CONTRACT_DRIFT) + re-entry reason. */
  | { readonly kind: "INVALIDATE_CONTRACT_DRIFT"; readonly decision_id: string };

export interface AttemptOutcome {
  readonly attempt_state: AttemptState;
  readonly candidate_commit?: string;
  readonly rework_count?: number;
  readonly attempt_reason_code?: string;
  /** Present when the same transaction must also decide the TaskState (§19.2 I4). */
  readonly task_state?: TaskState;
  readonly task_reason_code?: string;
  /** The transition needs a human decision to be opened alongside it (§11.1, §19.4). */
  readonly needs_human_decision?: boolean;
}

// --- batch facts --------------------------------------------------------------------

export type BatchFact =
  /**
   * §20.1 — whether any task could safely be started next. Derived by the Coordinator from the
   * dependency graph and repository conflicts; Batch 8 never computes it.
   */
  | { readonly kind: "EVALUATE_WAITING"; readonly safe_independent_runnable_exists: boolean }
  | { readonly kind: "RESUME"; readonly safe_independent_runnable_exists: boolean }
  | { readonly kind: "EVALUATE_COMPLETION" }
  /** Spec §52 circuit breaker — observed outside, never detected here. */
  | { readonly kind: "CIRCUIT_BREAKER"; readonly also_pause_run: boolean };

export interface BatchOutcome {
  readonly batch_state: BatchState;
  readonly pause_run: boolean;
}
