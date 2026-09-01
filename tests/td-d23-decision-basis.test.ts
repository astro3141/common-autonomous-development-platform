/**
 * TD §9.1/§9.2/§13.4 D23 (#60 → #66) — SupervisorDecisionContextV1 exact projection and
 * Platform-assigned `proposal_id` active-turn binding.
 *
 * The nine #66 negative controls are pinned here, in order. Throughout: the context is Model
 * input, never a second authority — V3/V8 are shown to re-observe fresh authoritative facts
 * after the turn, and nothing repairs or completes a Proposal after model output.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TaskSourceError } from "../core/tasksource/errors.ts";
import { validateDecision } from "../core/decision/validator.ts";
import { activeSupervisorProposalAllocation } from "../core/decision/decision-log.ts";
import { resolveHumanGateAndAdmit, submitProposal } from "../core/admission/submit-proposal.ts";
import type { SupervisorDecisionContextV1 } from "../core/execution/supervisor-decision-context.ts";
import { BATCH_ID, discover, RUN_ID, TASK_KEY, TASK_REF, withWorld } from "./support/domain-fixtures.ts";
import {
  compiled,
  inputFor,
  selection,
  task,
  HEAD,
  PROPOSAL_ID,
} from "./support/decision-fixtures.ts";
import {
  activeProposalId,
  coordinatorWorld,
  seedProposalAllocation,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";

const SINGLE = { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } };
const OTHER_ULID = "01JQ8ZK5T7RC9V2W4X6Y8Z0XYZ";

type World = Parameters<Parameters<typeof withWorld>[0]>[0];

function submit(w: CoordinatorWorld, world: World, proposal: unknown) {
  return submitProposal(
    { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
    { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T09:00:00Z", proposal },
  );
}

/** The instruction-embedded context of the latest requested Supervisor turn. */
function sentContext(w: CoordinatorWorld): SupervisorDecisionContextV1 {
  const call = w.runtime.sendCalls.at(-1);
  assert.notEqual(call, undefined, "a Supervisor turn was sent");
  const line = call!.instruction.split("\n").find((part) => part.startsWith("{"));
  return JSON.parse(line as string) as SupervisorDecisionContextV1;
}

// --- the exact context and the pre-turn allocation -----------------------------------------------

test("D23-0: a Supervisor turn carries the exact SupervisorDecisionContextV1 from authoritative reads", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");

    const context = sentContext(w);
    assert.equal(context.run_id, RUN_ID);
    assert.equal(context.batch_id, BATCH_ID);

    // The allocation is durable, pre-turn, and exactly what the context carries.
    const allocation = activeSupervisorProposalAllocation(w.store.decisions, BATCH_ID);
    assert.notEqual(allocation, undefined, "the allocation is journaled with the turn INTENT");
    assert.equal(context.proposal_id, allocation?.proposal_id);

    // The five declared-choice maps come from the batch-bound immutable profile.
    const effective = w.store.batchView.compiledProfileFor(BATCH_ID).effective;
    assert.equal(context.compiled_profile.hash, w.store.batches.require(BATCH_ID).compiled_profile_hash);
    assert.deepEqual(
      Object.keys(context.compiled_profile.pipelines).sort(),
      Object.keys(effective.project.pipelines).sort(),
    );
    assert.deepEqual(
      Object.keys(context.compiled_profile.classifications).sort(),
      Object.keys(effective.policy.classification_policy).sort(),
    );

    // One coherent fresh TaskSource basis per candidate ref.
    const candidate = context.candidates.find((row) => row.task_ref === TASK_REF);
    assert.notEqual(candidate, undefined);
    assert.equal(candidate?.task_definition.task_ref, TASK_REF);
    assert.equal(typeof candidate?.task_definition.definition_hash, "string");

    // Fresh repository head and the durable current-state projection.
    assert.equal(context.repository.canonical_head, w.repository.head);
    assert.equal(context.current_state.batch.admission_closed, false);
    assert.equal(
      context.current_state.tasks.some((row) => row.task_key === TASK_KEY),
      true,
    );
  }, SINGLE);
});

// --- control 1: valid ULID but not the active turn id --------------------------------------------

test("D23-1: a valid ULID that is not the active turn's allocation is PROPOSAL_SCHEMA_INVALID", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    const active = activeProposalId(w.store, BATCH_ID);
    assert.notEqual(active, undefined);
    assert.notEqual(active, OTHER_ULID);

    const wrong = submit(w, world, { ...selection({ profile: world.profile }), proposal_id: OTHER_ULID });
    assert.deepEqual(wrong.result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
    assert.equal(wrong.admitted, false);
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");

    // One turn ↔ one Proposal: the wrong-id submission was this turn's one structured
    // validation, so even the originally allocated id is closed now (review finding 1).
    const late = submit(w, world, { ...selection({ profile: world.profile }), proposal_id: active });
    assert.deepEqual(late.result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });

    // A fresh allocation (new turn) accepts the exact id; non-ULID grammar stays rejected.
    seedProposalAllocation(w.store, BATCH_ID, active!);
    const garbage = submit(w, world, { ...selection({ profile: world.profile }), proposal_id: "not-a-ulid" });
    assert.deepEqual(garbage.result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
    seedProposalAllocation(w.store, BATCH_ID, active!);
    const exact = submit(w, world, { ...selection({ profile: world.profile }), proposal_id: active });
    assert.deepEqual(exact.result, { kind: "ACCEPTED" });
    assert.equal(exact.admitted, true);
  }, SINGLE);
});

// --- review finding 1 regression: an answered turn's allocation is never reusable ----------------

test("D23-R1: an answered allocation admits at most once — sequential, restart and gate paths", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    discover(world, "T-2");
    w.tasks.definitions.set("T-2", task({ task_ref: "T-2" }));
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    const active = activeProposalId(w.store, BATCH_ID)!;

    // First ordinary submission consumes the turn and admits.
    const first = submit(w, world, { ...selection({ profile: world.profile }), proposal_id: active });
    assert.deepEqual(first.result, { kind: "ACCEPTED" });
    assert.equal(first.admitted, true);

    // A second distinct Proposal replaying the same id rejects with zero effect.
    const second = submit(w, world, {
      ...selection({ profile: world.profile, definition: task({ task_ref: "T-2" }) }),
      proposal_id: active,
    });
    assert.deepEqual(second.result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
    assert.equal(second.admitted, false);
    assert.equal(w.store.tasks.require(`task:alpha:T-2`).platform_state, "DISCOVERED");

    // Restart replay: consumption is durable, so a rebuilt caller sees no active identity.
    assert.equal(activeProposalId(w.store, BATCH_ID), undefined);
    const replayed = submit(w, world, {
      ...selection({ profile: world.profile, definition: task({ task_ref: "T-2" }) }),
      proposal_id: active,
    });
    assert.deepEqual(replayed.result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
  }, { batch_policy: { max_tasks: 3, max_rework: 2, concurrency: 2 } });
});

test("D23-1a: with no active turn allocation at all, every Proposal is rejected at /proposal_id", () => {
  const profile = compiled();
  const result = validateDecision({
    ...inputFor(selection({ profile }), profile),
    proposal_identity: undefined,
  });
  assert.deepEqual(result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
});

// --- controls 2/3/4: V3/V8 re-observe fresh authority, never the context echo --------------------

test("D23-2/3/4: freshness echoes are revalidated against newly observed authority, not the turn context", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    const context = sentContext(w);
    const active = context.proposal_id;

    // The Supervisor echoes exactly what the turn basis showed…
    const echoed = {
      ...selection({ profile: world.profile }),
      proposal_id: active,
      expected: {
        task_version: context.candidates[0]!.task_definition.version,
        task_definition_hash: context.candidates[0]!.task_definition.definition_hash,
        base_head: context.repository.canonical_head,
        compiled_profile_hash: context.compiled_profile.hash,
      },
    };

    // …but the world moves after the turn. Each rejected submission answers its turn, so a new
    // allocation is seeded per attempt (the platform-caller side of "POLICY_REJECTED → re-ask").
    // 2: the task version drifts → TASK_DRIFT.
    w.tasks.definitions.set(TASK_REF, task({ task_ref: TASK_REF, version: "2" }));
    const drifted = submit(w, world, echoed);
    assert.deepEqual(drifted.result, { kind: "POLICY_REJECTED", reason_code: "TASK_DRIFT" });
    w.tasks.definitions.delete(TASK_REF);

    // 4: canonical moves after the turn → REPOSITORY_STATE_MISMATCH from the fresh head.
    const originalHead = w.repository.head;
    w.repository.head = "1111111111111111111111111111111111111111";
    seedProposalAllocation(w.store, BATCH_ID, active);
    const moved = submit(w, world, echoed);
    assert.deepEqual(moved.result, { kind: "POLICY_REJECTED", reason_code: "REPOSITORY_STATE_MISMATCH" });
    w.repository.head = originalHead;

    // 3: a wrong compiled-profile echo → PROFILE_DRIFT.
    const wrongProfile = {
      ...echoed,
      expected: { ...echoed.expected, compiled_profile_hash: "sha256:" + "0".repeat(64) },
    };
    seedProposalAllocation(w.store, BATCH_ID, active);
    assert.deepEqual(submit(w, world, wrongProfile).result, {
      kind: "POLICY_REJECTED",
      reason_code: "PROFILE_DRIFT",
    });
  }, SINGLE);
});

// --- control 5: undeclared semantic selections are rejected, never repaired ----------------------

test("D23-5/8: undeclared or missing semantic selections are rejected as-is — no post-output completion", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    const active = activeProposalId(w.store, BATCH_ID)!;

    // 5 — an undeclared selection fails the existing membership/reference steps. Each rejected
    // submission answers its turn; the fixture opens a fresh allocation per attempt.
    assert.deepEqual(
      submit(w, world, {
        ...selection({ profile: world.profile }),
        proposal_id: active,
        classification: "NOT_DECLARED",
      }).result,
      { kind: "POLICY_REJECTED", reason_code: "CLASSIFICATION_UNKNOWN" },
    );
    seedProposalAllocation(w.store, BATCH_ID, active);
    assert.deepEqual(
      submit(w, world, {
        ...selection({ profile: world.profile }),
        proposal_id: active,
        pipeline_id: "not-a-pipeline",
      }).result,
      { kind: "POLICY_REJECTED", reason_code: "PROFILE_REFERENCE_UNKNOWN" },
    );

    // 8 — a Proposal missing a Supervisor-selected field is schema-invalid; nothing fills a
    // "declared default" after model output and nothing durable moves.
    seedProposalAllocation(w.store, BATCH_ID, active);
    const missing = { ...selection({ profile: world.profile }), proposal_id: active } as Record<string, unknown>;
    delete missing["actor_profile"];
    const rejected = submit(w, world, missing);
    assert.deepEqual(rejected.result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
    assert.equal(rejected.admitted, false);
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");

    // A missing freshness echo is equally unrepaired.
    seedProposalAllocation(w.store, BATCH_ID, active);
    const noExpected = { ...selection({ profile: world.profile }), proposal_id: active } as Record<string, unknown>;
    delete (noExpected["expected"] as Record<string, unknown>)["base_head"];
    assert.deepEqual(submit(w, world, noExpected).result, {
      kind: "POLICY_REJECTED",
      reason_code: "PROPOSAL_SCHEMA_INVALID",
    });
  }, SINGLE);
});

// --- controls 6/7: assembly failure prevents the Runtime turn ------------------------------------

test("D23-6: an unavailable TaskSource read prevents the Supervisor turn — zero Runtime effect", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tasks.failure = new TaskSourceError("TASK_SOURCE_UNAVAILABLE" as never, "/x", "source down");

    assert.equal(w.tick(), "BLOCKED", "assembly failed before any Runtime call");
    assert.equal(w.runtime.sendCalls.length, 0, "no Supervisor turn was sent");
    assert.equal(w.runtime.sessionCount, 0, "no session was spawned");
    assert.equal(
      activeSupervisorProposalAllocation(w.store.decisions, BATCH_ID),
      undefined,
      "no allocation was journaled for a turn that never happened",
    );
  }, SINGLE);
});

test("D23-7: an identity-mismatched candidate assembly prevents the turn — no partial context", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    // The source answers the fixture ref with a definition for a different task.
    w.tasks.definitions.set(TASK_REF, task({ task_ref: "T-999" }));

    assert.equal(w.tick(), "BLOCKED");
    assert.equal(w.runtime.sendCalls.length, 0, "no truncated or repaired context was sent");
  }, SINGLE);
});

// --- control 9: gate revalidation reuses the bound id --------------------------------------------

test("D23-9: Human-Gate revalidation reuses the bound proposal id and cannot substitute a new one", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    const active = activeProposalId(w.store, BATCH_ID)!;

    // LARGE_SCOPE is HOLD_HUMAN in the fixture profile → the gate opens for this exact Proposal.
    const gated = submitProposal(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        observed_at: "2026-09-01T09:00:00Z",
        proposal: { ...selection({ profile: world.profile, classification: "LARGE_SCOPE" }), proposal_id: active },
        decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0GD1",
        report_channel: "operations",
      },
    );
    assert.deepEqual(gated.result, { kind: "HUMAN_GATE_REQUIRED" });
    const decision_id = gated.pending_decision_id as string;

    w.store.withTransaction(() => {
      w.store.pendingDecisions.resolve(decision_id, {
        kind: "OPTION",
        chosen_option: "APPROVE",
        free_form: null,
        resolved_by: "operator@example",
        resolved_at: "2026-09-01T10:00:00.000Z",
        approval_binding: null,
        applied_transition_ref: null,
      });
    });

    // A NEWER active allocation exists by the time the approval is applied. The revalidation
    // still binds to the exact gate Proposal's id — it neither allocates a new id nor demands
    // the newer one; every other step still runs against fresh authority.
    seedProposalAllocation(w.store, BATCH_ID, OTHER_ULID);
    const applied = resolveHumanGateAndAdmit(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      { run_id: RUN_ID, batch_id: BATCH_ID, decision_id, observed_at: "2026-09-01T10:01:00Z" },
    );
    assert.deepEqual(applied.result, { kind: "ACCEPTED" });
    assert.equal(applied.admitted, true);
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
    void PROPOSAL_ID;
    void HEAD;
    void discover;
  }, SINGLE);
});

// --- review 5493739663 R1 regression: malformed output also answers the turn ---------------------

test("D23-R1b: structurally malformed ordinary output consumes the active allocation at first outcome", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");

    // Each malformed shape is one turn's whole answer: the validation row closes the allocation,
    // so the originally allocated id is dead immediately afterwards — replay has zero effect.
    const malformed: readonly unknown[] = [
      {},
      { ...selection({ profile: world.profile }), proposal_id: undefined },
      { ...selection({ profile: world.profile }), proposal_id: "not-a-ulid" },
      { ...selection({ profile: world.profile }), smuggled_field: true },
    ];
    for (const shape of malformed) {
      const active = activeProposalId(w.store, BATCH_ID) ?? seedNext(w);
      const refused = submit(w, world, shape);
      assert.deepEqual(
        refused.result,
        { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" },
        JSON.stringify(shape),
      );
      assert.equal(refused.admitted, false);
      assert.equal(activeProposalId(w.store, BATCH_ID), undefined, "the allocation is closed");
      const replay = submit(w, world, { ...selection({ profile: world.profile }), proposal_id: active });
      assert.deepEqual(replay.result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
      assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED", "zero effect");
    }

    // A fresh turn's allocation still admits normally — nothing was leaked or double-consumed.
    const fresh = seedNext(w);
    const exact = submit(w, world, { ...selection({ profile: world.profile }), proposal_id: fresh });
    assert.deepEqual(exact.result, { kind: "ACCEPTED" });
    assert.equal(exact.admitted, true);
  }, SINGLE);
});

/** Seeds a new turn allocation with a fresh ULID and returns it (the test-side platform caller). */
function seedNext(w: CoordinatorWorld): string {
  const id = `01JQ8ZK5T7RC9V2W4X6Y8Z0R${String(seedNext.n++).padStart(2, "0")}`;
  seedProposalAllocation(w.store, BATCH_ID, id);
  return id;
}
seedNext.n = 10;
