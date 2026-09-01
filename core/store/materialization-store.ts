/**
 * child_materialization_snapshot store (TD §18.1g, D24 — prospective MVP 3).
 *
 * §18.1a rules verbatim: the whole envelope is stored, re-hashed on load, and the indexed columns
 * must agree with the envelope exactly — a disagreement is corruption, never a loadable record.
 * Same identity + same envelope is idempotent; same identity + a different envelope is conflict.
 * No status, cursor or retry column lives here: operation state belongs to the existing
 * idempotency record and provenance to `decision_log`.
 */

import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { hashEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import type {
  ChildTaskMaterializationSnapshotV1,
  SealedMaterializationSnapshot,
} from "../materialization/snapshot.ts";
import type { DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";

interface SnapshotDbRow {
  materialization_id: string;
  hash: string;
  batch_id: string;
  parent_task_key: string;
  envelope_json: string;
}

export interface StoredMaterializationSnapshot {
  readonly materialization_id: string;
  readonly hash: string;
  readonly batch_id: string;
  readonly parent_task_key: string;
  readonly body: ChildTaskMaterializationSnapshotV1;
}

export class ChildMaterializationSnapshotStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  put(sealed: SealedMaterializationSnapshot): string {
    const id = sealed.body.materialization_id;
    const json = JSON.stringify(sealed.envelope);
    const existing = this.#row(id);
    if (existing !== undefined) {
      if (existing.envelope_json === json) return id;
      throw new StoreError(
        "ARTIFACT_CONFLICT",
        `materialization ${id} already exists with a different snapshot`,
      );
    }
    this.#database
      .prepare(
        `INSERT INTO child_materialization_snapshot
           (materialization_id, hash, batch_id, parent_task_key, envelope_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sealed.hash, sealed.body.batch_id, sealed.body.parent_intent.task_key, json, this.#now());
    return id;
  }

  get(materializationId: string): StoredMaterializationSnapshot | undefined {
    const row = this.#row(materializationId);
    if (row === undefined) return undefined;
    return this.#verified(row);
  }

  require(materializationId: string): StoredMaterializationSnapshot {
    const stored = this.get(materializationId);
    if (stored === undefined) {
      throw new StoreError("DOMAIN_ROW_MISSING", `materialization ${materializationId} does not exist`);
    }
    return stored;
  }

  forBatch(batchId: string): readonly StoredMaterializationSnapshot[] {
    const rows = this.#database
      .prepare(
        `SELECT materialization_id, hash, batch_id, parent_task_key, envelope_json
           FROM child_materialization_snapshot WHERE batch_id = ? ORDER BY materialization_id ASC`,
      )
      .all(batchId) as unknown as SnapshotDbRow[];
    return rows.map((row) => this.#verified(row));
  }

  forParent(parentTaskKey: string): readonly StoredMaterializationSnapshot[] {
    const rows = this.#database
      .prepare(
        `SELECT materialization_id, hash, batch_id, parent_task_key, envelope_json
           FROM child_materialization_snapshot WHERE parent_task_key = ? ORDER BY materialization_id ASC`,
      )
      .all(parentTaskKey) as unknown as SnapshotDbRow[];
    return rows.map((row) => this.#verified(row));
  }

  count(): number {
    const row = this.#database
      .prepare("SELECT count(*) AS n FROM child_materialization_snapshot")
      .get() as { n: number };
    return row.n;
  }

  #verified(row: SnapshotDbRow): StoredMaterializationSnapshot {
    let envelope: SchemaEnvelope<CanonicalObject>;
    try {
      envelope = JSON.parse(row.envelope_json) as SchemaEnvelope<CanonicalObject>;
    } catch {
      throw new StoreError("ARTIFACT_CORRUPT", `materialization ${row.materialization_id} is unparseable`);
    }
    if (hashEnvelope(envelope) !== row.hash) {
      throw new StoreError("ARTIFACT_CORRUPT", `materialization ${row.materialization_id} fails re-hash`);
    }
    const body = envelope.body as unknown as ChildTaskMaterializationSnapshotV1;
    if (
      body.materialization_id !== row.materialization_id ||
      body.batch_id !== row.batch_id ||
      body.parent_intent.task_key !== row.parent_task_key
    ) {
      throw new StoreError(
        "ARTIFACT_CORRUPT",
        `materialization ${row.materialization_id} index columns disagree with the envelope`,
      );
    }
    return {
      materialization_id: row.materialization_id,
      hash: row.hash,
      batch_id: row.batch_id,
      parent_task_key: row.parent_task_key,
      body,
    };
  }

  #row(materializationId: string): SnapshotDbRow | undefined {
    return this.#database
      .prepare(
        `SELECT materialization_id, hash, batch_id, parent_task_key, envelope_json
           FROM child_materialization_snapshot WHERE materialization_id = ?`,
      )
      .get(materializationId) as SnapshotDbRow | undefined;
  }
}
