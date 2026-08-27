/**
 * DG1 ~ DG22 — the direct HARD dependency admission fact (TD §8.4a, M1-5).
 *
 * Three layers: the pure rule, the fresh evaluation against real durable rows, and the commit-time
 * guard that consumes the boolean — including the Human Gate path, where an approval must not
 * carry a dependency fact from the past.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateHardDependencies,
  isDirectHardDependencySatisfied,
} from "../core/admission/dependency-admission.ts";
import { submitProposal, resolveHumanGateAndAdmit } from "../core/admission/submit-proposal.ts";
import { commitAdmission, commitDecisionResolution } from "../core/statemachine/transition-commit.ts";
import { TransitionError } from "../core/statemachine/errors.ts";
import { blockedByDecision } from "../core/statemachine/types.ts";
import { TaskSourceError } from "../core/tasksource/errors.ts";
import type { ExternalTaskState, TaskDependency } from "../core/tasksource/types.ts";
import type { TaskRow, TaskState } from "../core/store/domain-types.ts";
import {
  BATCH_ID,
  BINDING,
  PROJECT,
  RUN_ID,
  SCOPE_ID,
  TASK_KEY,
  discover,
  seedTask,
  type DomainWorld,
  withWorld,
} from "./support/domain-fixtures.ts";
import { selection } from "./support/decision-fixtures.ts";
import {
  authoritiesFor,
  DECISION_ID,
  REPORT_CHANNEL,
  StubTaskSource,
  type AdmissionWorld,
} from "./support/admission-fixtures.ts";

const OBSERVED_AT = "2026-08-12T09:00:00Z";
const RESOLVED_AT = "2026-08-12T15:00:00Z";
const DEP = "T-100";

const hard = (ref = DEP): TaskDependency => ({
  task_ref: "T-101",
  depends_on_ref: ref,
  kind: "HARD",
});
const soft = (ref = DEP): TaskDependency => ({
  task_ref: "T-101",
  depends_on_ref: ref,
  kind: "SOFT",
});

/** A synthetic durable row, for the pure-rule table only. */
const row = (state: TaskState, admitted: string | null): TaskRow =>
  ({ platform_state: state, admitted_at: admitted }) as TaskRow;

const submit = (world: DomainWorld, authorities: AdmissionWorld, proposal: unknown) =>
  submitProposal(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    proposal,
    observed_at: OBSERVED_AT,
    decision_id: DECISION_ID,
    report_channel: REPORT_CHANNEL,
  });

// --- DG1 ~ DG13: the pure rule ------------------------------------------------------------

test("DG3 ~ DG13: the satisfaction rule is exactly TD §8.4a", () => {
  const EXTERNAL: readonly ExternalTaskState[] = [
    "TODO",
    "READY",
    "IN_PROGRESS",
    "BLOCKED",
    "CLOSED",
    "UNKNOWN",
  ];

  // DG3 ~ DG7 — no target, or one the Platform never admitted: CLOSED alone decides.
  for (const target of [null, row("DISCOVERED", null), row("SELECTED", null)]) {
    for (const external of EXTERNAL) {
      assert.equal(
        isDirectHardDependencySatisfied(external, target),
        external === "CLOSED",
        `never-admitted target with ${external}`,
      );
    }
  }

  // DG8 ~ DG13 — an admitted target must say COMPLETED *and* be externally closed.
  const admittedStates: readonly TaskState[] = [
    "DISCOVERED",
    "SELECTED",
    "ACTIVE",
    "HELD",
    "DEFERRED",
    "FAILED",
    "COMPLETED",
  ];
  for (const state of admittedStates) {
    for (const external of EXTERNAL) {
      assert.equal(
        isDirectHardDependencySatisfied(external, row(state, "t-admit")),
        state === "COMPLETED" && external === "CLOSED",
        `admitted ${state} with ${external}`,
      );
    }
  }
});

test("DG1 / DG2: no dependency, or only SOFT ones, is clear without any external read", () => {
  withWorld((world) => {
    const source = new StubTaskSource();

    assert.deepEqual(
      evaluateHardDependencies({
        store: world.store,
        taskSource: source,
        project_id: PROJECT,
        dependencies: [],
      }),
      { hard_dependencies_clear: true },
      "DG1",
    );

    assert.deepEqual(
      evaluateHardDependencies({
        store: world.store,
        taskSource: source,
        project_id: PROJECT,
        dependencies: [soft("S1"), soft("S2")],
      }),
      { hard_dependencies_clear: true },
      "DG2",
    );
    assert.deepEqual(source.calls, [], "DG2: a SOFT target's state is never read");
  });
});

// --- DG14 ~ DG16: aggregation ----------------------------------------------------------------

test("DG14 ~ DG16: every direct HARD must be satisfied; SOFT entries are skipped", () => {
  withWorld((world) => {
    const source = new StubTaskSource();
    source.externalStates["H1"] = "CLOSED";
    source.externalStates["H2"] = "CLOSED";
    const evaluate = (dependencies: readonly TaskDependency[]) =>
      evaluateHardDependencies({
        store: world.store,
        taskSource: source,
        project_id: PROJECT,
        dependencies,
      }).hard_dependencies_clear;

    // DG14 / DG16 — mixed input, HARD only, both satisfied.
    assert.equal(evaluate([soft("S1"), hard("H1"), soft("S2"), hard("H2")]), true);
    assert.deepEqual(source.calls, ["get_task_state:H1", "get_task_state:H2"]);

    // DG15 — one blocked HARD fails the whole set, and evaluation stops there.
    source.calls.length = 0;
    source.externalStates["H2"] = "IN_PROGRESS";
    assert.equal(evaluate([hard("H2"), hard("H1")]), false);
    assert.deepEqual(source.calls, ["get_task_state:H2"], "short-circuits at the first blocker");

    // Order is input order, not a scheduler rank: the same set in the other order still blocks.
    source.calls.length = 0;
    assert.equal(evaluate([hard("H1"), hard("H2")]), false);
    assert.deepEqual(source.calls, ["get_task_state:H1", "get_task_state:H2"]);
  });
});

// --- DG18 / DG19: the commit-time guard --------------------------------------------------------

test("DG19: a clear external prerequisite admits the task", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    const result = submit(world, authorities, selection({ profile: world.profile }));

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, true);
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
  });
});

test("DG18 / §17: a blocked dependency leaves the task DISCOVERED with nothing else touched", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "READY";
    const authorities = authoritiesFor(world, { taskSource: source });

    // The Validator says ACCEPTED — dependency is not its authority — and the guard still refuses.
    assert.throws(
      () => submit(world, authorities, selection({ profile: world.profile })),
      (error: unknown) =>
        error instanceof TransitionError &&
        error.reason === "ADMISSION_REJECTED" &&
        error.detail === "HARD_DEPENDENCY_BLOCKED",
    );

    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "DISCOVERED");
    assert.equal(task.admitted_at, null);
    assert.equal(task.classification, null, "selection fields were not persisted");
    assert.equal(world.store.attempts.forTask(TASK_KEY).length, 0);
    assert.equal(world.store.contracts.count(), 0);
    assert.equal(world.store.grants.count(), 0);
    assert.equal(world.store.batchView.admitted(BATCH_ID), 0);
    // A blocked dependency is not escalated to a human.
    assert.equal(world.store.pendingDecisions.count(), 0);
    assert.equal(world.store.outbox.count(), 0);
  });
});

test("DG23: the guard composes with the existing count guards rather than replacing them", () => {
  withWorld(
    (world) => {
      discover(world);
      const authorities = authoritiesFor(world);
      world.store.withTransaction(() => world.store.batches.closeAdmission(BATCH_ID));

      // Admission is closed *and* dependencies are clear: the older rejection still wins.
      assert.throws(
        () => submit(world, authorities, selection({ profile: world.profile })),
        (error: unknown) =>
          error instanceof TransitionError && error.detail === "BATCH_ADMISSION_CLOSED",
      );
    },
    { batch_policy: { max_tasks: 3, max_rework: 2, concurrency: 2 } },
  );
});

// --- DG21 ~ DG22: the Platform-managed trust boundary ------------------------------------------

test("DG9 ~ DG11 / §21: external CLOSED never overrides a Platform-managed dependency", () => {
  for (const state of ["ACTIVE", "HELD", "FAILED"] as const) {
    withWorld((world) => {
      discover(world);
      // The dependency is a task this Platform admitted and is still carrying.
      // No live attempt on the dependency: a writable candidate would trip V11 first and hide the
      // rule under test. What matters here is only the dependency's Platform state.
      const dependencyKey = seedTask(world, { ref: DEP, state, snapshot_index: 3 });
      const before = world.store.tasks.require(dependencyKey);

      const source = new StubTaskSource();
      source.dependencies = [hard()];
      source.externalStates[DEP] = "CLOSED";
      const authorities = authoritiesFor(world, { taskSource: source });

      assert.throws(
        () => submit(world, authorities, selection({ profile: world.profile })),
        (error: unknown) =>
          error instanceof TransitionError && error.detail === "HARD_DEPENDENCY_BLOCKED",
        `admitted ${state} + external CLOSED must block`,
      );

      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
      // §12 — observing the dependency changed nothing about it.
      assert.deepEqual(world.store.tasks.require(dependencyKey), before);
      assert.equal(world.store.tasks.require(dependencyKey).platform_state, state);
    });
  }
});

test("DG12 / §21: a reopened prerequisite blocks even when the Platform says COMPLETED", () => {
  withWorld((world) => {
    discover(world);
    const dependencyKey = seedTask(world, { ref: DEP, state: "COMPLETED", snapshot_index: 3 });
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "READY";
    const authorities = authoritiesFor(world, { taskSource: source });

    assert.throws(
      () => submit(world, authorities, selection({ profile: world.profile })),
      (error: unknown) =>
        error instanceof TransitionError && error.detail === "HARD_DEPENDENCY_BLOCKED",
    );
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.equal(
      world.store.tasks.require(dependencyKey).platform_state,
      "COMPLETED",
      "the divergence is not reconciled here",
    );

    // The same dependency, still externally closed, is clear.
    source.externalStates[DEP] = "CLOSED";
    assert.equal(submit(world, authorities, selection({ profile: world.profile })).admitted, true);
  });
});

test("DG5 / DG13 / §23: UNKNOWN is never satisfied, with or without a durable target", () => {
  withWorld((world) => {
    discover(world);
    seedTask(world, { ref: DEP, state: "COMPLETED", snapshot_index: 3 });
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "UNKNOWN";
    const authorities = authoritiesFor(world, { taskSource: source });

    assert.throws(() => submit(world, authorities, selection({ profile: world.profile })));
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
  });
});

// --- DG22: externally completed prerequisites --------------------------------------------------

test("DG3 / DG6 / §22: a prerequisite finished outside the Platform is clear and stays untouched", () => {
  // No durable row at all.
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard("external-only:T-9")];
    source.externalStates["external-only:T-9"] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    assert.equal(submit(world, authorities, selection({ profile: world.profile })).admitted, true);
    assert.equal(
      world.store.tasks.get(`task:${PROJECT}:external-only:T-9`),
      undefined,
      "the Platform did not materialize the prerequisite",
    );
    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 1);
  });

  // A materialized but never-admitted row.
  withWorld((world) => {
    discover(world);
    const dependencyKey = discover(world, DEP);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    assert.equal(submit(world, authorities, selection({ profile: world.profile })).admitted, true);
    const dependency = world.store.tasks.require(dependencyKey);
    assert.equal(dependency.platform_state, "DISCOVERED", "external CLOSED did not complete it");
    assert.equal(dependency.admitted_at, null);
  });
});

// --- DG17: operational failure -----------------------------------------------------------------

test("DG17: a get_task_state failure is operational, never a quiet block or TASK_NOT_FOUND", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    const failure = new TaskSourceError("DOCUMENT_UNREADABLE", "plan.md", "no such document");
    source.stateFailure = failure;
    const authorities = authoritiesFor(world, { taskSource: source });

    assert.throws(
      () => submit(world, authorities, selection({ profile: world.profile })),
      (error: unknown) => error === failure,
    );

    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "DISCOVERED");
    assert.equal(task.admitted_at, null);
    assert.equal(world.store.batchView.admitted(BATCH_ID), 0);
    // The validation that ran before it is journalled honestly, and it was not TASK_NOT_FOUND.
    const payloads = world.store.decisions
      .read()
      .map((entry) => entry.payload as Record<string, unknown>);
    assert.equal(payloads.some((payload) => payload["reason_code"] === "TASK_NOT_FOUND"), false);
  });
});

// --- DG20 ~ DG22: the Human Gate path -----------------------------------------------------------

const gated = (world: DomainWorld) =>
  selection({ profile: world.profile, classification: "LARGE_SCOPE" });

const approve = (world: DomainWorld): void => {
  commitDecisionResolution(world.store, DECISION_ID, {
    kind: "OPTION",
    chosen_option: "APPROVE",
    free_form: null,
    resolved_by: "operator-1",
    resolved_at: RESOLVED_AT,
    approval_binding: null,
    applied_transition_ref: null,
  });
};

const resolve = (authorities: AdmissionWorld) =>
  resolveHumanGateAndAdmit(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    decision_id: DECISION_ID,
    observed_at: RESOLVED_AT,
  });

test("DG20: a resolved approval with clear dependencies admits from HELD", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    submit(world, authorities, gated(world));
    approve(world);
    const result = resolve(authorities);

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, true);
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
  });
});

test("DG21 / §20: a dependency that closed and reopened while the human waited blocks the approval", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    submit(world, authorities, gated(world));
    approve(world);

    // The prerequisite reopens between the approval and its application.
    source.externalStates[DEP] = "READY";
    const readsBefore = source.calls.filter((call) => call.startsWith("get_task_state")).length;

    assert.throws(
      () => resolve(authorities),
      (error: unknown) =>
        error instanceof TransitionError && error.detail === "HARD_DEPENDENCY_BLOCKED",
    );

    // The dependency fact was recomputed rather than carried over from the request.
    assert.equal(
      source.calls.filter((call) => call.startsWith("get_task_state")).length > readsBefore,
      true,
    );
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, blockedByDecision(DECISION_ID));
    assert.equal(task.admitted_at, null);
    assert.equal(
      world.store.pendingDecisions.require(DECISION_ID).body.resolution?.applied_transition_ref,
      null,
    );
    assert.equal(world.store.pendingDecisions.count(), 1, "no new decision was opened");
  });
});

test("DG21: a dependency that becomes clear while the human waits lets the approval through", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "IN_PROGRESS";
    const authorities = authoritiesFor(world, { taskSource: source });

    submit(world, authorities, gated(world));
    approve(world);

    source.externalStates[DEP] = "CLOSED";
    const result = resolve(authorities);

    assert.equal(result.admitted, true);
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
    assert.equal(
      world.store.pendingDecisions.require(DECISION_ID).body.resolution?.applied_transition_ref,
      `transition:${result.transition_seq}`,
    );
  });
});

test("DG22: an approval cannot bypass a Platform-ACTIVE dependency reported as externally closed", () => {
  withWorld((world) => {
    discover(world);
    const dependencyKey = seedTask(world, { ref: DEP, state: "ACTIVE", snapshot_index: 3 });
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    submit(world, authorities, gated(world));
    approve(world);

    assert.throws(
      () => resolve(authorities),
      (error: unknown) =>
        error instanceof TransitionError && error.detail === "HARD_DEPENDENCY_BLOCKED",
    );
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(world.store.tasks.require(dependencyKey).platform_state, "ACTIVE");
    assert.equal(world.store.batchView.admitted(BATCH_ID), 1, "only the dependency itself");
  });
});

test("DG17: the same operational failure rule applies at Human Gate resolution", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard()];
    source.externalStates[DEP] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    submit(world, authorities, gated(world));
    approve(world);

    const failure = new Error("the source process died");
    source.stateFailure = failure;
    assert.throws(() => resolve(authorities), (error: unknown) => error === failure);

    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(world.store.batchView.admitted(BATCH_ID), 0);
  });
});

// --- the fact is never durable ------------------------------------------------------------------

test("§26: the dependency fact is transition-time only and reaches no durable column", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    source.dependencies = [hard(), soft("S1")];
    source.externalStates[DEP] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    submit(world, authorities, selection({ profile: world.profile }));

    const admitted = world.store.tasks.require(TASK_KEY);
    for (const forbidden of ["hard_dependencies_clear", "dependency_status", "dependency_clear"]) {
      assert.equal(forbidden in admitted, false, `task rows expose ${forbidden}`);
    }
    const journal = JSON.stringify(world.store.decisions.read());
    assert.equal(journal.includes("hard_dependencies_clear"), false);
    assert.equal(journal.includes("depends_on_ref"), false);
    assert.equal(world.store.adapterMetadata.count(), 0);
  });
});

// --- the guard is not reachable without stating the fact -------------------------------------------

test("§14: commitAdmission cannot be called without an explicit dependency fact", () => {
  withWorld((world) => {
    const key = discover(world);
    assert.throws(
      () =>
        commitAdmission(world.store, {
          task_key: key,
          selection: {
            classification: "IMPLEMENTABLE",
            pipeline_id: "standard",
            actor_profile: "implementation",
            verification_profile: "full",
          },
          repository_scope_id: SCOPE_ID,
          selection_binding: BINDING,
          admitted_at: OBSERVED_AT,
          hard_dependencies_clear: false,
        }),
      (error: unknown) =>
        error instanceof TransitionError && error.detail === "HARD_DEPENDENCY_BLOCKED",
    );
    assert.equal(world.store.tasks.require(key).platform_state, "DISCOVERED");
  });
});
