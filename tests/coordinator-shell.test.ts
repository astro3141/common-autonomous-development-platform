/**
 * B9-AC1 ~ B9-AC11 — the MVP 0 Coordinator surface: a caller-driven tick with no scheduling, an
 * observe that is a bare `status` poll, and the exact three-value recovery vocabulary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowObservation } from "../adapters/interfaces/workflow-adapter.ts";
import type { WorkflowHandle } from "../adapters/interfaces/handles.ts";
import { Coordinator } from "../core/coordinator/coordinator.ts";
import { RECOVERY_CLASSIFICATIONS } from "../core/coordinator/types.ts";
import { TestDoubleError } from "../testdoubles/scripted.ts";
import { FakeReportAdapter } from "../testdoubles/fake-report-adapter.ts";
import { FakeRepositoryAdapter } from "../testdoubles/fake-repository-adapter.ts";
import { FakeRuntimeAdapter } from "../testdoubles/fake-runtime-adapter.ts";
import { FakeVerificationAdapter } from "../testdoubles/fake-verification-adapter.ts";
import { FakeWorkflowAdapter } from "../testdoubles/fake-workflow-adapter.ts";
import { withWorld, type DomainWorld } from "./support/domain-fixtures.ts";

const HANDLE = { __brand: "workflow" } as unknown as WorkflowHandle;

const OBSERVATION: WorkflowObservation = {
  state: "backend-specific-state",
  stage: "backend-specific-stage",
  attempt: 3,
  terminal: false,
  refs: { workflow_ref: "opaque-1" },
};

const coordinatorFor = (
  world: DomainWorld,
): { coordinator: Coordinator; workflow: FakeWorkflowAdapter } => {
  const workflow = new FakeWorkflowAdapter();
  return { coordinator: new Coordinator({ store: world.store, workflow }), workflow };
};

/** Everything durable that a tick must not touch. */
const durableSnapshot = (world: DomainWorld): Record<string, number> => ({
  decisions: world.store.decisions.count(),
  outbox: world.store.outbox.count(),
  blobs: world.store.blobs.count(),
  idempotency: world.store.idempotency.count(),
  pending: world.store.pendingDecisions.count(),
  contracts: world.store.contracts.count(),
  grants: world.store.grants.count(),
  profiles: world.store.compiledProfiles.count(),
});

// --- surface ------------------------------------------------------------------------------

test("B9-AC1 / B9-AC2: the public surface is exactly tick, observe and recover", () => {
  const own = Object.getOwnPropertyNames(Coordinator.prototype).filter(
    (name) => name !== "constructor",
  );
  assert.deepEqual(own.sort(), ["observe", "recover", "tickOnce"]);
});

test("B9-AC11: RecoveryClassification is the exact three-value vocabulary", () => {
  assert.deepEqual([...RECOVERY_CLASSIFICATIONS], ["CONSISTENT", "EXPLAINABLE", "UNEXPLAINED"]);
  for (const forbidden of [
    "NO_ACTION",
    "RECOVERED",
    "RETRY",
    "HOLD",
    "PAUSE",
    "RECREATE_SESSION",
    "NOT_APPLICABLE",
    "UNAVAILABLE",
  ]) {
    assert.equal(
      (RECOVERY_CLASSIFICATIONS as readonly string[]).includes(forbidden),
      false,
      `${forbidden} is not a recovery classification`,
    );
  }
});

// --- tick ----------------------------------------------------------------------------------

test("B9-AC5 / B9-AC7: tick is caller-driven, deterministic and touches nothing", () => {
  withWorld((world) => {
    const { coordinator, workflow } = coordinatorFor(world);
    const runtime = new FakeRuntimeAdapter();
    const repository = new FakeRepositoryAdapter();
    const verification = new FakeVerificationAdapter();
    const report = new FakeReportAdapter();

    const before = durableSnapshot(world);
    assert.equal(coordinator.tickOnce(), undefined, "returns no result vocabulary");
    coordinator.tickOnce();
    coordinator.tickOnce();

    assert.deepEqual(durableSnapshot(world), before, "no durable write of any kind");
    assert.deepEqual(workflow.calls, [], "no workflow observation");
    for (const adapter of [runtime, repository, verification, report]) {
      assert.deepEqual(adapter.calls, [], "no adapter is called");
    }
  });
});

test("B9-AC6: no timer, sleep or self-rescheduling is registered by a tick", () => {
  withWorld((world) => {
    const { coordinator } = coordinatorFor(world);
    const globals = globalThis as unknown as Record<string, unknown>;
    const patched: Record<string, unknown> = {};
    const seen: string[] = [];

    for (const name of ["setInterval", "setTimeout", "setImmediate", "queueMicrotask"]) {
      patched[name] = globals[name];
      globals[name] = (...args: readonly unknown[]) => {
        seen.push(name);
        return (patched[name] as (...a: readonly unknown[]) => unknown)(...args);
      };
    }

    try {
      coordinator.tickOnce();
      coordinator.tickOnce();
    } finally {
      for (const [name, original] of Object.entries(patched)) globals[name] = original;
    }

    assert.deepEqual(seen, [], "MVP 0 tick schedules nothing");
  });
});

test("B9-AC3: the Coordinator keeps no mutable state across ticks", () => {
  withWorld((world) => {
    const { coordinator } = coordinatorFor(world);
    const before = Object.keys(coordinator).length;
    coordinator.tickOnce();
    coordinator.tickOnce();
    assert.equal(Object.keys(coordinator).length, before);
    // Only the injected dependencies exist, and they are private fields.
    assert.deepEqual(Object.keys(coordinator), []);
  });
});

// --- observe ---------------------------------------------------------------------------------

test("B9-AC8 / B9-AC9: observe polls status exactly once and returns it verbatim", () => {
  withWorld((world) => {
    const { coordinator, workflow } = coordinatorFor(world);
    workflow.observations.push(OBSERVATION);

    const before = durableSnapshot(world);
    const observed = coordinator.observe(HANDLE);

    assert.equal(observed, OBSERVATION, "the adapter's object is returned unchanged");
    assert.deepEqual(observed, OBSERVATION);
    assert.equal(workflow.calls.length, 1);
    assert.equal(workflow.calls[0]?.method, "status");
    assert.equal(workflow.calls[0]?.args[0], HANDLE, "the supplied handle is passed through");
    assert.deepEqual(durableSnapshot(world), before, "observation writes nothing");
  });
});

test("B9-AC10: no observation is interpreted into Core lifecycle meaning", () => {
  withWorld((world) => {
    const { coordinator, workflow } = coordinatorFor(world);
    // A backend vocabulary that deliberately looks like Core state must stay opaque.
    const misleading: WorkflowObservation = {
      state: "MERGED",
      stage: "READY_TO_MERGE",
      attempt: 1,
      terminal: true,
      refs: {},
    };
    workflow.observations.push(misleading);

    const observed = coordinator.observe(HANDLE);
    assert.deepEqual(observed, misleading);

    // Nothing moved: the words are backend strings, not Platform authority.
    const tasks = world.store.tasks.inBatch("batch:x");
    assert.deepEqual(tasks, []);
    assert.equal(world.store.decisions.count(), 0);
  });
});

test("B9-AC8: an adapter failure propagates without any recovery behaviour", () => {
  withWorld((world) => {
    const { coordinator, workflow } = coordinatorFor(world);
    const before = durableSnapshot(world);

    // Script exhausted → the double raises; the Coordinator neither retries nor holds.
    assert.throws(() => coordinator.observe(HANDLE), (error: unknown) =>
      error instanceof TestDoubleError,
    );

    assert.equal(workflow.calls.length, 1, "no retry");
    assert.deepEqual(durableSnapshot(world), before, "no HELD/PAUSED_SAFELY mutation");
  });
});
