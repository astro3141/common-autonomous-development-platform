/**
 * PendingHumanDecision v1 — schema, identity, hash and Human Gate construction (TD §17).
 *
 * Contract only: persistence lives in `core/store/pending-decision-store.ts`.
 */

export {
  buildHumanGateDecision,
  gateQuestion,
  isHumanGateRequired,
  HUMAN_GATE_OPTIONS,
  type HumanGateRequestInput,
} from "./gate-request.ts";
/** TD §19.4 (M1-14/B12) — the human-merge decisions, their provenance and their validity. */
export {
  buildMergeApproval,
  buildMergeMismatchDecision,
  buildMergeRejectDecision,
  mergeApprovalRemainsValid,
  mergeDecisionCause,
  mergeRejectDecisionRemainsValid,
  MERGE_APPROVAL_OPTIONS,
  MERGE_FOLLOW_UP_OPTIONS,
  type MergeApprovalBasis,
  type MergeDecisionInput,
  type MergeFollowUpBasis,
} from "./merge-decision.ts";
/** TD §11.4 / §17.2 (M1-12) — the two drift decisions, their provenance and their validity. */
export {
  buildContractDriftDecision,
  buildReattemptDecision,
  driftCause,
  driftDecisionRemainsValid,
  CONTRACT_HOLD_OPTIONS,
  REATTEMPT_OPTIONS,
  type DriftDecisionBasis,
  type DriftDecisionCategory,
  type DriftDecisionInput,
} from "./drift-decision.ts";
export {
  resolvedHumanGateAuthorization,
  APPROVE_OPTION,
  type TerminalDecisionRecord,
} from "./gate-authorization.ts";
export { HumanDecisionError, type HumanDecisionErrorReason } from "./errors.ts";
export {
  canonicalPendingDecision,
  closePendingDecision,
  computeDedupKey,
  dedupContextEnvelope,
  hashPendingDecision,
  isRecordHash,
  isTerminalStatus,
  normalizeGateProposal,
  normalizePendingDecision,
  pendingDecisionEnvelope,
  resolvePendingDecision,
  sameProposal,
  subjectKey,
  withAppliedTransition,
  type TerminalDecision,
} from "./pending-decision.ts";
export * from "./types.ts";
