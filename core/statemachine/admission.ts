/**
 * Commit-time durable admission guard (TD §19.3a, M0-30).
 *
 * Batch 7's V11 validated a Proposal; this re-validates the same policy against the durable rows
 * inside the transaction that is about to admit a task. It is not a second policy authority — it
 * is the TOCTOU defence for the window between validation and commit, which a Supervisor turn or
 * a human approval can stretch out arbitrarily.
 */

import type { DecisionValidationBatchView } from "../decision/types.ts";
import type { BatchPolicy, CompiledProfileV1Body } from "../profile/types.ts";
import { TransitionError } from "./errors.ts";

/** The §9.2e reasons this recheck can reproduce, plus the closed-admission case. */
export type AdmissionRejection =
  | "BATCH_ADMISSION_CLOSED"
  | "BATCH_MAX_TASKS_REACHED"
  | "CONCURRENCY_LIMIT_REACHED"
  | "WRITABLE_CONCURRENCY_CONFLICT"
  /** TD §8.4a — a direct HARD dependency of the task is not clear. */
  | "HARD_DEPENDENCY_BLOCKED";

export interface AdmissionCheck {
  readonly view: DecisionValidationBatchView;
  readonly policy: BatchPolicy;
  readonly admission_closed: boolean;
  /** Whether the pipeline this admission selects contains an ACTOR step. */
  readonly pipeline_has_actor: boolean;
  /**
   * TD §9.2e (M1-7) — false for an explicit reselection: the task already consumed its batch
   * admission slot, so `max_tasks` is not re-applied. Concurrency and the writable slot are.
   */
  readonly consumes_admission_slot?: boolean;
  /**
   * TD §8.4a / §19.3a — the Coordinator's `DependencyAdmissionView`, supplied as a plain boolean.
   * Unlike the three counts this is not read from a durable row: the state machine never calls a
   * TaskSource (§19.3b), so the caller computes it and this guard only consumes it.
   */
  readonly hard_dependencies_clear: boolean;
  /**
   * §9.2g (D24) — seats held by pending child materialisations (and their unadmitted parents),
   * already excluding the admission target itself. Defaults to 0 in pre-D24 worlds.
   */
  readonly reserved_materialization_seats?: number;
}

/** Returns the rejection, or `undefined` when the admission may proceed. */
export function evaluateAdmission(check: AdmissionCheck): AdmissionRejection | undefined {
  if (check.admission_closed) return "BATCH_ADMISSION_CLOSED";
  if (
    check.consumes_admission_slot !== false &&
    check.view.admitted_task_count + (check.reserved_materialization_seats ?? 0) >=
      check.policy.max_tasks
  ) {
    return "BATCH_MAX_TASKS_REACHED";
  }
  if (check.view.active_task_count >= check.policy.concurrency) return "CONCURRENCY_LIMIT_REACHED";
  if (check.pipeline_has_actor && check.view.active_writable_candidate_count >= 1) {
    return "WRITABLE_CONCURRENCY_CONFLICT";
  }
  // Evaluated last so the existing rejection precedence is unchanged.
  if (!check.hard_dependencies_clear) return "HARD_DEPENDENCY_BLOCKED";
  return undefined;
}

export function assertAdmissible(check: AdmissionCheck): void {
  const rejection = evaluateAdmission(check);
  if (rejection !== undefined) {
    throw new TransitionError("ADMISSION_REJECTED", rejection);
  }
}

/** Pipeline shape comes from the batch's own frozen Compiled Profile, never from a later edit. */
export function pipelineHasActor(
  compiled: CompiledProfileV1Body,
  pipelineId: string,
): boolean {
  const pipeline = compiled.effective.project.pipelines[pipelineId];
  return pipeline !== undefined && pipeline.steps.includes("ACTOR");
}

/**
 * TD §19.3a — admission is also closed by reaching `max_tasks`, so the transaction that fills the
 * batch flips the flag itself rather than leaving the limit to be rediscovered.
 */
export function admissionBecomesClosed(
  admittedAfter: number,
  policy: BatchPolicy,
): boolean {
  return admittedAfter >= policy.max_tasks;
}
