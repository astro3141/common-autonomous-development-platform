/**
 * M1B2-AC3 ~ M1B2-AC10, M1B2-AC19 ~ M1B2-AC34, M1B2-AC38 — one discovery pass materializes and
 * refreshes the durable `task` projection, and never becomes lifecycle authority (TD §8.3, §8.4).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeDiscoveryPass,
  TASK_OBSERVATION_KIND,
} from "../core/discovery/materialize.ts";
import { ProjectDocumentTaskSource } from "../core/tasksource/project-document-task-source.ts";
import { EXTERNAL_TASK_STATES, type ExternalTaskState } from "../core/tasksource/types.ts";
import type { TaskRow } from "../core/store/domain-types.ts";
import {
  BATCH_ID,
  PROJECT,
  RUN_ID,
  seedTask,
  withWorld,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import {
  definitionHashOf,
  ScriptedTaskSource,
  type ScriptedTask,
} from "./support/scripted-task-source.ts";
import { readerFor, singleDocumentConfig, taskBlock } from "./support/task-fixtures.ts";

const OBS_1 = "2026-08-10T09:00:00Z";
const OBS_2 = "2026-08-10T11:00:00Z";

const pass = (
  world: DomainWorld,
  source: ScriptedTaskSource,
  observed_at = OBS_1,
): ReturnType<typeof materializeDiscoveryPass> =>
  materializeDiscoveryPass(world.store, source, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    context: { observed_at },
  });

const keyOf = (ref: string): string => `task:${PROJECT}:${ref}`;

const observationsFor = (world: DomainWorld, taskKey: string) =>
  world.store.decisions
    .read()
    .filter((entry) => entry.kind === TASK_OBSERVATION_KIND && entry.refKey === taskKey);

// --- read-call boundaries ----------------------------------------------------------------

test("M2-READ1 ~ M2-READ5 / M1B2-AC6 ~ AC10: exactly one discover_tasks and one get_task per candidate", () => {
  withWorld((world) => {
    const source = new ScriptedTaskSource([{ ref: "T-1" }, { ref: "T-2" }, { ref: "T-3" }]);
    pass(world, source);

    assert.equal(source.calls.discover_tasks, 1);
    assert.deepEqual(source.calls.get_task, ["T-1", "T-2", "T-3"]);
    assert.deepEqual(source.calls.get_dependencies, [], "get_dependencies is outside this path");
    assert.deepEqual(source.calls.get_task_state, [], "the pass uses one external observation");

    // A second pass over the same tasks repeats exactly the same two operations.
    pass(world, source, OBS_2);
    assert.equal(source.calls.discover_tasks, 2);
    assert.equal(source.calls.get_task.length, 6);
    assert.deepEqual(source.calls.get_dependencies, []);
    assert.deepEqual(source.calls.get_task_state, []);
  });
});

test("M1B2-AC3: the materializer takes any TaskSourceV1 and reads nothing else", () => {
  withWorld((world) => {
    // A minimal hand-written source: no adapter class, no filesystem, no config.
    const source = new ScriptedTaskSource([{ ref: "T-1", state: "TODO" }]);
    const result = pass(world, source);
    assert.equal(result.project_id, PROJECT, "project_id comes from the run, not the source");
    assert.equal(world.store.tasks.require(keyOf("T-1")).platform_state, "DISCOVERED");
  });
});

// --- run / batch validation --------------------------------------------------------------

test("M1B2-AC4 / AC5: the caller's run and batch must exist and belong together", () => {
  withWorld((world) => {
    const source = new ScriptedTaskSource([{ ref: "T-1" }]);
    const other = `${"batch:"}run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZZ:1`;

    assert.throws(() =>
      materializeDiscoveryPass(world.store, source, {
        run_id: "run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZZ",
        batch_id: BATCH_ID,
        context: { observed_at: OBS_1 },
      }),
    );
    assert.throws(() =>
      materializeDiscoveryPass(world.store, source, {
        run_id: RUN_ID,
        batch_id: other,
        context: { observed_at: OBS_1 },
      }),
    );

    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 0, "no row was written");
    assert.equal(world.store.decisions.count(), 0);
  });
});

test("M1B2-AC5: a closed batch still receives observations — materialization is not admission", () => {
  withWorld((world) => {
    world.store.withTransaction(() => world.store.batches.closeAdmission(BATCH_ID));
    const source = new ScriptedTaskSource([{ ref: "T-1" }]);
    pass(world, source);
    assert.equal(world.store.tasks.require(keyOf("T-1")).platform_state, "DISCOVERED");
  });
});

// --- first materialization ---------------------------------------------------------------

test("M2-FIRST1 ~ M2-FIRST10 / M1B2-AC19 ~ AC24: a first pass creates a DISCOVERED row and nothing else", () => {
  withWorld((world) => {
    const before = world.store.batchView.project(BATCH_ID);
    const scripted: ScriptedTask = { ref: "T-1", state: "TODO", version: "7" };
    const source = new ScriptedTaskSource([scripted]);

    const result = pass(world, source);
    const row = world.store.tasks.require(keyOf("T-1"));

    // M2-FIRST1 / FIRST2 / FIRST4
    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 1);
    assert.equal(row.platform_state, "DISCOVERED");
    assert.equal(row.project_id, PROJECT);
    assert.equal(row.batch_id, BATCH_ID);
    assert.equal(row.external_task_ref, "T-1");

    // M2-FIRST3 — exactly the four ExternalTaskSnapshotV1 fields, sourced as §8.4 requires.
    assert.deepEqual(Object.keys(row.external_snapshot).sort(), [
      "definition_hash",
      "external_state",
      "observed_at",
      "version",
    ]);
    assert.deepEqual(row.external_snapshot, {
      external_state: "TODO",
      version: "7",
      definition_hash: definitionHashOf(scripted),
      observed_at: OBS_1,
    });

    // M2-FIRST6 / FIRST7
    assert.equal(row.classification, null);
    assert.equal(row.pipeline_id, null);
    assert.equal(row.actor_profile, null);
    assert.equal(row.verification_profile, null);
    assert.equal(row.admitted_at, null);
    assert.equal(row.state_reason, null);
    assert.equal(row.created_at, OBS_1, "the caller's observation time, not a clock");
    assert.equal(row.updated_at, OBS_1);

    // M2-FIRST8 / M1B2-AC23
    assert.equal(world.store.attempts.get(`attempt:${keyOf("T-1")}:1`), undefined);

    // M2-FIRST9 / M1B2-AC24
    assert.deepEqual(world.store.batchView.project(BATCH_ID), before);

    // M2-FIRST10 / M1B2-AC35
    const entries = observationsFor(world, keyOf("T-1"));
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry?.ts, OBS_1);
    assert.deepEqual(entry?.payload, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      task_key: keyOf("T-1"),
      external_task_ref: "T-1",
      outcome: "MATERIALIZED",
      external_snapshot: row.external_snapshot,
    });
    assert.equal(result.observations[0]?.observation_seq, entry?.seq);
  });
});

test("M2-FIRST5 / M1B2-AC38: an opaque task_ref containing ':' is preserved verbatim", () => {
  withWorld((world) => {
    const ref = "area:sub:T-9";
    const source = new ScriptedTaskSource([{ ref }]);
    pass(world, source);

    const row = world.store.tasks.require(`task:${PROJECT}:${ref}`);
    assert.equal(row.external_task_ref, ref, "the ref is never split, encoded or hashed");
    assert.equal(row.task_key, `task:${PROJECT}:area:sub:T-9`);
    assert.deepEqual(source.calls.get_task, [ref]);
  });
});

// --- refresh ------------------------------------------------------------------------------

test("M2-REF1 ~ M2-REF10 / M1B2-AC25 ~ AC29: a repeated pass refreshes the snapshot only", () => {
  withWorld((world) => {
    const first = new ScriptedTaskSource([{ ref: "T-1", state: "TODO", version: "1" }]);
    pass(world, first);
    const created = world.store.tasks.require(keyOf("T-1"));

    const second = new ScriptedTaskSource([{ ref: "T-1", state: "IN_PROGRESS", version: "2" }]);
    const result = pass(world, second, OBS_2);
    const row = world.store.tasks.require(keyOf("T-1"));

    assert.equal(result.observations[0]?.outcome, "REFRESHED");
    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 1, "M2-REF1: no second row");
    assert.equal(row.external_snapshot.external_state, "IN_PROGRESS", "M2-REF2");
    assert.equal(row.external_snapshot.version, "2");
    assert.equal(row.external_snapshot.observed_at, OBS_2);
    assert.equal(row.platform_state, "DISCOVERED", "M2-REF3");
    assert.equal(row.created_at, created.created_at, "M2-REF4");
    assert.equal(row.updated_at, OBS_2, "M2-REF5");
    assert.equal(row.admitted_at, null, "M2-REF6");
    assert.equal(row.classification, null, "M2-REF7");
    assert.equal(row.pipeline_id, null);
    assert.equal(row.actor_profile, null);
    assert.equal(row.verification_profile, null);
    assert.equal(row.state_reason, null, "M2-REF8");
    assert.equal(observationsFor(world, keyOf("T-1")).length, 2, "M2-REF10");
  });
});

test("M2-REF6 ~ M2-REF9: an admitted task keeps every lifecycle field across a refresh", () => {
  withWorld((world) => {
    const taskKey = seedTask(world, { ref: "T-1", state: "ACTIVE", attempt_state: "IMPLEMENTING" });
    const before = world.store.tasks.require(taskKey);
    const attemptBefore = world.store.attempts.require(`attempt:${taskKey}:1`);

    pass(world, new ScriptedTaskSource([{ ref: "T-1", state: "BLOCKED", version: "9" }]), OBS_2);

    const after = world.store.tasks.require(taskKey);
    assert.equal(after.platform_state, "ACTIVE");
    assert.equal(after.admitted_at, before.admitted_at);
    assert.equal(after.classification, before.classification);
    assert.equal(after.pipeline_id, before.pipeline_id);
    assert.equal(after.actor_profile, before.actor_profile);
    assert.equal(after.verification_profile, before.verification_profile);
    assert.deepEqual(after.state_reason, before.state_reason);
    assert.equal(after.external_snapshot.external_state, "BLOCKED");
    assert.deepEqual(
      world.store.attempts.require(`attempt:${taskKey}:1`),
      attemptBefore,
      "M2-REF9: the attempt is untouched",
    );
  });
});

// --- drift ---------------------------------------------------------------------------------

const driftCases: ReadonlyArray<readonly [string, Partial<ScriptedTask>]> = [
  ["M2-DRIFT1: version drift", { version: "2" }],
  ["M2-DRIFT2: definition_hash drift", { description: "A rewritten description." }],
  ["M2-DRIFT3: both drift", { version: "3", description: "Rewritten again." }],
];

for (const [label, drift] of driftCases) {
  test(`${label} / M1B2-AC30 / AC31: only the projection moves`, () => {
    withWorld((world) => {
      const base: ScriptedTask = { ref: "T-1", version: "1" };
      pass(world, new ScriptedTaskSource([base]));
      const before = world.store.tasks.require(keyOf("T-1"));

      const drifted: ScriptedTask = { ...base, ...drift };
      pass(world, new ScriptedTaskSource([drifted]), OBS_2);
      const after = world.store.tasks.require(keyOf("T-1"));

      assert.notDeepEqual(after.external_snapshot, before.external_snapshot, "drift is visible");
      assert.equal(after.external_snapshot.version, drifted.version ?? "1");
      assert.equal(after.external_snapshot.definition_hash, definitionHashOf(drifted));
      assert.equal(after.platform_state, before.platform_state);
      assert.equal(after.admitted_at, before.admitted_at);
      assert.deepEqual(after.state_reason, before.state_reason);
      assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 1);
    });
  });
}

test("M2-DRIFT4 ~ M2-DRIFT6: drift never moves DISCOVERED, SELECTED or ACTIVE", () => {
  withWorld((world) => {
    const discovered = seedTask(world, { ref: "T-1", state: "DISCOVERED" });
    const selected = seedTask(world, { ref: "T-2", state: "SELECTED", snapshot_index: 1 });
    const active = seedTask(world, {
      ref: "T-3",
      state: "ACTIVE",
      attempt_state: "VERIFYING",
      snapshot_index: 2,
    });
    const attemptBefore = world.store.attempts.require(`attempt:${active}:1`);

    pass(
      world,
      new ScriptedTaskSource([
        { ref: "T-1", version: "9" },
        { ref: "T-2", version: "9" },
        { ref: "T-3", version: "9" },
      ]),
      OBS_2,
    );

    assert.equal(world.store.tasks.require(discovered).platform_state, "DISCOVERED");
    assert.equal(world.store.tasks.require(selected).platform_state, "SELECTED");
    assert.equal(world.store.tasks.require(active).platform_state, "ACTIVE");
    assert.deepEqual(world.store.attempts.require(`attempt:${active}:1`), attemptBefore);
    for (const key of [discovered, selected, active]) {
      assert.equal(world.store.tasks.require(key).external_snapshot.version, "9");
    }
  });
});

// --- external states ------------------------------------------------------------------------

test("M1B2-AC32: all six external states are preserved as projection, none is mapped", () => {
  withWorld((world) => {
    const source = new ScriptedTaskSource(
      EXTERNAL_TASK_STATES.map((state, index) => ({ ref: `T-${index}`, state })),
    );
    pass(world, source);

    for (const [index, state] of EXTERNAL_TASK_STATES.entries()) {
      const row = world.store.tasks.require(keyOf(`T-${index}`));
      assert.equal(row.external_snapshot.external_state, state);
      assert.equal(row.platform_state, "DISCOVERED", `${state} did not become a Platform state`);
    }
  });
});

test("M1B2-AC33: CLOSED before execution never becomes COMPLETED", () => {
  withWorld((world) => {
    const discovered = seedTask(world, { ref: "T-1", state: "DISCOVERED" });
    const selected = seedTask(world, { ref: "T-2", state: "SELECTED", snapshot_index: 1 });

    pass(
      world,
      new ScriptedTaskSource([
        { ref: "T-1", state: "CLOSED" },
        { ref: "T-2", state: "CLOSED" },
      ]),
      OBS_2,
    );

    const expect = (row: TaskRow, state: string): void => {
      assert.equal(row.platform_state, state);
      assert.equal(row.external_snapshot.external_state, "CLOSED");
      assert.equal(row.state_reason, null);
    };
    expect(world.store.tasks.require(discovered), "DISCOVERED");
    expect(world.store.tasks.require(selected), "SELECTED");
  });
});

test("M1B2-AC34: CLOSED observed during ACTIVE leaves the live attempt untouched", () => {
  withWorld((world) => {
    const taskKey = seedTask(world, { ref: "T-1", state: "ACTIVE", attempt_state: "AUDITING" });
    const attemptKey = `attempt:${taskKey}:1`;
    const before = world.store.attempts.require(attemptKey);
    const view = world.store.batchView.project(BATCH_ID);

    pass(world, new ScriptedTaskSource([{ ref: "T-1", state: "CLOSED" }]), OBS_2);

    const task = world.store.tasks.require(taskKey);
    const attempt = world.store.attempts.require(attemptKey);
    assert.equal(task.platform_state, "ACTIVE");
    assert.equal(task.external_snapshot.external_state, "CLOSED");
    assert.equal(attempt.state, before.state);
    assert.equal(attempt.candidate_commit, before.candidate_commit);
    assert.equal(attempt.rework_count, before.rework_count);
    assert.equal(attempt.contract_snapshot_id, before.contract_snapshot_id);
    assert.deepEqual(world.store.batchView.project(BATCH_ID), view);
  });
});

// --- ProjectDocumentTaskSource integration -------------------------------------------------

test("M1B2-AC3: the same pass runs against ProjectDocumentTaskSource end to end", () => {
  withWorld((world) => {
    const document = [
      taskBlock({ ref: "T-100", state: "TODO", version: "1", dependencies: [] }),
      taskBlock({ ref: "T-101", state: "READY", version: "4", dependencies: ["- HARD: T-100"] }),
    ].join("\n");
    const source = new ProjectDocumentTaskSource(
      singleDocumentConfig(),
      readerFor({ "plan.md": document }),
    );

    const result = materializeDiscoveryPass(world.store, source, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      context: { observed_at: OBS_1 },
    });

    assert.deepEqual(
      result.observations.map((observation) => observation.task_key),
      [keyOf("T-100"), keyOf("T-101")],
    );
    const first = world.store.tasks.require(keyOf("T-100"));
    const second = world.store.tasks.require(keyOf("T-101"));
    assert.equal(first.platform_state, "DISCOVERED");
    assert.equal(first.external_snapshot.external_state, "TODO");
    assert.equal(second.external_snapshot.external_state, "READY");
    assert.equal(second.external_snapshot.version, "4");
    assert.match(second.external_snapshot.definition_hash, /^sha256:[0-9a-f]{64}$/);
    // The declared HARD dependency is visible to the adapter and durably ignored by this pass.
    assert.equal(source.get_dependencies("T-101").length, 1);
    assert.equal(world.store.tasks.require(keyOf("T-101")).classification, null);
  });
});

test("M1B2-AC32: every external state a document can declare survives the round trip", () => {
  withWorld((world) => {
    const states: readonly ExternalTaskState[] = EXTERNAL_TASK_STATES;
    const document = states
      .map((state, index) => taskBlock({ ref: `D-${index}`, state, dependencies: [] }))
      .join("\n");
    const source = new ProjectDocumentTaskSource(
      singleDocumentConfig(),
      readerFor({ "plan.md": document }),
    );

    materializeDiscoveryPass(world.store, source, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      context: { observed_at: OBS_1 },
    });

    for (const [index, state] of states.entries()) {
      assert.equal(
        world.store.tasks.require(keyOf(`D-${index}`)).external_snapshot.external_state,
        state,
      );
    }
  });
});
