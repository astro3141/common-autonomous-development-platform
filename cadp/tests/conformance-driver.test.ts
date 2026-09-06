/**
 * Proposal-driver classification (#61): the pure loop logic behind `ctl work-plan`.
 * Fail closed: only a clean delivery (COMPLETED or parked at the Human merge gate)
 * advances the loop; anything else halts it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyRun, nextAction } from "../product/driver.ts";

test("D1: classification covers every terminal shape honestly", () => {
  assert.deepEqual(classifyRun({ workflow_status: "RUNNING", human_wait: [], deadline_exceeded: false }), { status: "RUNNING" });
  assert.deepEqual(
    classifyRun({ workflow_status: "RUNNING", human_wait: ["e-merge"], deadline_exceeded: false }),
    { status: "AWAITING_HUMAN_MERGE", effects: ["e-merge"] },
  );
  assert.deepEqual(
    classifyRun({ workflow_status: "COMPLETED", trace: { completed: true, pr_effect_id: "x" }, human_wait: [], deadline_exceeded: false }),
    { status: "COMPLETED", trace: { completed: true, pr_effect_id: "x" } },
  );
  assert.deepEqual(
    classifyRun({ workflow_status: "COMPLETED", trace: { stopped: "REVIEW_NOT_APPROVED", detail: "needs tests" }, human_wait: [], deadline_exceeded: false }),
    { status: "STOPPED", detail: "REVIEW_NOT_APPROVED: needs tests" },
  );
  // A completed workflow with neither `completed` nor `stopped` never reads as success.
  assert.equal(classifyRun({ workflow_status: "COMPLETED", trace: {}, human_wait: [], deadline_exceeded: false }).status, "STOPPED");
  for (const status of ["FAILED", "TERMINATED", "TIMED_OUT", "CANCELLED"] as const) {
    assert.deepEqual(classifyRun({ workflow_status: status, human_wait: [], deadline_exceeded: false }), { status: "FAILED", detail: status });
  }
  assert.equal(classifyRun({ workflow_status: "UNKNOWN", human_wait: [], deadline_exceeded: true }).status, "STALLED");
  // An UNKNOWN observation before the deadline keeps polling — it is not evidence of anything.
  assert.equal(classifyRun({ workflow_status: "UNKNOWN", human_wait: [], deadline_exceeded: false }).status, "RUNNING");
});

test("D2: only clean deliveries advance the loop; everything else halts (fail closed)", () => {
  assert.equal(nextAction({ status: "RUNNING" }), "CONTINUE_POLLING");
  assert.equal(nextAction({ status: "COMPLETED", trace: {} }), "NEXT_ITEM");
  assert.equal(nextAction({ status: "AWAITING_HUMAN_MERGE", effects: ["e"] }), "NEXT_ITEM");
  assert.equal(nextAction({ status: "STOPPED", detail: "BOUND" }), "HALT");
  assert.equal(nextAction({ status: "FAILED", detail: "FAILED" }), "HALT");
  assert.equal(nextAction({ status: "STALLED", detail: "deadline" }), "HALT");
});
