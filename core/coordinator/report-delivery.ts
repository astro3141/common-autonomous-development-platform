/**
 * Report Outbox delivery (TD §21.1, §26; MVP1-B13).
 *
 * The enqueue side has existed since Batch 8: a notification is written in the same transaction as
 * the transition that caused it, so it cannot be lost. This is the other half — the transport —
 * and it is deliberately the narrowest thing that can be called a delivery path:
 *
 *   take one unsent row → project it → hand it to the adapter → record `sent_at` **only** if the
 *   adapter confirmed it.
 *
 * Two rules keep it honest. A failure leaves the row exactly as it was, so the next tick presents
 * the **same `op_key`** and the adapter's own idempotency turns a retry into one logical
 * notification rather than a second one. And transport is never lifecycle authority: a delivery
 * that fails does not roll back the transition that enqueued it, because the fact happened whether
 * or not anyone was told.
 *
 * There is no scanner, no retry table, no backoff and no worker. Restart recovery of historical
 * unsent rows is Spec §69 / MVP 4 and is not implemented here.
 */

import type {
  ReportAdapter,
  ReportDeliveryRequest,
} from "../../adapters/interfaces/report-adapter.ts";
import type { PlatformStore } from "../store/platform-store.ts";

export interface ReportDeliveryDependencies {
  readonly store: PlatformStore;
  readonly report: ReportAdapter;
  /** Caller-supplied observation time — Core reads no clock. */
  readonly now: () => string;
}

export type ReportDeliveryOutcome =
  | { readonly kind: "NOTHING_PENDING" }
  | { readonly kind: "DELIVERED"; readonly op_key: string }
  /** The adapter could not confirm it. The row stays unsent and keeps its identity. */
  | { readonly kind: "UNCONFIRMED"; readonly op_key: string };

/**
 * Delivers at most one pending notification. One per tick, deliberately: a tick is a bounded
 * coordination step, and draining the whole outbox in a loop would be a worker by another name.
 */
export function deliverOneReport(
  dependencies: ReportDeliveryDependencies,
): ReportDeliveryOutcome {
  const { store } = dependencies;
  const row = store.outbox.pending()[0];
  if (row === undefined) return { kind: "NOTHING_PENDING" };

  // The row *is* the request; nothing is added, and the payload is never rewritten on a retry.
  const request: ReportDeliveryRequest = {
    op_key: row.op_key,
    channel: row.channel,
    payload: row.payload,
  };

  try {
    const result = dependencies.report.deliver(request);
    if (result.delivered !== true) return { kind: "UNCONFIRMED", op_key: row.op_key };
  } catch {
    // Unconfirmed. The transition that enqueued this is untouched — a report is not a fact.
    return { kind: "UNCONFIRMED", op_key: row.op_key };
  }

  store.withTransaction(() => {
    store.outbox.markSent(row.op_key, dependencies.now());
  });
  return { kind: "DELIVERED", op_key: row.op_key };
}
