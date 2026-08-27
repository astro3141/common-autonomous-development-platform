/**
 * Execution start — the `Attempt READY → Attempt IMPLEMENTING` use-case (TD §19.3e).
 *
 * A callable use-case, like `core/admission`: nothing here runs on a timer, polls, or drives a
 * loop. It lives beside the Coordinator rather than inside it, because the Coordinator is still
 * the MVP 0 shell and this is the first step that performs external side effects.
 */

export {
  startImplementation,
  ExecutionStartError,
  type ExecutionAuthorities,
  type StartImplementationCommand,
  type StartImplementationOutcome,
} from "./start-implementation.ts";
export {
  startVerification,
  type StartVerificationCommand,
  type StartVerificationOutcome,
  type VerificationAuthorities,
} from "./start-verification.ts";
export {
  completeVerification,
  type CompleteVerificationCommand,
  type CompleteVerificationOutcome,
  type VerificationCompletionAuthorities,
} from "./complete-verification.ts";
export {
  evaluateVerificationGate,
  type GateEvidenceView,
  type RequiredCheck,
  type UnsatisfiedReason,
} from "./verification-gate.ts";
export {
  startAuditing,
  type AuditingAuthorities,
  type StartAuditingCommand,
  type StartAuditingOutcome,
} from "./start-auditing.ts";
/** TD §11.4 (M1-11) — the stage-boundary drift gate: read model, assembler, pure evaluator. */
export {
  ABSENT,
  observed,
  UNAVAILABLE,
  type AuditorStageFacts,
  type DriftCurrentState,
  type DriftFrozenState,
  type DriftObservationV1,
  type DriftOutcome,
  type FrozenAuditorCapability,
  type Observation,
  type StageBoundary,
} from "./drift-observation.ts";
export { evaluateStageBoundaryDrift } from "./stage-boundary-drift.ts";
/** MVP1-B13 — the Actor rework turn and the run-level Supervisor request. */
export {
  actorSpawnOp,
  actorTurnMetadataKey,
  actorTurnOp,
  actorTurnOrdinal,
  actorWorkspaceOp,
} from "./actor-operations.ts";
export {
  startRework,
  type ReworkAuthorities,
  type StartReworkCommand,
  type StartReworkOutcome,
} from "./start-rework.ts";
export {
  supervisorSpawnOp,
  supervisorTurnMetadataKey,
  supervisorTurnOp,
  SUPERVISOR_SESSION_METADATA_KEY,
} from "./supervisor-operations.ts";
export {
  nextSupervisorTurn,
  requestSupervisorProposal,
  supervisorSession,
  supervisorTurnsIssued,
  type SupervisorAuthorities,
  type SupervisorRequestCommand,
  type SupervisorRequestOutcome,
} from "./supervisor-session.ts";
export {
  applyDriftStop,
  type DriftStopInput,
  type DriftStopOutcome,
} from "./drift-lifecycle.ts";
/** TD §16 (MVP1-B10/B11) — the Auditor cycle: identity, review context, verdict and decision. */
export {
  auditDecisionOp,
  auditorTurn1Op,
  auditorTurn2Op,
  auditorTurnMetadataKey,
  auditSpawnOp,
} from "./audit-operations.ts";
export {
  auditInstruction,
  auditorReviewContext,
  type AuditorReviewContextV1,
} from "./auditor-review.ts";
/** TD §19.4 (MVP1-B12) — the human-merge path: approval, its application, and the observation. */
export {
  applyResolvedMergeApproval,
  mergeApprovalStillValid,
  observeHumanMerge,
  requestMergeApproval,
  type ApplyMergeApprovalCommand,
  type ApplyMergeApprovalOutcome,
  type HumanMergeAuthorities,
  type MergeApprovalAuthorities,
  type ObserveHumanMergeAuthorities,
  type ObserveHumanMergeCommand,
  type ObserveHumanMergeOutcome,
  type RequestMergeApprovalCommand,
  type RequestMergeApprovalOutcome,
} from "./human-merge.ts";
export {
  completeAuditing,
  AUDIT_OBSERVATION_KIND,
  type AuditCompletionAuthorities,
  type AuditInvalidReason,
  type CompleteAuditingCommand,
  type CompleteAuditingOutcome,
} from "./complete-auditing.ts";
export {
  assembleDriftObservation,
  type DriftAssemblyInput,
  type DriftAuthorities,
} from "./assemble-drift-observation.ts";
