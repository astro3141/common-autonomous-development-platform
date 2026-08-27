/**
 * The five Backend boundaries of the Platform (TD §3, §25; Spec §64).
 *
 * Interfaces only — no production adapter exists in this package.
 */

export type * from "./handles.ts";
export type {
  CapabilityEnforcementReceipt,
  CapabilityName,
  EnforcementAssurance,
} from "./capability.ts";
export type {
  DeclaredStatus,
  IdentityAuthority,
  ModelDeclaredOutcome,
  ResultChannelKind,
  RuntimeAdapter,
  RuntimeBackendStatus,
  RuntimeOperationContextV1,
  RuntimePreflight,
  RuntimePreflightOutcome,
  RuntimeResultProvenance,
  RuntimeSpawnResult,
  RuntimeStructuredOutput,
  RuntimeTurnResult,
} from "./runtime-adapter.ts";
export type {
  AuditVerdict,
  WorkflowAdapter,
  WorkflowObservation,
} from "./workflow-adapter.ts";
export type {
  CandidateInspection,
  CreateFeatureWorkspaceRequestV1,
  ExpectedFilesRequest,
  FeatureWorkspace,
  MergeCommit,
  MergePreparation,
  MergeRequest,
  RepositoryAdapter,
  RepositoryCanonicalSnapshot,
  RepositoryDiff,
  RepositoryRange,
} from "./repository-adapter.ts";
export type {
  AssuranceLevel,
  VerificationAdapter,
  VerificationEvidence,
  VerificationOperationContextV1,
  VerificationResult,
  VerificationRunObservation,
  VerificationStartResult,
} from "./verification-adapter.ts";
export {
  ReportDeliveryError,
  type ReportAdapter,
  type ReportDeliveryErrorCode,
  type ReportDeliveryRequest,
  type ReportDeliveryResult,
} from "./report-adapter.ts";
