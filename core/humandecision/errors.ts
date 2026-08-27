/**
 * PendingHumanDecision contract failures.
 *
 * Local to this module: the Platform-wide taxonomy (§24) is owned by the Coordinator batch. No
 * global error framework is introduced.
 */

export type HumanDecisionErrorReason =
  /** Body violates the exact §17.1 schema. */
  | "DECISION_INVALID"
  /** A status/resolution combination TD does not define was attempted. */
  | "DECISION_STATUS_CONFLICT";

export class HumanDecisionError extends Error {
  readonly reason: HumanDecisionErrorReason;
  /** Where the failure is, e.g. `/resolution/chosen_option`. */
  readonly location: string;

  constructor(reason: HumanDecisionErrorReason, location: string, detail: string) {
    super(`${reason} at ${location === "" ? "/" : location}: ${detail}`);
    this.name = "HumanDecisionError";
    this.reason = reason;
    this.location = location;
  }
}

export function decisionInvalid(location: string, detail: string): HumanDecisionError {
  return new HumanDecisionError("DECISION_INVALID", location, detail);
}
