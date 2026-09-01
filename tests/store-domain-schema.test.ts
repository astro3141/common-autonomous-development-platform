/**
 * B8-AC4 ~ B8-AC13 — the exact domain columns of TD §18.1a and the row-level invariants they
 * carry: state vocabularies, admission marker, reason requirement and the one-attempt rule.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../core/store/database.ts";
import {
  ATTEMPT_STATES,
  BATCH_STATES,
  PLATFORM_RUN_STATES,
  TASK_STATES,
  TERMINAL_ATTEMPT_STATES,
  TERMINAL_TASK_STATES,
} from "../core/store/domain-types.ts";
import { StoreError } from "../core/store/errors.ts";
import { tempStore } from "./support/temp-store.ts";
import {
  ATTEMPT_KEY,
  BATCH_ID,
  PROJECT,
  RUN_ID,
  SELECTION,
  SELECTION_WRITE,
  TASK_KEY,
  contractBuild,
  discover,
  snapshot,
  withWorld,
} from "./support/domain-fixtures.ts";
import { compiled, HEAD } from "./support/decision-fixtures.ts";

const columns = (table: string): string[] => {
  const temp = tempStore();
  const store = temp.open();
  store.close();
  const database = openDatabase(temp.path);
  try {
    return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    database.close();
    temp.dispose();
  }
};

// --- vocabularies -----------------------------------------------------------------------

test("B8-AC4 / B8-AC5 / B8-AC6 / B8-AC7: the four state vocabularies are exact", () => {
  assert.deepEqual([...PLATFORM_RUN_STATES], ["RUNNING", "PAUSED_SAFELY", "COMPLETED"]);
  assert.deepEqual(
    [...BATCH_STATES],
    ["RUNNING", "WAITING", "COMPLETED", "PAUSED_SAFELY", "FAILED"],
  );
  assert.deepEqual(
    [...TASK_STATES],
    ["DISCOVERED", "SELECTED", "ACTIVE", "HELD", "SUSPENDED", "DEFERRED", "COMPLETED", "FAILED"],
  );
  assert.deepEqual(
    [...ATTEMPT_STATES],
    [
      "READY",
      "IMPLEMENTING",
      "VERIFYING",
      "AUDITING",
      "REWORKING",
      "READY_TO_MERGE",
      "APPROVED_FOR_MANUAL_MERGE",
      "MERGING",
      "MERGED",
      // §19.5.2 (D22, MVP 3) — additive terminal-success for a RESUME_PARENT terminal pipeline.
      // Completion ≠ merge: SUCCEEDED never aliases MERGED.
      "SUCCEEDED",
      "INVALIDATED",
      "FAILED",
    ],
  );

  // HELD is deliberately not terminal; SUSPENDED (MVP 3) is not terminal either — a suspended
  // parent resumes when its subflow children complete (Spec §47).
  assert.deepEqual([...TERMINAL_TASK_STATES], ["COMPLETED", "FAILED", "DEFERRED"]);
  assert.deepEqual([...TERMINAL_ATTEMPT_STATES], ["MERGED", "SUCCEEDED", "INVALIDATED", "FAILED"]);
  assert.equal((TERMINAL_TASK_STATES as readonly string[]).includes("SUSPENDED"), false);
});

// --- exact columns ------------------------------------------------------------------------

test("B8-AC7 / B8-AC8: the domain columns are exactly TD §18.1a", () => {
  assert.deepEqual(columns("compiled_profile_snapshot"), [
    "compiled_hash",
    "envelope_json",
    "created_at",
  ]);
  assert.deepEqual(columns("platform_run"), [
    "run_id",
    "project_id",
    "compiled_profile_hash",
    "status",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columns("batch"), [
    "batch_id",
    "run_id",
    "ordinal",
    "compiled_profile_hash",
    "status",
    "admission_closed",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columns("task"), [
    "task_key",
    "batch_id",
    "project_id",
    "external_task_ref",
    "platform_state",
    "classification",
    "pipeline_id",
    "actor_profile",
    "verification_profile",
    "external_snapshot_json",
    "admitted_at",
    "state_reason_code",
    "state_reason_log_seq",
    "created_at",
    "updated_at",
    // Appended by migrations v4/v5 and the v7 rewrite, so they land at the end: §18.1a's listing
    // is the logical schema, and column order is not part of it.
    "repository_scope_id",
    "selection_binding_json",
    "parent_task_key",
    // §18.1g (D24) — the nullable pre-admission materialisation provenance binding.
    "materialization_binding_json",
  ]);
  assert.deepEqual(columns("task_attempt"), [
    "attempt_key",
    "task_key",
    "n",
    "contract_snapshot_id",
    "state",
    "base_head",
    "candidate_commit",
    "rework_count",
    "state_reason_code",
    "state_reason_log_seq",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columns("report_outbox"), ["op_key", "channel", "payload_json", "sent_at"]);
});

test("B8-AC7: task_attempt has one lifecycle column, not stage plus status", () => {
  const names = columns("task_attempt");
  assert.equal(names.includes("state"), true);
  assert.equal(names.includes("stage"), false);
  assert.equal(names.includes("status"), false);
});

test("no policy limit is duplicated as a batch column", () => {
  const names = columns("batch");
  for (const forbidden of ["max_tasks", "concurrency", "max_rework", "completed_count"]) {
    assert.equal(names.includes(forbidden), false, `${forbidden} would be a second authority`);
  }
});

// --- run / batch ---------------------------------------------------------------------------

test("B8-AC4: run identity and status are validated", () => {
  withWorld((world) => {
    const run = world.store.runs.require(RUN_ID);
    assert.equal(run.status, "RUNNING");
    assert.equal(run.project_id, PROJECT);

    const fails = (input: { run_id: string; project_id: string }): void =>
      assert.throws(
        () =>
          world.store.withTransaction(() =>
            world.store.runs.create({ ...input, compiled_profile_hash: world.profile.compiled_hash }),
          ),
        (error: unknown) => error instanceof StoreError && error.code === "DOMAIN_ROW_INVALID",
      );
    fails({ run_id: "run-1", project_id: "beta" });
    fails({ run_id: `run:${"0".repeat(26)}`, project_id: "with:colon" });

    world.store.withTransaction(() => world.store.runs.setStatus(RUN_ID, "PAUSED_SAFELY"));
    assert.equal(world.store.runs.require(RUN_ID).status, "PAUSED_SAFELY");
    assert.throws(() =>
      world.store.withTransaction(() =>
        world.store.runs.setStatus(RUN_ID, "FAILED" as never),
      ),
    );
  });
});

test("B8-AC5: batch ordinal, status and uniqueness are enforced", () => {
  withWorld((world) => {
    const batch = world.store.batches.require(BATCH_ID);
    assert.deepEqual(
      { ordinal: batch.ordinal, status: batch.status, closed: batch.admission_closed },
      { ordinal: 1, status: "RUNNING", closed: false },
    );

    assert.throws(() =>
      world.store.withTransaction(() =>
        world.store.batches.create({
          batch_id: `batch:${RUN_ID}:0`,
          run_id: RUN_ID,
          ordinal: 0,
          compiled_profile_hash: world.profile.compiled_hash,
        }),
      ),
    );
    // (run_id, ordinal) is unique.
    assert.throws(() =>
      world.store.withTransaction(() =>
        world.store.batches.create({
          batch_id: `batch:${RUN_ID}:1b`,
          run_id: RUN_ID,
          ordinal: 1,
          compiled_profile_hash: world.profile.compiled_hash,
        }),
      ),
    );
  });
});

test("B8-AC5: a batch may freeze a different Compiled Profile than the run did", () => {
  withWorld((world) => {
    // A Profile change applies from the next batch (TD §7.4), so the run's hash is provenance only.
    const later = compiled({ batch_policy: { max_tasks: 5, max_rework: 2, concurrency: 2 } });
    assert.notEqual(later.compiled_hash, world.profile.compiled_hash);

    world.store.withTransaction(() => {
      world.store.compiledProfiles.put(later);
      world.store.batches.create({
        batch_id: `batch:${RUN_ID}:2`,
        run_id: RUN_ID,
        ordinal: 2,
        compiled_profile_hash: later.compiled_hash,
      });
    });

    assert.equal(
      world.store.batches.require(`batch:${RUN_ID}:2`).compiled_profile_hash,
      later.compiled_hash,
    );
    assert.equal(world.store.runs.require(RUN_ID).compiled_profile_hash, world.profile.compiled_hash);
    assert.equal(
      world.store.batchView.compiledProfileFor(`batch:${RUN_ID}:2`).effective.policy.batch_policy
        .max_tasks,
      5,
    );
  });
});

// --- task ----------------------------------------------------------------------------------

test("B8-AC8 / B8-AC9: task stores project and ref separately and keeps ':' intact", () => {
  withWorld((world) => {
    const ref = "epic:42:item:7";
    const key = discover(world, ref);
    const row = world.store.tasks.require(key);

    assert.equal(row.external_task_ref, ref, "the opaque ref is preserved verbatim");
    assert.equal(row.project_id, PROJECT);
    assert.equal(row.platform_state, "DISCOVERED");
    assert.deepEqual(Object.keys(row.external_snapshot).sort(), [
      "definition_hash",
      "external_state",
      "observed_at",
      "version",
    ]);

    // The same (project, ref) may not be discovered twice.
    assert.throws(() => discover(world, ref));
  });
});

test("B8-AC9: an external snapshot without a version, or with an extra field, is rejected", () => {
  withWorld((world) => {
    const fails = (patch: Record<string, unknown>): void =>
      assert.throws(
        () =>
          world.store.withTransaction(() =>
            world.store.tasks.discover({
              task_key: `task:${PROJECT}:X`,
              batch_id: BATCH_ID,
              project_id: PROJECT,
              external_task_ref: "X",
              external_snapshot: { ...snapshot(), ...patch } as never,
            }),
          ),
        (error: unknown) => error instanceof StoreError && error.code === "DOMAIN_ROW_INVALID",
      );

    fails({ version: undefined });
    fails({ version: "" });
    fails({ task_ref: "T-101" });
    fails({ definition_hash: "not-a-hash" });
    fails({ external_state: "SOMETHING" });
  });
});

test("B8-AC10: admitted_at is set once and never cleared", () => {
  withWorld((world) => {
    const key = discover(world);
    world.store.withTransaction(() =>
      world.store.tasks.write(key, {
        platform_state: "SELECTED",
        selection: SELECTION_WRITE,
        admitted_at: "t-admit",
      }),
    );
    assert.equal(world.store.tasks.require(key).admitted_at, "t-admit");

    // Later states leave the marker alone, including terminal ones.
    for (const state of ["ACTIVE", "COMPLETED"] as const) {
      world.store.withTransaction(() => world.store.tasks.write(key, { platform_state: state }));
      assert.equal(world.store.tasks.require(key).admitted_at, "t-admit");
    }
  });
});

test("B8-AC11: HELD and FAILED always carry a reason and a journal reference", () => {
  withWorld((world) => {
    const key = discover(world);
    for (const state of ["HELD", "FAILED"] as const) {
      assert.throws(
        () => world.store.withTransaction(() => world.store.tasks.write(key, { platform_state: state })),
        (error: unknown) => error instanceof StoreError && error.code === "DOMAIN_ROW_INVALID",
      );
    }

    const seq = world.store.withTransaction(
      () => world.store.decisions.append({ kind: "state_transition", refKey: key, payload: {} }).seq,
    );
    world.store.withTransaction(() =>
      world.store.tasks.write(key, {
        platform_state: "HELD",
        reason: { code: "REWORK_LIMIT", log_seq: seq },
      }),
    );
    assert.deepEqual(world.store.tasks.require(key).state_reason, {
      code: "REWORK_LIMIT",
      log_seq: seq,
    });
  });
});

test("B8-AC12: only one non-terminal attempt may exist per task", () => {
  withWorld((world) => {
    const key = discover(world);
    world.store.withTransaction(() => {
      world.store.tasks.write(key, {
        platform_state: "ACTIVE",
        selection: SELECTION_WRITE,
        admitted_at: "t-admit",
      });
      const built = contractBuild(world)();
      world.store.contracts.put(built.contract);
      world.store.attempts.create({
        attempt_key: ATTEMPT_KEY,
        task_key: key,
        n: 1,
        contract_snapshot_id: built.contract.body.snapshot_id,
        base_head: HEAD,
      });
    });

    // A second live attempt is refused by the partial unique index, not by application logic.
    assert.throws(() =>
      world.store.withTransaction(() => {
        const built = contractBuild(world, { attempt: 2 })();
        world.store.contracts.put(built.contract);
        world.store.attempts.create({
          attempt_key: `attempt:${key}:2`,
          task_key: key,
          n: 2,
          contract_snapshot_id: built.contract.body.snapshot_id,
          base_head: HEAD,
        });
      }),
    );

    // Once the first attempt is terminal, a successor is allowed.
    world.store.withTransaction(() => {
      world.store.attempts.write(ATTEMPT_KEY, { state: "INVALIDATED" });
      const built = contractBuild(world, { attempt: 2 })();
      world.store.contracts.put(built.contract);
      world.store.attempts.create({
        attempt_key: `attempt:${key}:2`,
        task_key: key,
        n: 2,
        contract_snapshot_id: built.contract.body.snapshot_id,
        base_head: HEAD,
      });
    });
    assert.equal(world.store.attempts.forTask(key).length, 2);
    assert.equal(world.store.attempts.current(key)?.n, 2);
  });
});

test("B8-AC13: a HELD task may keep a live attempt", () => {
  withWorld((world) => {
    const key = discover(world);
    const seq = world.store.withTransaction(() => {
      world.store.tasks.write(key, {
        platform_state: "ACTIVE",
        selection: SELECTION_WRITE,
        admitted_at: "t-admit",
      });
      const built = contractBuild(world)();
      world.store.contracts.put(built.contract);
      world.store.attempts.create({
        attempt_key: ATTEMPT_KEY,
        task_key: key,
        n: 1,
        contract_snapshot_id: built.contract.body.snapshot_id,
        base_head: HEAD,
      });
      world.store.attempts.write(ATTEMPT_KEY, { state: "READY_TO_MERGE" });
      return world.store.decisions.append({ kind: "state_transition", refKey: key, payload: {} }).seq;
    });

    world.store.withTransaction(() =>
      world.store.tasks.write(key, {
        platform_state: "HELD",
        reason: { code: `BLOCKED_BY_DECISION:${TASK_KEY}`, log_seq: seq },
      }),
    );

    assert.equal(world.store.tasks.require(key).platform_state, "HELD");
    assert.equal(world.store.attempts.current(key)?.state, "READY_TO_MERGE");
  });
});

test("B8-AC12: attempt bounds are enforced", () => {
  withWorld((world) => {
    const key = discover(world);
    world.store.withTransaction(() => {
      world.store.tasks.write(key, {
        platform_state: "ACTIVE",
        selection: SELECTION_WRITE,
        admitted_at: "t",
      });
    });
    assert.throws(() =>
      world.store.withTransaction(() => {
        const built = contractBuild(world)();
        world.store.contracts.put(built.contract);
        world.store.attempts.create({
          attempt_key: ATTEMPT_KEY,
          task_key: key,
          n: 0,
          contract_snapshot_id: built.contract.body.snapshot_id,
          base_head: HEAD,
        });
      }),
    );
  });
});
