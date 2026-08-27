/**
 * B8-AC32 ~ B8-AC35 — commit-time admission, atomic contract activation and the full generic
 * Attempt lifecycle driven by synthetic facts alone (TD §19.3, §19.3a, §19.3b).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeDedupKey, normalizePendingDecision } from "../core/humandecision/pending-decision.ts";
import type { PendingDecisionCategory, PendingDecisionV1 } from "../core/humandecision/types.ts";
import { TransitionError } from "../core/statemachine/errors.ts";
import {
  commitAdmission,
  commitAttemptFact,
  commitBatchAdmissionClose,
  commitContractActivation,
  commitTaskDeferral,
} from "../core/statemachine/transition-commit.ts";
import type { DomainWorld } from "./support/domain-fixtures.ts";
import {
  ATTEMPT_KEY,
  BATCH_ID,
  BINDING,
  SCOPE_ID,
  SELECTION,
  TASK_KEY,
  ULID,
  contractBuild,
  discover,
  seedTask,
  snapshotId,
  withWorld,
} from "./support/domain-fixtures.ts";

const admissionRejected = (detail: string) => (error: unknown) =>
  error instanceof TransitionError && error.reason === "ADMISSION_REJECTED" && error.detail === detail;

const decisionOf = (
  category: PendingDecisionCategory,
  taskKey: string,
  decisionId: string,
  createdFrom = "transition:1",
): PendingDecisionV1 => {
  const subject = { kind: "TASK", task_key: taskKey } as const;
  return normalizePendingDecision({
    decision_id: decisionId,
    subject,
    status: "OPEN",
    category,
    question: "How should this continue?",
    options: ["REATTEMPT", "ABANDON"],
    recommendation: null,
    blocking_scope: "TASK_ONLY",
    evidence_refs: [],
    dedup_key: computeDedupKey(subject, category, createdFrom),
    created_from: createdFrom,
    gate_proposal: null,
    resolution: null,
  } as unknown);
};

/** Admits and activates a task, leaving its attempt in READY. */
function activate(world: DomainWorld, ref = "T-101"): string {
  const key = discover(world, ref);
  commitAdmission(world.store, {
    task_key: key,
    selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING,
    admitted_at: "t-admit", hard_dependencies_clear: true,
  });
  commitContractActivation(world.store, {
    task_key: key,
    attempt_key: `attempt:${key}:1`,
    n: 1,
    build: contractBuild(world, { task_ref: ref, snapshot_id: snapshotId(0) }),
  });
  return key;
}

// --- admission -------------------------------------------------------------------------------

test("B8-AC32: admission sets the selection and the marker atomically", () => {
  withWorld((world) => {
    const key = discover(world);
    const result = commitAdmission(world.store, {
      task_key: key,
      selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING,
      admitted_at: "t-admit", hard_dependencies_clear: true,
    });

    const task = world.store.tasks.require(key);
    assert.equal(task.platform_state, "SELECTED");
    assert.equal(task.admitted_at, "t-admit");
    assert.deepEqual(
      {
        classification: task.classification,
        pipeline_id: task.pipeline_id,
        actor_profile: task.actor_profile,
        verification_profile: task.verification_profile,
      },
      { ...SELECTION },
    );
    assert.match(result.transition.ref, /^transition:[0-9]+$/);
  });
});

test("B8-AC32: durable state changing after validation still stops the commit", () => {
  // max_tasks reached between validation and commit.
  withWorld((world) => {
    seedTask(world, { ref: "A", state: "COMPLETED" });
    seedTask(world, { ref: "B", state: "COMPLETED" });
    seedTask(world, { ref: "C", state: "COMPLETED" });
    const key = discover(world, "D");
    assert.throws(
      () =>
        commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, }),
      admissionRejected("BATCH_MAX_TASKS_REACHED"),
    );
    assert.equal(world.store.tasks.require(key).platform_state, "DISCOVERED", "no partial update");
    assert.equal(world.store.tasks.require(key).admitted_at, null);
  });

  // concurrency filled.
  withWorld((world) => {
    seedTask(world, { ref: "A", state: "ACTIVE", attempt_state: "VERIFYING", snapshot_index: 0 });
    seedTask(world, { ref: "B", state: "ACTIVE", attempt_state: "VERIFYING", snapshot_index: 1 });
    const key = discover(world, "C");
    assert.throws(
      () => commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, }),
      admissionRejected("CONCURRENCY_LIMIT_REACHED"),
    );
  });

  // writable slot taken.
  withWorld((world) => {
    seedTask(world, { ref: "A", state: "ACTIVE", attempt_state: "IMPLEMENTING", snapshot_index: 0 });
    const key = discover(world, "B");
    assert.throws(
      () => commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, }),
      admissionRejected("WRITABLE_CONCURRENCY_CONFLICT"),
    );
    // A review-only pipeline does not need the slot, so it is admitted.
    commitAdmission(world.store, {
      task_key: key,
      selection: { ...SELECTION, pipeline_id: "review_only" },
        repository_scope_id: SCOPE_ID,
        selection_binding: BINDING,
      admitted_at: "t", hard_dependencies_clear: true,
    });
    assert.equal(world.store.tasks.require(key).platform_state, "SELECTED");
  });

  // admission explicitly closed.
  withWorld((world) => {
    const key = discover(world);
    commitBatchAdmissionClose(world.store, BATCH_ID);
    assert.throws(
      () => commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, }),
      admissionRejected("BATCH_ADMISSION_CLOSED"),
    );
  });
});

test("B8-AC32: reaching max_tasks closes admission in the same transaction", () => {
  withWorld(
    (world) => {
      const key = discover(world);
      commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, });
      assert.equal(world.store.batches.require(BATCH_ID).admission_closed, true);
    },
    { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 2 } },
  );
});

test("B8-AC32: CLOSE_BATCH stops admission without touching running tasks", () => {
  withWorld((world) => {
    const running = seedTask(world, {
      ref: "A",
      state: "ACTIVE",
      attempt_state: "IMPLEMENTING",
      snapshot_index: 0,
    });
    commitBatchAdmissionClose(world.store, BATCH_ID);

    assert.equal(world.store.batches.require(BATCH_ID).admission_closed, true);
    assert.equal(world.store.tasks.require(running).platform_state, "ACTIVE");
    assert.equal(world.store.attempts.current(running)?.state, "IMPLEMENTING");
  });
});

test("B8-AC32: DEFER applies before admission and does not release the marker", () => {
  withWorld((world) => {
    const key = discover(world);
    commitTaskDeferral(world.store, key);
    assert.equal(world.store.tasks.require(key).platform_state, "DEFERRED");
    assert.equal(world.store.tasks.require(key).admitted_at, null);

    const admitted = discover(world, "B");
    commitAdmission(world.store, { task_key: admitted, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, });
    // Once admitted, DEFER is no longer a legal source state.
    assert.throws(
      () => commitTaskDeferral(world.store, admitted),
      (error: unknown) => error instanceof TransitionError && error.reason === "ILLEGAL_TRANSITION",
    );
    assert.equal(world.store.batchView.admitted(BATCH_ID), 1);
  });
});

// --- contract activation --------------------------------------------------------------------------

test("B8-AC33: activation writes task, attempt, snapshot, grants and blobs atomically", () => {
  withWorld((world) => {
    const key = activate(world);

    assert.equal(world.store.tasks.require(key).platform_state, "ACTIVE");
    const attempt = world.store.attempts.require(`attempt:${key}:1`);
    assert.deepEqual(
      { state: attempt.state, n: attempt.n, rework: attempt.rework_count },
      { state: "READY", n: 1, rework: 0 },
    );
    assert.equal(world.store.contracts.count(), 1);
    assert.equal(world.store.grants.forAttempt(`attempt:${key}:1`).length, 2);
    assert.equal(world.store.blobs.count(), 1, "the contract source blob landed too");

    // Exactly one transition entry for the whole activation.
    const entries = world.store.decisions
      .read()
      .filter((entry) => entry.kind === "state_transition");
    const last = entries[entries.length - 1]?.payload as Record<string, unknown>;
    assert.deepEqual(last["task"], { from: "SELECTED", to: "ACTIVE" });
    assert.deepEqual(last["attempt"], { from: "-", to: "READY" });

    // No idempotency row is required for a local-only transition (TD §21, M0-32).
    assert.equal(world.store.idempotency.count(), 0);
  });
});

test("B8-AC33: a failure during activation rolls the whole thing back", () => {
  withWorld((world) => {
    const key = discover(world);
    commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, });

    assert.throws(() =>
      commitContractActivation(world.store, {
        task_key: key,
        attempt_key: `attempt:${key}:1`,
        n: 1,
        build: () => {
          // The builder itself writes the blobs; failing after it must undo them too.
          contractBuild(world)();
          throw new Error("contract build failed late");
        },
      }),
    );

    assert.equal(world.store.tasks.require(key).platform_state, "SELECTED", "no half activation");
    assert.equal(world.store.attempts.current(key), undefined);
    assert.equal(world.store.contracts.count(), 0);
    assert.equal(world.store.grants.forAttempt(`attempt:${key}:1`).length, 0);
    assert.equal(world.store.blobs.count(), 0);
  });
});

// --- attempt lifecycle -------------------------------------------------------------------------------

test("B8-AC34: the whole generic lifecycle runs on synthetic facts", () => {
  withWorld((world) => {
    const key = activate(world);
    const attemptKey = `attempt:${key}:1`;
    const step = (fact: Parameters<typeof commitAttemptFact>[1]["fact"]): string =>
      commitAttemptFact(world.store, { attempt_key: attemptKey, fact }).attempt_state;

    assert.equal(step({ kind: "EXECUTION_STARTED", workspace_created: true, receipt_valid: true }), "IMPLEMENTING");
    assert.equal(
      step({
        kind: "CANDIDATE_OBSERVED",
        candidate_commit: "candidate-1",
        lineage_valid: true,
        tracked_clean: true,
      }),
      "VERIFYING",
    );
    assert.equal(world.store.attempts.require(attemptKey).candidate_commit, "candidate-1");
    assert.equal(step({ kind: "VERIFICATION_PASSED" }), "AUDITING");
    assert.equal(step({ kind: "AUDIT_DECIDED", verdict: "AUDIT_PASS", drift_clear: true }), "READY_TO_MERGE");
    assert.equal(step({ kind: "AUTOMATIC_MERGE_STARTED", gate_preconditions_met: true }), "MERGING");
    assert.equal(step({ kind: "MERGE_OBSERVED", canonical_contains_candidate: true }), "MERGED");

    assert.equal(world.store.tasks.require(key).platform_state, "COMPLETED");
  });
});

test("B8-AC34: a model self-report cannot advance IMPLEMENTING", () => {
  withWorld((world) => {
    const key = activate(world);
    const attemptKey = `attempt:${key}:1`;
    commitAttemptFact(world.store, {
      attempt_key: attemptKey,
      fact: { kind: "EXECUTION_STARTED", workspace_created: true, receipt_valid: true },
    });

    // There is no `declared_status` field to supply at all; and the repository facts must hold.
    const facts = [
      { kind: "CANDIDATE_OBSERVED", candidate_commit: "", lineage_valid: true, tracked_clean: true },
      { kind: "CANDIDATE_OBSERVED", candidate_commit: "c", lineage_valid: false, tracked_clean: true },
      { kind: "CANDIDATE_OBSERVED", candidate_commit: "c", lineage_valid: true, tracked_clean: false },
    ] as const;
    for (const fact of facts) {
      assert.throws(
        () => commitAttemptFact(world.store, { attempt_key: attemptKey, fact }),
        (error: unknown) =>
          error instanceof TransitionError && error.reason === "PRECONDITION_FAILED",
      );
    }
    assert.equal(world.store.attempts.require(attemptKey).state, "IMPLEMENTING");
    assert.equal(world.store.attempts.require(attemptKey).candidate_commit, null);
  });
});

test("B8-AC34: rework increments within the limit and holds at it", () => {
  withWorld(
    (world) => {
      const key = activate(world);
      const attemptKey = `attempt:${key}:1`;
      const contractHash = world.store.contracts.hashOf(snapshotId(0));
      const grants = world.store.grants.forAttempt(attemptKey).map((row) => row.grant_hash);

      const toAuditing = (): void => {
        commitAttemptFact(world.store, {
          attempt_key: attemptKey,
          fact: { kind: "EXECUTION_STARTED", workspace_created: true, receipt_valid: true },
        });
        commitAttemptFact(world.store, {
          attempt_key: attemptKey,
          fact: {
            kind: "CANDIDATE_OBSERVED",
            candidate_commit: "candidate-1",
            lineage_valid: true,
            tracked_clean: true,
          },
        });
        commitAttemptFact(world.store, { attempt_key: attemptKey, fact: { kind: "VERIFICATION_PASSED" } });
      };

      toAuditing();
      assert.equal(
        commitAttemptFact(world.store, {
          attempt_key: attemptKey,
          fact: { kind: "AUDIT_DECIDED", verdict: "FIX_REQUIRED", drift_clear: true },
        }).attempt_state,
        "REWORKING",
      );
      assert.equal(
        commitAttemptFact(world.store, {
          attempt_key: attemptKey,
          fact: { kind: "REWORK_STARTED", snapshot_valid: true },
        }).attempt_state,
        "IMPLEMENTING",
      );
      assert.equal(world.store.attempts.require(attemptKey).rework_count, 1);

      // The limit is 1 in this world; the next audit failure parks the task instead.
      commitAttemptFact(world.store, {
        attempt_key: attemptKey,
        fact: {
          kind: "CANDIDATE_OBSERVED",
          candidate_commit: "candidate-2",
          lineage_valid: true,
          tracked_clean: true,
        },
      });
      commitAttemptFact(world.store, { attempt_key: attemptKey, fact: { kind: "VERIFICATION_PASSED" } });
      const held = commitAttemptFact(world.store, {
        attempt_key: attemptKey,
        fact: { kind: "AUDIT_DECIDED", verdict: "FIX_REQUIRED", drift_clear: true },
      });

      assert.equal(held.attempt_state, "AUDITING");
      assert.equal(world.store.tasks.require(key).platform_state, "HELD");
      assert.equal(world.store.tasks.require(key).state_reason?.code, "REWORK_LIMIT");

      // Same attempt, same contract, same grants throughout.
      assert.equal(world.store.attempts.require(attemptKey).n, 1);
      assert.equal(world.store.contracts.hashOf(snapshotId(0)), contractHash);
      assert.deepEqual(
        world.store.grants.forAttempt(attemptKey).map((row) => row.grant_hash),
        grants,
      );
    },
    { batch_policy: { max_tasks: 3, max_rework: 1, concurrency: 2 } },
  );
});

test("B8-AC34: drift invalidates the attempt and parks the task on a decision", () => {
  withWorld((world) => {
    const key = activate(world);
    const attemptKey = `attempt:${key}:1`;

    // The outcome needs a human decision, so omitting it is a command error.
    assert.throws(
      () =>
        commitAttemptFact(world.store, {
          attempt_key: attemptKey,
          fact: { kind: "CONTRACT_DRIFT_INVALIDATED" },
        }),
      (error: unknown) => error instanceof TransitionError && error.reason === "COMMAND_INVALID",
    );

    const result = commitAttemptFact(world.store, {
      attempt_key: attemptKey,
      fact: { kind: "CONTRACT_DRIFT_INVALIDATED" },
      decision: {
        decision: decisionOf("REATTEMPT_DECISION", key, ULID.decision),
        channel: "operations",
      },
    });

    assert.equal(result.attempt_state, "INVALIDATED");
    const task = world.store.tasks.require(key);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, `BLOCKED_BY_DECISION:${ULID.decision}`);
    assert.equal(world.store.pendingDecisions.countByStatus("OPEN"), 1);
    assert.equal(world.store.outbox.count(), 1);
    // No new attempt is created automatically.
    assert.equal(world.store.attempts.current(key), undefined);
    assert.equal(world.store.attempts.forTask(key).length, 1);
  });
});

test("B8-AC34: a terminal attempt failure decides the task in the same transaction", () => {
  withWorld((world) => {
    const key = activate(world);
    const attemptKey = `attempt:${key}:1`;
    const result = commitAttemptFact(world.store, {
      attempt_key: attemptKey,
      fact: { kind: "ATTEMPT_FAILED", reason_code: "RUNTIME_FAILED" },
    });

    assert.equal(result.attempt_state, "FAILED");
    const attempt = world.store.attempts.require(attemptKey);
    const task = world.store.tasks.require(key);
    assert.equal(task.platform_state, "FAILED");
    assert.equal(task.state_reason?.code, "RUNTIME_FAILED");
    assert.equal(attempt.state_reason?.code, "RUNTIME_FAILED");
    assert.equal(attempt.state_reason?.log_seq, task.state_reason?.log_seq);
  });
});

test("B8-AC34: manual merge approval is not a merge", () => {
  withWorld((world) => {
    const key = activate(world);
    const attemptKey = `attempt:${key}:1`;
    const step = (fact: Parameters<typeof commitAttemptFact>[1]["fact"]): string =>
      commitAttemptFact(world.store, { attempt_key: attemptKey, fact }).attempt_state;

    step({ kind: "EXECUTION_STARTED", workspace_created: true, receipt_valid: true });
    step({ kind: "CANDIDATE_OBSERVED", candidate_commit: "c1", lineage_valid: true, tracked_clean: true });
    step({ kind: "VERIFICATION_PASSED" });
    step({ kind: "AUDIT_DECIDED", verdict: "AUDIT_PASS", drift_clear: true });

    assert.equal(step({ kind: "MANUAL_MERGE_APPROVED" }), "APPROVED_FOR_MANUAL_MERGE");
    assert.equal(world.store.tasks.require(key).platform_state, "ACTIVE", "APPROVE is not MERGED");

    // Nothing observed yet: the attempt waits rather than completing.
    assert.equal(step({ kind: "MERGE_OBSERVED", canonical_contains_candidate: false }), "APPROVED_FOR_MANUAL_MERGE");
    assert.equal(world.store.tasks.require(key).platform_state, "ACTIVE");

    // An unexplained canonical move parks the task instead of claiming success.
    const mismatch = commitAttemptFact(world.store, {
      attempt_key: attemptKey,
      fact: { kind: "MERGE_MISMATCH_OBSERVED" },
      decision: { decision: decisionOf("RECOVERY_DECISION", key, ULID.decision), channel: "ops" },
    });
    assert.equal(mismatch.attempt_state, "APPROVED_FOR_MANUAL_MERGE");
    assert.equal(world.store.tasks.require(key).platform_state, "HELD");

    // Only an authoritative observation produces MERGED.
    assert.equal(step({ kind: "MERGE_OBSERVED", canonical_contains_candidate: true }), "MERGED");
    assert.equal(world.store.tasks.require(key).platform_state, "COMPLETED");
  });
});

test("B8-AC34: an audit HUMAN_REQUIRED parks the task without moving the attempt", () => {
  withWorld((world) => {
    const key = activate(world);
    const attemptKey = `attempt:${key}:1`;
    commitAttemptFact(world.store, {
      attempt_key: attemptKey,
      fact: { kind: "EXECUTION_STARTED", workspace_created: true, receipt_valid: true },
    });
    commitAttemptFact(world.store, {
      attempt_key: attemptKey,
      fact: { kind: "CANDIDATE_OBSERVED", candidate_commit: "c", lineage_valid: true, tracked_clean: true },
    });
    commitAttemptFact(world.store, { attempt_key: attemptKey, fact: { kind: "VERIFICATION_PASSED" } });

    const result = commitAttemptFact(world.store, {
      attempt_key: attemptKey,
      fact: { kind: "AUDIT_DECIDED", verdict: "HUMAN_REQUIRED", drift_clear: true },
      decision: { decision: decisionOf("CONTRACT_DECISION", key, ULID.decision), channel: "ops" },
    });

    assert.equal(result.attempt_state, "AUDITING");
    assert.equal(world.store.tasks.require(key).platform_state, "HELD");
    // TD §19.2 I2/I3: a held task keeps its live attempt.
    assert.equal(world.store.attempts.current(key)?.state, "AUDITING");
  });
});

test("B8-AC34: review-only pipelines invent no terminal state", () => {
  withWorld((world) => {
    const key = discover(world, "R");
    commitAdmission(world.store, {
      task_key: key,
      selection: { ...SELECTION, pipeline_id: "review_only" },
        repository_scope_id: SCOPE_ID,
        selection_binding: BINDING,
      admitted_at: "t", hard_dependencies_clear: true,
    });
    commitContractActivation(world.store, {
      task_key: key,
      attempt_key: `attempt:${key}:1`,
      n: 1,
      build: contractBuild(world, { task_ref: "R", snapshot_id: snapshotId(3) }),
    });

    // The generic lifecycle is the only one there is; nothing reinterprets MERGED as "success".
    assert.equal(world.store.attempts.current(key)?.state, "READY");
    assert.equal(world.store.tasks.require(key).platform_state, "ACTIVE");
  });
});
