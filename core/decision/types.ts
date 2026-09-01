/**
 * Supervisor Proposal v1 and Decision Validator contracts (TD §9.1, §9.2, M0-25 ~ M0-28).
 *
 * A Proposal is strict typed structured input, never a hashed artifact: there is no envelope,
 * no `proposal_hash` and no snapshot table. The validator is a pure function of already-observed
 * authoritative facts, so every read model below is supplied by the caller.
 */

import type { CapabilityCheck } from "../capability/compatibility.ts";
import type { CoreExecutionRole } from "../capability/types.ts";
import { DECISION_TYPES, type DecisionType, type PipelineStep } from "../profile/types.ts";
import type { TaskDefinition } from "../tasksource/types.ts";

export { DECISION_TYPES };
export type { DecisionType };

// --- variants (TD §9.1) -------------------------------------------------------------

/**
 * The four MVP 0/1 structural shapes plus the one MVP 3 subflow shape (§9.1 E). A decision maps
 * to exactly one of them; the MVP 0/1 seal of the original four is unchanged.
 */
export type ProposalVariant =
  | "TASK_SELECTION"
  | "SUBFLOW_SELECTION"
  | "REPOSITORY_SENSITIVE_TASK_CONTROL"
  | "TASK_CONTROL"
  | "BATCH_CONTROL";

export const PROPOSAL_VARIANT_BY_DECISION: Readonly<Record<DecisionType, ProposalVariant>> = {
  START_TASK: "TASK_SELECTION",
  // §9.2f — applying START_SUBFLOW requires the explicit-parent shape E; the legacy parentless
  // form is not a valid Proposal at all (V1 PROPOSAL_SCHEMA_INVALID), never a deferred acceptance.
  START_SUBFLOW: "SUBFLOW_SELECTION",
  REQUEST_REWORK: "REPOSITORY_SENSITIVE_TASK_CONTROL",
  PROPOSE_MERGE: "REPOSITORY_SENSITIVE_TASK_CONTROL",
  HOLD_TASK: "TASK_CONTROL",
  DEFER_TASK: "TASK_CONTROL",
  RESUME_PARENT: "TASK_CONTROL",
  CLOSE_BATCH: "BATCH_CONTROL",
};

export interface TaskFreshnessExpectation {
  readonly task_version: string;
  readonly task_definition_hash: string;
  readonly compiled_profile_hash: string;
}

export interface RepositorySensitiveExpectation extends TaskFreshnessExpectation {
  readonly base_head: string;
}

export interface ProfileFreshnessExpectation {
  readonly compiled_profile_hash: string;
}

export interface TaskSelectionProposalV1 {
  readonly variant: "TASK_SELECTION";
  readonly proposal_id: string;
  readonly decision: "START_TASK";
  /** Adapter-scoped opaque ref; `:` is allowed and no syntax is interpreted (§6.1 D+). */
  readonly task_ref: string;
  readonly classification: string;
  readonly pipeline_id: string;
  readonly actor_profile: string;
  readonly verification_profile: string;
  /**
   * TD §9.1 (M1-6) — a *declared* Project Profile scope id, never a path body. The Supervisor can
   * only choose from what the Profile declared; V6 validates the reference.
   */
  readonly repository_scope_id: string;
  readonly expected: RepositorySensitiveExpectation;
  /** Order-sensitive, duplicates preserved — not a semantic set (M0-13). */
  readonly reason_refs: readonly string[];
}

/**
 * §9.2f — the Supervisor's *observed* explicit relationship intent. `task_key` is the durable
 * Platform parent identity; the other three are stale guards over that parent's current
 * Attempt/Contract/continuation point, compared exactly against a fresh view in V3.
 * **Uniqueness is not relationship authority** — no cardinality inference ever fills this in.
 */
export interface SubflowParentIntentV1 {
  readonly task_key: string;
  readonly attempt_key: string;
  readonly task_contract_hash: string;
  readonly attempt_state: string;
}

/** §9.1 E — START_SUBFLOW with an explicit, validated parent. Prospective MVP 3. */
export interface SubflowSelectionProposalV1 {
  readonly variant: "SUBFLOW_SELECTION";
  readonly proposal_id: string;
  readonly decision: "START_SUBFLOW";
  readonly task_ref: string;
  readonly classification: string;
  readonly pipeline_id: string;
  readonly actor_profile: string;
  readonly verification_profile: string;
  readonly repository_scope_id: string;
  readonly parent: SubflowParentIntentV1;
  readonly expected: RepositorySensitiveExpectation;
  readonly reason_refs: readonly string[];
}

export interface RepositorySensitiveTaskControlProposalV1 {
  readonly variant: "REPOSITORY_SENSITIVE_TASK_CONTROL";
  readonly proposal_id: string;
  readonly decision: "REQUEST_REWORK" | "PROPOSE_MERGE";
  readonly task_ref: string;
  readonly expected: RepositorySensitiveExpectation;
  readonly reason_refs: readonly string[];
}

export interface TaskControlProposalV1 {
  readonly variant: "TASK_CONTROL";
  readonly proposal_id: string;
  readonly decision: "HOLD_TASK" | "DEFER_TASK" | "RESUME_PARENT";
  readonly task_ref: string;
  readonly expected: TaskFreshnessExpectation;
  readonly reason_refs: readonly string[];
}

export interface BatchControlProposalV1 {
  readonly variant: "BATCH_CONTROL";
  readonly proposal_id: string;
  readonly decision: "CLOSE_BATCH";
  readonly expected: ProfileFreshnessExpectation;
  readonly reason_refs: readonly string[];
}

export type ProposalV1 =
  | TaskSelectionProposalV1
  | SubflowSelectionProposalV1
  | RepositorySensitiveTaskControlProposalV1
  | TaskControlProposalV1
  | BatchControlProposalV1;

/** A Proposal carrying a `task_ref`: variants A, B, C and E. */
export type TaskBearingProposalV1 =
  | TaskSelectionProposalV1
  | SubflowSelectionProposalV1
  | RepositorySensitiveTaskControlProposalV1
  | TaskControlProposalV1;

/** The selection variants (A/E) — the shapes V4/V5/V6/V9/V10/V11 judge. */
export type SelectionProposalV1 = TaskSelectionProposalV1 | SubflowSelectionProposalV1;

/** Exact accepted wrapper keys — `variant` is derived by the parser, never accepted as input. */
export const PROPOSAL_FIELDS: Readonly<Record<ProposalVariant, readonly string[]>> = {
  TASK_SELECTION: [
    "proposal_id",
    "decision",
    "task_ref",
    "classification",
    "pipeline_id",
    "actor_profile",
    "verification_profile",
    "repository_scope_id",
    "expected",
    "reason_refs",
  ],
  SUBFLOW_SELECTION: [
    "proposal_id",
    "decision",
    "task_ref",
    "classification",
    "pipeline_id",
    "actor_profile",
    "verification_profile",
    "repository_scope_id",
    "parent",
    "expected",
    "reason_refs",
  ],
  REPOSITORY_SENSITIVE_TASK_CONTROL: [
    "proposal_id",
    "decision",
    "task_ref",
    "expected",
    "reason_refs",
  ],
  TASK_CONTROL: ["proposal_id", "decision", "task_ref", "expected", "reason_refs"],
  BATCH_CONTROL: ["proposal_id", "decision", "expected", "reason_refs"],
};

export const SUBFLOW_PARENT_FIELDS: readonly (keyof SubflowParentIntentV1)[] = [
  "task_key",
  "attempt_key",
  "task_contract_hash",
  "attempt_state",
];

export const EXPECTED_FIELDS: Readonly<Record<ProposalVariant, readonly string[]>> = {
  TASK_SELECTION: ["task_version", "task_definition_hash", "base_head", "compiled_profile_hash"],
  SUBFLOW_SELECTION: ["task_version", "task_definition_hash", "base_head", "compiled_profile_hash"],
  REPOSITORY_SENSITIVE_TASK_CONTROL: [
    "task_version",
    "task_definition_hash",
    "base_head",
    "compiled_profile_hash",
  ],
  TASK_CONTROL: ["task_version", "task_definition_hash", "compiled_profile_hash"],
  BATCH_CONTROL: ["compiled_profile_hash"],
};

// --- read models (TD §9.2, M0-27, M0-28) --------------------------------------------

/**
 * The TaskSource projection. There is deliberately no operational-failure variant: an unreadable
 * or malformed source is a Coordinator concern and must never be disguised as `NOT_FOUND`.
 */
export type TaskLookupView =
  | { readonly status: "FOUND"; readonly task: TaskDefinition }
  | { readonly status: "NOT_FOUND" };

/** The RepositoryAdapter fact, already observed. The validator never queries a repository. */
export interface RepositoryValidationView {
  readonly canonical_head: string;
}

/**
 * §9.2f — the fresh parent read-model an E submission carries. Built by the caller from the
 * durable owners only; TaskSource unavailability, an unreadable Store or a corrupt relation is an
 * operational failure *before* the validator runs, never a `NOT_FOUND`.
 */
export type SubflowParentValidationView =
  | { readonly status: "NOT_FOUND" }
  | {
      readonly status: "FOUND";
      readonly task_key: string;
      readonly batch_id: string;
      readonly platform_state: string;
      readonly current_attempt_key: string | null;
      readonly current_attempt_state: string | null;
      readonly current_task_contract_hash: string | null;
      /** Derived from durable `parent_task_key` chains only (§18.1f). */
      readonly ancestor_task_keys: readonly string[];
      readonly current_suspension_child_task_key: string | null;
      readonly has_open_blocker: boolean;
      readonly has_recovery_conflict: boolean;
    };

/**
 * D23 — the active §13.4 turn's Platform `proposal_id` allocation. Ordinary submission sources it
 * from the active `SupervisorDecisionContextV1`; §17.3 post-gate revalidation reconstructs it from
 * the terminal record's bound `gate_proposal.proposal_id` without allocating a new id.
 */
export interface SupervisorProposalIdentityView {
  readonly proposal_id: string;
}

/** §9.2f P1/P3/P4 — the child-side durable facts the parent checks compare against. */
export interface SubflowChildContextV1 {
  readonly task_key: string;
  readonly batch_id: string;
  readonly has_parent_relation: boolean;
}

/** Exactly three counts; the queries that produce them belong to the domain-store batch. */
export interface DecisionValidationBatchView {
  readonly admitted_task_count: number;
  readonly active_task_count: number;
  readonly active_writable_candidate_count: number;
}

/**
 * TD §9.2e (M1-7) — which kind of selection V11 is judging.
 *
 * Not a Proposal field and never Model input: the Coordinator reads it off durable task state
 * (a `HELD(SELECTION_STALE)` task with an existing `admitted_at` and no Attempt is a reselection).
 * A reselection does not consume a batch admission slot again, because the task already did.
 */
export type SelectionAdmissionKind = "INITIAL_ADMISSION" | "RESELECTION";

export const SELECTION_ADMISSION_KINDS: readonly SelectionAdmissionKind[] = [
  "INITIAL_ADMISSION",
  "RESELECTION",
];

export const BATCH_VIEW_FIELDS: readonly (keyof DecisionValidationBatchView)[] = [
  "admitted_task_count",
  "active_task_count",
  "active_writable_candidate_count",
];

// --- result contract (TD §9.2) ------------------------------------------------------

/**
 * The exact twelve MVP 0/1 rejection reasons plus the seven §9.2f subflow reasons. V10 failures
 * are a separate result kind.
 */
export type DecisionRejectReason =
  | "PROPOSAL_SCHEMA_INVALID"
  | "TASK_NOT_FOUND"
  | "TASK_DRIFT"
  | "PROFILE_DRIFT"
  | "CLASSIFICATION_UNKNOWN"
  | "DECISION_NOT_ALLOWED"
  | "PROFILE_REFERENCE_UNKNOWN"
  | "REPOSITORY_STATE_MISMATCH"
  | "CAPABILITY_DERIVATION_FAILED"
  | "BATCH_MAX_TASKS_REACHED"
  | "CONCURRENCY_LIMIT_REACHED"
  | "WRITABLE_CONCURRENCY_CONFLICT"
  | "SUBFLOW_PARENT_NOT_FOUND"
  | "SUBFLOW_PARENT_STALE"
  | "SUBFLOW_PARENT_INELIGIBLE"
  | "SUBFLOW_PARENT_BATCH_MISMATCH"
  | "SUBFLOW_RELATION_CONFLICT"
  | "SUBFLOW_CYCLE_DETECTED"
  | "SUBFLOW_PIPELINE_INVALID";

export const DECISION_REJECT_REASONS: readonly DecisionRejectReason[] = [
  "PROPOSAL_SCHEMA_INVALID",
  "TASK_NOT_FOUND",
  "TASK_DRIFT",
  "PROFILE_DRIFT",
  "CLASSIFICATION_UNKNOWN",
  "DECISION_NOT_ALLOWED",
  "PROFILE_REFERENCE_UNKNOWN",
  "REPOSITORY_STATE_MISMATCH",
  "CAPABILITY_DERIVATION_FAILED",
  "BATCH_MAX_TASKS_REACHED",
  "CONCURRENCY_LIMIT_REACHED",
  "WRITABLE_CONCURRENCY_CONFLICT",
  "SUBFLOW_PARENT_NOT_FOUND",
  "SUBFLOW_PARENT_STALE",
  "SUBFLOW_PARENT_INELIGIBLE",
  "SUBFLOW_PARENT_BATCH_MISMATCH",
  "SUBFLOW_RELATION_CONFLICT",
  "SUBFLOW_CYCLE_DETECTED",
  "SUBFLOW_PIPELINE_INVALID",
];

/** The B5 compatibility failure representation is reused verbatim — no second failure schema. */
export interface BackendIncompatibleDetail {
  readonly operation_id: string;
  readonly role: CoreExecutionRole;
  readonly failure: CapabilityCheck;
}

export type DecisionValidationResult =
  | { readonly kind: "ACCEPTED" }
  | { readonly kind: "HUMAN_GATE_REQUIRED" }
  | { readonly kind: "POLICY_REJECTED"; readonly reason_code: DecisionRejectReason }
  | { readonly kind: "BACKEND_INCOMPATIBLE"; readonly detail: BackendIncompatibleDetail };

export const DECISION_RESULT_KINDS: readonly DecisionValidationResult["kind"][] = [
  "ACCEPTED",
  "HUMAN_GATE_REQUIRED",
  "POLICY_REJECTED",
  "BACKEND_INCOMPATIBLE",
];

// --- operation identifiers (TD §9.2d, M0-27) ----------------------------------------

/**
 * The only operation ids the validator itself references. `operation_id` stays a Policy-owned
 * opaque string: a Policy may declare others, but nothing here infers or selects them, and no
 * Proposal field carries one.
 */
export const ACTOR_EXECUTION_OPERATION = "actor_execution";
export const AUDITOR_EXECUTION_OPERATION = "auditor_execution";
export const AUTOMATIC_MERGE_OPERATION = "automatic_merge";

export const CORE_REFERENCED_OPERATION_IDS: readonly string[] = [
  ACTOR_EXECUTION_OPERATION,
  AUDITOR_EXECUTION_OPERATION,
  AUTOMATIC_MERGE_OPERATION,
];

/** The pipeline step whose presence makes a selection consume a writable slot (§9.2e). */
export const WRITABLE_PIPELINE_STEP: PipelineStep = "ACTOR";
