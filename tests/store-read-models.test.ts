/**
 * B8-AC30, B8-AC31 — the durable projection of `DecisionValidationBatchView` (TD §19.3c) and the
 * Hold-and-Continue property it protects (Spec §48).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { seedTask, withWorld, BATCH_ID } from "./support/domain-fixtures.ts";

test("B8-AC30: admitted counts the marker, not the rows", () => {
  withWorld((world) => {
    seedTask(world, { ref: "T-1", state: "DISCOVERED" });
    seedTask(world, { ref: "T-2", state: "SELECTED" });
    seedTask(world, { ref: "T-3", state: "COMPLETED" });
    seedTask(world, { ref: "T-4", state: "FAILED" });
    seedTask(world, { ref: "T-5", state: "HELD", attempt_state: "READY_TO_MERGE", snapshot_index: 1 });

    // Five task rows exist, but only the four that were ever SELECTED consumed admission.
    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 5);
    assert.equal(world.store.batchView.admitted(BATCH_ID), 4);
  });
});

test("B8-AC30 / B8-AC31: active counts ACTIVE tasks, not live attempts", () => {
  withWorld((world) => {
    seedTask(world, { ref: "T-1", state: "ACTIVE", attempt_state: "IMPLEMENTING", snapshot_index: 0 });
    // A held task whose attempt is still alive — the human-merge pause and the drift hold.
    seedTask(world, { ref: "T-2", state: "HELD", attempt_state: "READY_TO_MERGE", snapshot_index: 1 });
    seedTask(world, { ref: "T-3", state: "HELD", attempt_state: "AUDITING", snapshot_index: 2 });

    assert.equal(
      world.store.batchView.active(BATCH_ID),
      1,
      "a HELD task with a live attempt does not occupy a concurrency slot",
    );
    // The attempts really are non-terminal — the count is a policy choice, not an artefact.
    assert.equal(world.store.attempts.current("task:alpha:T-2")?.state, "READY_TO_MERGE");
    assert.equal(world.store.attempts.current("task:alpha:T-3")?.state, "AUDITING");
  });
});

test("B8-AC30: the writable matrix is exactly TD §19.3c", () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["READY", "standard", true],
    ["IMPLEMENTING", "standard", true],
    ["REWORKING", "standard", true],
    ["VERIFYING", "standard", false],
    ["AUDITING", "standard", false],
    ["READY_TO_MERGE", "standard", false],
    ["APPROVED_FOR_MANUAL_MERGE", "standard", false],
    ["MERGING", "standard", false],
    ["READY", "review_only", false],
  ];

  for (const [attemptState, pipeline, expected] of cases) {
    withWorld((world) => {
      seedTask(world, {
        ref: "T-1",
        state: "ACTIVE",
        pipeline_id: pipeline,
        attempt_state: attemptState as never,
      });
      assert.equal(
        world.store.batchView.writable(BATCH_ID),
        expected ? 1 : 0,
        `${pipeline} + ${attemptState}`,
      );
    });
  }
});

test("B8-AC31: a HELD task never contributes a writable candidate", () => {
  withWorld((world) => {
    seedTask(world, { ref: "T-1", state: "HELD", attempt_state: "READY", snapshot_index: 0 });
    assert.equal(world.store.batchView.writable(BATCH_ID), 0);

    // …so an independent task can still be admitted alongside it (Spec §48).
    seedTask(world, { ref: "T-2", state: "ACTIVE", attempt_state: "IMPLEMENTING", snapshot_index: 1 });
    assert.deepEqual(world.store.batchView.project(BATCH_ID), {
      admitted_task_count: 2,
      active_task_count: 1,
      active_writable_candidate_count: 1,
    });
  });
});

test("B8-AC30: the whole view comes from the batch's own frozen Compiled Profile", () => {
  withWorld((world) => {
    seedTask(world, { ref: "T-1", state: "ACTIVE", attempt_state: "READY", snapshot_index: 0 });
    const compiled = world.store.batchView.compiledProfileFor(BATCH_ID);
    assert.equal(compiled.effective.policy.batch_policy.max_tasks, 3);
    assert.deepEqual(world.store.batchView.project(BATCH_ID), {
      admitted_task_count: 1,
      active_task_count: 1,
      active_writable_candidate_count: 1,
    });
  });
});
