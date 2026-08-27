/**
 * Decision-module-local failures.
 *
 * Two meanings only, and they are deliberately not the same thing:
 *
 * - `PROPOSAL_SCHEMA_INVALID` describes untrusted structured input and is mapped by the validator
 *   to `POLICY_REJECTED(PROPOSAL_SCHEMA_INVALID)` — it is a V1 outcome, not a crash.
 * - `VALIDATOR_INPUT_INVALID` describes the *caller's* contract: a missing read model, a
 *   malformed count, a compiled profile that contradicts itself. It propagates, because turning a
 *   programming error into a Proposal rejection would blame the Supervisor for a Platform defect.
 *
 * No global error or Result framework is introduced.
 */

export type DecisionErrorReason = "PROPOSAL_SCHEMA_INVALID" | "VALIDATOR_INPUT_INVALID";

export class DecisionError extends Error {
  readonly reason: DecisionErrorReason;
  /** Where the failure is, e.g. `/expected/base_head` or `/batch/active_task_count`. */
  readonly location: string;

  constructor(reason: DecisionErrorReason, location: string, detail: string) {
    super(`${reason} at ${location === "" ? "/" : location}: ${detail}`);
    this.name = "DecisionError";
    this.reason = reason;
    this.location = location;
  }
}

export function proposalInvalid(location: string, detail: string): DecisionError {
  return new DecisionError("PROPOSAL_SCHEMA_INVALID", location, detail);
}

export function inputInvalid(location: string, detail: string): DecisionError {
  return new DecisionError("VALIDATOR_INPUT_INVALID", location, detail);
}
