/**
 * Validated Auditor `HUMAN_REQUIRED` → PendingHumanDecision (TD §16.2, §17.1; M1-13).
 *
 * The Auditor is allowed to say "a person has to look at this". It is not allowed to say what the
 * person may then do, so the option set is Core-owned and deliberately short: send it back for
 * rework, or stop. There is **no** option that turns `HUMAN_REQUIRED` into `AUDIT_PASS` — a human
 * cannot hand-wave an audit into a pass in MVP 1, and no wording here should suggest otherwise.
 *
 * `created_from` names the concrete audit cycle by its candidate, which is what makes the §17.1c
 * dedup identity stable across a restart: the caller re-allocates a `decision_id`, but the same
 * candidate under the same attempt is the same question. The immutable `audit_record` is referenced
 * through `evidence_refs`, so the finding context is reachable without any free-form text.
 */

import type { AttemptState } from "../store/domain-types.ts";
import { computeDedupKey, normalizePendingDecision } from "./pending-decision.ts";
import type { PendingDecisionSubject, PendingDecisionV1 } from "./types.ts";

/** TD §16.2 (M1-13) — exactly two, in this order. No accept-as-pass and no bypass. */
export const AUDIT_DECISION_OPTIONS: readonly string[] = ["REQUEST_REWORK", "ABANDON"];

/** The Core-owned `created_from` grammar for an audit decision. */
const AUDIT_PREFIX = "audit:";

export interface AuditDecisionInput {
  /** Caller-allocated ULID — Core allocates no identity (TD §17.1). */
  readonly decision_id: string;
  readonly task_key: string;
  readonly attempt_key: string;
  /** The candidate this audit cycle judged. Identifies the cycle; stable across a restart. */
  readonly candidate_commit: string;
  /** The immutable `audit_record` this decision is about (TD §18.1c). */
  readonly audit_id: string;
}

export function buildAuditDecision(input: AuditDecisionInput): PendingDecisionV1 {
  const subject: PendingDecisionSubject = { kind: "TASK", task_key: input.task_key };
  const created_from = `${AUDIT_PREFIX}${input.attempt_key}:${input.candidate_commit}`;

  return normalizePendingDecision({
    decision_id: input.decision_id,
    subject,
    status: "OPEN",
    category: "AUDIT_DECISION",
    question:
      `The Auditor reviewed ${input.candidate_commit} for ${input.attempt_key} and requires a ` +
      `human decision (audit record ${input.audit_id}). Send it back for rework, or abandon?`,
    options: [...AUDIT_DECISION_OPTIONS],
    // Presentation is Core's; a recommendation would be the model speaking through the record.
    recommendation: null,
    blocking_scope: "TASK_ONLY",
    // The immutable record carries the verdict and its findings; nothing is copied out of it.
    evidence_refs: [input.audit_id],
    dedup_key: computeDedupKey(subject, "AUDIT_DECISION", created_from),
    created_from,
    gate_proposal: null,
    resolution: null,
  } as unknown);
}

/** The causal provenance, read back structurally rather than parsed out of prose (M1-12 style). */
export function auditDecisionCause(
  decision: PendingDecisionV1,
): { readonly attempt_key: string; readonly candidate_commit: string } | undefined {
  if (decision.created_from.startsWith(AUDIT_PREFIX) === false) return undefined;
  const body = decision.created_from.slice(AUDIT_PREFIX.length);
  // `attempt_key` contains ':'; a commit sha never does, so the last segment is the candidate.
  const split = body.lastIndexOf(":");
  if (split <= 0 || split === body.length - 1) return undefined;
  return { attempt_key: body.slice(0, split), candidate_commit: body.slice(split + 1) };
}

/**
 * TD §17.2 STALE, closed for this category (M1-13), in the same narrow style M1-12 established:
 * the decision states the condition it exists to resolve and stays valid while that holds.
 *
 * Not a dependency engine — one pure predicate over facts a caller has already read.
 */
export interface AuditDecisionBasis {
  /** State of the Attempt named by `created_from`; `undefined` when that row is gone. */
  readonly source_attempt_state: AttemptState | undefined;
  /** The candidate the Attempt currently holds. A newer one means a newer audit cycle. */
  readonly current_candidate_commit: string | undefined;
  /** A later Attempt exists for the same task. */
  readonly newer_attempt_exists: boolean;
  readonly task_terminal: boolean;
}

export function auditDecisionRemainsValid(
  audited_candidate: string,
  basis: AuditDecisionBasis,
): boolean {
  if (basis.task_terminal || basis.newer_attempt_exists) return false;
  if (basis.source_attempt_state === undefined) return false;
  // The question is about an audit that is still the current one: a rework that produced a new
  // candidate has superseded it, and so has an Attempt that left AUDITING by any other route.
  if (basis.current_candidate_commit !== audited_candidate) return false;
  return basis.source_attempt_state === "AUDITING";
}
