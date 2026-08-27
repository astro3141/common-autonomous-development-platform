/**
 * The verification gate (TD §15.3), extracted so it has exactly one implementation.
 *
 * B9 asks it about the evidence it has just bound; B10 asks it again about the evidence that is
 * durably stored. Both must reach the same verdict for the same facts, and the only way to be sure
 * of that is for there to be one evaluator rather than two that look alike.
 *
 * It reads four fields per item and nothing else, so a stored row and a freshly bound one are both
 * valid inputs without any adapting shape in between.
 */

import type { AssuranceLevel, VerificationResult } from "../../adapters/interfaces/verification-adapter.ts";

/** Why one required check did not satisfy the gate. Diagnostic only; not a §24 reason code. */
export type UnsatisfiedReason =
  | "MISSING"
  | "AMBIGUOUS"
  | "NOT_PASS"
  | "BINDING_INVALID"
  | "ASSURANCE_NOT_ACCEPTED";

/** The part of an evidence item the gate is allowed to consider. */
export interface GateEvidenceView {
  readonly check_id: string;
  readonly result: VerificationResult;
  readonly assurance_level: AssuranceLevel;
  /** The Coordinator's own binding verdict, never the verifier's claim (TD §15.2). */
  readonly binding_valid: boolean;
}

export interface RequiredCheck {
  readonly accepted_assurance: readonly AssuranceLevel[];
}

/**
 * Every required check needs one item that passed, is bound, and carries an accepted assurance.
 *
 * Assurance is a set vocabulary with no ordering, so this is membership and never a comparison.
 * Two items claiming one required check are ambiguous authority: the check is left unsatisfied
 * rather than resolved by taking the first, the last, or the strongest.
 */
export function evaluateVerificationGate(
  required: Readonly<Record<string, RequiredCheck>>,
  evidence: readonly GateEvidenceView[],
): Record<string, UnsatisfiedReason> {
  const unsatisfied: Record<string, UnsatisfiedReason> = {};

  for (const [check_id, requirement] of Object.entries(required)) {
    const matches = evidence.filter((item) => item.check_id === check_id);
    if (matches.length === 0) {
      unsatisfied[check_id] = "MISSING";
      continue;
    }
    if (matches.length > 1) {
      unsatisfied[check_id] = "AMBIGUOUS";
      continue;
    }
    const item = matches[0] as GateEvidenceView;
    if (item.result !== "PASS") {
      unsatisfied[check_id] = "NOT_PASS";
    } else if (!item.binding_valid) {
      unsatisfied[check_id] = "BINDING_INVALID";
    } else if (!requirement.accepted_assurance.includes(item.assurance_level)) {
      unsatisfied[check_id] = "ASSURANCE_NOT_ACCEPTED";
    }
  }
  return unsatisfied;
}
