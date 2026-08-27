/**
 * Applying a §11 stopping outcome (TD §11.4, §19.2; M1-11, M1-12).
 *
 * One implementation, shared by every stage boundary that evaluates drift. Each outcome is a
 * single transaction: the state change, its journal entry and — where §11.4 requires one — the
 * PendingDecision commit together or not at all. Callers evaluate the boundary *before* any
 * external effect, so a rollback here leaves the outside world untouched either way.
 *
 * `HOLD` and `INVALIDATE` reach the decision by different routes, and deliberately so. An
 * invalidated attempt carries `CONTRACT_DRIFT` on its own row, so the ordinary `decision` field is
 * used and the task is labelled by its blocking decision (§17.2). A held attempt has no reason of
 * its own, so that same relabelling would erase the only durable trace that the *contract drifted*
 * — the cause then lives in the transition entry and in the decision's own `created_from`.
 */

import {
  buildContractDriftDecision,
  buildReattemptDecision,
} from "../humandecision/drift-decision.ts";
import type { PendingDecisionV1 } from "../humandecision/types.ts";
import type { DriftTarget } from "../profile/types.ts";
import {
  commitAttemptFact,
  type PendingDecisionCreation,
} from "../statemachine/transition-commit.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { DriftOutcome } from "./drift-observation.ts";
import { ExecutionStartError } from "./start-implementation.ts";

/** TD §11.4 — what a non-`CONTINUE` boundary did to the lifecycle. */
export type DriftStopOutcome =
  | {
      readonly kind: "DRIFT_HELD";
      readonly attempt_key: string;
      readonly target: DriftTarget;
      readonly decision_id: string;
      readonly transition_seq: number;
    }
  | {
      readonly kind: "DRIFT_INVALIDATED";
      readonly attempt_key: string;
      readonly target: DriftTarget;
      readonly decision_id: string;
      readonly transition_seq: number;
    }
  | {
      readonly kind: "DRIFT_CHECK_UNAVAILABLE";
      readonly attempt_key: string;
      readonly target: DriftTarget;
      readonly transition_seq: number;
    };

export interface DriftStopInput {
  readonly attempt_key: string;
  readonly task_key: string;
  readonly outcome: Exclude<DriftOutcome, { kind: "CONTINUE" }>;
  /** Caller-allocated ULID; required only when the outcome opens a decision (TD §17.1). */
  readonly decision_id?: string;
  readonly report_channel?: string;
}

export function applyDriftStop(store: PlatformStore, input: DriftStopInput): DriftStopOutcome {
  const attempt_key = input.attempt_key;
  const target = input.outcome.target;

  if (input.outcome.kind === "UNAVAILABLE") {
    // No decision: "I could not tell" is not yet a question a person can answer between options.
    const held = commitAttemptFact(store, {
      attempt_key,
      fact: { kind: "EXECUTION_HELD", reason_code: "DRIFT_CHECK_UNAVAILABLE" },
    });
    return {
      kind: "DRIFT_CHECK_UNAVAILABLE",
      attempt_key,
      target,
      transition_seq: held.transition.seq,
    };
  }

  const invalidating = input.outcome.kind === "INVALIDATE";
  const decision = requireDriftDecision(input, target, invalidating);

  // §17.1c — the same drift on a second pass finds the open record instead of opening a second.
  const existing = store.pendingDecisions.byDedupKey(decision.decision.dedup_key);
  if (existing !== undefined) {
    throw new ExecutionStartError(
      `${attempt_key} already has an open ${decision.decision.category} for ${target}`,
    );
  }

  const committed = commitAttemptFact(store, {
    attempt_key,
    fact: invalidating
      ? { kind: "CONTRACT_DRIFT_INVALIDATED" }
      : { kind: "EXECUTION_HELD", reason_code: "CONTRACT_DRIFT" },
    decision,
  });
  return {
    kind: invalidating ? "DRIFT_INVALIDATED" : "DRIFT_HELD",
    attempt_key,
    target,
    decision_id: decision.decision.decision_id,
    transition_seq: committed.transition.seq,
  };
}

function requireDriftDecision(
  input: DriftStopInput,
  target: DriftTarget,
  invalidating: boolean,
): PendingDecisionCreation {
  if (input.decision_id === undefined || input.report_channel === undefined) {
    throw new ExecutionStartError(
      `${input.attempt_key} drifted at ${target}, which needs an allocated decision id and a report channel`,
    );
  }
  const build = invalidating ? buildReattemptDecision : buildContractDriftDecision;
  const decision: PendingDecisionV1 = build({
    decision_id: input.decision_id,
    task_key: input.task_key,
    attempt_key: input.attempt_key,
    target,
  });
  return { decision, channel: input.report_channel };
}
