/**
 * PendingHumanDecision persistence (TD §17, §18.1a).
 *
 * `OPEN` is a lifecycle row; a terminal record is an immutable, hashed artifact. Dedup is by
 * `dedup_key`: replaying the same semantic body returns the existing record, a conflicting body
 * fails closed. Identity is always caller-supplied — nothing here allocates a ULID.
 */

import {
  canonicalPendingDecision,
  closePendingDecision,
  hashPendingDecision,
  normalizePendingDecision,
  resolvePendingDecision,
  withAppliedTransition,
} from "../humandecision/pending-decision.ts";
import { subjectKey } from "../humandecision/pending-decision.ts";
import type {
  PendingDecisionResolution,
  PendingDecisionStatus,
  PendingDecisionV1,
} from "../humandecision/types.ts";
import type { DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";

export interface StoredPendingDecision {
  readonly body: PendingDecisionV1;
  /** NULL while OPEN; the final envelope hash once terminal (TD §17.1f). */
  readonly record_hash: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PendingRow {
  decision_id: string;
  envelope_json: string;
  record_hash: string | null;
  created_at: string;
  updated_at: string;
}

export class PendingDecisionStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * Opens a decision, or returns the existing record for the same `dedup_key`. A different
   * semantic body under the same key is a conflict, never an overwrite.
   */
  open(input: PendingDecisionV1 | unknown): StoredPendingDecision {
    const body = normalizePendingDecision(input);
    if (body.status !== "OPEN") {
      throw new StoreError("DOMAIN_ROW_INVALID", "a decision must be created in OPEN");
    }

    const existing = this.byDedupKey(body.dedup_key);
    if (existing !== undefined) {
      // Retry of the same request: same body → same record. Anything else is a conflict.
      if (canonicalPendingDecision(existing.body) !== canonicalPendingDecision(body)) {
        throw new StoreError(
          "PENDING_DECISION_CONFLICT",
          `dedup_key ${body.dedup_key} already identifies a different decision`,
        );
      }
      return existing;
    }

    const at = this.#now();
    this.#database
      .prepare(
        `INSERT INTO pending_human_decision
           (decision_id, dedup_key, subject_kind, subject_ref, status, category, blocking_scope,
            envelope_json, record_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        body.decision_id,
        body.dedup_key,
        body.subject.kind,
        subjectKey(body.subject),
        body.category,
        body.blocking_scope,
        canonicalPendingDecision(body),
        at,
        at,
      );
    return this.require(body.decision_id);
  }

  /** `OPEN → RESOLVED`, freezing the record hash over the final envelope. */
  resolve(decisionId: string, resolution: PendingDecisionResolution): StoredPendingDecision {
    const current = this.require(decisionId);
    const terminal = resolvePendingDecision(current.body, resolution);
    this.#writeTerminal(terminal.body, terminal.record_hash);
    return this.require(decisionId);
  }

  /** `OPEN → CANCELLED` / `OPEN → STALE`. A RESOLVED record is never walked back (§17.1f). */
  close(decisionId: string, status: "CANCELLED" | "STALE"): StoredPendingDecision {
    const current = this.require(decisionId);
    const terminal = closePendingDecision(current.body, status);
    this.#writeTerminal(terminal.body, terminal.record_hash);
    return this.require(decisionId);
  }

  /**
   * Records which transition a resolution actually caused. This is the one write a terminal
   * record admits, and it re-freezes the hash over the new envelope (§17.1e).
   */
  recordAppliedTransition(decisionId: string, seq: number): StoredPendingDecision {
    const current = this.require(decisionId);
    const updated = withAppliedTransition(current.body, seq);
    this.#writeTerminal(updated.body, updated.record_hash);
    return this.require(decisionId);
  }

  get(decisionId: string): StoredPendingDecision | undefined {
    const row = this.#database
      .prepare(`${COLUMNS} WHERE decision_id = ?`)
      .get(decisionId) as PendingRow | undefined;
    return row === undefined ? undefined : toStored(row);
  }

  require(decisionId: string): StoredPendingDecision {
    const record = this.get(decisionId);
    if (record === undefined) {
      throw new StoreError("DOMAIN_ROW_MISSING", `pending decision ${decisionId} does not exist`);
    }
    return record;
  }

  byDedupKey(dedupKey: string): StoredPendingDecision | undefined {
    const row = this.#database.prepare(`${COLUMNS} WHERE dedup_key = ?`).get(dedupKey) as
      | PendingRow
      | undefined;
    return row === undefined ? undefined : toStored(row);
  }

  /** Open decisions whose subject is this reference, in insertion order. */
  openFor(subjectRef: string): readonly StoredPendingDecision[] {
    const rows = this.#database
      .prepare(`${COLUMNS} WHERE subject_ref = ? AND status = 'OPEN' ORDER BY created_at ASC`)
      .all(subjectRef) as unknown as PendingRow[];
    return rows.map(toStored);
  }

  /** Every decision for this subject, whatever its status, in insertion order. */
  forSubject(subjectRef: string): readonly StoredPendingDecision[] {
    const rows = this.#database
      .prepare(`${COLUMNS} WHERE subject_ref = ? ORDER BY created_at ASC`)
      .all(subjectRef) as unknown as PendingRow[];
    return rows.map(toStored);
  }

  countByStatus(status: PendingDecisionStatus): number {
    const row = this.#database
      .prepare("SELECT count(*) AS n FROM pending_human_decision WHERE status = ?")
      .get(status) as { n: number };
    return row.n;
  }

  count(): number {
    const row = this.#database
      .prepare("SELECT count(*) AS n FROM pending_human_decision")
      .get() as { n: number };
    return row.n;
  }

  #writeTerminal(body: PendingDecisionV1, recordHash: string): void {
    if (recordHash !== hashPendingDecision(body)) {
      throw new StoreError("ARTIFACT_CORRUPT", "record hash does not match the final envelope");
    }
    this.#database
      .prepare(
        `UPDATE pending_human_decision
            SET status = ?, envelope_json = ?, record_hash = ?, updated_at = ?
          WHERE decision_id = ?`,
      )
      .run(body.status, canonicalPendingDecision(body), recordHash, this.#now(), body.decision_id);
  }
}

const COLUMNS = `SELECT decision_id, envelope_json, record_hash, created_at, updated_at
                   FROM pending_human_decision`;

function toStored(row: PendingRow): StoredPendingDecision {
  const envelope = JSON.parse(row.envelope_json) as { body?: unknown };
  const body = normalizePendingDecision(envelope.body);
  if (row.record_hash !== null && row.record_hash !== hashPendingDecision(body)) {
    throw new StoreError(
      "ARTIFACT_CORRUPT",
      `pending decision ${row.decision_id} no longer hashes to its recorded record_hash`,
    );
  }
  return {
    body,
    record_hash: row.record_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
