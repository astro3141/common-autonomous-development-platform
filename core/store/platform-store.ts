/**
 * Platform durable store (TD D2, §18) — the single writer for one SQLite file.
 *
 * It owns exactly one connection and hands it to the focused stores; those stores never open a
 * connection themselves. Transition *policy* is not here either: the stores expose reads and
 * narrow writes, and `core/statemachine` decides what may be written.
 */

import { openDatabase, readJournalMode, type DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";
import {
  CapabilityGrantStore,
  CompiledProfileStore,
  OperatorActionStore,
  TaskContractSnapshotStore,
} from "./artifact-stores.ts";
import { BlobStore } from "./blob-store.ts";
import { DecisionLog } from "./decision-log.ts";
import { ChildMaterializationSnapshotStore } from "./materialization-store.ts";
import { IdempotencyStore } from "./idempotency-store.ts";
import { AttemptStore, BatchStore, RunStore, TaskStore } from "./lifecycle-stores.ts";
import { migrate, MIGRATIONS, readSchemaVersion, type Migration } from "./migrations.ts";
import {
  AdapterMetadataStore,
  AuditRecordStore,
  VerificationEvidenceStore,
} from "./mvp1-artifact-stores.ts";
import { PendingDecisionStore } from "./pending-decision-store.ts";
import { BatchViewProjector } from "./read-models.ts";
import { ReportOutboxStore } from "./report-outbox-store.ts";
import { TransactionRunner } from "./transaction.ts";

export interface PlatformStoreOptions {
  /** Timestamp source for durable records. Injectable so tests stay deterministic. */
  readonly now?: () => string;
  /** Migration list; defaults to the built-in sequence. */
  readonly migrations?: readonly Migration[];
  /**
   * #55 / §22.1 — open an *observation* connection: SQLite-enforced read-only, no migration
   * write, schema version verified against the expected sequence (an out-of-date file fails
   * closed rather than serving projections of an unknown schema). The single writable
   * connection stays exactly one, held elsewhere.
   */
  readonly read_only?: boolean;
}

export class PlatformStore {
  readonly #database: DatabaseSync;
  readonly #transactions: TransactionRunner;
  readonly #schemaVersion: number;

  readonly blobs: BlobStore;
  readonly decisions: DecisionLog;
  readonly idempotency: IdempotencyStore;

  // Batch 8 domain stores (TD §18.1a).
  readonly compiledProfiles: CompiledProfileStore;
  readonly materializations: ChildMaterializationSnapshotStore;
  readonly runs: RunStore;
  readonly batches: BatchStore;
  readonly tasks: TaskStore;
  readonly attempts: AttemptStore;
  readonly contracts: TaskContractSnapshotStore;
  readonly grants: CapabilityGrantStore;
  readonly pendingDecisions: PendingDecisionStore;
  readonly operatorActions: OperatorActionStore;
  readonly outbox: ReportOutboxStore;
  readonly batchView: BatchViewProjector;

  // MVP 1 artifact stores (TD §18.1c).
  readonly adapterMetadata: AdapterMetadataStore;
  readonly verificationEvidence: VerificationEvidenceStore;
  readonly auditRecords: AuditRecordStore;

  private constructor(database: DatabaseSync, options: PlatformStoreOptions) {
    const now = options.now ?? (() => new Date().toISOString());
    this.#database = database;
    if (options.read_only === true) {
      const expected = (options.migrations ?? MIGRATIONS).length;
      const applied = readSchemaVersion(database);
      if (applied !== expected) {
        throw new StoreError(
          "ARTIFACT_CORRUPT",
          `read-only open expects schema version ${expected}, found ${applied}`,
        );
      }
      this.#schemaVersion = applied;
    } else {
      this.#schemaVersion = migrate(database, options.migrations);
    }
    this.#transactions = new TransactionRunner(database);
    this.blobs = new BlobStore(database);
    this.decisions = new DecisionLog(database, now);
    this.idempotency = new IdempotencyStore(database, now);

    this.compiledProfiles = new CompiledProfileStore(database, now);
    this.materializations = new ChildMaterializationSnapshotStore(database, now);
    this.runs = new RunStore(database, now);
    this.batches = new BatchStore(database, now);
    this.tasks = new TaskStore(database, now);
    this.attempts = new AttemptStore(database, now);
    this.contracts = new TaskContractSnapshotStore(database, now);
    this.grants = new CapabilityGrantStore(database, now);
    this.pendingDecisions = new PendingDecisionStore(database, now);
    this.operatorActions = new OperatorActionStore(database);
    this.outbox = new ReportOutboxStore(database);
    this.batchView = new BatchViewProjector(database, this.compiledProfiles);

    this.adapterMetadata = new AdapterMetadataStore(database);
    this.verificationEvidence = new VerificationEvidenceStore(database);
    this.auditRecords = new AuditRecordStore(database);
  }

  /** Opens (creating if needed) the store file, enables WAL and applies pending migrations. */
  static open(filePath: string, options: PlatformStoreOptions = {}): PlatformStore {
    const database = openDatabase(filePath, { read_only: options.read_only === true });
    try {
      return new PlatformStore(database, options);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Schema version after migration. */
  get schemaVersion(): number {
    return this.#schemaVersion;
  }

  /** Journal mode as reported by the database itself. */
  get journalMode(): string {
    return readJournalMode(this.#database);
  }

  /** One state transition = one transaction (TD §18.2). Throwing rolls the whole thing back. */
  withTransaction<T>(body: () => T): T {
    return this.#transactions.run(body);
  }

  close(): void {
    this.#database.close();
  }
}
