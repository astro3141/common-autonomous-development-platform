/**
 * FakeReportAdapter — scripted responses + call recording, plus the minimum state needed to
 * exercise the `op_key` delivery idempotency contract of TD §21.1.
 *
 * That state (`op_key -> canonical request + result`) is deterministic test state, not a transport
 * implementation: there is no queue, no retry engine and no network.
 */

import { ReportDeliveryError } from "../adapters/interfaces/report-adapter.ts";
import type {
  ReportAdapter,
  ReportDeliveryRequest,
  ReportDeliveryResult,
} from "../adapters/interfaces/report-adapter.ts";
import { canonicalize } from "../core/schemas/canonical-json.ts";
import { ScriptedResponses, type FakeCall } from "./scripted.ts";

interface DeliveredRecord {
  readonly canonicalRequest: string;
  readonly result: ReportDeliveryResult;
}

export class FakeReportAdapter implements ReportAdapter {
  readonly calls: FakeCall[] = [];

  readonly results = new ScriptedResponses<ReportDeliveryResult>();

  /** One entry per *logical* notification, keyed by op_key. */
  readonly #delivered = new Map<string, DeliveredRecord>();

  /** Number of logical deliveries performed — a replay must not increase this. */
  get deliveryCount(): number {
    return this.#delivered.size;
  }

  deliver(request: ReportDeliveryRequest): ReportDeliveryResult {
    this.calls.push({ method: "deliver", args: [request] });

    // Canonical JSON is the equality rule (Batch 1); no separate comparison rule exists.
    const canonicalRequest = canonicalize({ channel: request.channel, payload: request.payload });
    const existing = this.#delivered.get(request.op_key);

    if (existing !== undefined) {
      if (existing.canonicalRequest !== canonicalRequest) {
        throw new ReportDeliveryError(
          "REPORT_IDEMPOTENCY_CONFLICT",
          request.op_key,
          "the same op_key was delivered with a different channel or payload",
        );
      }
      // Same logical notification: no second delivery, no scripted response consumed.
      return existing.result;
    }

    const result = this.results.take("deliver");
    this.#delivered.set(request.op_key, { canonicalRequest, result });
    return result;
  }
}
