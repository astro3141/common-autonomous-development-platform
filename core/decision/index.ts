/**
 * Supervisor Proposal + deterministic Decision Validator V1–V11 (TD §9).
 *
 * Pure Core calculation plus one durable append seam. No state machine, no Coordinator, no
 * pending human decision, no Task Contract and no capability grant are produced here.
 */

export {
  authorizeDecision,
  effectiveDisposition,
  requiresHumanGate,
} from "./decision-authority.ts";
export {
  decisionPayload,
  validateAndRecordDecision,
  DECISION_VALIDATION_LOG_KIND,
  type DecisionLogAppender,
  type RecordedDecision,
} from "./decision-log.ts";
export { DecisionError, type DecisionErrorReason } from "./errors.ts";
export {
  validateDecisionAfterResolvedHumanGate,
  type ResolvedHumanGateAuthorization,
} from "./human-gate-revalidation.ts";
export { validateProposal } from "./proposal.ts";
export {
  validateDecision,
  validateDecisionWithSatisfiedGate,
  type DecisionValidationInput,
} from "./validator.ts";
export * from "./types.ts";
