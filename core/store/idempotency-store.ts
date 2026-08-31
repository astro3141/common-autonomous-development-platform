/**
 * Idempotency records (TD I-TD2, §18.1, §21).
 *
 * This is the durable half of the write-ahead intent rule: the intent is committed *before* a
 * canonical side effect runs, and the completion is recorded after. No side effect is performed
 * here — that boundary belongs to the components that own the effect.
 *
 * State vocabulary is exactly TD §21's `INTENT | DONE | FAILED`; nothing is added. Rewrites that
 * TD does not define (`DONE → INTENT`, `DONE → FAILED`, `FAILED → DONE`) fail closed.
 */

import { canonicalize, type CanonicalValue } from "../schemas/canonical-json.ts";
import type { DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";

export type IdempotencyState = "INTENT" | "DONE" | "FAILED";

export interface IdempotencyRecord {
  readonly opKey: string;
  readonly state: IdempotencyState;
  readonly result: CanonicalValue | undefined;
  readonly ts: string;
}

export interface BeginIntentResult {
  /** False when an record for this op_key already existed — the duplicate-intent case. */
  readonly created: boolean;
  readonly record: IdempotencyRecord;
}

interface IdempotencyRow {
  readonly op_key: string;
  readonly state: IdempotencyState;
  readonly result_json: string | null;
  readonly ts: string;
}

export class IdempotencyStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * Records the intent for `opKey`. A second call for the same key never creates a second row;
   * it returns the record that already exists, whatever its state.
   */
  beginIntent(opKey: string): BeginIntentResult {
    const existing = this.get(opKey);
    if (existing !== undefined) {
      return { created: false, record: existing };
    }

    const ts = this.#now();
    this.#database
      .prepare("INSERT INTO idempotency (op_key, state, result_json, ts) VALUES (?, 'INTENT', NULL, ?)")
      .run(opKey, ts);
    return { created: true, record: { opKey, state: "INTENT", result: undefined, ts } };
  }

  /** `INTENT → DONE`. Replaying the identical completion is a no-op, not a second record. */
  markDone(opKey: string, result?: CanonicalValue): IdempotencyRecord {
    return this.#complete(opKey, "DONE", result);
  }

  /** `INTENT → FAILED`. Retry policy is not decided here (Coordinator/Recovery own it). */
  markFailed(opKey: string, result?: CanonicalValue): IdempotencyRecord {
    return this.#complete(opKey, "FAILED", result);
  }

  get(opKey: string): IdempotencyRecord | undefined {
    const row = this.#database
      .prepare("SELECT op_key, state, result_json, ts FROM idempotency WHERE op_key = ?")
      .get(opKey) as IdempotencyRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Every recorded key under one prefix, in key order.
   *
   * A read, not a scan framework: the one caller needs to know whether an operation already exists
   * under a *different* qualifier of the same `op:<entity>:<operation>:` family, which is the
   * fail-closed check for an identity whose qualifier can move (TD §19.3).
   */
  /** Every unresolved INTENT row, oldest first. A monitoring read model, never an authority. */
  unresolvedIntents(): readonly IdempotencyRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT op_key, state, result_json, ts FROM idempotency WHERE state = 'INTENT' ORDER BY ts ASC",
      )
      .all() as { op_key: string; state: "INTENT"; result_json: string | null; ts: string }[];
    return rows.map((row) => ({
      opKey: row.op_key,
      state: row.state,
      result: row.result_json === null ? undefined : (JSON.parse(row.result_json) as never),
      ts: row.ts,
    }));
  }

  keysWithPrefix(prefix: string): readonly string[] {
    const rows = this.#database
      .prepare("SELECT op_key FROM idempotency WHERE op_key LIKE ? ESCAPE '\\' ORDER BY op_key ASC")
      .all(`${escapeLike(prefix)}%`) as unknown as { op_key: string }[];
    return rows.map((row) => row.op_key);
  }

  count(): number {
    const row = this.#database.prepare("SELECT count(*) AS n FROM idempotency").get() as {
      n: number;
    };
    return row.n;
  }

  #complete(
    opKey: string,
    target: "DONE" | "FAILED",
    result: CanonicalValue | undefined,
  ): IdempotencyRecord {
    const existing = this.get(opKey);
    if (existing === undefined) {
      throw new StoreError(
        "IDEMPOTENCY_RECORD_MISSING",
        `no intent recorded for ${JSON.stringify(opKey)}; the intent must be committed first (I-TD2)`,
      );
    }

    const resultJson = result === undefined ? null : canonicalize(result);

    if (existing.state === target) {
      // Idempotent replay of the same completion: identical result → no write at all.
      const storedJson = existing.result === undefined ? null : canonicalize(existing.result);
      if (storedJson === resultJson) return existing;
      throw new StoreError(
        "IDEMPOTENCY_STATE_CONFLICT",
        `${opKey} is already ${target} with a different result; refusing to rewrite`,
      );
    }

    if (existing.state !== "INTENT") {
      throw new StoreError(
        "IDEMPOTENCY_STATE_CONFLICT",
        `${existing.state} → ${target} is not a transition defined by TD §21`,
      );
    }

    const ts = this.#now();
    this.#database
      .prepare("UPDATE idempotency SET state = ?, result_json = ?, ts = ? WHERE op_key = ?")
      .run(target, resultJson, ts, opKey);
    return { opKey, state: target, result, ts };
  }
}

/** `%`, `_` and the escape character itself are literals in an op key, never wildcards. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    opKey: row.op_key,
    state: row.state,
    result: row.result_json === null ? undefined : (JSON.parse(row.result_json) as CanonicalValue),
    ts: row.ts,
  };
}
