/**
 * Task / Attempt / Batch state machine (TD §19, §20).
 *
 * Pure guards plus atomic transactional commit. No adapter is imported here, no side effect is
 * performed, and no Coordinator loop exists — every external fact arrives typed from the caller.
 */

export {
  admissionBecomesClosed,
  assertAdmissible,
  evaluateAdmission,
  pipelineHasActor,
  type AdmissionCheck,
  type AdmissionRejection,
} from "./admission.ts";
export { nextAttemptOutcome, type AttemptLimits } from "./attempt-transitions.ts";
export { nextBatchOutcome, type BatchTaskCounts } from "./batch-transitions.ts";
export { TransitionError, type TransitionErrorReason } from "./errors.ts";
export {
  commitAdmission,
  commitAttemptFact,
  commitBatchAdmissionClose,
  commitBatchFact,
  commitContractActivation,
  commitDecisionResolution,
  commitPendingDecision,
  commitTaskDeferral,
  commitTaskDiscovery,
  STATE_TRANSITION_KIND,
  type AdmissionCommand,
  type AttemptCommand,
  type AttemptTransitionResult,
  type BatchCommand,
  type ContractActivationCommand,
  type DiscoverTaskCommand,
  type PendingDecisionCreation,
  type PendingDecisionResult,
  type StateChange,
  type TransitionRecord,
  type TransitionResult,
} from "./transition-commit.ts";
export * from "./types.ts";
