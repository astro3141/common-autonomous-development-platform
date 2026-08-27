/**
 * B5-R1 ~ B5-R11, B5-H1 ~ B5-H4 — explicit reselection out of `HELD(SELECTION_STALE)` and the
 * Human Gate's own initial binding (TD §9.2e, §17.3, §19.3, §19.3a, M1-7).
 *
 * Staleness is not a human decision: the recovery path is a fresh Supervisor `START_TASK`, which
 * is re-validated in full and only reaches a human if the ordinary V7 policy says so.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { activateSelectedTask } from "../core/admission/activate-task.ts";
import { resolveHumanGateAndAdmit, submitProposal } from "../core/admission/submit-proposal.ts";
import { commitDecisionResolution } from "../core/statemachine/transition-commit.ts";
import { TransitionError } from "../core/statemachine/errors.ts";
import { normalizeTaskDefinition } from "../core/tasksource/task-definition.ts";
import type { ContractSourceInput } from "../core/contract/types.ts";
import {
  BATCH_ID,
  discover,
  RUN_ID,
  seedTask,
  TASK_KEY,
  withWorld,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import { selection, task } from "./support/decision-fixtures.ts";
import {
  authoritiesFor,
  DECISION_ID,
  REPORT_CHANNEL,
  StubTaskSource,
  type AdmissionWorld,
} from "./support/admission-fixtures.ts";

const OBSERVED_AT = "2026-08-13T09:00:00Z";
const RESELECTED_AT = "2026-08-13T18:00:00Z";
const RESOLVED_AT = "2026-08-13T20:00:00Z";
const encoder = new TextEncoder();
const sources = (): ContractSourceInput[] => [
  { path: "SPEC.md", bytes: encoder.encode("spec bytes\n") },
];

const submit = (
  world: DomainWorld,
  authorities: AdmissionWorld,
  overrides: Record<string, unknown> = {},
  observed_at = OBSERVED_AT,
) =>
  submitProposal(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    proposal: { ...selection({ profile: world.profile }), ...overrides },
    observed_at,
    decision_id: DECISION_ID,
    report_channel: REPORT_CHANNEL,
  });

/** Drives a task all the way to `HELD(SELECTION_STALE)` through a real activation. */
const stale = (world: DomainWorld): AdmissionWorld => {
  discover(world);
  const authorities = authoritiesFor(world);
  assert.deepEqual(submit(world, authorities).result, { kind: "ACCEPTED" });

  authorities.taskSource.definition = task({ version: "2" });
  const outcome = activateSelectedTask(authorities, {
    task_key: TASK_KEY,
    snapshot_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F01",
    actor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F02",
    auditor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F03",
    contract_sources: sources(),
  });
  assert.equal(outcome.kind, "SELECTION_STALE");
  return authorities;
};

/** The Proposal a Supervisor would write for the world as it is after the drift. */
const freshProposal = (world: DomainWorld, definition = task({ version: "2" })) =>
  selection({ profile: world.profile, definition });

// --- B5-R1 / B5-R2: eligibility ------------------------------------------------------------

test("B5-R1: a fresh START_TASK reselects a SELECTION_STALE task", () => {
  withWorld((world) => {
    const authorities = stale(world);
    const before = world.store.tasks.require(TASK_KEY);
    assert.equal(before.state_reason?.code, "SELECTION_STALE");

    const result = submitProposal(authorities, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      proposal: freshProposal(world),
      observed_at: RESELECTED_AT,
    });

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, true);
    const row = world.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "SELECTED");
    assert.equal(row.state_reason, null, "the hold is cleared");
  });
});

test("B5-R2: another HELD reason is not a reselection escape hatch", () => {
  withWorld((world) => {
    // A task held by a decision, not by staleness.
    const held = seedTask(world, { ref: "T-101", state: "HELD" });
    const authorities = authoritiesFor(world);
    assert.equal(world.store.tasks.require(held).state_reason?.code, "RECOVERY_CONFLICT");

    assert.throws(
      () =>
        submitProposal(authorities, {
          run_id: RUN_ID,
          batch_id: BATCH_ID,
          proposal: selection({ profile: world.profile }),
          observed_at: RESELECTED_AT,
        }),
      TransitionError,
    );
    assert.equal(world.store.tasks.require(held).platform_state, "HELD");
    assert.equal(world.store.tasks.require(held).state_reason?.code, "RECOVERY_CONFLICT");
  });
});

// --- B5-R3 / B5-R4: what reselection does not re-consume -----------------------------------

test("B5-R3 / B5-R4: reselection re-uses its slot and ignores a closed admission", () => {
  withWorld(
    (world) => {
      const authorities = stale(world);
      // max_tasks = 1, so admission closed the moment this task was admitted.
      assert.equal(world.store.batches.require(BATCH_ID).admission_closed, true);
      assert.equal(world.store.batchView.admitted(BATCH_ID), 1);

      const result = submitProposal(authorities, {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        proposal: freshProposal(world),
        observed_at: RESELECTED_AT,
      });

      assert.deepEqual(result.result, { kind: "ACCEPTED" }, "B5-R3: max_tasks not re-consumed");
      assert.equal(result.admitted, true, "B5-R4: admission_closed is not a reselection barrier");
      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
    },
    { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 2 } },
  );
});

test("B5-R3: an initial admission still fails closed once max_tasks is reached", () => {
  withWorld(
    (world) => {
      const authorities = stale(world);
      const other = discover(world, "T-202");
      authorities.taskSource.definition = task({ task_ref: "T-202" });

      const result = submitProposal(authorities, {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        proposal: selection({ profile: world.profile, definition: task({ task_ref: "T-202" }) }),
        observed_at: RESELECTED_AT,
      });

      assert.deepEqual(result.result, {
        kind: "POLICY_REJECTED",
        reason_code: "BATCH_MAX_TASKS_REACHED",
      });
      assert.equal(world.store.tasks.require(other).platform_state, "DISCOVERED");
    },
    { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 2 } },
  );
});

// --- B5-R5 ~ B5-R7: what reselection does re-check -----------------------------------------

test("B5-R5 / B5-R6: concurrency and the writable slot are re-checked", () => {
  withWorld(
    (world) => {
      const authorities = stale(world);
      // Another task is already ACTIVE with a live writable attempt.
      seedTask(world, {
        ref: "T-900",
        state: "ACTIVE",
        attempt_state: "IMPLEMENTING",
        snapshot_index: 4,
      });

      const result = submitProposal(authorities, {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        proposal: freshProposal(world),
        observed_at: RESELECTED_AT,
      });

      assert.equal(result.result.kind, "POLICY_REJECTED");
      if (result.result.kind === "POLICY_REJECTED") {
        assert.equal(
          ["CONCURRENCY_LIMIT_REACHED", "WRITABLE_CONCURRENCY_CONFLICT"].includes(
            result.result.reason_code,
          ),
          true,
        );
      }
      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    },
    { batch_policy: { max_tasks: 4, max_rework: 2, concurrency: 1 } },
  );
});

test("B5-R7: the direct HARD dependency guard is re-evaluated on reselection", () => {
  withWorld((world) => {
    const authorities = stale(world);
    authorities.taskSource.dependencies = [
      { task_ref: "T-101", depends_on_ref: "T-100", kind: "HARD" },
    ];
    authorities.taskSource.externalStates["T-100"] = "IN_PROGRESS";

    assert.throws(
      () =>
        submitProposal(authorities, {
          run_id: RUN_ID,
          batch_id: BATCH_ID,
          proposal: freshProposal(world),
          observed_at: RESELECTED_AT,
        }),
      (error: unknown) =>
        error instanceof TransitionError && error.detail === "HARD_DEPENDENCY_BLOCKED",
    );
    assert.equal(world.store.tasks.require(TASK_KEY).state_reason?.code, "SELECTION_STALE");

    // Once the prerequisite closes, the same reselection succeeds.
    authorities.taskSource.externalStates["T-100"] = "CLOSED";
    const result = submitProposal(authorities, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      proposal: freshProposal(world),
      observed_at: RESELECTED_AT,
    });
    assert.equal(result.admitted, true);
  });
});

// --- B5-R8 ~ B5-R11: what reselection writes -----------------------------------------------

test("B5-R8 ~ B5-R11: selection fields and the binding are replaced atomically", () => {
  withWorld((world) => {
    const authorities = stale(world);
    const before = world.store.tasks.require(TASK_KEY);
    const admittedBefore = world.store.batchView.admitted(BATCH_ID);

    const drifted = task({ version: "2" });
    authorities.repository.head = "head-canonical-2";
    const result = submitProposal(authorities, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      proposal: {
        ...selection({ profile: world.profile, definition: drifted, base_head: "head-canonical-2" }),
        repository_scope_id: "docs_only",
        pipeline_id: "review_only",
      },
      observed_at: RESELECTED_AT,
    });

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    const after = world.store.tasks.require(TASK_KEY);

    // B5-R10 / B5-R11 — every selection field and the binding are the new validated values.
    assert.equal(after.classification, "IMPLEMENTABLE");
    assert.equal(after.pipeline_id, "review_only");
    assert.notEqual(after.pipeline_id, before.pipeline_id);
    assert.equal(after.repository_scope_id, "docs_only");
    assert.deepEqual(after.selection_binding, {
      task_version: drifted.version,
      task_definition_hash: drifted.definition_hash,
      base_head: "head-canonical-2",
    });
    assert.notDeepEqual(after.selection_binding, before.selection_binding);

    // B5-R8 / B5-R9 — the admission marker and the batch counts are untouched.
    assert.equal(after.admitted_at, before.admitted_at);
    assert.equal(world.store.batchView.admitted(BATCH_ID), admittedBefore);
    assert.equal(
      world.store.batches.require(BATCH_ID).admission_closed,
      false,
      "a reselection never closes admission",
    );
  });
});

test("B5-R8: repeated reselection never consumes another admission slot", () => {
  withWorld((world) => {
    const authorities = stale(world);
    const admittedAt = world.store.tasks.require(TASK_KEY).admitted_at;

    for (let round = 0; round < 3; round += 1) {
      const version = `${round + 2}`;
      authorities.taskSource.definition = task({ version });
      const accepted = submitProposal(authorities, {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        proposal: selection({ profile: world.profile, definition: task({ version }) }),
        observed_at: RESELECTED_AT,
      });
      assert.equal(accepted.admitted, true);

      // Drift again to return to the stale hold.
      authorities.taskSource.definition = task({ version: `${round + 3}` });
      activateSelectedTask(authorities, {
        task_key: TASK_KEY,
        snapshot_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F01",
        actor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F02",
        auditor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F03",
        contract_sources: sources(),
      });
    }

    assert.equal(world.store.batchView.admitted(BATCH_ID), 1);
    assert.equal(world.store.tasks.require(TASK_KEY).admitted_at, admittedAt);
  });
});

// --- B5-H: the Human Gate's own binding ----------------------------------------------------

test("B5-H1 ~ B5-H4: a gated admission binds resolution-time authoritative facts", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);

    const gated = submit(world, authorities, { classification: "LARGE_SCOPE" });
    assert.deepEqual(gated.result, { kind: "HUMAN_GATE_REQUIRED" });
    assert.equal(world.store.tasks.require(TASK_KEY).selection_binding, null, "B5-H4");

    commitDecisionResolution(world.store, DECISION_ID, {
      kind: "OPTION",
      chosen_option: "APPROVE",
      free_form: null,
      resolved_by: "operator-1",
      resolved_at: RESOLVED_AT,
      approval_binding: null,
      applied_transition_ref: null,
    });

    // B5-H1 / B5-H2 — the authorities are read again at resolution time.
    const readsBefore = authorities.taskSource.calls.length;
    const repositoryBefore = authorities.repository.calls.length;
    const resolved = resolveHumanGateAndAdmit(authorities, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      decision_id: DECISION_ID,
      observed_at: RESOLVED_AT,
    });

    assert.deepEqual(resolved.result, { kind: "ACCEPTED" });
    assert.equal(authorities.taskSource.calls.length > readsBefore, true, "B5-H1");
    assert.equal(authorities.repository.calls.length > repositoryBefore, true, "B5-H2");

    // B5-H3 — the binding is those resolution-time facts.
    const row = world.store.tasks.require(TASK_KEY);
    assert.deepEqual(row.selection_binding, {
      task_version: task().version,
      task_definition_hash: task().definition_hash,
      base_head: authorities.repository.head,
    });
    assert.equal(row.repository_scope_id, "collector");
    assert.equal(row.admitted_at, RESOLVED_AT);
  });
});

test("B5-H4 / §33: a reselection Proposal reaches a human only through the ordinary V7", () => {
  withWorld((world) => {
    const authorities = stale(world);
    assert.equal(world.store.pendingDecisions.count(), 0, "staleness alone opens no decision");
    assert.equal(world.store.outbox.count(), 0);

    // The fresh Proposal picks a gated classification, so V7 — not staleness — gates it.
    authorities.taskSource.definition = normalizeTaskDefinition({
      task_ref: "T-101",
      version: "2",
      body: task().body,
    });
    const result = submit(
      world,
      authorities,
      { ...selection({ profile: world.profile, definition: task({ version: "2" }) }), classification: "LARGE_SCOPE" },
      RESELECTED_AT,
    );

    assert.deepEqual(result.result, { kind: "HUMAN_GATE_REQUIRED" });
    const stored = world.store.pendingDecisions.require(DECISION_ID);
    assert.equal(stored.body.category, "HUMAN_GATE_APPROVAL");
    // The task moves to the decision hold; the stale binding is still the old one.
    const row = world.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "HELD");
    assert.equal(row.state_reason?.code?.startsWith("BLOCKED_BY_DECISION"), true);
  });
});
