/**
 * Durable domain vocabularies and row shapes (TD §18.1a, §19.1, §19.2, §20).
 *
 * These are the Core-fixed state vocabularies — nothing here invents a state, and the SQL CHECK
 * constraints of migration v2 mirror exactly these lists.
 */

import type { CanonicalValue } from "../schemas/canonical-json.ts";
import type { ExternalTaskState } from "../tasksource/types.ts";

// --- state vocabularies -------------------------------------------------------------

/** TD §20 / §18.1a. No run-level FAILED in v1: safety failures converge on PAUSED_SAFELY. */
export type PlatformRunState = "RUNNING" | "PAUSED_SAFELY" | "COMPLETED";
export const PLATFORM_RUN_STATES: readonly PlatformRunState[] = [
  "RUNNING",
  "PAUSED_SAFELY",
  "COMPLETED",
];

/** TD §20. `FAILED` stays representable but has no automatic incoming transition (§20.3). */
export type BatchState = "RUNNING" | "WAITING" | "COMPLETED" | "PAUSED_SAFELY" | "FAILED";
export const BATCH_STATES: readonly BatchState[] = [
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "PAUSED_SAFELY",
  "FAILED",
];

/** TD §19.1. `SUSPENDED` is MVP 3 and is deliberately absent. */
export type TaskState =
  | "DISCOVERED"
  | "SELECTED"
  | "ACTIVE"
  | "HELD"
  /** TD §19.1 / §27 — MVP 3 extension state, held only by a subflow parent. */
  | "SUSPENDED"
  | "DEFERRED"
  | "COMPLETED"
  | "FAILED";
export const TASK_STATES: readonly TaskState[] = [
  "DISCOVERED",
  "SELECTED",
  "ACTIVE",
  "HELD",
  "SUSPENDED",
  "DEFERRED",
  "COMPLETED",
  "FAILED",
];

/** TD §19.1 — `HELD` is deliberately not terminal: it is resumed by a human decision. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["COMPLETED", "FAILED", "DEFERRED"];

export type AttemptState =
  | "READY"
  | "IMPLEMENTING"
  | "VERIFYING"
  | "AUDITING"
  | "REWORKING"
  | "READY_TO_MERGE"
  | "APPROVED_FOR_MANUAL_MERGE"
  | "MERGING"
  | "MERGED"
  | "SUCCEEDED"
  | "INVALIDATED"
  | "FAILED";
export const ATTEMPT_STATES: readonly AttemptState[] = [
  "READY",
  "IMPLEMENTING",
  "VERIFYING",
  "AUDITING",
  "REWORKING",
  "READY_TO_MERGE",
  "APPROVED_FOR_MANUAL_MERGE",
  "MERGING",
  "MERGED",
  // §19.5.2 (D22, MVP 3) — frozen-pipeline terminal-success for a RESUME_PARENT terminal step.
  // Not a repository/publication fact and never interchangeable with MERGED.
  "SUCCEEDED",
  "INVALIDATED",
  "FAILED",
];

export const TERMINAL_ATTEMPT_STATES: readonly AttemptState[] = [
  "MERGED",
  "SUCCEEDED",
  "INVALIDATED",
  "FAILED",
];

/** TD §19.3c — the attempt states that reserve the single writable candidate slot. */
export const WRITABLE_ATTEMPT_STATES: readonly AttemptState[] = [
  "READY",
  "IMPLEMENTING",
  "REWORKING",
];

export const isTerminalTask = (state: TaskState): boolean => TERMINAL_TASK_STATES.includes(state);
export const isTerminalAttempt = (state: AttemptState): boolean =>
  TERMINAL_ATTEMPT_STATES.includes(state);

// --- rows ----------------------------------------------------------------------------

export interface PlatformRunRow {
  readonly run_id: string;
  readonly project_id: string;
  readonly compiled_profile_hash: string;
  readonly status: PlatformRunState;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BatchRow {
  readonly batch_id: string;
  readonly run_id: string;
  readonly ordinal: number;
  readonly compiled_profile_hash: string;
  readonly status: BatchState;
  readonly admission_closed: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** TD §8.3 — exactly four fields; `version` is required for §9.2 V3 freshness. */
export interface ExternalTaskSnapshotV1 {
  readonly external_state: ExternalTaskState;
  readonly version: string;
  readonly definition_hash: string;
  readonly observed_at: string;
}

export const EXTERNAL_SNAPSHOT_FIELDS: readonly (keyof ExternalTaskSnapshotV1)[] = [
  "external_state",
  "version",
  "definition_hash",
  "observed_at",
];

/** The four Proposal-selected fields, all NULL until the first admission (TD §18.1a). */
export interface TaskSelectionFields {
  readonly classification: string;
  readonly pipeline_id: string;
  readonly actor_profile: string;
  readonly verification_profile: string;
}

export interface StateReason {
  readonly code: string;
  readonly log_seq: number;
}

/**
 * TD §19.3a (M1-7) — the selection basis a task was admitted against.
 *
 * Exactly three fields. The authority is **not** `Proposal.expected`: these are the authoritative
 * TaskSource/Repository facts that V3/V8 validated at admission time, so activation can prove it
 * is executing what was actually decided — even after a restart, with no Proposal in memory.
 */
export interface SelectionBindingV1 {
  readonly task_version: string;
  readonly task_definition_hash: string;
  readonly base_head: string;
}

export const SELECTION_BINDING_FIELDS: readonly (keyof SelectionBindingV1)[] = [
  "task_version",
  "task_definition_hash",
  "base_head",
];

/**
 * §8.4b/§18.1g (D24) — the immutable pre-admission relation provenance a materialised child's
 * task row carries after the exact TaskSource round-trip. Never rewritten or cleared; ordinary
 * and pre-existing external tasks keep null. Distinct from `parent_task_key`, which stays the
 * D22 executable relation set only at E admission.
 */
export interface ChildMaterializationBindingV1 {
  readonly materialization_id: string;
  readonly materialization_hash: string;
  readonly task_source_id: string;
  readonly parent_task_key: string;
  readonly child_definition_hash: string;
}

export const CHILD_MATERIALIZATION_BINDING_FIELDS: readonly (keyof ChildMaterializationBindingV1)[] = [
  "materialization_id",
  "materialization_hash",
  "task_source_id",
  "parent_task_key",
  "child_definition_hash",
];

export interface TaskRow {
  readonly task_key: string;
  readonly batch_id: string;
  readonly project_id: string;
  readonly external_task_ref: string;
  readonly platform_state: TaskState;
  readonly classification: string | null;
  readonly pipeline_id: string | null;
  readonly actor_profile: string | null;
  readonly verification_profile: string | null;
  /** TD §7.1a/§18.1d (M1-6) — the declared scope id this selection chose. */
  readonly repository_scope_id: string | null;
  /** TD §19.3a/§18.1e (M1-7) — validated selection basis; never the latest observation. */
  readonly selection_binding: SelectionBindingV1 | null;
  readonly external_snapshot: ExternalTaskSnapshotV1;
  /** Monotonic admission marker: once set it is never cleared (TD §18.1a). */
  readonly admitted_at: string | null;
  /** MVP 3 (TD §27) — the parent this task is a subflow child of, or null. */
  readonly parent_task_key: string | null;
  /** §18.1g (D24) — pre-admission materialisation provenance, or null. */
  readonly materialization_binding: ChildMaterializationBindingV1 | null;
  readonly state_reason: StateReason | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskAttemptRow {
  readonly attempt_key: string;
  readonly task_key: string;
  readonly n: number;
  readonly contract_snapshot_id: string;
  readonly state: AttemptState;
  readonly base_head: string;
  readonly candidate_commit: string | null;
  readonly rework_count: number;
  readonly state_reason: StateReason | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type GrantRole = "SUPERVISOR" | "ACTOR" | "AUDITOR";

export interface CapabilityGrantRow {
  readonly grant_id: string;
  readonly grant_hash: string;
  readonly role: GrantRole;
  readonly run_id: string | null;
  readonly attempt_key: string | null;
  readonly created_at: string;
}

export interface ReportOutboxRow {
  readonly op_key: string;
  readonly channel: string;
  readonly payload: CanonicalValue;
  readonly sent_at: string | null;
}

// --- MVP 1 artifact rows (TD §18.1c) -------------------------------------------------

/** TD §15.2 — evidence outcome. */
export type VerificationResult = "PASS" | "FAIL" | "ERROR";
export const VERIFICATION_RESULTS: readonly VerificationResult[] = ["PASS", "FAIL", "ERROR"];

/** TD §15.2 / §7.1b — the five assurance levels, unchanged. */
export type EvidenceAssuranceLevel =
  | "REEXECUTED"
  | "ARTIFACT_VERIFIED"
  | "LOG_VERIFIED"
  | "WORKER_REPORTED"
  | "INFERRED";
export const EVIDENCE_ASSURANCE_LEVELS: readonly EvidenceAssuranceLevel[] = [
  "REEXECUTED",
  "ARTIFACT_VERIFIED",
  "LOG_VERIFIED",
  "WORKER_REPORTED",
  "INFERRED",
];

/** TD §16.2 — the three verdicts the Auditor envelope may carry. */
export type AuditVerdictV1 = "AUDIT_PASS" | "FIX_REQUIRED" | "HUMAN_REQUIRED";
export const AUDIT_VERDICTS: readonly AuditVerdictV1[] = [
  "AUDIT_PASS",
  "FIX_REQUIRED",
  "HUMAN_REQUIRED",
];

/**
 * TD §18.1c — one `adapter_metadata` row. A *current projection* of an adapter-owned reference
 * admissible under I-TD7, never Platform lifecycle authority: no hash, no state, no version, no history.
 */
export interface AdapterMetadataRow {
  readonly entity_key: string;
  readonly adapter_id: string;
  readonly key: string;
  readonly value: CanonicalValue;
}

/** TD §18.1c — one immutable `verification_evidence` row (§15.2 envelope + query projection). */
export interface VerificationEvidenceRow {
  readonly evidence_id: string;
  readonly attempt_key: string;
  readonly check_id: string;
  readonly result: VerificationResult;
  readonly assurance_level: EvidenceAssuranceLevel;
  readonly target_commit: string;
  readonly task_contract_hash: string;
  readonly executor_identity: string;
  readonly run_reference: string | null;
  readonly artifact_digest: string | null;
  readonly log_digest: string | null;
  readonly timestamp: string;
  /**
   * TD §15.2 — computed by the Coordinator from an authoritative revalidation, never asserted by
   * the producer of the evidence. A `false` row is stored but can back no gate.
   */
  readonly binding_valid: boolean;
}

/** TD §18.1c — one immutable `audit_record` row (a §16.2-validated verdict). */
export interface AuditRecordRow {
  readonly audit_id: string;
  readonly attempt_key: string;
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
  readonly verdict: AuditVerdictV1;
  readonly workflow_ref: string | null;
  /** Generic provenance only — no backend-specific vocabulary (TD §18.1c). */
  readonly committed_via: string;
  readonly recorded_at: string;
}
