/**
 * Platform durable store errors (TD §18).
 *
 * The store fails closed: an inconsistency is never repaired by guessing, and a rejected
 * write leaves no partial state behind (TD §18 failure behavior).
 */

export type StoreErrorCode =
  /** The database reports a journal mode other than the required WAL (TD D2/§18). */
  | "JOURNAL_MODE_UNAVAILABLE"
  /** The database was created by a newer schema version than this build knows. */
  | "SCHEMA_VERSION_AHEAD"
  /** The migration list is not a deterministic contiguous sequence. */
  | "MIGRATION_SEQUENCE_INVALID"
  /** A migration failed; it is not recorded as applied. */
  | "MIGRATION_FAILED"
  /** A transaction was opened while one is already active on the single writer. */
  | "NESTED_TRANSACTION"
  /** A stored blob's bytes disagree with its content hash. */
  | "BLOB_CONTENT_MISMATCH"
  /** An idempotency record was not found where one is required. */
  | "IDEMPOTENCY_RECORD_MISSING"
  /** A state rewrite that TD §21 does not define was attempted. */
  | "IDEMPOTENCY_STATE_CONFLICT"
  /** An immutable artifact was re-inserted under the same identity with different content. */
  | "ARTIFACT_CONFLICT"
  /** A stored artifact's bytes disagree with the hash recorded for it. */
  | "ARTIFACT_CORRUPT"
  /** A durable row required by the operation does not exist. */
  | "DOMAIN_ROW_MISSING"
  /** A row or write violates the TD §18.1a domain contract. */
  | "DOMAIN_ROW_INVALID"
  /** Same `dedup_key` reused for a semantically different pending decision (TD §17.2). */
  | "PENDING_DECISION_CONFLICT"
  /** Same `op_key` re-enqueued with a different channel or payload (TD §21.1). */
  | "REPORT_OUTBOX_CONFLICT";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "StoreError";
    this.code = code;
  }
}
