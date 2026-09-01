/**
 * Durable lifecycle rows: run, batch, task and attempt (TD §18.1a, §19, §20).
 *
 * Plain concrete stores — read, insert, and the narrow state writes the transitions need. They
 * hold no policy: guards live in `core/statemachine`, and every write here is expected to run
 * inside the transition's own transaction (TD §18.2).
 */

import { canonicalize } from "../schemas/canonical-json.ts";
import type { DatabaseSync } from "./database.ts";
import {
  ATTEMPT_STATES,
  BATCH_STATES,
  EXTERNAL_SNAPSHOT_FIELDS,
  PLATFORM_RUN_STATES,
  TASK_STATES,
  type AttemptState,
  type BatchRow,
  type BatchState,
  SELECTION_BINDING_FIELDS,
  type ExternalTaskSnapshotV1,
  type SelectionBindingV1,
  type PlatformRunRow,
  type PlatformRunState,
  type StateReason,
  type TaskAttemptRow,
  type TaskRow,
  type TaskSelectionFields,
  type TaskState,
} from "./domain-types.ts";
import { StoreError } from "./errors.ts";
import { EXTERNAL_TASK_STATES } from "../tasksource/types.ts";

const invalid = (detail: string): StoreError => new StoreError("DOMAIN_ROW_INVALID", detail);

// --- platform_run -----------------------------------------------------------------------

export interface RunInput {
  readonly run_id: string;
  readonly project_id: string;
  readonly compiled_profile_hash: string;
}

export class RunStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  create(input: RunInput): PlatformRunRow {
    if (!/^run:[0-9A-HJKMNP-TV-Z]{26}$/.test(input.run_id)) {
      throw invalid(`run_id must be run:<ulid>, got ${JSON.stringify(input.run_id)}`);
    }
    if (input.project_id.length === 0 || input.project_id.includes(":")) {
      // §6.1: project_id fixes the first structural separator of task_key.
      throw invalid("project_id must be non-empty and must not contain ':'");
    }

    const at = this.#now();
    this.#database
      .prepare(
        `INSERT INTO platform_run
           (run_id, project_id, compiled_profile_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, 'RUNNING', ?, ?)`,
      )
      .run(input.run_id, input.project_id, input.compiled_profile_hash, at, at);
    return this.require(input.run_id);
  }

  setStatus(runId: string, status: PlatformRunState): PlatformRunRow {
    assertMember(status, PLATFORM_RUN_STATES, "platform run status");
    this.#database
      .prepare("UPDATE platform_run SET status = ?, updated_at = ? WHERE run_id = ?")
      .run(status, this.#now(), runId);
    return this.require(runId);
  }

  /** Non-COMPLETED runs of one project, oldest first. The durable run-discovery read (§53). */
  activeForProject(projectId: string): readonly PlatformRunRow[] {
    const rows = this.#database
      .prepare(
        `SELECT run_id, project_id, compiled_profile_hash, status, created_at, updated_at
           FROM platform_run
          WHERE project_id = ? AND status <> 'COMPLETED'
          ORDER BY run_id ASC`,
      )
      .all(projectId) as unknown as PlatformRunRow[];
    return rows;
  }

  get(runId: string): PlatformRunRow | undefined {
    const row = this.#database
      .prepare(
        "SELECT run_id, project_id, compiled_profile_hash, status, created_at, updated_at FROM platform_run WHERE run_id = ?",
      )
      .get(runId) as PlatformRunRow | undefined;
    return row === undefined ? undefined : { ...row };
  }

  require(runId: string): PlatformRunRow {
    const row = this.get(runId);
    if (row === undefined) throw missing("platform_run", runId);
    return row;
  }
}

// --- batch --------------------------------------------------------------------------------

export interface BatchInput {
  readonly batch_id: string;
  readonly run_id: string;
  readonly ordinal: number;
  /** Frozen per batch: a later Profile change applies from the next batch (TD §7.4). */
  readonly compiled_profile_hash: string;
}

export class BatchStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  create(input: BatchInput): BatchRow {
    if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
      throw invalid("batch ordinal must be an integer >= 1");
    }
    const at = this.#now();
    this.#database
      .prepare(
        `INSERT INTO batch
           (batch_id, run_id, ordinal, compiled_profile_hash, status, admission_closed,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'RUNNING', 0, ?, ?)`,
      )
      .run(input.batch_id, input.run_id, input.ordinal, input.compiled_profile_hash, at, at);
    return this.require(input.batch_id);
  }

  setStatus(batchId: string, status: BatchState): BatchRow {
    assertMember(status, BATCH_STATES, "batch status");
    this.#database
      .prepare("UPDATE batch SET status = ?, updated_at = ? WHERE batch_id = ?")
      .run(status, this.#now(), batchId);
    return this.require(batchId);
  }

  /** Admission only ever closes; it is never reopened (TD §19.3a). */
  closeAdmission(batchId: string): BatchRow {
    this.#database
      .prepare("UPDATE batch SET admission_closed = 1, updated_at = ? WHERE batch_id = ?")
      .run(this.#now(), batchId);
    return this.require(batchId);
  }

  get(batchId: string): BatchRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT batch_id, run_id, ordinal, compiled_profile_hash, status, admission_closed,
                created_at, updated_at FROM batch WHERE batch_id = ?`,
      )
      .get(batchId) as (Omit<BatchRow, "admission_closed"> & { admission_closed: number }) | undefined;
    return row === undefined ? undefined : { ...row, admission_closed: row.admission_closed === 1 };
  }

  require(batchId: string): BatchRow {
    const row = this.get(batchId);
    if (row === undefined) throw missing("batch", batchId);
    return row;
  }

  /** Read-only enumeration of the existing run→batch relation, in ordinal order. */
  forRun(runId: string): readonly BatchRow[] {
    const rows = this.#database
      .prepare(
        `SELECT batch_id, run_id, ordinal, compiled_profile_hash, status, admission_closed,
                created_at, updated_at FROM batch WHERE run_id = ? ORDER BY ordinal ASC`,
      )
      .all(runId) as unknown as (Omit<BatchRow, "admission_closed"> & {
      admission_closed: number;
    })[];
    return rows.map((row) => ({ ...row, admission_closed: row.admission_closed === 1 }));
  }
}

// --- task -----------------------------------------------------------------------------------

/** TD §19.3a — the selection provenance one admission writes, as a single unit. */
export interface TaskSelectionWrite {
  readonly selection: TaskSelectionFields;
  readonly repository_scope_id: string;
  readonly selection_binding: SelectionBindingV1;
}

export interface DiscoveredTaskInput {
  readonly task_key: string;
  readonly batch_id: string;
  readonly project_id: string;
  readonly external_task_ref: string;
  readonly external_snapshot: ExternalTaskSnapshotV1;
  /** Caller-supplied observation time (TD §8.4). Falls back to the store clock when omitted. */
  readonly at?: string;
}

export interface TaskStateWrite {
  readonly platform_state: TaskState;
  readonly reason?: StateReason;
  /** The whole selection provenance, written as one unit (TD §19.3a). */
  readonly selection?: TaskSelectionWrite;
  /**
   * TD §19.3a (M1-7) — an explicit reselection replaces an existing selection. Initial admission
   * may not: without this flag a second selection write is refused.
   */
  readonly replace_selection?: boolean;
  /** Set on the first admission and never cleared afterwards (TD §18.1a). */
  readonly admitted_at?: string;
  /** Clears `state_reason_*`, e.g. when a reselection resolves a SELECTION_STALE hold. */
  readonly clear_reason?: boolean;
  /** MVP 3 — links a subflow child to its parent. Written once at subflow admission. */
  readonly parent_task_key?: string;
}

export class TaskStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  discover(input: DiscoveredTaskInput): TaskRow {
    const snapshot = validateExternalSnapshot(input.external_snapshot);
    if (input.external_task_ref.length === 0) throw invalid("external_task_ref must be non-empty");
    if (input.project_id.includes(":")) throw invalid("project_id must not contain ':'");

    const at = observationTime(input.at, this.#now);
    this.#database
      .prepare(
        `INSERT INTO task
           (task_key, batch_id, project_id, external_task_ref, platform_state,
            classification, pipeline_id, actor_profile, verification_profile,
            external_snapshot_json, admitted_at, state_reason_code, state_reason_log_seq,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'DISCOVERED', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.task_key,
        input.batch_id,
        input.project_id,
        input.external_task_ref,
        canonicalize(snapshot as never),
        at,
        at,
      );
    return this.require(input.task_key);
  }

  /**
   * Latest TaskSource observation. A projection, never Platform lifecycle authority (§8.3).
   *
   * The statement touches exactly two columns: the observation itself and its time. Platform
   * state, selection fields, `admitted_at` and the state reason are unreachable from here, so an
   * external observation can never become a lifecycle claim (TD §8.3, §34 of this batch).
   */
  observe(taskKey: string, snapshot: ExternalTaskSnapshotV1, at?: string): TaskRow {
    const validated = validateExternalSnapshot(snapshot);
    this.require(taskKey);
    this.#database
      .prepare("UPDATE task SET external_snapshot_json = ?, updated_at = ? WHERE task_key = ?")
      .run(canonicalize(validated as never), observationTime(at, this.#now), taskKey);
    return this.require(taskKey);
  }

  write(taskKey: string, write: TaskStateWrite): TaskRow {
    assertMember(write.platform_state, TASK_STATES, "task state");
    const current = this.require(taskKey);

    const needsReason = write.platform_state === "HELD" || write.platform_state === "FAILED";
    if (needsReason && write.reason === undefined) {
      throw invalid(`${write.platform_state} requires a reason code and a decision_log ref`);
    }

    // Selection is written once; a later transition may not silently re-select. An explicit
    // reselection (§19.3a) says so, and then replaces every selection field together.
    if (
      write.selection !== undefined &&
      currentSelection(current) !== undefined &&
      write.replace_selection !== true
    ) {
      throw invalid(`${taskKey} already has selection fields; silent re-selection is not allowed`);
    }

    const selection = write.selection?.selection ?? currentSelection(current);
    const scopeId = write.selection?.repository_scope_id ?? current.repository_scope_id;
    const binding =
      write.selection === undefined
        ? current.selection_binding
        : validateSelectionBinding(write.selection.selection_binding);

    this.#database
      .prepare(
        `UPDATE task SET platform_state = ?,
                         classification = ?, pipeline_id = ?, actor_profile = ?,
                         verification_profile = ?,
                         repository_scope_id = ?, selection_binding_json = ?,
                         admitted_at = COALESCE(admitted_at, ?),
                         state_reason_code = ?, state_reason_log_seq = ?,
                         parent_task_key = COALESCE(?, parent_task_key),
                         updated_at = ?
           WHERE task_key = ?`,
      )
      .run(
        write.platform_state,
        selection?.classification ?? null,
        selection?.pipeline_id ?? null,
        selection?.actor_profile ?? null,
        selection?.verification_profile ?? null,
        scopeId,
        binding === null ? null : canonicalize(binding as never),
        write.admitted_at ?? null,
        write.clear_reason === true ? null : (write.reason?.code ?? null),
        write.clear_reason === true ? null : (write.reason?.log_seq ?? null),
        write.parent_task_key ?? null,
        this.#now(),
        taskKey,
      );
    return this.require(taskKey);
  }

  get(taskKey: string): TaskRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT task_key, batch_id, project_id, external_task_ref, platform_state,
                classification, pipeline_id, actor_profile, verification_profile,
                repository_scope_id, selection_binding_json,
                external_snapshot_json, admitted_at, state_reason_code, state_reason_log_seq,
                parent_task_key, created_at, updated_at
           FROM task WHERE task_key = ?`,
      )
      .get(taskKey) as TaskDbRow | undefined;
    return row === undefined ? undefined : toTaskRow(row);
  }

  require(taskKey: string): TaskRow {
    const row = this.get(taskKey);
    if (row === undefined) throw missing("task", taskKey);
    return row;
  }

  /** MVP 3 — the subflow children linked to one parent, in stable key order. */
  childrenOf(parentTaskKey: string): readonly TaskRow[] {
    const rows = this.#database
      .prepare(
        `SELECT task_key, batch_id, project_id, external_task_ref, platform_state,
                classification, pipeline_id, actor_profile, verification_profile,
                repository_scope_id, selection_binding_json,
                external_snapshot_json, admitted_at, state_reason_code, state_reason_log_seq,
                parent_task_key, created_at, updated_at
           FROM task WHERE parent_task_key = ? ORDER BY task_key ASC`,
      )
      .all(parentTaskKey) as unknown as TaskDbRow[];
    return rows.map(toTaskRow);
  }

  inBatch(batchId: string): readonly TaskRow[] {
    const rows = this.#database
      .prepare(
        `SELECT task_key, batch_id, project_id, external_task_ref, platform_state,
                classification, pipeline_id, actor_profile, verification_profile,
                repository_scope_id, selection_binding_json,
                external_snapshot_json, admitted_at, state_reason_code, state_reason_log_seq,
                parent_task_key, created_at, updated_at
           FROM task WHERE batch_id = ? ORDER BY task_key ASC`,
      )
      .all(batchId) as unknown as TaskDbRow[];
    return rows.map(toTaskRow);
  }
}

// --- task_attempt ---------------------------------------------------------------------------

export interface AttemptInput {
  readonly attempt_key: string;
  readonly task_key: string;
  readonly n: number;
  readonly contract_snapshot_id: string;
  readonly base_head: string;
}

export interface AttemptWrite {
  readonly state: AttemptState;
  readonly reason?: StateReason;
  readonly candidate_commit?: string;
  readonly rework_count?: number;
}

export class AttemptStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  /** Creates the attempt in `READY`. The partial unique index enforces "one at a time". */
  create(input: AttemptInput): TaskAttemptRow {
    if (!Number.isInteger(input.n) || input.n < 1) throw invalid("attempt n must be >= 1");
    if (input.base_head.length === 0) throw invalid("base_head must be non-empty");

    const at = this.#now();
    this.#database
      .prepare(
        `INSERT INTO task_attempt
           (attempt_key, task_key, n, contract_snapshot_id, state, base_head, candidate_commit,
            rework_count, state_reason_code, state_reason_log_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'READY', ?, NULL, 0, NULL, NULL, ?, ?)`,
      )
      .run(
        input.attempt_key,
        input.task_key,
        input.n,
        input.contract_snapshot_id,
        input.base_head,
        at,
        at,
      );
    return this.require(input.attempt_key);
  }

  write(attemptKey: string, write: AttemptWrite): TaskAttemptRow {
    assertMember(write.state, ATTEMPT_STATES, "attempt state");
    const current = this.require(attemptKey);
    if (write.state === "FAILED" && write.reason === undefined) {
      throw invalid("a FAILED attempt requires a reason code and a decision_log ref");
    }
    if (write.rework_count !== undefined && write.rework_count < current.rework_count) {
      throw invalid("rework_count may not decrease");
    }

    this.#database
      .prepare(
        `UPDATE task_attempt SET state = ?, candidate_commit = ?, rework_count = ?,
                                 state_reason_code = ?, state_reason_log_seq = ?, updated_at = ?
           WHERE attempt_key = ?`,
      )
      .run(
        write.state,
        write.candidate_commit ?? current.candidate_commit,
        write.rework_count ?? current.rework_count,
        write.reason?.code ?? null,
        write.reason?.log_seq ?? null,
        this.#now(),
        attemptKey,
      );
    return this.require(attemptKey);
  }

  get(attemptKey: string): TaskAttemptRow | undefined {
    const row = this.#database
      .prepare(`${ATTEMPT_COLUMNS} WHERE attempt_key = ?`)
      .get(attemptKey) as AttemptDbRow | undefined;
    return row === undefined ? undefined : toAttemptRow(row);
  }

  require(attemptKey: string): TaskAttemptRow {
    const row = this.get(attemptKey);
    if (row === undefined) throw missing("task_attempt", attemptKey);
    return row;
  }

  /** The one non-terminal attempt of a task, if it has one (TD §19.2 I1/I2). */
  /**
   * The next attempt ordinal for a task: one past the highest that exists (TD §6.1 `attempt:<k>:<n>`).
   * A plain max+1 over the task's own rows — no allocator, no counter column, no sequence.
   */
  nextOrdinal(taskKey: string): number {
    const row = this.#database
      .prepare("SELECT COALESCE(max(n), 0) AS highest FROM task_attempt WHERE task_key = ?")
      .get(taskKey) as { highest: number };
    return row.highest + 1;
  }

  current(taskKey: string): TaskAttemptRow | undefined {
    const row = this.#database
      .prepare(
        `${ATTEMPT_COLUMNS} WHERE task_key = ?
            AND state NOT IN ('MERGED', 'SUCCEEDED', 'INVALIDATED', 'FAILED')`,
      )
      .get(taskKey) as AttemptDbRow | undefined;
    return row === undefined ? undefined : toAttemptRow(row);
  }

  forTask(taskKey: string): readonly TaskAttemptRow[] {
    const rows = this.#database
      .prepare(`${ATTEMPT_COLUMNS} WHERE task_key = ? ORDER BY n ASC`)
      .all(taskKey) as unknown as AttemptDbRow[];
    return rows.map(toAttemptRow);
  }
}

const ATTEMPT_COLUMNS = `SELECT attempt_key, task_key, n, contract_snapshot_id, state, base_head,
       candidate_commit, rework_count, state_reason_code, state_reason_log_seq,
       created_at, updated_at FROM task_attempt`;

// --- helpers -----------------------------------------------------------------------------------

interface TaskDbRow {
  task_key: string;
  batch_id: string;
  project_id: string;
  external_task_ref: string;
  platform_state: TaskState;
  classification: string | null;
  pipeline_id: string | null;
  actor_profile: string | null;
  verification_profile: string | null;
  repository_scope_id: string | null;
  selection_binding_json: string | null;
  external_snapshot_json: string;
  admitted_at: string | null;
  state_reason_code: string | null;
  state_reason_log_seq: number | null;
  parent_task_key: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptDbRow {
  attempt_key: string;
  task_key: string;
  n: number;
  contract_snapshot_id: string;
  state: AttemptState;
  base_head: string;
  candidate_commit: string | null;
  rework_count: number;
  state_reason_code: string | null;
  state_reason_log_seq: number | null;
  created_at: string;
  updated_at: string;
}

function toTaskRow(row: TaskDbRow): TaskRow {
  return {
    task_key: row.task_key,
    batch_id: row.batch_id,
    project_id: row.project_id,
    external_task_ref: row.external_task_ref,
    platform_state: row.platform_state,
    classification: row.classification,
    pipeline_id: row.pipeline_id,
    actor_profile: row.actor_profile,
    verification_profile: row.verification_profile,
    repository_scope_id: row.repository_scope_id,
    selection_binding:
      row.selection_binding_json === null
        ? null
        : (JSON.parse(row.selection_binding_json) as SelectionBindingV1),
    external_snapshot: JSON.parse(row.external_snapshot_json) as ExternalTaskSnapshotV1,
    admitted_at: row.admitted_at,
    parent_task_key: row.parent_task_key,
    state_reason: toReason(row.state_reason_code, row.state_reason_log_seq),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toAttemptRow(row: AttemptDbRow): TaskAttemptRow {
  return {
    attempt_key: row.attempt_key,
    task_key: row.task_key,
    n: row.n,
    contract_snapshot_id: row.contract_snapshot_id,
    state: row.state,
    base_head: row.base_head,
    candidate_commit: row.candidate_commit,
    rework_count: row.rework_count,
    state_reason: toReason(row.state_reason_code, row.state_reason_log_seq),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toReason(code: string | null, seq: number | null): StateReason | null {
  return code === null || seq === null ? null : { code, log_seq: seq };
}

function currentSelection(task: TaskRow): TaskSelectionFields | undefined {
  if (
    task.classification === null ||
    task.pipeline_id === null ||
    task.actor_profile === null ||
    task.verification_profile === null
  ) {
    return undefined;
  }
  return {
    classification: task.classification,
    pipeline_id: task.pipeline_id,
    actor_profile: task.actor_profile,
    verification_profile: task.verification_profile,
  };
}

/** TD §8.3 — exactly four fields, nothing else, nothing missing. */
/** Caller-supplied observation times are used verbatim; only the fallback reads the clock. */
function observationTime(at: string | undefined, now: () => string): string {
  if (at === undefined) return now();
  if (at.length === 0) throw invalid("an observation time must be a non-empty string");
  return at;
}

/** TD §19.3a — exactly three fields; a malformed binding never reaches durable state. */
export function validateSelectionBinding(input: unknown): SelectionBindingV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid("selection_binding must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const field of SELECTION_BINDING_FIELDS) {
    if (!Object.hasOwn(raw, field)) throw invalid(`selection_binding is missing "${field}"`);
  }
  for (const key of Object.keys(raw)) {
    if (!(SELECTION_BINDING_FIELDS as readonly string[]).includes(key)) {
      throw invalid(`selection_binding has unknown field "${key}"`);
    }
  }
  const task_definition_hash = raw["task_definition_hash"];
  if (typeof task_definition_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(task_definition_hash)) {
    throw invalid("selection_binding.task_definition_hash must be sha256:<lowercase-hex>");
  }
  const task_version = raw["task_version"];
  const base_head = raw["base_head"];
  if (typeof task_version !== "string" || task_version.length === 0) {
    throw invalid("selection_binding.task_version must be a non-empty string");
  }
  if (typeof base_head !== "string" || base_head.length === 0) {
    throw invalid("selection_binding.base_head must be a non-empty string");
  }
  return { task_version, task_definition_hash, base_head };
}

export function validateExternalSnapshot(input: unknown): ExternalTaskSnapshotV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid("external_snapshot must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const field of EXTERNAL_SNAPSHOT_FIELDS) {
    if (!Object.hasOwn(raw, field)) throw invalid(`external_snapshot is missing "${field}"`);
  }
  for (const key of Object.keys(raw)) {
    if (!(EXTERNAL_SNAPSHOT_FIELDS as readonly string[]).includes(key)) {
      throw invalid(`external_snapshot has unknown field "${key}"`);
    }
  }
  const external_state = raw["external_state"];
  if (typeof external_state !== "string" || !EXTERNAL_TASK_STATES.includes(external_state as never)) {
    throw invalid("external_snapshot.external_state is not a known ExternalTaskState");
  }
  const version = raw["version"];
  const definition_hash = raw["definition_hash"];
  const observed_at = raw["observed_at"];
  if (typeof version !== "string" || version.length === 0) {
    throw invalid("external_snapshot.version must be a non-empty string");
  }
  if (typeof definition_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(definition_hash)) {
    throw invalid("external_snapshot.definition_hash must be sha256:<lowercase-hex>");
  }
  if (typeof observed_at !== "string" || observed_at.length === 0) {
    throw invalid("external_snapshot.observed_at must be a non-empty timestamp");
  }
  return {
    external_state: external_state as ExternalTaskSnapshotV1["external_state"],
    version,
    definition_hash,
    observed_at,
  };
}

function assertMember(value: string, allowed: readonly string[], what: string): void {
  if (!allowed.includes(value)) throw invalid(`${value} is not a valid ${what}`);
}

function missing(table: string, key: string): StoreError {
  return new StoreError("DOMAIN_ROW_MISSING", `${table} row ${JSON.stringify(key)} does not exist`);
}
