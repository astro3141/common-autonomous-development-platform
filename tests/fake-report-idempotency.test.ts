/**
 * B3-AC9 — the ReportAdapter delivery idempotency contract of TD §21.1, exercised through
 * FakeReportAdapter.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ReportDeliveryError } from "../adapters/interfaces/report-adapter.ts";
import type { ReportDeliveryRequest } from "../adapters/interfaces/report-adapter.ts";
import { FakeReportAdapter } from "../testdoubles/fake-report-adapter.ts";

const OP = "op:batch:run:01JQ8ZK5T7RC9V2W4X6Y8Z0ABC:0:report-pending:d-42";

const request = (overrides: Partial<ReportDeliveryRequest> = {}): ReportDeliveryRequest => ({
  op_key: OP,
  channel: "operations",
  payload: { event: "PAUSED_SAFELY", batch: 0 },
  ...overrides,
});

test("B3-AC9: a first request performs one logical delivery", () => {
  const report = new FakeReportAdapter();
  report.results.push({ delivered: true, backend_ref: "ref-1" });

  const result = report.deliver(request());

  assert.equal(result.delivered, true);
  assert.equal(result.backend_ref, "ref-1");
  assert.equal(report.deliveryCount, 1);
  assert.deepEqual(
    report.calls.map((call) => call.method),
    ["deliver"],
  );
});

test("B3-AC9: an identical repeat is one logical notification, not a second delivery", () => {
  const report = new FakeReportAdapter();
  report.results.push({ delivered: true, backend_ref: "ref-1" });

  const first = report.deliver(request());
  const replay = report.deliver(request());

  assert.deepEqual(replay, first);
  assert.equal(report.deliveryCount, 1, "the logical delivery count must not grow");
  assert.equal(report.results.remaining, 0, "a replay consumes no further scripted response");
  assert.equal(report.calls.length, 2, "the call itself is still recorded");
});

test("B3-AC9: key ordering inside the payload does not make it a different request", () => {
  const report = new FakeReportAdapter();
  report.results.push({ delivered: true });

  const first = report.deliver(request({ payload: { event: "PAUSED_SAFELY", batch: 0 } }));
  const reordered = report.deliver(request({ payload: { batch: 0, event: "PAUSED_SAFELY" } }));

  assert.deepEqual(reordered, first);
  assert.equal(report.deliveryCount, 1);
});

test("B3-AC9: the same op_key with a different channel fails closed", () => {
  const report = new FakeReportAdapter();
  report.results.push({ delivered: true });
  report.deliver(request());

  assert.throws(
    () => report.deliver(request({ channel: "other" })),
    (error: unknown) =>
      error instanceof ReportDeliveryError &&
      error.code === "REPORT_IDEMPOTENCY_CONFLICT" &&
      error.op_key === OP,
  );
  assert.equal(report.deliveryCount, 1);
});

test("B3-AC9: the same op_key with a different payload fails closed", () => {
  const report = new FakeReportAdapter();
  report.results.push({ delivered: true });
  report.deliver(request());

  assert.throws(
    () => report.deliver(request({ payload: { event: "BATCH_COMPLETE", batch: 0 } })),
    (error: unknown) =>
      error instanceof ReportDeliveryError && error.code === "REPORT_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(report.deliveryCount, 1);
});

test("B3-AC9: distinct op_keys are distinct notifications", () => {
  const report = new FakeReportAdapter();
  report.results.push({ delivered: true, backend_ref: "a" }, { delivered: true, backend_ref: "b" });

  report.deliver(request());
  report.deliver(request({ op_key: `${OP}-second` }));

  assert.equal(report.deliveryCount, 2);
});

test("B3-AC9: a payload outside the restricted JSON model is rejected before delivery", () => {
  const report = new FakeReportAdapter();
  report.results.push({ delivered: true });

  assert.throws(() => report.deliver(request({ payload: { ratio: 0.5 } })));
  assert.equal(report.deliveryCount, 0);
});
