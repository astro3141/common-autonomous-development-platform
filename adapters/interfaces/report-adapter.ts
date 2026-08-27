/**
 * ReportAdapter — TD §5.10 / §21.1 (decision M0-5).
 *
 * Report policy and payload creation are Core's; transport is the adapter's (Spec §59). The
 * Platform Outbox is Core-owned and never exposed here — Core projects an outbox row into a
 * `ReportDeliveryRequest`.
 *
 * `op_key` is the **delivery idempotency identity**, not metadata: the same
 * `op_key + channel + payload` must resolve to one logical notification however many times it is
 * delivered, which is what keeps `external delivery → crash before sent_at → restart → resend`
 * from producing a duplicate report (Spec §58/§71).
 */

import type { CanonicalValue } from "../../core/schemas/canonical-json.ts";

export interface ReportDeliveryRequest {
  /** TD §6.1 op_key; identifies the logical notification across restarts and retries. */
  readonly op_key: string;
  /** Opaque destination string interpreted by the adapter alone. */
  readonly channel: string;
  /** Platform-owned payload in the TD §6 restricted JSON data model. */
  readonly payload: CanonicalValue;
}

/**
 * Confirmed delivery. There is no `delivered: false` — an unconfirmed delivery must fail the call
 * so that Core leaves `sent_at` NULL and retries later with the same `op_key` (TD §21.1).
 */
export interface ReportDeliveryResult {
  readonly delivered: true;
  /** Optional adapter-owned reference. Restricted to what I-TD7 admits into Core. */
  readonly backend_ref?: string;
}

export type ReportDeliveryErrorCode = "REPORT_IDEMPOTENCY_CONFLICT";

/** Deterministic, fail-closed delivery failure (TD §21.1). */
export class ReportDeliveryError extends Error {
  readonly code: ReportDeliveryErrorCode;
  readonly op_key: string;

  constructor(code: ReportDeliveryErrorCode, op_key: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReportDeliveryError";
    this.code = code;
    this.op_key = op_key;
  }
}

export interface ReportAdapter {
  /**
   * Delivers one logical notification. Re-delivering an identical request is the same logical
   * notification; the same `op_key` with a different `channel` or `payload` fails closed with
   * `REPORT_IDEMPOTENCY_CONFLICT`.
   */
  deliver(request: ReportDeliveryRequest): ReportDeliveryResult;
}
