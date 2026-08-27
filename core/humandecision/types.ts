/**
 * PendingHumanDecision v1 contract (TD §17.1 – §17.1f, M0-31).
 *
 * A typed record end to end: there is no opaque metadata bag, and unknown body fields are
 * rejected. The record is a lifecycle row while `OPEN` and becomes an immutable, hashed artifact
 * the moment it reaches a terminal status.
 */

import type { CanonicalValue } from "../schemas/canonical-json.ts";
import type { ProposalV1 } from "../decision/types.ts";

export const PENDING_DECISION_SCHEMA = "platform/pending-decision";
export const PENDING_DECISION_CONTEXT_SCHEMA = "platform/pending-decision-context";

export type PendingDecisionStatus = "OPEN" | "RESOLVED" | "CANCELLED" | "STALE";
export const PENDING_DECISION_STATUSES: readonly PendingDecisionStatus[] = [
  "OPEN",
  "RESOLVED",
  "CANCELLED",
  "STALE",
];

export const TERMINAL_PENDING_STATUSES: readonly PendingDecisionStatus[] = [
  "RESOLVED",
  "CANCELLED",
  "STALE",
];

/** TD §17.1b — Core-fixed. Project-specific categories are not admitted into this enum. */
export type PendingDecisionCategory =
  | "HUMAN_GATE_APPROVAL"
  | "MERGE_APPROVAL"
  | "REATTEMPT_DECISION"
  | "CONTRACT_DECISION"
  | "RECOVERY_DECISION"
  /**
   * TD §16.2/§17.1b (M1-13) — a validated Auditor `HUMAN_REQUIRED` verdict.
   *
   * None of the others owns it: `HUMAN_GATE_APPROVAL` is bound to a Proposal copy, `MERGE_APPROVAL`
   * is the merge, the drift pair belongs to §11, and `RECOVERY_DECISION` is §22. The Auditor asked
   * for a person, and this is that question — it is never a way to approve a merge, and it offers
   * no path from `HUMAN_REQUIRED` to `AUDIT_PASS`.
   */
  | "AUDIT_DECISION";
export const PENDING_DECISION_CATEGORIES: readonly PendingDecisionCategory[] = [
  "HUMAN_GATE_APPROVAL",
  "MERGE_APPROVAL",
  "REATTEMPT_DECISION",
  "CONTRACT_DECISION",
  "RECOVERY_DECISION",
  "AUDIT_DECISION",
];

export type BlockingScope = "TASK_ONLY" | "DEPENDENCY_SUBTREE" | "BATCH" | "PROJECT";
export const BLOCKING_SCOPES: readonly BlockingScope[] = [
  "TASK_ONLY",
  "DEPENDENCY_SUBTREE",
  "BATCH",
  "PROJECT",
];

/** TD §17.1a — generic subject. A taskless decision never borrows a placeholder task_key. */
export type PendingDecisionSubject =
  | { readonly kind: "TASK"; readonly task_key: string }
  | { readonly kind: "BATCH"; readonly batch_id: string }
  | { readonly kind: "PROJECT"; readonly project_id: string };

export type SubjectKind = PendingDecisionSubject["kind"];
export const SUBJECT_KINDS: readonly SubjectKind[] = ["TASK", "BATCH", "PROJECT"];

/** Which subject kinds a scope may be declared on (TD §17.1a). */
export const SCOPE_SUBJECTS: Readonly<Record<BlockingScope, readonly SubjectKind[]>> = {
  TASK_ONLY: ["TASK"],
  DEPENDENCY_SUBTREE: ["TASK"],
  BATCH: ["TASK", "BATCH"],
  PROJECT: ["TASK", "BATCH", "PROJECT"],
};

/** TD §17.1d — the human's answer. `approval_binding` is what makes it a Profile authority. */
export interface PendingDecisionResolution {
  readonly kind: "OPTION" | "FREE_FORM";
  readonly chosen_option: string | null;
  readonly free_form: string | null;
  readonly resolved_by: string;
  readonly resolved_at: string;
  readonly approval_binding: {
    readonly field_path: string;
    readonly approved_value: CanonicalValue;
  } | null;
  /** `transition:<decision_log.seq>` of the transition this resolution actually caused. */
  readonly applied_transition_ref: string | null;
}

export const RESOLUTION_FIELDS: readonly string[] = [
  "kind",
  "chosen_option",
  "free_form",
  "resolved_by",
  "resolved_at",
  "approval_binding",
  "applied_transition_ref",
];

export interface PendingDecisionV1 {
  readonly decision_id: string;
  readonly subject: PendingDecisionSubject;
  readonly status: PendingDecisionStatus;
  readonly category: PendingDecisionCategory;
  readonly question: string;
  /** Order-sensitive, duplicates rejected — the option set has identity. */
  readonly options: readonly string[];
  /** Presentation only; never an execution authority (I-TD3). */
  readonly recommendation: string | null;
  readonly blocking_scope: BlockingScope;
  /** Order preserved, duplicates allowed — not a semantic set (M0-13). */
  readonly evidence_refs: readonly string[];
  readonly dedup_key: string;
  readonly created_from: string;
  /** Non-null only for `HUMAN_GATE_APPROVAL` (TD §17.2a). */
  readonly gate_proposal: ProposalV1 | null;
  readonly resolution: PendingDecisionResolution | null;
}

export const PENDING_DECISION_FIELDS: readonly (keyof PendingDecisionV1)[] = [
  "decision_id",
  "subject",
  "status",
  "category",
  "question",
  "options",
  "recommendation",
  "blocking_scope",
  "evidence_refs",
  "dedup_key",
  "created_from",
  "gate_proposal",
  "resolution",
];

/** TD §7.2 rule 7 — the projection a Profile override approval is checked against. */
export interface ApprovalBindingView {
  readonly ref: string;
  readonly status: string;
  readonly field_path: string;
  readonly approved_value: CanonicalValue;
  readonly record_hash: string;
}
