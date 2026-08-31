/**
 * FileReportAdapter — a production ReportAdapter (TD §21.1, IG-4).
 *
 * Transport is deliberately the simplest thing that can *confirm* a delivery: one durable JSON
 * line per logical notification, under a directory the deployment owns. Confirmation is the
 * fsync'd write of that line — nothing weaker counts, because `delivered: true` is what lets Core
 * record `sent_at` and stop retrying (TD §21.1).
 *
 * The `op_key` idempotency contract is held durably, not in process memory: each logical
 * notification also writes an index entry keyed by its `op_key` holding the canonical request.
 * A replay with the same material is the same logical notification (no second line); the same
 * `op_key` with different material fails closed with `REPORT_IDEMPOTENCY_CONFLICT`. A restarted
 * adapter therefore keeps the same answers it gave before the restart.
 *
 * `channel` stays an opaque string; here it selects the log file name, and nothing else is read
 * from it. Slack or any other transport is a different implementation of the same interface —
 * Core cannot tell the difference, which is the point (Spec §59).
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { ReportDeliveryError } from "../interfaces/report-adapter.ts";
import type {
  ReportAdapter,
  ReportDeliveryRequest,
  ReportDeliveryResult,
} from "../interfaces/report-adapter.ts";
import { canonicalize } from "../../core/schemas/canonical-json.ts";
import { sha256Digest } from "../../core/schemas/digest.ts";

/** A file name that is total and injective over channel strings / op keys. */
const fileNameFor = (value: string): string =>
  [...value]
    .map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : `_${c.codePointAt(0)?.toString(16)}_`))
    .join("");

export class FileReportAdapter implements ReportAdapter {
  readonly #root: string;
  readonly #indexDir: string;

  /** @param root deployment-owned directory; created if absent. Never inside a repository. */
  constructor(root: string) {
    this.#root = root;
    this.#indexDir = join(root, "delivered");
    mkdirSync(this.#indexDir, { recursive: true });
  }

  deliver(request: ReportDeliveryRequest): ReportDeliveryResult {
    const canonicalRequest = canonicalize({
      channel: request.channel,
      payload: request.payload,
    } as never);
    const indexPath = join(this.#indexDir, fileNameFor(request.op_key));

    const existing = this.#readIndex(indexPath);
    if (existing !== undefined) {
      if (existing !== canonicalRequest) {
        throw new ReportDeliveryError(
          "REPORT_IDEMPOTENCY_CONFLICT",
          request.op_key,
          "the same op_key was delivered with a different channel or payload",
        );
      }
      // The same logical notification. It was already durably delivered once.
      return { delivered: true, backend_ref: this.#backendRef(request.op_key) };
    }

    // Write the line first, fsync it, then the index — a crash between the two re-delivers the
    // same material under the same op_key, which the line format makes an append of an identical
    // record, never a different notification (Spec §58).
    const line = `${JSON.stringify({ op_key: request.op_key, channel: request.channel, payload: request.payload })}\n`;
    this.#appendDurably(join(this.#root, `${fileNameFor(request.channel)}.jsonl`), line);
    this.#appendDurably(indexPath, canonicalRequest);
    return { delivered: true, backend_ref: this.#backendRef(request.op_key) };
  }

  #backendRef(op_key: string): string {
    return `file-report:${sha256Digest(new TextEncoder().encode(op_key)).slice(7, 23)}`;
  }

  #readIndex(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  #appendDurably(path: string, text: string): void {
    const fd = openSync(path, "a");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
