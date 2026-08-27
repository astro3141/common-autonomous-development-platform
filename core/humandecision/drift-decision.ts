/**
 * Stage-boundary drift → PendingHumanDecision construction (TD §11.4, §17.1; M1-11).
 *
 * §11.4 maps its two stopping outcomes onto categories that already exist: an invalidated Attempt
 * asks whether to try again against a new snapshot (`REATTEMPT_DECISION`), and a held one asks
 * whether the frozen snapshot may still finish (`CONTRACT_DECISION`). Nothing new is invented —
 * no category, no scope, no record shape.
 *
 * Both builders are deterministic. `created_from` names the attempt and the drift target, so the
 * §17.1c dedup identity distinguishes two genuinely different drifts and collapses two passes over
 * the same one. The question text is Core-owned: what a person is asked to authorize never comes
 * from a model (I-TD3).
 */

import type { AttemptState } from "../store/domain-types.ts";
import { computeDedupKey, normalizePendingDecision } from "./pending-decision.ts";
import type { PendingDecisionSubject, PendingDecisionV1 } from "./types.ts";

/** The two categories §11.4 opens, and the only ones this module knows anything about. */
export type DriftDecisionCategory = "CONTRACT_DECISION" | "REATTEMPT_DECISION";

/** TD §17.1c — the Core-owned `created_from` grammar for a drift decision. */
const DRIFT_PREFIX = "drift:";

/** TD §11.4 — reattempt against a new snapshot, or stop. */
export const REATTEMPT_OPTIONS: readonly string[] = ["REATTEMPT_WITH_NEW_SNAPSHOT", "ABANDON"];

/** TD §11.2 — let the frozen snapshot finish, or invalidate the Attempt. */
export const CONTRACT_HOLD_OPTIONS: readonly string[] = [
  "ALLOW_FROZEN_SNAPSHOT_TO_COMPLETE",
  "INVALIDATE_ATTEMPT",
];

export interface DriftDecisionInput {
  /** Caller-allocated ULID — Core allocates no identity (TD §17.1). */
  readonly decision_id: string;
  readonly task_key: string;
  readonly attempt_key: string;
  /** The §11.2 target whose observation produced this outcome. */
  readonly target: string;
}

/**
 * The `INVALIDATE` decision. `TASK_ONLY`: an invalidated Attempt blocks its own task and nothing
 * else, and the next Attempt is a human decision rather than an automatic restart (§19.2).
 */
export function buildReattemptDecision(input: DriftDecisionInput): PendingDecisionV1 {
  return driftDecision(input, {
    category: "REATTEMPT_DECISION",
    options: REATTEMPT_OPTIONS,
    question:
      `${input.attempt_key} was invalidated because ${input.target} no longer matches the frozen ` +
      `contract. Reattempt against a new snapshot, or abandon?`,
  });
}

/** The `HOLD` decision, including a restrictive `REEVALUATE_AT_BOUNDARY`. */
export function buildContractDriftDecision(input: DriftDecisionInput): PendingDecisionV1 {
  return driftDecision(input, {
    category: "CONTRACT_DECISION",
    options: CONTRACT_HOLD_OPTIONS,
    question:
      `${input.attempt_key} is held because ${input.target} changed after its contract was frozen. ` +
      `Allow the frozen snapshot to complete, or invalidate the Attempt?`,
  });
}

/**
 * TD §11.4 / §17.1c (M1-12) — the causal provenance, read back structurally.
 *
 * §17.2's blocking rule means a drifting task's `state_reason_code` is
 * `BLOCKED_BY_DECISION:<id>` like every other task-scoped decision, so the *cause* lives here and
 * in the transition fact instead. This reader exists so nobody has to invent a regular expression
 * over the record to recover it: `created_from` is a Core-owned grammar, not free-form prose, and
 * this is its one parser.
 */
export function driftCause(
  decision: PendingDecisionV1,
): { readonly attempt_key: string; readonly target: string } | undefined {
  if (!decision.created_from.startsWith(DRIFT_PREFIX)) return undefined;
  const body = decision.created_from.slice(DRIFT_PREFIX.length);
  // `attempt_key` contains ':'; the drift target never does, so the last segment is the target.
  const split = body.lastIndexOf(":");
  if (split <= 0 || split === body.length - 1) return undefined;
  return { attempt_key: body.slice(0, split), target: body.slice(split + 1) };
}

/**
 * TD §17.2 STALE, closed for exactly these two categories (M1-12).
 *
 * A generic "the attempt is INVALIDATED, so stale every decision on its task" rule would kill a
 * `REATTEMPT_DECISION` the instant it was created — its whole subject *is* an invalidated Attempt.
 * So validity is per-category and stated positively: each decision names the condition it exists
 * to resolve, and stays valid while that condition holds.
 *
 * This is not a dependency engine. It is one pure predicate over facts a caller has already read,
 * and it decides nothing about *when* a reconciliation pass runs.
 */
export interface DriftDecisionBasis {
  /** State of the Attempt named by `created_from`; `undefined` when that row is gone. */
  readonly source_attempt_state: AttemptState | undefined;
  /** A later Attempt exists for the same task — the decision has been overtaken by events. */
  readonly newer_attempt_exists: boolean;
  /** The task reached a terminal state, so nothing about this Attempt is still open. */
  readonly task_terminal: boolean;
}

export function driftDecisionRemainsValid(
  category: DriftDecisionCategory,
  basis: DriftDecisionBasis,
): boolean {
  if (basis.task_terminal || basis.newer_attempt_exists) return false;
  if (basis.source_attempt_state === undefined) return false;

  return category === "REATTEMPT_DECISION"
    ? // The condition it asks about: the source Attempt is invalidated and no replacement exists.
      basis.source_attempt_state === "INVALIDATED"
    : // A hold is a question about the Attempt as it stands. If it has moved on — invalidated,
      // failed, merged — the held snapshot the question was about is gone.
      basis.source_attempt_state === "VERIFYING" ||
        basis.source_attempt_state === "IMPLEMENTING" ||
        basis.source_attempt_state === "AUDITING" ||
        basis.source_attempt_state === "READY_TO_MERGE" ||
        basis.source_attempt_state === "REWORKING" ||
        basis.source_attempt_state === "READY";
}

function driftDecision(
  input: DriftDecisionInput,
  shape: {
    readonly category: DriftDecisionCategory;
    readonly options: readonly string[];
    readonly question: string;
  },
): PendingDecisionV1 {
  const subject: PendingDecisionSubject = { kind: "TASK", task_key: input.task_key };
  const created_from = `${DRIFT_PREFIX}${input.attempt_key}:${input.target}`;

  return normalizePendingDecision({
    decision_id: input.decision_id,
    subject,
    status: "OPEN",
    category: shape.category,
    question: shape.question,
    options: [...shape.options],
    recommendation: null,
    blocking_scope: "TASK_ONLY",
    evidence_refs: [],
    dedup_key: computeDedupKey(subject, shape.category, created_from),
    created_from,
    gate_proposal: null,
    resolution: null,
  } as unknown);
}
