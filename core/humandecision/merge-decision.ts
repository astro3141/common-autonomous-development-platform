/**
 * MVP 1 Human Merge decisions (TD §19.4a, §19.4d, §19.4h; M1-14).
 *
 * Three questions arise on the human-merge path, and each reuses an existing Core-fixed category
 * rather than inventing one:
 *
 *   `MERGE_APPROVAL`      may this candidate be merged by hand?
 *   `REATTEMPT_DECISION`  the human declined it — redo the work, or stop? (merge-reject origin)
 *   `RECOVERY_DECISION`   canonical moved somewhere the candidate is not — redo, or stop?
 *
 * All three bind to their subject the same way, and it is deliberately minimal: `evidence_refs`
 * names the immutable `audit_record` of the settled `AUDIT_PASS` cycle, which already carries the
 * attempt, the candidate, the contract hash and the verdict. One reference reconstructs the whole
 * basis after a restart, so no body is copied into the decision (§18.1c).
 *
 * `created_from` names the attempt and the candidate rather than the audit id, because a caller
 * re-allocates identities on every pass while the attempt and its candidate are durable — that is
 * what makes the §17.1c dedup key stable across a restart. Its prefix distinguishes the three
 * origins, so two categories can share a vocabulary without sharing a question.
 */

import type { AttemptState, TaskState } from "../store/domain-types.ts";
import { isTerminalTask } from "../store/domain-types.ts";
import { computeDedupKey, normalizePendingDecision } from "./pending-decision.ts";
import type {
  PendingDecisionCategory,
  PendingDecisionSubject,
  PendingDecisionV1,
} from "./types.ts";

/** TD §19.4a — exactly these two, in this order. */
export const MERGE_APPROVAL_OPTIONS: readonly string[] = ["APPROVE", "REJECT"];

/** TD §19.4d/§19.4h — the existing reattempt vocabulary, reused verbatim. */
export const MERGE_FOLLOW_UP_OPTIONS: readonly string[] = ["REATTEMPT_WITH_NEW_SNAPSHOT", "ABANDON"];

/** The three Core-owned `created_from` prefixes of the human-merge path. */
export const MERGE_APPROVAL_PREFIX = "merge:";
export const MERGE_REJECT_PREFIX = "merge-reject:";
export const MERGE_MISMATCH_PREFIX = "merge-mismatch:";

export interface MergeDecisionInput {
  /** Caller-allocated ULID — Core allocates no identity (TD §17.1). */
  readonly decision_id: string;
  readonly task_key: string;
  readonly attempt_key: string;
  readonly candidate_commit: string;
  /** The immutable `audit_record` of the settled `AUDIT_PASS` cycle (TD §18.1c). */
  readonly audit_id: string;
}

/** TD §19.4a — the question a person is asked before a manual merge. */
export function buildMergeApproval(input: MergeDecisionInput): PendingDecisionV1 {
  return mergeDecision(input, {
    category: "MERGE_APPROVAL",
    prefix: MERGE_APPROVAL_PREFIX,
    options: MERGE_APPROVAL_OPTIONS,
    question:
      `${input.attempt_key} passed its independent audit (record ${input.audit_id}) at candidate ` +
      `${input.candidate_commit}. Approve merging it by hand, or reject?`,
  });
}

/** TD §19.4d — the human declined this candidate. The attempt is not invalidated by that. */
export function buildMergeRejectDecision(input: MergeDecisionInput): PendingDecisionV1 {
  return mergeDecision(input, {
    category: "REATTEMPT_DECISION",
    prefix: MERGE_REJECT_PREFIX,
    options: MERGE_FOLLOW_UP_OPTIONS,
    question:
      `The merge of ${input.candidate_commit} for ${input.attempt_key} was rejected. ` +
      `Reattempt against a new snapshot, or abandon?`,
  });
}

/** TD §19.4h — canonical moved, and the candidate is not in it. */
export function buildMergeMismatchDecision(input: MergeDecisionInput): PendingDecisionV1 {
  return mergeDecision(input, {
    category: "RECOVERY_DECISION",
    prefix: MERGE_MISMATCH_PREFIX,
    options: MERGE_FOLLOW_UP_OPTIONS,
    question:
      `The canonical branch moved without incorporating ${input.candidate_commit} for ` +
      `${input.attempt_key}. Reattempt against a new snapshot, or abandon?`,
  });
}

/**
 * The causal provenance, read back structurally rather than parsed out of prose (M1-12 style).
 * Returns `undefined` for a decision that did not come from the human-merge path at all.
 */
export function mergeDecisionCause(
  decision: PendingDecisionV1,
): { readonly attempt_key: string; readonly candidate_commit: string } | undefined {
  const prefix = [MERGE_MISMATCH_PREFIX, MERGE_REJECT_PREFIX, MERGE_APPROVAL_PREFIX].find((value) =>
    decision.created_from.startsWith(value),
  );
  if (prefix === undefined) return undefined;
  const body = decision.created_from.slice(prefix.length);
  // `attempt_key` contains ':'; a commit sha never does, so the last segment is the candidate.
  const split = body.lastIndexOf(":");
  if (split <= 0 || split === body.length - 1) return undefined;
  return { attempt_key: body.slice(0, split), candidate_commit: body.slice(split + 1) };
}

// --- validity (TD §17.2 category-specific STALE basis, M1-12 style) --------------------------

/**
 * TD §19.4b — what an OPEN `MERGE_APPROVAL` is still a question about.
 *
 * Canonical HEAD is deliberately absent. It moves normally while a person thinks, and that alone
 * does not make "may this be merged?" meaningless; whether canonical *permits* the merge is
 * decided once, at resolution time, by the §11 merge boundary (§19.4f). One canonical movement,
 * one authority.
 */
export interface MergeApprovalBasis {
  /** State of the Attempt named by `created_from`; `undefined` when that row is gone. */
  readonly source_attempt_state: AttemptState | undefined;
  /** The candidate the Attempt currently holds. */
  readonly current_candidate_commit: string | undefined;
  /** The settled `AUDIT_PASS` record named by `evidence_refs[0]` still resolves for this cycle. */
  readonly audit_pass_intact: boolean;
  readonly newer_attempt_exists: boolean;
  readonly task_state: TaskState;
}

export function mergeApprovalRemainsValid(
  audited_candidate: string,
  basis: MergeApprovalBasis,
): boolean {
  if (isTerminalTask(basis.task_state) || basis.newer_attempt_exists) return false;
  if (basis.source_attempt_state !== "READY_TO_MERGE") return false;
  if (basis.current_candidate_commit !== audited_candidate) return false;
  return basis.audit_pass_intact;
}

/**
 * TD §19.4d — the merge-reject follow-up.
 *
 * It uses `REATTEMPT_DECISION`, but **not** M1-12's drift predicate for that category: that one
 * requires the Attempt to be `INVALIDATED`, and a rejected merge leaves it `READY_TO_MERGE`. Each
 * decision states the condition it exists to resolve, so origin decides the rule.
 */
export interface MergeFollowUpBasis {
  readonly source_attempt_state: AttemptState | undefined;
  readonly newer_attempt_exists: boolean;
  readonly task_state: TaskState;
}

export function mergeRejectDecisionRemainsValid(basis: MergeFollowUpBasis): boolean {
  if (isTerminalTask(basis.task_state) || basis.newer_attempt_exists) return false;
  return basis.source_attempt_state === "READY_TO_MERGE";
}

// --- construction ------------------------------------------------------------------------------

function mergeDecision(
  input: MergeDecisionInput,
  shape: {
    readonly category: PendingDecisionCategory;
    readonly prefix: string;
    readonly options: readonly string[];
    readonly question: string;
  },
): PendingDecisionV1 {
  const subject: PendingDecisionSubject = { kind: "TASK", task_key: input.task_key };
  const created_from = `${shape.prefix}${input.attempt_key}:${input.candidate_commit}`;

  return normalizePendingDecision({
    decision_id: input.decision_id,
    subject,
    status: "OPEN",
    category: shape.category,
    question: shape.question,
    options: [...shape.options],
    // Presentation is Core's; a recommendation would be a model speaking through the record.
    recommendation: null,
    blocking_scope: "TASK_ONLY",
    evidence_refs: [input.audit_id],
    dedup_key: computeDedupKey(subject, shape.category, created_from),
    created_from,
    // §17.1b — a Proposal copy belongs to `HUMAN_GATE_APPROVAL` and to nothing else.
    gate_proposal: null,
    resolution: null,
  } as unknown);
}
