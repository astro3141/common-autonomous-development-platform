/**
 * M1B2-AC11 ~ M1B2-AC18, M1B2-AC35 ~ M1B2-AC39, M1B2-AC41 ~ M1B2-AC43 — a discovery pass is
 * all-or-nothing, gathers every external observation before it writes, and leaves the previous
 * observation intact when it fails (TD §8.4, §18.2).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeDiscoveryPass,
  TASK_OBSERVATION_KIND,
} from "../core/discovery/materialize.ts";
import { StoreError } from "../core/store/errors.ts";
import { TaskSourceError } from "../core/tasksource/errors.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import {
  BATCH_ID,
  PROJECT,
  RUN_ID,
  seedTask,
  withWorld,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import { definitionBody, ScriptedTaskSource, type ScriptedTask } from "./support/scripted-task-source.ts";

const OBS_1 = "2026-08-10T09:00:00Z";
const OBS_2 = "2026-08-10T11:00:00Z";
const keyOf = (ref: string): string => `task:${PROJECT}:${ref}`;

const pass = (world: DomainWorld, source: ScriptedTaskSource, observed_at = OBS_1) =>
  materializeDiscoveryPass(world.store, source, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    context: { observed_at },
  });

interface DurableSnapshot {
  readonly tasks: number;
  readonly log: number;
  readonly attempts: number;
  readonly contracts: number;
  readonly grants: number;
  readonly pending: number;
  readonly outbox: number;
}

const durable = (world: DomainWorld): DurableSnapshot => ({
  tasks: world.store.tasks.inBatch(BATCH_ID).length,
  log: world.store.decisions.count(),
  attempts: world.store.attempts.forTask(keyOf("T-1")).length,
  contracts: world.store.contracts.count(),
  grants: world.store.grants.count(),
  pending: world.store.pendingDecisions.count(),
  outbox: world.store.outbox.count(),
});

/** Every failure mode of §8.4 that must abort the whole pass, with the second candidate at fault. */
const failingPasses: ReadonlyArray<readonly [string, readonly ScriptedTask[]]> = [
  ["M2-AT1: a duplicate task_ref", [{ ref: "T-1" }, { ref: "T-2" }, { ref: "T-1" }]],
  ["M2-AT2: get_task fails", [{ ref: "T-1" }, { ref: "T-2", getTaskFails: "source unavailable" }]],
  [
    "M2-AT3: a malformed definition body",
    [{ ref: "T-1" }, { ref: "T-2", definition: { task_ref: "T-2", version: "1", body: {} } }],
  ],
  [
    "M2-AT4: an adapter-supplied definition_hash that does not match",
    [
      { ref: "T-1" },
      {
        ref: "T-2",
        definition: {
          task_ref: "T-2",
          version: "1",
          definition_hash: `sha256:${"0".repeat(64)}`,
          body: definitionBody({ ref: "T-2" }),
        },
      },
    ],
  ],
  [
    "M2-AT5: a definition for another task",
    [
      { ref: "T-1" },
      {
        ref: "T-2",
        definition: { task_ref: "T-9", version: "1", body: definitionBody({ ref: "T-9" }) },
      },
    ],
  ],
  [
    "M2-AT1: a malformed candidate external_state",
    [{ ref: "T-1" }, { ref: "T-2", state: "DONE" as never }],
  ],
];

for (const [label, tasks] of failingPasses) {
  test(`${label} / M1B2-AC11 ~ AC14 / AC17 / AC18: the whole pass writes nothing`, () => {
    withWorld((world) => {
      const before = durable(world);
      const source = new ScriptedTaskSource(tasks);

      assert.throws(() => pass(world, source));

      assert.deepEqual(durable(world), before, "no row and no journal entry survived");
      assert.equal(world.store.tasks.get(keyOf("T-1")), undefined, "not even the first candidate");
    });
  });
}

test("M2-AT1 / M1B2-AC11: a duplicate is refused before any get_task is issued", () => {
  withWorld((world) => {
    const source = new ScriptedTaskSource([{ ref: "T-1" }, { ref: "T-1" }]);
    assert.throws(
      () => pass(world, source),
      (error: unknown) =>
        error instanceof TaskSourceError && error.reason === "DUPLICATE_TASK_REF",
    );
    assert.deepEqual(source.calls.get_task, [], "neither candidate was resolved");
    assert.equal(world.store.decisions.count(), 0);
  });
});

test("M1B2-AC15: discover_tasks fails before the pass can open a transaction", () => {
  withWorld((world) => {
    const source = new ScriptedTaskSource([{ ref: "T-1" }], "the source is unreachable");
    assert.throws(() => pass(world, source), /unreachable/);
    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 0);
    assert.equal(world.store.decisions.count(), 0);
  });
});

test("M1B2-AC15: every get_task of the pass is issued before the first durable write", () => {
  withWorld((world) => {
    // The failure is in the last candidate, so the first two were fully gathered. If any of them
    // had been written on the way, the counts below would have moved.
    const source = new ScriptedTaskSource([
      { ref: "T-1" },
      { ref: "T-2" },
      { ref: "T-3", getTaskFails: "gone" },
    ]);
    assert.throws(() => pass(world, source));

    assert.deepEqual(source.calls.get_task, ["T-1", "T-2", "T-3"]);
    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 0);
    assert.equal(world.store.decisions.count(), 0);
  });
});

test("M2-AT6 / M1B2-AC16 / AC17: a write that fails midway rolls the whole transaction back", () => {
  withWorld((world) => {
    // A durable row that already belongs to another batch of the same run. Reaching it is a real
    // mid-transaction failure: the first candidate has been inserted by then.
    const otherBatch = `${"batch:"}${RUN_ID}:2`;
    world.store.withTransaction(() => {
      world.store.batches.create({
        batch_id: otherBatch,
        run_id: RUN_ID,
        ordinal: 2,
        compiled_profile_hash: world.profile.compiled_hash,
      });
      world.store.tasks.discover({
        task_key: keyOf("T-2"),
        batch_id: otherBatch,
        project_id: PROJECT,
        external_task_ref: "T-2",
        external_snapshot: {
          external_state: "READY",
          version: "1",
          definition_hash: `sha256:${"a".repeat(64)}`,
          observed_at: OBS_1,
        },
        at: OBS_1,
      });
    });
    const logBefore = world.store.decisions.count();

    assert.throws(
      () => pass(world, new ScriptedTaskSource([{ ref: "T-1" }, { ref: "T-2" }]), OBS_2),
      (error: unknown) => error instanceof StoreError && error.code === "DOMAIN_ROW_INVALID",
    );

    // M1B2-AC28 — the pre-existing row was neither re-homed nor refreshed.
    const existing = world.store.tasks.require(keyOf("T-2"));
    assert.equal(existing.batch_id, otherBatch);
    assert.equal(existing.external_snapshot.observed_at, OBS_1);
    // And the first candidate, written earlier in the same transaction, is gone again.
    assert.equal(world.store.tasks.get(keyOf("T-1")), undefined);
    assert.equal(world.store.decisions.count(), logBefore);
  });
});

test("M1B2-AC17 / §52: a failed refresh leaves the last successful observation in place", () => {
  withWorld((world) => {
    pass(world, new ScriptedTaskSource([{ ref: "T-1", state: "TODO", version: "1" }]));
    const snapshotA = world.store.tasks.require(keyOf("T-1")).external_snapshot;
    const logAfterA = world.store.decisions.count();

    assert.throws(() =>
      pass(
        world,
        new ScriptedTaskSource([
          { ref: "T-1", state: "CLOSED", version: "2" },
          { ref: "T-2", getTaskFails: "gone" },
        ]),
        OBS_2,
      ),
    );

    assert.deepEqual(
      world.store.tasks.require(keyOf("T-1")).external_snapshot,
      snapshotA,
      "no partial snapshot B survived",
    );
    assert.equal(world.store.tasks.get(keyOf("T-2")), undefined);
    assert.equal(world.store.decisions.count(), logAfterA);
  });
});

// --- journal semantics -----------------------------------------------------------------------

test("M1B2-AC35 / AC36 / §54: one successful pass appends exactly one observation per task", () => {
  withWorld((world) => {
    pass(world, new ScriptedTaskSource([{ ref: "T-1" }, { ref: "T-2" }, { ref: "T-3" }]));
    pass(world, new ScriptedTaskSource([{ ref: "T-1" }, { ref: "T-2" }]), OBS_2);

    const entries = world.store.decisions
      .read()
      .filter((entry) => entry.kind === TASK_OBSERVATION_KIND);
    assert.equal(entries.length, 5);
    assert.deepEqual(
      entries.map((entry) => `${entry.refKey}/${(entry.payload as { outcome: string }).outcome}`),
      [
        `${keyOf("T-1")}/MATERIALIZED`,
        `${keyOf("T-2")}/MATERIALIZED`,
        `${keyOf("T-3")}/MATERIALIZED`,
        `${keyOf("T-1")}/REFRESHED`,
        `${keyOf("T-2")}/REFRESHED`,
      ],
    );
    // The kind is its own vocabulary and is never a state transition claim.
    assert.notEqual(TASK_OBSERVATION_KIND, STATE_TRANSITION_KIND);
    assert.equal(
      world.store.decisions.read().some((entry) => entry.kind === STATE_TRANSITION_KIND),
      false,
      "materialization claims no transition",
    );
    assert.deepEqual(
      [...new Set(entries.map((entry) => entry.ts))],
      [OBS_1, OBS_2],
      "the journal time is the caller's observation time",
    );
  });
});

test("M1B2-AC37: an observation never becomes a task's state reason", () => {
  withWorld((world) => {
    const held = seedTask(world, { ref: "T-1", state: "HELD" });
    const before = world.store.tasks.require(held).state_reason;
    assert.notEqual(before, null, "the seeded task is held for a real reason");

    pass(world, new ScriptedTaskSource([{ ref: "T-1", state: "BLOCKED" }]), OBS_2);

    const after = world.store.tasks.require(held);
    assert.deepEqual(after.state_reason, before, "the reason and its log_seq are untouched");
    assert.equal(after.platform_state, "HELD");
    assert.equal(after.external_snapshot.external_state, "BLOCKED");
  });
});

test("M1B2-AC39 / §53: discovery order is not priority and is not durable", () => {
  withWorld((world) => {
    const result = pass(
      world,
      new ScriptedTaskSource([{ ref: "T-3" }, { ref: "T-1" }, { ref: "T-2" }]),
    );

    // The result preserves candidate order — presentation only.
    assert.deepEqual(
      result.observations.map((observation) => observation.external_task_ref),
      ["T-3", "T-1", "T-2"],
    );
    // Durable rows carry no rank of any kind: the store orders them by key, not by arrival.
    for (const row of world.store.tasks.inBatch(BATCH_ID)) {
      for (const forbidden of ["priority", "ordinal", "rank", "position", "discovery_index"]) {
        assert.equal(forbidden in row, false, `task rows expose ${forbidden}`);
      }
      assert.equal(row.platform_state, "DISCOVERED");
    }
    assert.deepEqual(
      world.store.tasks.inBatch(BATCH_ID).map((row) => row.external_task_ref),
      ["T-1", "T-2", "T-3"],
    );
  });
});

// --- what a pass must not touch ---------------------------------------------------------------

test("M1B2-AC23 / AC42 / AC43: no contract, grant, attempt, pending decision, outbox or intent", () => {
  withWorld((world) => {
    const before = durable(world);
    pass(world, new ScriptedTaskSource([{ ref: "T-1" }, { ref: "T-2" }]));

    assert.equal(world.store.contracts.count(), before.contracts);
    assert.equal(world.store.grants.count(), before.grants);
    assert.equal(world.store.attempts.forTask(keyOf("T-1")).length, 0);
    assert.equal(world.store.pendingDecisions.count(), before.pending);
    assert.equal(world.store.outbox.count(), before.outbox);

    // A TaskSource read is not a canonical external side effect (I-TD2), so no INTENT is written.
    assert.throws(() => pass(world, new ScriptedTaskSource([{ ref: "T-1" }], "down")));
    assert.equal(world.store.pendingDecisions.count(), before.pending, "no auto PendingDecision");
    assert.equal(world.store.outbox.count(), before.outbox);
  });
});

test("M1B2-AC41 / AC42: a source failure stays a source failure and is never TASK_NOT_FOUND", () => {
  withWorld((world) => {
    assert.throws(
      () => pass(world, new ScriptedTaskSource([{ ref: "T-1", getTaskFails: "io error" }])),
      (error: unknown) => !(error instanceof TaskSourceError) && /io error/.test(String(error)),
    );
    assert.throws(
      () =>
        pass(
          world,
          new ScriptedTaskSource([
            { ref: "T-1", definition: { task_ref: "T-1", version: "1", body: 5 } },
          ]),
        ),
      (error: unknown) =>
        error instanceof TaskSourceError &&
        error.reason === "DEFINITION_INVALID" &&
        error.reason !== ("TASK_NOT_FOUND" as string),
    );
  });
});
