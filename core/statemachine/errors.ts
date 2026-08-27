/**
 * State machine failures.
 *
 * Local to this module. A guard rejection is not a Proposal rejection: Batch 7's
 * `DecisionRejectReason` is untouched, and no new global taxonomy is introduced.
 */

export type TransitionErrorReason =
  /** The current state does not admit this transition. */
  | "ILLEGAL_TRANSITION"
  /** The transition is legal but its authoritative precondition is not satisfied. */
  | "PRECONDITION_FAILED"
  /** Commit-time durable admission recheck failed (TD §19.3a). */
  | "ADMISSION_REJECTED"
  /** A HELD/FAILED write arrived without a §24 reason code. */
  | "REASON_REQUIRED"
  /** The caller's command contradicts the durable rows it names. */
  | "COMMAND_INVALID";

export class TransitionError extends Error {
  readonly reason: TransitionErrorReason;
  /** For an admission rejection, the §9.2e reason the recheck reproduced. */
  readonly detail: string;

  constructor(reason: TransitionErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "TransitionError";
    this.reason = reason;
    this.detail = detail;
  }
}

export const illegal = (detail: string): TransitionError =>
  new TransitionError("ILLEGAL_TRANSITION", detail);

export const precondition = (detail: string): TransitionError =>
  new TransitionError("PRECONDITION_FAILED", detail);
