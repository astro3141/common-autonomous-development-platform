/**
 * B8-AC36, B8-AC37 — Batch WAITING / COMPLETED / PAUSED_SAFELY semantics (TD §20.1 – §20.3).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeDedupKey, normalizePendingDecision } from "../core/humandecision/pending-decision.ts";
import type { PendingDecisionV1 } from "../core/humandecision/types.ts";
import { TransitionError } from "../core/statemachine/errors.ts";
import { nextBatchOutcome } from "../core/statemachine/batch-transitions.ts";
import {
  commitBatchAdmissionClose,
  commitBatchFact,
  commitPendingDecision,
} from "../core/statemachine/transition-commit.ts";
import type { DomainWorld } from "./support/domain-fixtures.ts";
import { seedTask, withWorld, BATCH_ID, RUN_ID } from "./support/domain-fixtures.ts";

const ULIDS = ["01JQ8ZK5T7RC9V2W4X6Y8Z0C01", "01JQ8ZK5T7RC9V2W4X6Y8Z0C02"];

const holdDecision = (taskKey: string, decisionId: string): PendingDecisionV1 => {
  const subject = { kind: "TASK", task_key: taskKey } as const;
  const createdFrom = `transition:1`;
  return normalizePendingDecision({
    decision_id: decisionId,
    subject,
    status: "OPEN",
    category: "CONTRACT_DECISION",
    question: "How should this continue?",
    options: ["REATTEMPT", "ABANDON"],
    recommendation: null,
    blocking_scope: "TASK_ONLY",
    evidence_refs: [],
    dedup_key: computeDedupKey(subject, "CONTRACT_DECISION", createdFrom),
    created_from: createdFrom,
    gate_proposal: null,
    resolution: null,
  } as unknown);
};

/** One admitted task, parked on an open decision. */
function heldOnDecision(world: DomainWorld, ref: string, decisionId: string): string {
  const key = seedTask(world, {
    ref,
    state: "ACTIVE",
    attempt_state: "AUDITING",
    snapshot_index: ref.charCodeAt(0) % 20,
  });
  commitPendingDecision(world.store, {
    decision: holdDecision(key, decisionId),
    channel: "operations",
  });
  return key;
}

// --- WAITING -------------------------------------------------------------------------------

test("B8-AC36: WAITING needs every §20.1 condition, including the Coordinator's fact", () => {
  withWorld((world) => {
    heldOnDecision(world, "A", ULIDS[0] as string);

    // Something could still be started → still RUNNING.
    assert.throws(
      () =>
        commitBatchFact(world.store, {
          batch_id: BATCH_ID,
          fact: { kind: "EVALUATE_WAITING", safe_independent_runnable_exists: true },
        }),
      (error: unknown) => error instanceof TransitionError && error.reason === "PRECONDITION_FAILED",
    );
    assert.equal(world.store.batches.require(BATCH_ID).status, "RUNNING");

    const waiting = commitBatchFact(world.store, {
      batch_id: BATCH_ID,
      fact: { kind: "EVALUATE_WAITING", safe_independent_runnable_exists: false },
    });
    assert.equal(waiting.batch?.status, "WAITING");
  });
});

test("B8-AC36: an arbitrary HELD task alone is not WAITING", () => {
  withWorld((world) => {
    // Held for a non-human reason, with no open decision at all.
    seedTask(world, { ref: "A", state: "HELD", attempt_state: "AUDITING", snapshot_index: 0 });
    assert.equal(world.store.pendingDecisions.countByStatus("OPEN"), 0);
    assert.throws(
      () =>
        commitBatchFact(world.store, {
          batch_id: BATCH_ID,
          fact: { kind: "EVALUATE_WAITING", safe_independent_runnable_exists: false },
        }),
      (error: unknown) => error instanceof TransitionError && error.reason === "PRECONDITION_FAILED",
    );
  });
});

test("B8-AC36: an ACTIVE or SELECTED task keeps the batch RUNNING", () => {
  withWorld((world) => {
    heldOnDecision(world, "A", ULIDS[0] as string);
    seedTask(world, { ref: "B", state: "ACTIVE", attempt_state: "VERIFYING", snapshot_index: 11 });
    assert.throws(() =>
      commitBatchFact(world.store, {
        batch_id: BATCH_ID,
        fact: { kind: "EVALUATE_WAITING", safe_independent_runnable_exists: false },
      }),
    );
  });
});

test("B8-AC36: WAITING resumes when progress becomes possible", () => {
  withWorld((world) => {
    heldOnDecision(world, "A", ULIDS[0] as string);
    commitBatchFact(world.store, {
      batch_id: BATCH_ID,
      fact: { kind: "EVALUATE_WAITING", safe_independent_runnable_exists: false },
    });

    assert.throws(() =>
      commitBatchFact(world.store, {
        batch_id: BATCH_ID,
        fact: { kind: "RESUME", safe_independent_runnable_exists: false },
      }),
    );
    const resumed = commitBatchFact(world.store, {
      batch_id: BATCH_ID,
      fact: { kind: "RESUME", safe_independent_runnable_exists: true },
    });
    assert.equal(resumed.batch?.status, "RUNNING");
  });
});

// --- COMPLETED -------------------------------------------------------------------------------

test("B8-AC36: COMPLETED requires closed admission and every admitted task terminal", () => {
  withWorld((world) => {
    seedTask(world, { ref: "A", state: "COMPLETED" });
    seedTask(world, { ref: "B", state: "DEFERRED" });

    // Admission still open → not complete, even though nothing is running.
    assert.throws(
      () => commitBatchFact(world.store, { batch_id: BATCH_ID, fact: { kind: "EVALUATE_COMPLETION" } }),
      (error: unknown) => error instanceof TransitionError && error.reason === "PRECONDITION_FAILED",
    );

    // An explicit CLOSE_BATCH before max_tasks is reached is the supported route.
    commitBatchAdmissionClose(world.store, BATCH_ID);
    const done = commitBatchFact(world.store, {
      batch_id: BATCH_ID,
      fact: { kind: "EVALUATE_COMPLETION" },
    });
    assert.equal(done.batch?.status, "COMPLETED");
  });
});

test("B8-AC36: a HELD task is not terminal, so it blocks completion", () => {
  withWorld((world) => {
    seedTask(world, { ref: "A", state: "COMPLETED" });
    heldOnDecision(world, "B", ULIDS[0] as string);
    commitBatchAdmissionClose(world.store, BATCH_ID);

    assert.throws(
      () => commitBatchFact(world.store, { batch_id: BATCH_ID, fact: { kind: "EVALUATE_COMPLETION" } }),
      (error: unknown) => error instanceof TransitionError && error.reason === "PRECONDITION_FAILED",
    );
    assert.equal(world.store.batches.require(BATCH_ID).status, "RUNNING");
  });
});

// --- PAUSED_SAFELY / FAILED ----------------------------------------------------------------------

test("B8-AC36: a circuit-breaker fact pauses the batch and optionally the run", () => {
  withWorld((world) => {
    seedTask(world, { ref: "A", state: "ACTIVE", attempt_state: "IMPLEMENTING", snapshot_index: 0 });
    const paused = commitBatchFact(world.store, {
      batch_id: BATCH_ID,
      fact: { kind: "CIRCUIT_BREAKER", also_pause_run: true },
    });

    assert.equal(paused.batch?.status, "PAUSED_SAFELY");
    assert.equal(world.store.runs.require(RUN_ID).status, "PAUSED_SAFELY");
    // The task itself is untouched: no cancellation is attempted from here.
    assert.equal(world.store.tasks.require("task:alpha:A").platform_state, "ACTIVE");
  });
});

test("B8-AC37: no fact leads to Batch FAILED", () => {
  withWorld((world) => {
    const batch = world.store.batches.require(BATCH_ID);
    const counts = {
      admitted_non_terminal: 0,
      active: 0,
      selected: 0,
      open_blocking_decisions: 0,
    };
    const outcomes = [
      { kind: "CIRCUIT_BREAKER", also_pause_run: false },
      { kind: "EVALUATE_WAITING", safe_independent_runnable_exists: false },
      { kind: "RESUME", safe_independent_runnable_exists: true },
      { kind: "EVALUATE_COMPLETION" },
    ] as const;

    const reachable = new Set<string>();
    for (const fact of outcomes) {
      try {
        reachable.add(nextBatchOutcome(batch, fact, counts).batch_state);
      } catch {
        // Guard rejections are fine; we only care that FAILED is never produced.
      }
    }
    assert.equal(reachable.has("FAILED"), false);
    // It stays in the vocabulary for schema compatibility.
    assert.equal(world.store.batches.require(BATCH_ID).status, "RUNNING");
  });
});
