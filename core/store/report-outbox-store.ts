/**
 * Report Outbox rows (TD §18.1a, §18.2, §21.1).
 *
 * Batch 8 owns enqueue and nothing else: no ReportAdapter is imported, no delivery is attempted
 * and `sent_at` is left for the batch that confirms delivery. `op_key` is the delivery identity —
 * the same key with a different channel or payload is a conflict, not a second notification.
 */

import { canonicalize, type CanonicalValue } from "../schemas/canonical-json.ts";
import type { DatabaseSync } from "./database.ts";
import type { ReportOutboxRow } from "./domain-types.ts";
import { StoreError } from "./errors.ts";

export interface ReportEnqueue {
  readonly op_key: string;
  readonly channel: string;
  readonly payload: CanonicalValue;
}

export class ReportOutboxStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Idempotent: re-enqueuing the identical notification does not create a second row. */
  enqueue(entry: ReportEnqueue): ReportOutboxRow {
    if (entry.op_key.length === 0 || entry.channel.length === 0) {
      throw new StoreError("DOMAIN_ROW_INVALID", "op_key and channel must be non-empty");
    }
    const payloadJson = canonicalize(entry.payload);

    const existing = this.#row(entry.op_key);
    if (existing !== undefined) {
      if (existing.channel !== entry.channel || existing.payload_json !== payloadJson) {
        throw new StoreError(
          "REPORT_OUTBOX_CONFLICT",
          `${entry.op_key} is already enqueued with a different channel or payload`,
        );
      }
      return toRow(entry.op_key, existing);
    }

    this.#database
      .prepare("INSERT INTO report_outbox (op_key, channel, payload_json, sent_at) VALUES (?, ?, ?, NULL)")
      .run(entry.op_key, entry.channel, payloadJson);
    return { op_key: entry.op_key, channel: entry.channel, payload: entry.payload, sent_at: null };
  }

  /**
   * TD §21.1 — records a **confirmed** delivery. Only the Coordinator's delivery seam calls this,
   * and only after `ReportAdapter.deliver` returned `delivered: true`: an unconfirmed delivery
   * leaves `sent_at` NULL so the same `op_key` is presented again later, which is what keeps a
   * retry from becoming a second notification. A row that is already sent is left as it is.
   */
  markSent(opKey: string, sentAt: string): ReportOutboxRow {
    const row = this.#row(opKey);
    if (row === undefined) {
      throw new StoreError("DOMAIN_ROW_MISSING", `report outbox row ${opKey} does not exist`);
    }
    if (row.sent_at !== null) return toRow(opKey, row);
    if (sentAt.length === 0) {
      throw new StoreError("DOMAIN_ROW_INVALID", "a confirmed delivery needs an observation time");
    }
    this.#database
      .prepare("UPDATE report_outbox SET sent_at = ? WHERE op_key = ? AND sent_at IS NULL")
      .run(sentAt, opKey);
    return toRow(opKey, { ...row, sent_at: sentAt });
  }

  get(opKey: string): ReportOutboxRow | undefined {
    const row = this.#row(opKey);
    return row === undefined ? undefined : toRow(opKey, row);
  }

  /** Everything not yet confirmed delivered, in insertion order. Delivery itself is not here. */
  pending(): readonly ReportOutboxRow[] {
    const rows = this.#database
      .prepare(
        "SELECT op_key, channel, payload_json, sent_at FROM report_outbox WHERE sent_at IS NULL ORDER BY rowid ASC",
      )
      .all() as unknown as {
      op_key: string;
      channel: string;
      payload_json: string;
      sent_at: string | null;
    }[];
    return rows.map((row) => toRow(row.op_key, row));
  }

  count(): number {
    const row = this.#database.prepare("SELECT count(*) AS n FROM report_outbox").get() as {
      n: number;
    };
    return row.n;
  }

  #row(
    opKey: string,
  ): { channel: string; payload_json: string; sent_at: string | null } | undefined {
    return this.#database
      .prepare("SELECT channel, payload_json, sent_at FROM report_outbox WHERE op_key = ?")
      .get(opKey) as { channel: string; payload_json: string; sent_at: string | null } | undefined;
  }
}

function toRow(
  opKey: string,
  row: { channel: string; payload_json: string; sent_at: string | null },
): ReportOutboxRow {
  return {
    op_key: opKey,
    channel: row.channel,
    payload: JSON.parse(row.payload_json) as CanonicalValue,
    sent_at: row.sent_at,
  };
}
