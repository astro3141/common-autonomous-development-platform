/**
 * AttemptState guards (TD §19.2, §19.3, §19.4).
 *
 * Pure: current row plus one observed fact plus the batch's frozen rework limit. No side effect
 * is performed and no adapter is consulted — the whole generic lifecycle is therefore drivable
 * from synthetic facts, which is what MVP 0 A1/A4 rely on.
 *
 * Every transition is written out explicitly. There is no transition table framework, no
 * statechart and no registry.
 */

import { isTerminalAttempt, type TaskAttemptRow } from "../store/domain-types.ts";
import { illegal, precondition, TransitionError } from "./errors.ts";
import type { AttemptFact, AttemptOutcome } from "./types.ts";

export interface AttemptLimits {
  /** `effective.policy.batch_policy.max_rework` of the batch that froze the profile. */
  readonly max_rework: number;
}

export function nextAttemptOutcome(
  attempt: TaskAttemptRow,
  fact: AttemptFact,
  limits: AttemptLimits,
): AttemptOutcome {
  if (isTerminalAttempt(attempt.state)) {
    throw illegal(`attempt ${attempt.attempt_key} is already ${attempt.state}`);
  }
  const from = attempt.state;

  switch (fact.kind) {
    case "EXECUTION_STARTED": {
      expect(from === "READY", `READY→IMPLEMENTING requires READY, not ${from}`);
      if (!fact.workspace_created) throw precondition("no workspace was created");
      // §12.6: a receipt weaker than the grant is a boundary change, never a silent start.
      if (!fact.receipt_valid) throw precondition("the enforcement receipt does not match the grant");
      return { attempt_state: "IMPLEMENTING" };
    }

    case "CANDIDATE_OBSERVED": {
      expect(from === "IMPLEMENTING", `IMPLEMENTING→VERIFYING requires IMPLEMENTING, not ${from}`);
      if (fact.candidate_commit.length === 0) throw precondition("no candidate commit was observed");
      if (!fact.lineage_valid) throw precondition("the candidate is not a child of base_head");
      if (!fact.tracked_clean) throw precondition("the workspace is not tracked-clean");
      return { attempt_state: "VERIFYING", candidate_commit: fact.candidate_commit };
    }

    case "CANDIDATE_REJECTED": {
      expect(from === "IMPLEMENTING", `a rejected candidate requires IMPLEMENTING, not ${from}`);
      // §19.3 — the same shape a failed verification takes: rework while the batch still allows
      // it, otherwise park the task. No new §24 reason and no candidate-specific vocabulary.
      if (attempt.rework_count >= limits.max_rework) {
        return { attempt_state: from, task_state: "HELD", task_reason_code: "REWORK_LIMIT" };
      }
      return { attempt_state: "REWORKING" };
    }

    case "VERIFICATION_PASSED": {
      expect(from === "VERIFYING", `VERIFYING→AUDITING requires VERIFYING, not ${from}`);
      return { attempt_state: "AUDITING" };
    }

    case "AUDIT_STARTED": {
      expect(from === "VERIFYING", `VERIFYING→AUDITING requires VERIFYING, not ${from}`);
      if (!fact.session_ready) throw precondition("no Auditor session was established");
      // §12.6 — a receipt weaker than the grant is a boundary change, never a silent start.
      if (!fact.receipt_valid) throw precondition("the enforcement receipt does not match the grant");
      return { attempt_state: "AUDITING" };
    }

    case "VERIFICATION_FAILED": {
      expect(from === "VERIFYING", `verification failure requires VERIFYING, not ${from}`);
      // Infrastructure failures are not the Actor's fault, so they never consume a rework.
      if (fact.infrastructure) {
        return {
          attempt_state: "VERIFYING",
          task_state: "HELD",
          task_reason_code: "VERIFICATION_INFRA",
        };
      }
      if (attempt.rework_count >= limits.max_rework) {
        return { attempt_state: "VERIFYING", task_state: "HELD", task_reason_code: "REWORK_LIMIT" };
      }
      return { attempt_state: "REWORKING" };
    }

    case "AUDIT_DECIDED": {
      expect(from === "AUDITING", `an audit verdict requires AUDITING, not ${from}`);
      switch (fact.verdict) {
        case "AUDIT_PASS":
          if (!fact.drift_clear) {
            return {
              attempt_state: "AUDITING",
              task_state: "HELD",
              task_reason_code: "CONTRACT_DRIFT",
              needs_human_decision: true,
            };
          }
          return { attempt_state: "READY_TO_MERGE" };
        case "FIX_REQUIRED":
          if (attempt.rework_count >= limits.max_rework) {
            return {
              attempt_state: "AUDITING",
              task_state: "HELD",
              task_reason_code: "REWORK_LIMIT",
            };
          }
          return { attempt_state: "REWORKING" };
        case "HUMAN_REQUIRED":
          // The attempt stays where it is; the task parks until a person answers (§24).
          return {
            attempt_state: "AUDITING",
            task_state: "HELD",
            task_reason_code: "AUDIT_HUMAN_REQUIRED",
            needs_human_decision: true,
          };
      }
      break;
    }

    case "REWORK_STARTED": {
      expect(from === "REWORKING", `rework requires REWORKING, not ${from}`);
      if (!fact.snapshot_valid) throw precondition("the frozen contract snapshot is no longer valid");
      if (attempt.rework_count >= limits.max_rework) {
        return { attempt_state: "REWORKING", task_state: "HELD", task_reason_code: "REWORK_LIMIT" };
      }
      // Same attempt, same contract, same grants — only the counter moves (§19.3).
      return { attempt_state: "IMPLEMENTING", rework_count: attempt.rework_count + 1 };
    }

    case "MANUAL_MERGE_APPROVED": {
      expect(from === "READY_TO_MERGE", `manual approval requires READY_TO_MERGE, not ${from}`);
      // APPROVE records consent only. MERGED is a repository fact (§19.4).
      //
      // M1-14 — the task was `HELD(BLOCKED_BY_DECISION:<merge decision>)` while the question was
      // open. Applying the answer is what unblocks it, so the task returns to `ACTIVE` with no
      // reason: leaving it held by a decision that is already resolved would be a stale blocker.
      return { attempt_state: "APPROVED_FOR_MANUAL_MERGE", task_state: "ACTIVE" };
    }

    case "MANUAL_MERGE_REJECTED": {
      expect(from === "READY_TO_MERGE", `merge rejection requires READY_TO_MERGE, not ${from}`);
      return {
        attempt_state: "READY_TO_MERGE",
        task_state: "HELD",
        task_reason_code: "MERGE_REJECTED",
        needs_human_decision: true,
      };
    }

    case "AUTOMATIC_MERGE_STARTED": {
      expect(from === "READY_TO_MERGE", `merge start requires READY_TO_MERGE, not ${from}`);
      if (!fact.gate_preconditions_met) throw precondition("the repository gate preconditions failed");
      return { attempt_state: "MERGING" };
    }

    case "MERGE_OBSERVED": {
      expect(
        from === "MERGING" || from === "APPROVED_FOR_MANUAL_MERGE",
        `a merge observation requires MERGING or APPROVED_FOR_MANUAL_MERGE, not ${from}`,
      );
      if (!fact.canonical_contains_candidate) {
        // Nothing happened yet: the attempt waits. Absence of a merge is not a failure.
        return { attempt_state: from };
      }
      return { attempt_state: "MERGED", task_state: "COMPLETED" };
    }

    case "MERGE_MISMATCH_OBSERVED": {
      expect(
        from === "MERGING" || from === "APPROVED_FOR_MANUAL_MERGE",
        `a mismatch observation requires a merge-pending attempt, not ${from}`,
      );
      return {
        attempt_state: from,
        task_state: "HELD",
        task_reason_code: "HUMAN_MERGE_MISMATCH",
        needs_human_decision: true,
      };
    }

    case "CONTRACT_DRIFT_INVALIDATED": {
      return {
        attempt_state: "INVALIDATED",
        attempt_reason_code: "CONTRACT_DRIFT",
        task_state: "HELD",
        task_reason_code: "CONTRACT_DRIFT",
        // A new Attempt is always an explicit human decision — never a silent restart (§19.2).
        needs_human_decision: true,
      };
    }

    case "EXECUTION_HELD": {
      return {
        attempt_state: from,
        task_state: "HELD",
        task_reason_code: fact.reason_code,
      };
    }

    case "ATTEMPT_FAILED": {
      return {
        attempt_state: "FAILED",
        attempt_reason_code: fact.reason_code,
        task_state: "FAILED",
        task_reason_code: fact.reason_code,
      };
    }
  }

  throw illegal(`unhandled attempt fact from ${from}`);
}

function expect(condition: boolean, detail: string): void {
  if (!condition) throw new TransitionError("ILLEGAL_TRANSITION", detail);
}
