/**
 * Post-resolved-Human-Gate revalidation (TD §17.3, HG-1).
 *
 * A human APPROVE is consent, not execution authorization. An approval can arrive hours later
 * (Spec §50), by which time the repository head, the Backend Manifest, the batch capacity, the
 * Compiled Profile or the TaskDefinition may all have moved. So the approved Proposal is put back
 * through the *whole* validator against fresh authority input:
 *
 *   V1–V6 fresh → the exact resolved V7 occurrence → V8–V11 fresh
 *
 * There is no global gate switch. The authorization satisfies V7 only for the Proposal copy that
 * was frozen inside the resolved record, so approving one Proposal cannot execute another.
 */

import { DecisionError, inputInvalid } from "./errors.ts";
import { validateProposal } from "./proposal.ts";
import type { DecisionValidationResult, ProposalV1 } from "./types.ts";
import {
  sameStructure,
  validateDecisionWithSatisfiedGate,
  type DecisionValidationInput,
} from "./validator.ts";

/**
 * Built from a durable RESOLVED `HUMAN_GATE_APPROVAL` record — never asserted by a caller out of
 * thin air (see `core/humandecision/gate-authorization.ts`).
 */
export interface ResolvedHumanGateAuthorization {
  readonly decision_id: string;
  readonly record_hash: string;
  readonly normalized_gate_proposal: ProposalV1;
}

/**
 * Returns one of the existing four Batch 7 result kinds. Precondition failures of the
 * authorization itself are caller-contract errors, not Proposal policy rejections, so they throw
 * rather than inventing a new reason code.
 */
export function validateDecisionAfterResolvedHumanGate(
  input: DecisionValidationInput,
  authorization: ResolvedHumanGateAuthorization,
): DecisionValidationResult {
  assertAuthorizationShape(authorization);

  // V1 first: a structurally invalid Proposal is rejected exactly as in the ordinary path.
  let proposal: ProposalV1;
  try {
    proposal = validateProposal(input.proposal);
  } catch (error) {
    if (error instanceof DecisionError && error.reason === "PROPOSAL_SCHEMA_INVALID") {
      return { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" };
    }
    throw error;
  }

  // §17.3 step 5 — the approval covers this Proposal and no other.
  if (!sameStructure(proposal, authorization.normalized_gate_proposal)) {
    throw inputInvalid(
      "/proposal",
      `decision ${authorization.decision_id} approved a different Proposal`,
    );
  }

  // D23 — post-gate revalidation never allocates a new id. The identity view is reconstructed
  // from the exact Proposal copy the terminal record hash bound; this narrow rule applies to the
  // one already-V1-passed Proposal and is not a generic bypass of the active-turn binding.
  return validateDecisionWithSatisfiedGate(
    {
      ...input,
      proposal_identity: { proposal_id: authorization.normalized_gate_proposal.proposal_id },
    },
    authorization.normalized_gate_proposal,
  );
}

function assertAuthorizationShape(authorization: ResolvedHumanGateAuthorization): void {
  if (
    typeof authorization.decision_id !== "string" ||
    authorization.decision_id.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(authorization.record_hash)
  ) {
    throw inputInvalid("/authorization", "expected a decision id and a terminal record hash");
  }
}
