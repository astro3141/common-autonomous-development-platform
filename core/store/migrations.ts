/**
 * Sequential schema migrations (TD §18: "migration은 `schema_migrations` 테이블로 관리").
 *
 * Deliberately small: an ordered list plus a runner. Migration v1 creates only the foundation
 * tables this batch actually uses; the remaining TD §18.1 domain tables are added by the
 * migration of the batch that implements them.
 */

import type { DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** One or more statements applied inside a single transaction. */
  readonly statements: string;
  /**
   * A table-rewrite migration over a table other tables reference must run with foreign-key
   * enforcement off (SQLite cannot alter a CHECK in place). The runner turns enforcement back on
   * and verifies with `PRAGMA foreign_key_check` afterwards — a rewrite that broke a reference is
   * a failed migration, never a silently weaker database.
   */
  readonly disable_foreign_keys?: boolean;
}

const MIGRATION_V1 = `
CREATE TABLE blob (
  content_hash TEXT PRIMARY KEY,
  bytes        BLOB NOT NULL
) STRICT;

CREATE TABLE decision_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  ref_key      TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;

CREATE TABLE idempotency (
  op_key      TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('INTENT', 'DONE', 'FAILED')),
  result_json TEXT,
  ts          TEXT NOT NULL
) STRICT;
`;

/**
 * Migration v2 — the exact ten domain tables of TD §18.1a. `verification_evidence`,
 * `audit_record` and `adapter_metadata` are deliberately absent: they belong to the batch that
 * actually connects Verification/Audit/backend observation persistence.
 *
 * Policy limits (`max_tasks` / `concurrency` / `max_rework`) and `completed_count` are not
 * columns: the authority is `batch.compiled_profile_hash` → the immutable Compiled Profile.
 */
const MIGRATION_V2 = `
CREATE TABLE compiled_profile_snapshot (
  compiled_hash TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE platform_run (
  run_id                TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  compiled_profile_hash TEXT NOT NULL REFERENCES compiled_profile_snapshot(compiled_hash),
  status                TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED_SAFELY', 'COMPLETED')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE TABLE batch (
  batch_id              TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES platform_run(run_id),
  ordinal               INTEGER NOT NULL CHECK (ordinal >= 1),
  compiled_profile_hash TEXT NOT NULL REFERENCES compiled_profile_snapshot(compiled_hash),
  status                TEXT NOT NULL CHECK (status IN
                          ('RUNNING', 'WAITING', 'COMPLETED', 'PAUSED_SAFELY', 'FAILED')),
  admission_closed      INTEGER NOT NULL CHECK (admission_closed IN (0, 1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (run_id, ordinal)
) STRICT;

CREATE TABLE task_contract_snapshot (
  snapshot_id   TEXT PRIMARY KEY,
  hash          TEXT NOT NULL UNIQUE,
  envelope_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE task (
  task_key               TEXT PRIMARY KEY,
  batch_id               TEXT NOT NULL REFERENCES batch(batch_id),
  project_id             TEXT NOT NULL,
  external_task_ref      TEXT NOT NULL,
  platform_state         TEXT NOT NULL CHECK (platform_state IN
                           ('DISCOVERED', 'SELECTED', 'ACTIVE', 'HELD',
                            'DEFERRED', 'COMPLETED', 'FAILED')),
  classification         TEXT,
  pipeline_id            TEXT,
  actor_profile          TEXT,
  verification_profile   TEXT,
  external_snapshot_json TEXT NOT NULL,
  admitted_at            TEXT,
  state_reason_code      TEXT,
  state_reason_log_seq   INTEGER REFERENCES decision_log(seq),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (project_id, external_task_ref),
  CHECK (platform_state NOT IN ('HELD', 'FAILED')
         OR (state_reason_code IS NOT NULL AND state_reason_log_seq IS NOT NULL))
) STRICT;

CREATE TABLE task_attempt (
  attempt_key          TEXT PRIMARY KEY,
  task_key             TEXT NOT NULL REFERENCES task(task_key),
  n                    INTEGER NOT NULL CHECK (n >= 1),
  contract_snapshot_id TEXT NOT NULL UNIQUE REFERENCES task_contract_snapshot(snapshot_id),
  state                TEXT NOT NULL CHECK (state IN
                         ('READY', 'IMPLEMENTING', 'VERIFYING', 'AUDITING', 'REWORKING',
                          'READY_TO_MERGE', 'APPROVED_FOR_MANUAL_MERGE', 'MERGING', 'MERGED',
                          'INVALIDATED', 'FAILED')),
  base_head            TEXT NOT NULL,
  candidate_commit     TEXT,
  rework_count         INTEGER NOT NULL CHECK (rework_count >= 0),
  state_reason_code    TEXT,
  state_reason_log_seq INTEGER REFERENCES decision_log(seq),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (task_key, n),
  CHECK (state <> 'FAILED'
         OR (state_reason_code IS NOT NULL AND state_reason_log_seq IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX task_attempt_single_non_terminal
  ON task_attempt (task_key)
  WHERE state NOT IN ('MERGED', 'INVALIDATED', 'FAILED');

CREATE TABLE capability_grant (
  grant_id      TEXT PRIMARY KEY,
  grant_hash    TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('SUPERVISOR', 'ACTOR', 'AUDITOR')),
  run_id        TEXT REFERENCES platform_run(run_id),
  attempt_key   TEXT REFERENCES task_attempt(attempt_key),
  envelope_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK ((role =  'SUPERVISOR' AND run_id IS NOT NULL AND attempt_key IS NULL)
      OR (role <> 'SUPERVISOR' AND run_id IS NULL     AND attempt_key IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX capability_grant_supervisor_per_run
  ON capability_grant (run_id) WHERE role = 'SUPERVISOR';

CREATE UNIQUE INDEX capability_grant_role_per_attempt
  ON capability_grant (attempt_key, role) WHERE role IN ('ACTOR', 'AUDITOR');

CREATE TABLE pending_human_decision (
  decision_id    TEXT PRIMARY KEY,
  dedup_key      TEXT NOT NULL UNIQUE,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('TASK', 'BATCH', 'PROJECT')),
  subject_ref    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'CANCELLED', 'STALE')),
  category       TEXT NOT NULL CHECK (category IN
                   ('HUMAN_GATE_APPROVAL', 'MERGE_APPROVAL', 'REATTEMPT_DECISION',
                    'CONTRACT_DECISION', 'RECOVERY_DECISION')),
  blocking_scope TEXT NOT NULL CHECK (blocking_scope IN
                   ('TASK_ONLY', 'DEPENDENCY_SUBTREE', 'BATCH', 'PROJECT')),
  envelope_json  TEXT NOT NULL,
  record_hash    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((status =  'OPEN' AND record_hash IS NULL)
      OR (status <> 'OPEN' AND record_hash IS NOT NULL))
) STRICT;

CREATE TABLE operator_action (
  action_id           TEXT PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status = 'RESOLVED'),
  field_path          TEXT NOT NULL,
  approved_value_json TEXT NOT NULL,
  recorded_by         TEXT NOT NULL,
  recorded_at         TEXT NOT NULL,
  record_hash         TEXT NOT NULL UNIQUE,
  envelope_json       TEXT NOT NULL
) STRICT;

CREATE TABLE report_outbox (
  op_key       TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sent_at      TEXT
) STRICT;
`;

/**
 * Migration v3 — the exact three MVP 1 tables of TD §18.1c. Nothing else is added: no runtime,
 * workflow, workspace, coordinator, scheduler, recovery, dependency, event or registry table.
 *
 * `adapter_metadata` is a *current projection*, so it has no hash, no state and no history;
 * `verification_evidence` and `audit_record` are immutable artifact rows.
 */
const MIGRATION_V3 = `
CREATE TABLE adapter_metadata (
  entity_key TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (entity_key, adapter_id, key)
) STRICT;

CREATE TABLE verification_evidence (
  evidence_id        TEXT PRIMARY KEY,
  attempt_key        TEXT NOT NULL REFERENCES task_attempt(attempt_key),
  check_id           TEXT NOT NULL,
  result             TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'ERROR')),
  assurance_level    TEXT NOT NULL CHECK (assurance_level IN
                       ('REEXECUTED', 'ARTIFACT_VERIFIED', 'LOG_VERIFIED',
                        'WORKER_REPORTED', 'INFERRED')),
  target_commit      TEXT NOT NULL,
  task_contract_hash TEXT NOT NULL,
  executor_identity  TEXT NOT NULL,
  run_reference      TEXT,
  artifact_digest    TEXT,
  log_digest         TEXT,
  timestamp          TEXT NOT NULL,
  binding_valid      INTEGER NOT NULL CHECK (binding_valid IN (0, 1)),
  envelope_json      TEXT NOT NULL
) STRICT;

CREATE INDEX verification_evidence_by_attempt ON verification_evidence (attempt_key);

CREATE TABLE audit_record (
  audit_id           TEXT PRIMARY KEY,
  attempt_key        TEXT NOT NULL REFERENCES task_attempt(attempt_key),
  candidate_commit   TEXT NOT NULL,
  task_contract_hash TEXT NOT NULL,
  verdict            TEXT NOT NULL CHECK (verdict IN
                       ('AUDIT_PASS', 'FIX_REQUIRED', 'HUMAN_REQUIRED')),
  envelope_json      TEXT NOT NULL,
  workflow_ref       TEXT,
  committed_via      TEXT NOT NULL,
  recorded_at        TEXT NOT NULL
) STRICT;

CREATE INDEX audit_record_by_attempt ON audit_record (attempt_key);
`;

/** TD §18.1d (M1-6) — the selected repository scope id, one nullable selection column. */
const MIGRATION_V4 = `
ALTER TABLE task ADD COLUMN repository_scope_id TEXT NULL;
`;

/** TD §18.1e (M1-7) — the validated selection basis, one nullable typed body. */
const MIGRATION_V5 = `
ALTER TABLE task ADD COLUMN selection_binding_json TEXT NULL;
`;

/**
 * TD §17.1b (M1-13) — `AUDIT_DECISION` joins the Core-fixed category vocabulary.
 *
 * The vocabulary is a SQLite `CHECK` constraint, which cannot be altered in place, so the table is
 * rebuilt: create, copy, drop, rename. Everything else about it is byte-identical to v2's
 * definition — same columns, same types, same constraints, same `STRICT` — and the copy is a plain
 * `INSERT … SELECT` of every existing row, so no record is rewritten or dropped. Nothing
 * references `pending_human_decision`, so the drop takes no foreign key with it, and the whole
 * migration runs inside the runner's own transaction.
 *
 * The table count is unchanged: 17 before, 17 after.
 */
const MIGRATION_V6 = `
CREATE TABLE pending_human_decision_v6 (
  decision_id    TEXT PRIMARY KEY,
  dedup_key      TEXT NOT NULL UNIQUE,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('TASK', 'BATCH', 'PROJECT')),
  subject_ref    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'CANCELLED', 'STALE')),
  category       TEXT NOT NULL CHECK (category IN
                   ('HUMAN_GATE_APPROVAL', 'MERGE_APPROVAL', 'REATTEMPT_DECISION',
                    'CONTRACT_DECISION', 'RECOVERY_DECISION', 'AUDIT_DECISION')),
  blocking_scope TEXT NOT NULL CHECK (blocking_scope IN
                   ('TASK_ONLY', 'DEPENDENCY_SUBTREE', 'BATCH', 'PROJECT')),
  envelope_json  TEXT NOT NULL,
  record_hash    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((status =  'OPEN' AND record_hash IS NULL)
      OR (status <> 'OPEN' AND record_hash IS NOT NULL))
) STRICT;

INSERT INTO pending_human_decision_v6
  (decision_id, dedup_key, subject_kind, subject_ref, status, category, blocking_scope,
   envelope_json, record_hash, created_at, updated_at)
SELECT
  decision_id, dedup_key, subject_kind, subject_ref, status, category, blocking_scope,
  envelope_json, record_hash, created_at, updated_at
FROM pending_human_decision;

DROP TABLE pending_human_decision;

ALTER TABLE pending_human_decision_v6 RENAME TO pending_human_decision;
`;

/**
 * Migration v7 — MVP 3 (TD §19.1/§27): the `SUSPENDED` parent state and the child's
 * `parent_task_key`. SQLite cannot extend a CHECK, so the task table is rewritten — the same
 * pattern migration v6 used for the decision category, with the foreign-key handling the runner
 * provides for a referenced table. Table count stays 17: no new table, one new nullable column.
 */
const MIGRATION_V7 = `
CREATE TABLE task_v7 (
  task_key               TEXT PRIMARY KEY,
  batch_id               TEXT NOT NULL REFERENCES batch(batch_id),
  project_id             TEXT NOT NULL,
  external_task_ref      TEXT NOT NULL,
  platform_state         TEXT NOT NULL CHECK (platform_state IN
                           ('DISCOVERED', 'SELECTED', 'ACTIVE', 'HELD', 'SUSPENDED',
                            'DEFERRED', 'COMPLETED', 'FAILED')),
  classification         TEXT,
  pipeline_id            TEXT,
  actor_profile          TEXT,
  verification_profile   TEXT,
  external_snapshot_json TEXT NOT NULL,
  admitted_at            TEXT,
  state_reason_code      TEXT,
  state_reason_log_seq   INTEGER REFERENCES decision_log(seq),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  repository_scope_id    TEXT,
  selection_binding_json TEXT,
  parent_task_key        TEXT REFERENCES task_v7(task_key),
  UNIQUE (project_id, external_task_ref),
  CHECK (platform_state NOT IN ('HELD', 'FAILED')
         OR (state_reason_code IS NOT NULL AND state_reason_log_seq IS NOT NULL))
) STRICT;

INSERT INTO task_v7
  (task_key, batch_id, project_id, external_task_ref, platform_state,
   classification, pipeline_id, actor_profile, verification_profile,
   external_snapshot_json, admitted_at, state_reason_code, state_reason_log_seq,
   created_at, updated_at, repository_scope_id, selection_binding_json, parent_task_key)
SELECT
  task_key, batch_id, project_id, external_task_ref, platform_state,
  classification, pipeline_id, actor_profile, verification_profile,
  external_snapshot_json, admitted_at, state_reason_code, state_reason_log_seq,
  created_at, updated_at, repository_scope_id, selection_binding_json, NULL
FROM task;

DROP TABLE task;

ALTER TABLE task_v7 RENAME TO task;
`;

/**
 * §18.1f/§19.2 (D22, MVP 3) — adds the additive terminal AttemptState `SUCCEEDED` to the
 * `task_attempt` CHECK and to the single-non-terminal index's terminal set. `SUCCEEDED` is a
 * frozen-pipeline terminal-success fact (§19.5.2), never an alias for `MERGED`. Same FK-off
 * rewrite discipline as v7; table count unchanged; MVP 0/1 rows are copied verbatim.
 */
const MIGRATION_V8 = `
CREATE TABLE task_attempt_v8 (
  attempt_key          TEXT PRIMARY KEY,
  task_key             TEXT NOT NULL REFERENCES task(task_key),
  n                    INTEGER NOT NULL CHECK (n >= 1),
  contract_snapshot_id TEXT NOT NULL UNIQUE REFERENCES task_contract_snapshot(snapshot_id),
  state                TEXT NOT NULL CHECK (state IN
                         ('READY', 'IMPLEMENTING', 'VERIFYING', 'AUDITING', 'REWORKING',
                          'READY_TO_MERGE', 'APPROVED_FOR_MANUAL_MERGE', 'MERGING', 'MERGED',
                          'SUCCEEDED', 'INVALIDATED', 'FAILED')),
  base_head            TEXT NOT NULL,
  candidate_commit     TEXT,
  rework_count         INTEGER NOT NULL CHECK (rework_count >= 0),
  state_reason_code    TEXT,
  state_reason_log_seq INTEGER REFERENCES decision_log(seq),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (task_key, n),
  CHECK (state <> 'FAILED'
         OR (state_reason_code IS NOT NULL AND state_reason_log_seq IS NOT NULL))
) STRICT;

INSERT INTO task_attempt_v8
  (attempt_key, task_key, n, contract_snapshot_id, state, base_head, candidate_commit,
   rework_count, state_reason_code, state_reason_log_seq, created_at, updated_at)
SELECT
  attempt_key, task_key, n, contract_snapshot_id, state, base_head, candidate_commit,
  rework_count, state_reason_code, state_reason_log_seq, created_at, updated_at
FROM task_attempt;

DROP TABLE task_attempt;

ALTER TABLE task_attempt_v8 RENAME TO task_attempt;

CREATE UNIQUE INDEX task_attempt_single_non_terminal
  ON task_attempt (task_key)
  WHERE state NOT IN ('MERGED', 'SUCCEEDED', 'INVALIDATED', 'FAILED');
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "foundation", statements: MIGRATION_V1 },
  { version: 2, name: "domain", statements: MIGRATION_V2 },
  { version: 3, name: "mvp1-artifacts", statements: MIGRATION_V3 },
  { version: 4, name: "selection-scope", statements: MIGRATION_V4 },
  { version: 5, name: "selection-binding", statements: MIGRATION_V5 },
  { version: 6, name: "audit-decision-category", statements: MIGRATION_V6 },
  { version: 7, name: "subflow-parent", statements: MIGRATION_V7, disable_foreign_keys: true },
  { version: 8, name: "subflow-succeeded", statements: MIGRATION_V8, disable_foreign_keys: true },
];

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

/** The highest applied migration version, or 0 for a database with none applied. */
export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Applies every migration newer than the recorded version, in ascending order, each inside its
 * own transaction together with its `schema_migrations` row — so a failed migration is rolled
 * back and never recorded as applied. Returns the resulting schema version.
 */
export function migrate(
  database: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  assertDeterministicSequence(migrations);
  database.exec(BOOTSTRAP);

  const current = readSchemaVersion(database);
  const latest = migrations.length === 0 ? 0 : (migrations[migrations.length - 1] as Migration).version;
  if (current > latest) {
    throw new StoreError(
      "SCHEMA_VERSION_AHEAD",
      `database is at schema version ${current} but this build knows up to ${latest}; refusing to downgrade`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    applyOne(database, migration);
  }
  return readSchemaVersion(database);
}

function applyOne(database: DatabaseSync, migration: Migration): void {
  const withoutForeignKeys = migration.disable_foreign_keys === true;
  // PRAGMA foreign_keys cannot change inside a transaction, so the toggle brackets it.
  if (withoutForeignKeys) database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migration.statements);
    if (withoutForeignKeys) {
      // The check runs before COMMIT: a rewrite that broke a reference rolls back whole.
      const broken = database.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`${broken.length} broken foreign-key references after rewrite`);
      }
    }
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    if (withoutForeignKeys) database.exec("PRAGMA foreign_keys = ON");
    throw new StoreError(
      "MIGRATION_FAILED",
      `migration ${migration.version} (${migration.name}) was rolled back and not recorded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (withoutForeignKeys) database.exec("PRAGMA foreign_keys = ON");
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Already rolled back by SQLite; nothing further to undo.
  }
}

/** Versions must be a contiguous 1..n sequence so application order cannot drift. */
function assertDeterministicSequence(migrations: readonly Migration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new StoreError(
        "MIGRATION_SEQUENCE_INVALID",
        `expected version ${index + 1} at position ${index}, found ${migration.version}`,
      );
    }
  }
}
