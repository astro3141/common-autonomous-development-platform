/**
 * Admission-local failures.
 *
 * Deliberately local, exactly like `TaskSourceError`: these are caller-contract and operational
 * failures of the submission *operation*, never Proposal policy outcomes. A validator rejection
 * is a `DecisionValidationResult`, and nothing here may be mistaken for one — in particular an
 * unreadable TaskSource must never surface as `TASK_NOT_FOUND` (TD §9.2, M0-28).
 */

export type AdmissionErrorReason =
  /** `run_id`/`batch_id` do not describe a submittable target. */
  | "SUBMISSION_CONTEXT_INVALID"
  /** The Proposal names a task with no durable row in this batch (TD §8.4: B2 owns that). */
  | "TASK_NOT_MATERIALIZED"
  /** The Proposal, the fresh definition and the durable row disagree about the task identity. */
  | "TASK_IDENTITY_MISMATCH"
  /** The branch needs a caller-supplied identity or channel that was not given. */
  | "SUBMISSION_INPUT_INCOMPLETE";

export class AdmissionError extends Error {
  readonly reason: AdmissionErrorReason;
  readonly location: string;

  constructor(reason: AdmissionErrorReason, location: string, detail: string) {
    super(`${reason} at ${location}: ${detail}`);
    this.name = "AdmissionError";
    this.reason = reason;
    this.location = location;
  }
}
