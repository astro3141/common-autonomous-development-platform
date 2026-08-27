/**
 * Platform durable store — foundation substrate (TD D2, §18, §21).
 */

export {
  lookupApprovalBinding,
  HUMAN_DECISION_PREFIX,
  OPERATOR_ACTION_PREFIX,
  type ApprovalSources,
} from "./approval-binding.ts";
export {
  CapabilityGrantStore,
  CompiledProfileStore,
  OperatorActionStore,
  TaskContractSnapshotStore,
  type GrantScope,
  type OperatorActionInput,
  type OperatorActionRecord,
} from "./artifact-stores.ts";
export { BlobStore } from "./blob-store.ts";
export { DecisionLog, type DecisionLogAppend, type DecisionLogEntry } from "./decision-log.ts";
export { StoreError, type StoreErrorCode } from "./errors.ts";
export {
  IdempotencyStore,
  type BeginIntentResult,
  type IdempotencyRecord,
  type IdempotencyState,
} from "./idempotency-store.ts";
export * from "./domain-types.ts";
export {
  AttemptStore,
  BatchStore,
  RunStore,
  TaskStore,
  validateExternalSnapshot,
  type AttemptInput,
  type AttemptWrite,
  type BatchInput,
  type DiscoveredTaskInput,
  type RunInput,
  type TaskStateWrite,
} from "./lifecycle-stores.ts";
export { MIGRATIONS, readSchemaVersion, type Migration } from "./migrations.ts";
export {
  isSecretBearingKey,
  SECRET_BEARING_KEY_CATEGORIES,
} from "./restricted-key-denylist.ts";
export {
  AdapterMetadataStore,
  AuditRecordStore,
  VerificationEvidenceStore,
  type AdapterMetadataInput,
  validateAuditorVerdict,
  type AuditorFindingV1,
  type AuditorReviewedV1,
  type AuditorVerdictV1,
  type AuditRecordInput,
  type VerificationEvidenceInput,
  type VerificationEvidenceV1,
} from "./mvp1-artifact-stores.ts";
export { PendingDecisionStore, type StoredPendingDecision } from "./pending-decision-store.ts";
export { BatchViewProjector } from "./read-models.ts";
export { ReportOutboxStore, type ReportEnqueue } from "./report-outbox-store.ts";
export { PlatformStore, type PlatformStoreOptions } from "./platform-store.ts";
