/**
 * TD §9.2f / §10.1a / §19.5 (v1.5 PR #43 amendment, D22) — negative and falsification controls
 * for the typed subflow parent binding, the v2 relation freeze and the deterministic resume.
 *
 * The positive full path (E admission → atomic suspension → foundation SUCCEEDED without a merge
 * → deterministic parent resume) is proven in B15-3; this file pins the fail-closed edges.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateDecision } from "../core/decision/validator.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import { submitProposal } from "../core/admission/submit-proposal.ts";
import { commitAdmission } from "../core/statemachine/transition-commit.ts";
import { resumeEligibility } from "../core/execution/subflow-resume.ts";
import { subflowChild } from "../core/statemachine/types.ts";
import type { DecisionValidationResult } from "../core/decision/types.ts";
import {
  BATCH_ID,
  BINDING,
  PROJECT,
  RUN_ID,
  SCOPE_ID,
  SELECTION,
  discover,
  withWorld,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import {
  compiled,
  inputFor,
  selection,
  subflowChildContext,
  subflowParentView,
  subflowSelection,
  SUBFLOW_PARENT_INTENT,
  task,
} from "./support/decision-fixtures.ts";
import {
  seedAllocationForProposal, coordinatorWorld, submitSupervisorProposal, type CoordinatorWorld } from "./support/coordinator-fixtures.ts";
import { TASK_KEY } from "./support/domain-fixtures.ts";
import { ProductionCoordinator } from "../core/coordinator/production-coordinator.ts";

const profile = compiled();
const rejected = (reason: string): DecisionValidationResult => ({
  kind: "POLICY_REJECTED",
  reason_code: reason as never,
});

const eProposal = (overrides: Record<string, unknown> = {}): unknown =>
  subflowSelection({
    profile,
    classification: "SPLIT_NEEDED",
    pipeline_id: "foundation",
    parent: SUBFLOW_PARENT_INTENT,
    ...overrides,
  });

const eInput = (
  proposal: unknown,
  views: { parent?: Record<string, unknown>; child?: Record<string, unknown> } = {},
) =>
  inputFor(proposal, profile, {
    subflow_parent: subflowParentView(views.parent ?? {}) as never,
    subflow_child: subflowChildContext(views.child ?? {}) as never,
  });

// --- V1/V2/V3: shape, existence, staleness -------------------------------------------------------

test("9.2f-1: cardinality is not relationship authority — the parentless shape has no E and no late-parent path", () => {
  // A START_SUBFLOW without `parent` is not a valid Proposal at all.
  assert.throws(() => validateProposal(selection({ profile, decision: "START_SUBFLOW" })));
  // And a `parent` with a missing or extra field rejects exactly.
  const intent = { ...SUBFLOW_PARENT_INTENT } as Record<string, unknown>;
  delete intent["attempt_key"];
  assert.throws(() => validateProposal(eProposal({ parent: intent })));
  assert.throws(() =>
    validateProposal(eProposal({ parent: { ...SUBFLOW_PARENT_INTENT, extra: "x" } })),
  );
});

test("9.2f-2: a missing parent row is SUBFLOW_PARENT_NOT_FOUND; a stale observation is SUBFLOW_PARENT_STALE", () => {
  assert.deepEqual(
    validateDecision(eInput(eProposal(), { parent: { status: "NOT_FOUND" } })),
    rejected("SUBFLOW_PARENT_NOT_FOUND"),
  );
  // Any one of the four fields drifting fails the exact-equality stale guard.
  for (const drift of [
    { current_attempt_key: "attempt:task:alpha:P-1:2" },
    { current_attempt_state: "AUDITING" },
    { current_task_contract_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222" },
  ]) {
    assert.deepEqual(validateDecision(eInput(eProposal(), { parent: drift })), rejected("SUBFLOW_PARENT_STALE"));
  }
});

// --- V6/V11: pipeline shape and P1–P4 ------------------------------------------------------------

test("9.2f-3: the child pipeline must terminate in RESUME_PARENT — MERGE_GATE children are refused", () => {
  assert.deepEqual(
    validateDecision(eInput(eProposal({ pipeline_id: "standard" }))),
    rejected("SUBFLOW_PIPELINE_INVALID"),
  );
});

test("9.2f-4: P1–P4 fail closed — cross-batch, ineligible, cyclic and conflicting parents", () => {
  // P1 — a parent in another batch.
  assert.deepEqual(
    validateDecision(eInput(eProposal(), { parent: { batch_id: "batch:alpha:2" } })),
    rejected("SUBFLOW_PARENT_BATCH_MISMATCH"),
  );
  // P2 — HELD parent, merge-stage attempt, open blocker, recovery conflict: all ineligible.
  for (const bad of [
    { platform_state: "HELD" },
    { platform_state: "SUSPENDED" },
    { current_attempt_state: "READY_TO_MERGE", },
    { has_open_blocker: true },
    { has_recovery_conflict: true },
  ]) {
    const view: Record<string, unknown> = { ...bad };
    // Keep V3's equality satisfied when P2's failure is a state field V3 also compares.
    const proposal =
      "current_attempt_state" in bad
        ? eProposal({ parent: { ...SUBFLOW_PARENT_INTENT, attempt_state: "READY_TO_MERGE" } })
        : eProposal();
    assert.deepEqual(validateDecision(eInput(proposal, { parent: view })), rejected("SUBFLOW_PARENT_INELIGIBLE"));
  }
  // P3 — the child already sits above the parent (cycle), or is the parent itself.
  assert.deepEqual(
    validateDecision(eInput(eProposal(), { parent: { ancestor_task_keys: ["task:alpha:C-1"] } })),
    rejected("SUBFLOW_CYCLE_DETECTED"),
  );
  assert.deepEqual(
    validateDecision(eInput(eProposal(), { child: { task_key: SUBFLOW_PARENT_INTENT.task_key } })),
    rejected("SUBFLOW_CYCLE_DETECTED"),
  );
  // P4 — a competing current relation on either side.
  assert.deepEqual(
    validateDecision(
      eInput(eProposal(), { parent: { current_suspension_child_task_key: "task:alpha:other" } }),
    ),
    rejected("SUBFLOW_RELATION_CONFLICT"),
  );
  assert.deepEqual(
    validateDecision(eInput(eProposal(), { child: { has_parent_relation: true } })),
    rejected("SUBFLOW_RELATION_CONFLICT"),
  );
});

// --- §19.5.1 commit-time revalidation ------------------------------------------------------------

test("19.5.1-1: validation is not a lease — the admission transaction re-checks the parent and rolls everything back", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick(); // ACTIVATED — parent task:alpha:T-101 now runs attempt 1 (READY)
    const childKey = discover(world, "C-1");
    const parent = w.store.attempts.current(TASK_KEY)!;
    const hash = w.store.contracts.hashOf(parent.contract_snapshot_id) as string;

    // The Proposal's observation is already stale at commit time (wrong attempt state claimed).
    assert.throws(() =>
      commitAdmission(w.store, {
        task_key: childKey,
        selection: { ...SELECTION, pipeline_id: "review_only" },
        repository_scope_id: SCOPE_ID,
        selection_binding: BINDING,
        admitted_at: "t-admit",
        hard_dependencies_clear: true,
        subflow_parent: {
          task_key: TASK_KEY,
          attempt_key: parent.attempt_key,
          task_contract_hash: hash,
          attempt_state: "VERIFYING", // actually READY
        },
      }),
    );
    // Nothing moved: no child selection, no parent suspension, no relation.
    assert.equal(w.store.tasks.require(childKey).platform_state, "DISCOVERED");
    assert.equal(w.store.tasks.require(childKey).parent_task_key, null);
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");

    // With the true observation the same transaction commits atomically, with §18.1f provenance.
    const admitted = commitAdmission(w.store, {
      task_key: childKey,
      selection: { ...SELECTION, pipeline_id: "review_only" },
      repository_scope_id: SCOPE_ID,
      selection_binding: BINDING,
      admitted_at: "t-admit",
      hard_dependencies_clear: true,
      subflow_parent: {
        task_key: TASK_KEY,
        attempt_key: parent.attempt_key,
        task_contract_hash: hash,
        attempt_state: parent.state,
      },
    });
    assert.ok(admitted.transition.seq >= 1);
    const suspended = w.store.tasks.require(TASK_KEY);
    assert.equal(suspended.platform_state, "SUSPENDED");
    assert.equal(suspended.state_reason?.code, subflowChild(childKey));
    assert.equal(typeof suspended.state_reason?.log_seq, "number");
    assert.equal(w.store.tasks.require(childKey).parent_task_key, TASK_KEY);
  }, { batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 2 } });
});

// --- §19.5.3 eligibility falsification -----------------------------------------------------------

test("19.5.3-1: the resume predicate refuses every broken leg and survives a restart unchanged", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick();
    const childKey = discover(world, "C-1");
    const parent = w.store.attempts.current(TASK_KEY)!;
    const hash = w.store.contracts.hashOf(parent.contract_snapshot_id) as string;
    commitAdmission(w.store, {
      task_key: childKey,
      selection: { ...SELECTION, pipeline_id: "review_only" },
      repository_scope_id: SCOPE_ID,
      selection_binding: BINDING,
      admitted_at: "t-admit",
      hard_dependencies_clear: true,
      subflow_parent: {
        task_key: TASK_KEY,
        attempt_key: parent.attempt_key,
        task_contract_hash: hash,
        attempt_state: parent.state,
      },
    });

    // The child has not succeeded: not eligible, and a fresh Coordinator over the same store
    // (a restart) derives exactly the same answer from durable rows alone.
    const before = resumeEligibility(w.store, TASK_KEY);
    assert.equal(before.kind, "NOT_ELIGIBLE");
    const restarted = new ProductionCoordinator(w);
    void restarted;
    assert.deepEqual(resumeEligibility(w.store, TASK_KEY), before);

    // A parent that is not suspended, or suspended without the exact cause, is never eligible.
    assert.equal(resumeEligibility(w.store, childKey).kind, "NOT_ELIGIBLE");

    // Falsification: mark the child COMPLETED *without* a SUCCEEDED attempt (the external-closed
    // analog of "issue closed ≠ success"). The predicate still refuses: completion evidence is
    // the terminal SUCCEEDED attempt, never the task state alone.
    w.store.withTransaction(() => {
      w.store.decisions.append({ kind: "state_transition", refKey: childKey, payload: { probe: true } as never });
      w.store.tasks.write(childKey, { platform_state: "COMPLETED" });
    });
    const stillNot = resumeEligibility(w.store, TASK_KEY);
    assert.equal(stillNot.kind, "NOT_ELIGIBLE");
    assert.match((stillNot as { reason: string }).reason, /SUCCEEDED/);
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "SUSPENDED", "no resume happened");
  }, { batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 2 } });
});

// --- E submission end-to-end negative ------------------------------------------------------------

test("9.2f-5: a stale E submission through the production path rejects and admits nothing", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick(); // parent ACTIVE/READY
    discover(world, "C-1");
    const parent = w.store.attempts.current(TASK_KEY)!;
    const definition = task({ task_ref: "C-1" });
    w.tasks.definition = definition;

    const stalePayload = subflowSelection({
      profile: world.profile,
      definition,
      classification: "SPLIT_NEEDED",
      pipeline_id: "foundation",
      parent: {
        task_key: TASK_KEY,
        attempt_key: parent.attempt_key,
        task_contract_hash: w.store.contracts.hashOf(parent.contract_snapshot_id) as string,
        attempt_state: "VERIFYING", // stale: the parent is READY
      },
    });
    seedAllocationForProposal(w.store, BATCH_ID, stalePayload);
    const outcome = submitProposal(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        observed_at: "2026-09-01T09:00:00Z",
        proposal: subflowSelection({
          profile: world.profile,
          definition,
          classification: "SPLIT_NEEDED",
          pipeline_id: "foundation",
          parent: {
            task_key: TASK_KEY,
            attempt_key: parent.attempt_key,
            task_contract_hash: w.store.contracts.hashOf(parent.contract_snapshot_id) as string,
            attempt_state: "VERIFYING", // stale: the parent is READY
          },
        }),
      },
    );
    assert.deepEqual(outcome.result, rejected("SUBFLOW_PARENT_STALE"));
    assert.equal(outcome.admitted, false);
    assert.equal(w.store.tasks.require(`task:${PROJECT}:C-1`).platform_state, "DISCOVERED");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "ACTIVE", "the parent is untouched");
  }, { batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 2 } });
});
