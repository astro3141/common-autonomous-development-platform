/**
 * Append-only decision journal (TD §18.1, §18.2).
 *
 * `kind` and `ref_key` are generic strings at this layer — this batch defines no decision
 * vocabulary. Payloads go through the Batch 1 canonical JSON contract, so a payload that is not
 * expressible in the restricted data model (a float, for instance) is rejected rather than
 * silently coerced. There is no update or delete path: the journal is history substrate only.
 */

import { canonicalize, type CanonicalValue } from "../schemas/canonical-json.ts";
import type { DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";

export interface DecisionLogAppend {
  readonly kind: string;
  readonly refKey: string;
  readonly payload: CanonicalValue;
  /** Caller-supplied entry time. Omitted means "use the store clock", as every caller did. */
  readonly ts?: string;
}

export interface DecisionLogEntry {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly refKey: string;
  readonly payload: CanonicalValue;
}

interface DecisionLogRow {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly ref_key: string;
  readonly payload_json: string;
}

export class DecisionLog {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  /** Appends one entry and returns it, including the assigned monotonic `seq`. */
  /** How many entries of one kind exist. A read model for pacing, never an authority. */
  countByKind(kind: string): number {
    const row = this.#database
      .prepare("SELECT count(*) AS n FROM decision_log WHERE kind = ?")
      .get(kind) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  append(entry: DecisionLogAppend): DecisionLogEntry {
    const payloadJson = canonicalize(entry.payload);
    if (entry.ts !== undefined && entry.ts.length === 0) {
      throw new StoreError("DOMAIN_ROW_INVALID", "a decision_log ts must be a non-empty string");
    }
    const ts = entry.ts ?? this.#now();
    const result = this.#database
      .prepare("INSERT INTO decision_log (ts, kind, ref_key, payload_json) VALUES (?, ?, ?, ?)")
      .run(ts, entry.kind, entry.refKey, payloadJson);

    return {
      seq: Number(result.lastInsertRowid),
      ts,
      kind: entry.kind,
      refKey: entry.refKey,
      payload: JSON.parse(payloadJson) as CanonicalValue,
    };
  }

  /** All entries in append order. */
  read(): DecisionLogEntry[] {
    const rows = this.#database
      .prepare("SELECT seq, ts, kind, ref_key, payload_json FROM decision_log ORDER BY seq ASC")
      .all() as unknown as DecisionLogRow[];
    return rows.map(toEntry);
  }

  count(): number {
    const row = this.#database.prepare("SELECT count(*) AS n FROM decision_log").get() as {
      n: number;
    };
    return row.n;
  }
}

function toEntry(row: DecisionLogRow): DecisionLogEntry {
  return {
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    refKey: row.ref_key,
    payload: JSON.parse(row.payload_json) as CanonicalValue,
  };
}
