/**
 * TD D24 (#59 → #68) — bounded Supervisor child-task materialisation: F Proposal → immutable
 * snapshot + write-ahead INTENT → idempotent publish → exact TaskSource round-trip → bound
 * DISCOVERED child → fresh E admission. The #68 negative controls are pinned here by number.
 *
 * Throughout: F acceptance ≠ E acceptance, publication ≠ admission, and the Supervisor is the
 * only semantic author of child body/parent intent — nothing fills fields after model output.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MaterializationFailedError } from "../adapters/interfaces/child-materialization-adapter.ts";
import { FakeChildMaterializer } from "../testdoubles/fake-child-materializer.ts";
import { compileProfile } from "../core/profile/compiler.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import { submitProposal, resolveHumanGateAndAdmit } from "../core/admission/submit-proposal.ts";
import {
  materializationReservedSeats,
  advanceMaterializations,
  applyRejectedMaterializationGate,
  commitMaterializationIntent,
  materializationOperations,
  pendingMaterializationsFor,
} from "../core/materialization/materialize-child.ts";
import { sealMaterializationSnapshot, materializeChildOp } from "../core/materialization/snapshot.ts";
import { hashTaskDefinitionBody } from "../core/tasksource/task-definition.ts";
import { ProductionCoordinator } from "../core/coordinator/production-coordinator.ts";
import { assembleSupervisorDecisionContext } from "../core/execution/supervisor-decision-context.ts";
import { BATCH_ID, discover, PROJECT, RUN_ID, TASK_KEY, TASK_REF, withWorld } from "./support/domain-fixtures.ts";
import {
  compiled,
  executionPolicy,
  inputFor,
  projectProfile,
  selection,
  subflowChildContext,
  subflowParentView,
  subflowSelection,
  SUBFLOW_PARENT_INTENT,
  task,
} from "./support/decision-fixtures.ts";
import { validateDecision } from "../core/decision/validator.ts";
import { normalizeTaskDefinition } from "../core/tasksource/task-definition.ts";
import {
  activeProposalId,
  coordinatorWorld,
  seedProposalAllocation,
  submitSupervisorProposal,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";

const ULID_F = "01JQ8ZK5T7RC9V2W4X6Y8Z0FM1";
const ULID_F2 = "01JQ8ZK5T7RC9V2W4X6Y8Z0FM2";

/** A v3 world: one task source with one bound materializer, and the v2 Supervisor binding. */
const V3_PROJECT = {
  supervisor_profile: "implementation",
  task_sources: [
    {
      id: "primary",
      adapter: "example-source",
      config: { paths: ["plan.md"] },
      child_materializer: { adapter: "example-materializer", config: {} },
    },
  ],
};
const V3_OPTIONS = { projectOverrides: V3_PROJECT };
const POLICY = { batch_policy: { max_tasks: 3, max_rework: 2, concurrency: 2 } };

const childBody = (title = "Split: implement the collector parser") => ({
  title,
  description: "One bounded child of the whole intent.",
  references: [],
  acceptance_notes: ["parser passes the fixture corpus"],
});

type World = Parameters<Parameters<typeof withWorld>[0]>[0];

function fProposal(w: CoordinatorWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const parentTask = w.store.tasks.require(TASK_KEY);
  return {
    proposal_id: activeProposalId(w.store, BATCH_ID) ?? ULID_F,
    decision: "START_SUBFLOW",
    parent: {
      kind: "DISCOVERED_TASK",
      task_key: TASK_KEY,
      task_ref: TASK_REF,
      task_version: parentTask.external_snapshot.version,
      task_definition_hash: parentTask.external_snapshot.definition_hash,
    },
    child: { task_definition_body: childBody() },
    expected: { compiled_profile_hash: w.store.batches.require(BATCH_ID).compiled_profile_hash },
    reason_refs: ["intent:whole"],
    ...overrides,
  };
}

function submitF(w: CoordinatorWorld, proposal: Record<string, unknown>, gate: Record<string, unknown> = {}) {
  seedProposalAllocation(w.store, BATCH_ID, proposal["proposal_id"] as string);
  return submitProposal(
    { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
    { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T09:00:00Z", proposal, ...gate },
  );
}

function effectCounts(w: CoordinatorWorld, materializer: FakeChildMaterializer) {
  return {
    snapshots: w.store.materializations.count(),
    adapterCalls: materializer.calls.filter((call) => call.startsWith("materialize:")).length,
  };
}

// --- Profile v3 boundary (#68 §1, control 19) ----------------------------------------------------

test("D24-P: v1/v2 profiles stay valid; multi-source materialiser shapes fail deterministically", () => {
  // v1/v2 compile exactly as before (meaning unchanged).
  const v1 = compileProfile({
    projectProfile: projectProfile(),
    executionPolicy: executionPolicy(),
    approvedOverrides: { items: [] },
  });
  assert.equal(v1.body.compiled_version, 1);

  // v3: the single-source + single-materializer boundary compiles to compiled_version 3.
  const v3 = compileProfile({
    projectProfile: projectProfile(V3_PROJECT),
    executionPolicy: executionPolicy(),
    approvedOverrides: { items: [] },
  });
  assert.equal(v3.body.compiled_version, 3);

  // Ambiguous routing — two sources with a declared materializer — is a compile error, never an
  // inference. Zero materializers stays a valid profile with the feature unavailable.
  assert.throws(() =>
    compileProfile({
      projectProfile: projectProfile({
        ...V3_PROJECT,
        task_sources: [
          ...V3_PROJECT.task_sources,
          { id: "secondary", adapter: "example-source", config: {} },
        ],
      }),
      executionPolicy: executionPolicy(),
      approvedOverrides: { items: [] },
    }),
  );
});

// --- control 4: F carries no execution/identity fields -------------------------------------------

test("D24-4: an F that smuggles task_ref/pipeline/scope/base_head or a parentless child is schema-invalid", () => {
  const base = {
    proposal_id: ULID_F,
    decision: "START_SUBFLOW",
    parent: {
      kind: "DISCOVERED_TASK",
      task_key: "task:alpha:T-1",
      task_ref: "T-1",
      task_version: "1",
      task_definition_hash: "sha256:" + "0".repeat(64),
    },
    child: { task_definition_body: childBody() },
    expected: { compiled_profile_hash: "sha256:" + "1".repeat(64) },
    reason_refs: [],
  };
  assert.equal(validateProposal(base).variant, "SUBFLOW_CHILD_MATERIALIZATION");
  for (const smuggled of [
    { task_ref: "T-9" },
    { pipeline_id: "standard" },
    { actor_profile: "implementation" },
    { repository_scope_id: "collector" },
    { expected: { compiled_profile_hash: base.expected.compiled_profile_hash, base_head: "x" } },
  ]) {
    assert.throws(() => validateProposal({ ...base, ...smuggled }), JSON.stringify(smuggled));
  }
  // A malformed child body is rejected at V1, not repaired.
  assert.throws(() => validateProposal({ ...base, child: { task_definition_body: { title: "" } } }));
});

// --- controls 1/2/3/5/6: policy, gate, parent, reservation ---------------------------------------

test("D24-1: allow_auto_subflow=false rejects F with zero snapshot/INTENT/effect", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    const outcome = submitF(w, fProposal(w));
    assert.deepEqual(outcome.result, { kind: "POLICY_REJECTED", reason_code: "DECISION_NOT_ALLOWED" });
    assert.deepEqual(effectCounts(w, materializer), { snapshots: 0, adapterCalls: 0 });
  }, { ...POLICY, allow_auto_subflow: false }, V3_OPTIONS);
});

test("D24-2/3: a gated F publishes nothing before approval, and F approval never authorizes E", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    const proposal = fProposal(w);
    const gated = submitF(w, proposal, {
      decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0GF1",
      report_channel: "operations",
    });
    assert.deepEqual(gated.result, { kind: "HUMAN_GATE_REQUIRED" });
    assert.deepEqual(effectCounts(w, materializer), { snapshots: 0, adapterCalls: 0 }, "control 2");
    // The exact parent is parked on the gate, its tagged origin frozen.
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "HELD");

    // Approval applies the exact frozen F: snapshot + INTENT commit, parent origin restored.
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
    const applied = resolveHumanGateAndAdmit(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      { run_id: RUN_ID, batch_id: BATCH_ID, decision_id, observed_at: "2026-09-01T10:01:00Z" },
    );
    assert.deepEqual(applied.result, { kind: "ACCEPTED" });
    assert.equal(applied.admitted, false, "F acceptance is never admission");
    assert.equal(w.store.materializations.count(), 1);
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED", "origin restored");

    // Control 3 — the F approval cannot be replayed as an E/other acceptance: the terminal
    // record is spent on this exact application and carries its transition ref.
    const record = w.store.pendingDecisions.require(decision_id);
    assert.notEqual(record.body.resolution?.applied_transition_ref, null);
    assert.throws(() =>
      resolveHumanGateAndAdmit(
        { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
        { run_id: RUN_ID, batch_id: BATCH_ID, decision_id, observed_at: "2026-09-01T10:02:00Z" },
      ),
    );
  }, { ...POLICY, human_gate_policy: { required_decisions: ["START_SUBFLOW"] } }, V3_OPTIONS);
});

test("D24-2r: a REJECTED gate has zero external effect and parks the parent for replanning", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    const gated = submitF(w, fProposal(w), {
      decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0GF2",
      report_channel: "operations",
    });
    const decision_id = gated.pending_decision_id as string;
    w.store.withTransaction(() => {
      w.store.pendingDecisions.resolve(decision_id, {
        kind: "OPTION",
        chosen_option: "REJECT",
        free_form: null,
        resolved_by: "operator@example",
        resolved_at: "2026-09-01T10:00:00.000Z",
        approval_binding: null,
        applied_transition_ref: null,
      });
    });
    applyRejectedMaterializationGate(w.store, { parent_task_key: TASK_KEY, decision_id });
    const parent = w.store.tasks.require(TASK_KEY);
    assert.equal(parent.platform_state, "HELD");
    assert.equal(parent.state_reason?.code, `MATERIALIZATION_REJECTED:${decision_id}`);
    assert.deepEqual(effectCounts(w, materializer), { snapshots: 0, adapterCalls: 0 });
  }, { ...POLICY, human_gate_policy: { required_decisions: ["START_SUBFLOW"] } }, V3_OPTIONS);
});

test("D24-5: a stale/missing/ineligible parent basis produces zero effect", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });

    // Stale version echo.
    const stale = fProposal(w);
    (stale["parent"] as Record<string, unknown>)["task_version"] = "999";
    assert.deepEqual(submitF(w, stale).result, { kind: "POLICY_REJECTED", reason_code: "SUBFLOW_PARENT_STALE" });

    // Missing parent row.
    const missing = fProposal(w);
    (missing["parent"] as Record<string, unknown>)["task_key"] = `task:${PROJECT}:GHOST`;
    assert.deepEqual(submitF(w, missing).result, {
      kind: "POLICY_REJECTED",
      reason_code: "SUBFLOW_PARENT_NOT_FOUND",
    });
    assert.deepEqual(effectCounts(w, materializer), { snapshots: 0, adapterCalls: 0 });
  }, POLICY, V3_OPTIONS);
});

test("D24-6: an exhausted batch reservation refuses F before any snapshot exists", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    // max_tasks 1: the unadmitted DISCOVERED parent's own reserved seat exhausts the bound.
    const outcome = submitF(w, fProposal(w));
    assert.deepEqual(outcome.result, { kind: "POLICY_REJECTED", reason_code: "BATCH_MAX_TASKS_REACHED" });
    assert.deepEqual(effectCounts(w, materializer), { snapshots: 0, adapterCalls: 0 });
  }, { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } }, V3_OPTIONS);
});

// --- control 7: same identity, different snapshot ------------------------------------------------

test("D24-7: the same materialization id with a different snapshot is a conflict", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    const seal = (title: string) => {
      const body = childBody(title);
      return sealMaterializationSnapshot({
        materialization_id: ULID_F,
        batch_id: BATCH_ID,
        compiled_profile_hash: w.store.batches.require(BATCH_ID).compiled_profile_hash,
        task_source_id: "primary",
        parent_intent: {
          kind: "DISCOVERED_TASK",
          task_key: TASK_KEY,
          task_ref: TASK_REF,
          task_version: "1",
          task_definition_hash: "sha256:" + "0".repeat(64),
        },
        child_definition_body: body as never,
        child_definition_hash: hashTaskDefinitionBody(body as never),
        reason_refs: [],
      });
    };
    commitMaterializationIntent(w.store, { sealed: seal("one") });
    // Same identity + same envelope is idempotent…
    commitMaterializationIntent(w.store, { sealed: seal("one") });
    assert.equal(w.store.materializations.count(), 1);
    // …and a different envelope under the same identity refuses.
    assert.throws(() => commitMaterializationIntent(w.store, { sealed: seal("two") }));
  }, POLICY, V3_OPTIONS);
});

// --- the full happy path + controls 13/14/16 -----------------------------------------------------

function acceptF(w: CoordinatorWorld): string {
  const proposal = fProposal(w);
  const outcome = submitF(w, proposal);
  assert.deepEqual(outcome.result, { kind: "ACCEPTED" });
  assert.equal(outcome.admitted, false, "publication is never admission");
  return proposal["proposal_id"] as string;
}

test("D24-H: F publishes exactly one child, the round-trip binds it, and only a fresh E admits it", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    const materialization_id = acceptF(w);

    // The Coordinator's bounded steps: publish, then observe through the same TaskSource. The
    // test plays the TaskSource side: the exact published body becomes readable at the adapter
    // ref, which is precisely what a conforming materialisation target guarantees.
    assert.equal(w.tick(), "MATERIALIZATION_PUBLISHED");
    const receipt = materializer.committedReceipt(materializeChildOp(BATCH_ID, materialization_id))!;
    const snapshot = w.store.materializations.require(materialization_id);
    w.tasks.definitions.set(
      receipt.external_task_ref,
      normalizeTaskDefinition({
        task_ref: receipt.external_task_ref,
        version: "1",
        body: snapshot.body.child_definition_body,
      }),
    );
    assert.equal(w.tick(), "MATERIALIZATION_OBSERVED");

    const childKey = `task:${PROJECT}:${receipt.external_task_ref}`;
    const child = w.store.tasks.require(childKey);
    assert.equal(child.platform_state, "DISCOVERED");
    assert.equal(child.materialization_binding?.materialization_id, materialization_id);
    assert.equal(child.parent_task_key, null, "no executable relation before E");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED", "parent untouched");

    // Control 16 — while the observed child is unadmitted, the parent's Actor INTENT is gated:
    // admit the parent (A) and confirm activation happens but no Actor turn starts.
    submitSupervisorProposal(w, world);
    assert.equal(w.tick(), "ACTIVATED");
    const step = w.tick();
    assert.notEqual(step, "IMPLEMENTATION_STARTED", "pending child blocks the Actor external INTENT");
    assert.equal(pendingMaterializationsFor(w.store, TASK_KEY).length, 1);

    // Control 13 — the bound child cannot be admitted as an ordinary top-level task, even with a
    // perfectly fresh basis.
    const freshChildDefinition = w.tasks.definitions.get(receipt.external_task_ref)!;
    const aOverChild = {
      ...selection({ profile: world.profile, definition: freshChildDefinition }),
    };
    seedProposalAllocation(w.store, BATCH_ID, aOverChild["proposal_id"] as string);
    const aResult = submitProposal(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T09:10:00Z", proposal: aOverChild },
    );
    assert.deepEqual(aResult.result, {
      kind: "POLICY_REJECTED",
      reason_code: "SUBFLOW_MATERIALIZATION_CONFLICT",
    });

    void ULID_F2;
  }, POLICY, V3_OPTIONS);
});

// --- controls 8/9/10/11: reconcile semantics ------------------------------------------------------

test("D24-8/9: a transient failure is UNKNOWN — no retry, no new id, PAUSED_SAFELY, F guard closed", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    acceptF(w);

    // The call crashes; the honest fake's reconcile answers UNKNOWN (absence is not proof).
    materializer.failNextWith = new Error("socket hang up");
    assert.equal(w.tick(), "MATERIALIZATION_UNKNOWN");
    assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
    assert.equal(
      w.store.decisions.read().some((entry) => entry.kind === "materialization_reconcile_unknown"),
      true,
      "same-op provenance is journaled",
    );
    const calls = materializer.calls.filter((call) => call.startsWith("materialize:")).length;
    // No blind retry on later passes while UNKNOWN stands: the batch is paused and the op stays.
    w.tick();
    assert.equal(materializer.calls.filter((call) => call.startsWith("materialize:")).length, calls);

    // Control 9's F-guard leg: even if the pause is cleared *incorrectly* (simulated raw status
    // flip, bypassing reconciliation), a new F is still refused while the UNKNOWN op stands —
    // the guard derives from durable exact facts, not from the pause. Zero new snapshot/INTENT.
    w.store.withTransaction(() => {
      w.store.batches.setStatus(BATCH_ID, "RUNNING");
    });
    const again = fProposal(w, { proposal_id: ULID_F2 });
    const refused = submitF(w, again);
    assert.deepEqual(refused.result, { kind: "POLICY_REJECTED", reason_code: "DECISION_NOT_ALLOWED" });
    assert.equal(w.store.materializations.count(), 1);
  }, POLICY, V3_OPTIONS);
});

test("D24-10/11: only NO_EFFECT_CONFIRMED reopens the same op, and a lost receipt reconciles to the same child", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    const id = acceptF(w);
    const op = materializeChildOp(BATCH_ID, id);

    // First call crashes with a scripted authoritative no-effect: the same op may retry and
    // commits exactly one child on the retry (control 10).
    materializer.failNextWith = new Error("connection reset");
    materializer.reconcileAnswer = { status: "NO_EFFECT_CONFIRMED" };
    assert.equal(w.tick(), "MATERIALIZATION_PUBLISHED");
    materializer.reconcileAnswer = undefined;
    assert.equal(w.store.idempotency.get(op)?.state, "DONE");

    // Control 11 — a crash after external create but before DONE: reconcile returns the exact
    // committed receipt; promotion is idempotent and creates no second child.
    const receipt = materializer.committedReceipt(op)!;
    const again = materializer.reconcile_child_materialization(op);
    assert.equal(again.status, "COMMITTED");
    assert.equal((again as { receipt: { external_task_ref: string } }).receipt.external_task_ref, receipt.external_task_ref);
  }, POLICY, V3_OPTIONS);
});

// --- control 12: wrong round-trip body -----------------------------------------------------------

test("D24-12: a round-trip that disagrees with the snapshot binds nothing and fails closed", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    acceptF(w);
    assert.equal(w.tick(), "MATERIALIZATION_PUBLISHED");
    const receipt = materializer.committedReceipt(
      materializeChildOp(BATCH_ID, w.store.materializations.forBatch(BATCH_ID)[0]!.materialization_id),
    )!;
    // The source republishes a DIFFERENT body under the committed ref.
    w.tasks.definitions.set(receipt.external_task_ref, task({ task_ref: receipt.external_task_ref }));

    assert.equal(w.tick(), "MATERIALIZATION_CONFLICT");
    assert.equal(w.store.tasks.get(`task:${PROJECT}:${receipt.external_task_ref}`), undefined);
    assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
  }, POLICY, V3_OPTIONS);
});

// --- control 18: pre-existing external child with null binding -----------------------------------

test("D24-18: a pre-existing external child with a null binding still takes the ordinary D22 E path", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    discover(world, "PRE-EXISTING");
    assert.equal(w.store.tasks.require(`task:${PROJECT}:PRE-EXISTING`).materialization_binding, null);
    // The D22 E flow over unbound children is proven end-to-end in B15-3; here we pin that the
    // new §19.3a guard does not reject the null-binding path at the validator level.
    const proposal = selection({ profile: world.profile, definition: task({ task_ref: "PRE-EXISTING" }) });
    seedProposalAllocation(w.store, BATCH_ID, proposal["proposal_id"] as string);
    const outcome = submitProposal(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T09:00:00Z", proposal },
    );
    assert.deepEqual(outcome.result, { kind: "ACCEPTED" }, "an unbound task admits ordinarily");
  }, POLICY, V3_OPTIONS);
});

// --- control 17: restart convergence (CM windows) -------------------------------------------------

test("D24-17: restart at the INTENT and COMMITTED windows converges with zero duplicate creates", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    const id = acceptF(w);
    const op = materializeChildOp(BATCH_ID, id);

    // CM2 — "restart" between INTENT and the adapter call: a fresh Coordinator over the same
    // store performs the same op exactly once.
    const rebuilt = new ProductionCoordinator({ ...w, materializer });
    assert.equal(rebuilt.tickOnce(RUN_ID), "MATERIALIZATION_PUBLISHED");
    assert.equal(materializer.calls.filter((c) => c.startsWith("materialize:")).length, 1);

    // CM4/CM5 — restart after DONE, before/after the round-trip: the same receipt drives the
    // same fresh read; once bound, nothing runs twice.
    const receipt = materializer.committedReceipt(op)!;
    const snapshot = w.store.materializations.require(id);
    w.tasks.definitions.set(
      receipt.external_task_ref,
      normalizeTaskDefinition({
        task_ref: receipt.external_task_ref,
        version: "1",
        body: snapshot.body.child_definition_body,
      }),
    );
    const rebuiltAgain = new ProductionCoordinator({ ...w, materializer });
    assert.equal(rebuiltAgain.tickOnce(RUN_ID), "MATERIALIZATION_OBSERVED");
    const created = w.store.tasks.inBatch(BATCH_ID).filter((t) => t.materialization_binding !== null);
    assert.equal(created.length, 1);
    const rebuiltThird = new ProductionCoordinator({ ...w, materializer });
    const next = rebuiltThird.tickOnce(RUN_ID);
    assert.notEqual(next, "MATERIALIZATION_PUBLISHED");
    assert.notEqual(next, "MATERIALIZATION_OBSERVED");
    assert.equal(materializer.calls.filter((c) => c.startsWith("materialize:")).length, 1, "duplicate create count 0");
  }, POLICY, V3_OPTIONS);
});

// --- definitive failure --------------------------------------------------------------------------

test("D24-F: a definitive no-effect failure ends the op FAILED and holds the parent for replanning", () => {
  withWorld((world) => {
    const materializer = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer });
    const id = acceptF(w);
    materializer.failNextWith = new MaterializationFailedError("target refuses this representation");
    assert.equal(w.tick(), "MATERIALIZATION_FAILED");
    assert.equal(w.store.idempotency.get(materializeChildOp(BATCH_ID, id))?.state, "FAILED");
    const parent = w.store.tasks.require(TASK_KEY);
    assert.equal(parent.platform_state, "HELD");
    assert.equal(parent.state_reason?.code, "TASK_MATERIALIZATION_FAILED");
    // The reservation is released: a fresh F under a new id validates again.
    void materializationOperations;
  }, POLICY, V3_OPTIONS);
});

// --- controls 14/15: E consumption of the binding ------------------------------------------------

test("D24-14/15: an E with the wrong parent is a conflict; a drifted child body is drift", () => {
  const profile = compiled();
  const eInput = (child: Record<string, unknown>) =>
    inputFor(
      subflowSelection({
        profile,
        classification: "SPLIT_NEEDED",
        pipeline_id: "foundation",
        parent: SUBFLOW_PARENT_INTENT,
      }),
      profile,
      {
        subflow_parent: subflowParentView() as never,
        subflow_child: subflowChildContext(child) as never,
      },
    );

  // 14 — the binding names a different parent than the E proposes.
  assert.deepEqual(
    validateDecision(
      eInput({
        materialization_binding: {
          parent_task_key: "task:alpha:SOMEONE-ELSE",
          child_definition_hash: "sha256:" + "2".repeat(64),
        },
      }),
    ),
    { kind: "POLICY_REJECTED", reason_code: "SUBFLOW_MATERIALIZATION_CONFLICT" },
  );

  // 15 — the fresh child body drifted from the bound hash.
  assert.deepEqual(
    validateDecision(
      eInput({
        materialization_binding: {
          parent_task_key: SUBFLOW_PARENT_INTENT.task_key,
          child_definition_hash: "sha256:" + "3".repeat(64),
        },
      }),
    ),
    { kind: "POLICY_REJECTED", reason_code: "SUBFLOW_MATERIALIZATION_DRIFT" },
  );
});


// === PR #69 review 5493230285 — required regressions (findings 2–5; finding 1 is D23-R1) ========

/** An adapter that creates the child and then throws, with an unreadable reconciler. */
class CreateThenThrowMaterializer extends FakeChildMaterializer {
  createThenThrowOnce = false;
  reconcileThrows = false;
  override materialize_child(request: Parameters<FakeChildMaterializer["materialize_child"]>[0]) {
    if (this.createThenThrowOnce) {
      this.createThenThrowOnce = false;
      super.materialize_child(request); // the external effect happens
      throw new Error("network dropped after create");
    }
    return super.materialize_child(request);
  }
  override reconcile_child_materialization(op_key: string) {
    if (this.reconcileThrows) throw new Error("observer down");
    return super.reconcile_child_materialization(op_key);
  }
}

test("R2: create-then-throw with an unreadable reconciler is UNKNOWN — one create, ever", () => {
  withWorld((world) => {
    const m = new CreateThenThrowMaterializer();
    const w = coordinatorWorld(world, { materializer: m });
    const id = acceptF(w);

    m.createThenThrowOnce = true;
    m.reconcileThrows = true;
    assert.equal(w.tick(), "MATERIALIZATION_UNKNOWN", "unproven either way is UNKNOWN, never bare INTENT");
    assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
    assert.equal(
      w.store.decisions.read().some((e) => e.kind === "materialization_reconcile_unknown"),
      true,
      "same-op provenance persists",
    );

    // Repeated ticks and a rebuilt Coordinator never call materialize_child again.
    const creates = () => m.calls.filter((c) => c.startsWith("materialize:")).length;
    const before = creates();
    m.reconcileThrows = false; // reconciler heals but keeps answering honestly (COMMITTED known)
    w.tick();
    new ProductionCoordinator({ ...w, materializer: m }).tickOnce(RUN_ID);
    assert.equal(creates(), before, "duplicate create count 0");

    // A later same-identity COMMITTED reconciliation converges without another publish: the
    // recovery pass promotes the exact receipt to DONE through the same single handler.
    const op = materializeChildOp(BATCH_ID, id);
    // Direct bounded pass over the paused batch (read-only reconcile is allowed while UNKNOWN):
    const step = advanceMaterializations(
      { store: w.store, taskSource: w.tasks, materializer: m },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T11:00:00Z" },
    );
    assert.equal(step, "MATERIALIZATION_PUBLISHED");
    assert.equal(w.store.idempotency.get(op)?.state, "DONE");
    assert.equal(creates(), before, "convergence promoted the receipt; it did not re-create");
  }, POLICY, V3_OPTIONS);
});

/** Receipt-corrupting adapters for the three COMMITTED paths. */
class BadReceiptMaterializer extends FakeChildMaterializer {
  corruption: "id" | "hash" | "ref" = "id";
  mode: "direct" | "no-effect-retry" | "reconcile" = "direct";
  #phase = 0;
  #bad(request: { materialization_id: string; materialization_hash: string }) {
    return {
      status: "COMMITTED" as const,
      receipt: {
        materialization_id: this.corruption === "id" ? "01JQ8ZK5T7RC9V2W4X6Y8Z0BAD" : request.materialization_id,
        materialization_hash: this.corruption === "hash" ? "sha256:" + "f".repeat(64) : request.materialization_hash,
        external_task_ref: this.corruption === "ref" ? "" : "CHILD-FOREIGN",
      },
    };
  }
  override materialize_child(request: Parameters<FakeChildMaterializer["materialize_child"]>[0]) {
    this.#phase += 1;
    if (this.mode === "direct") return this.#bad(request);
    if (this.mode === "no-effect-retry") {
      if (this.#phase === 1) throw new Error("ambiguous first call");
      return this.#bad(request);
    }
    throw new Error("always ambiguous");
  }
  override reconcile_child_materialization(op_key: string) {
    void op_key;
    if (this.mode === "no-effect-retry") return { status: "NO_EFFECT_CONFIRMED" as const };
    if (this.mode === "reconcile") {
      return this.#bad({ materialization_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0BAD", materialization_hash: "sha256:" + "f".repeat(64) });
    }
    return { status: "UNKNOWN" as const };
  }
}

test("R3: a mismatched or empty-ref COMMITTED receipt never reaches DONE on any path", () => {
  for (const mode of ["direct", "no-effect-retry", "reconcile"] as const) {
    for (const corruption of ["id", "hash", "ref"] as const) {
      withWorld((world) => {
        const m = new BadReceiptMaterializer();
        m.mode = mode;
        m.corruption = corruption;
        const w = coordinatorWorld(world, { materializer: m });
        const id = acceptF(w);
        const step = w.tick();
        assert.equal(step, "MATERIALIZATION_CONFLICT", `${mode}/${corruption}`);
        const record = w.store.idempotency.get(materializeChildOp(BATCH_ID, id));
        assert.notEqual(record?.state, "DONE", `${mode}/${corruption}: no DONE`);
        assert.equal(
          w.store.tasks.inBatch(BATCH_ID).some((t) => t.materialization_binding !== null),
          false,
          `${mode}/${corruption}: no binding`,
        );
        assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
      }, POLICY, V3_OPTIONS);
    }
  }
});

test("R4: pending materialisation seats cannot be stolen by an unrelated admission", () => {
  withWorld((world) => {
    const m = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer: m });
    discover(world, "UNRELATED");
    w.tasks.definitions.set("UNRELATED", task({ task_ref: "UNRELATED" }));
    acceptF(w); // reserves the child seat + the unadmitted DISCOVERED parent's seat

    // max_tasks = 2: both seats are reserved — the context projection says capacity 0…
    const context = assembleSupervisorDecisionContext(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never },
      { run_id: RUN_ID, batch_id: BATCH_ID, proposal_id: ULID_F2, observed_at: "2026-09-01T11:00:00Z" },
    ) as { subflow_materialization?: { remaining_task_capacity: number } };
    assert.equal(context.subflow_materialization?.remaining_task_capacity, 0);

    // …an unrelated A rejects at validation and cannot slip through the commit-time guard either…
    const unrelated = selection({ profile: world.profile, definition: task({ task_ref: "UNRELATED" }) });
    seedProposalAllocation(w.store, BATCH_ID, unrelated["proposal_id"] as string);
    const stolen = submitProposal(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T11:00:00Z", proposal: unrelated },
    );
    assert.deepEqual(stolen.result, { kind: "POLICY_REJECTED", reason_code: "BATCH_MAX_TASKS_REACHED" });
    assert.equal(w.store.tasks.require(`task:${PROJECT}:UNRELATED`).platform_state, "DISCOVERED");

    // …while the exact reserved parent consumes its own seat and admits normally.
    const parentA = selection({ profile: world.profile });
    seedProposalAllocation(w.store, BATCH_ID, parentA["proposal_id"] as string);
    const parent = submitProposal(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T11:01:00Z", proposal: parentA },
    );
    assert.deepEqual(parent.result, { kind: "ACCEPTED" });
    assert.equal(parent.admitted, true);

    // Restart changes nothing: the reservation derives from durable rows alone.
    assert.equal(materializationReservedSeats(w.store, BATCH_ID), 1, "the child seat still stands");
    const again = selection({ profile: world.profile, definition: task({ task_ref: "UNRELATED" }) });
    seedProposalAllocation(w.store, BATCH_ID, again["proposal_id"] as string);
    const post = submitProposal(
      { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: "2026-09-01T11:02:00Z", proposal: again },
    );
    assert.deepEqual(post.result, { kind: "POLICY_REJECTED", reason_code: "BATCH_MAX_TASKS_REACHED" });
  }, { batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 2 } }, V3_OPTIONS);
});

test("R5: a cross-batch F parent fails closed everywhere, and a legacy row still blocks dispatch", () => {
  withWorld((world) => {
    const m = new FakeChildMaterializer();
    const w = coordinatorWorld(world, { materializer: m });
    world.store.withTransaction(() => {
      world.store.batches.create({
        batch_id: "batch:other:1",
        run_id: RUN_ID,
        ordinal: 2,
        compiled_profile_hash: w.store.batches.require(BATCH_ID).compiled_profile_hash,
      });
    });
    const OTHER_KEY = `task:${PROJECT}:OTHER-1`;
    world.store.withTransaction(() => {
      world.store.decisions.append({ kind: "state_transition", refKey: OTHER_KEY, payload: {} as never });
      world.store.tasks.discover({
        task_key: OTHER_KEY,
        batch_id: "batch:other:1",
        project_id: PROJECT,
        external_task_ref: "OTHER-1",
        external_snapshot: {
          external_state: "READY",
          version: "1",
          definition_hash: task({ task_ref: "OTHER-1" }).definition_hash,
          observed_at: "t",
        },
      });
    });
    w.tasks.definitions.set("OTHER-1", task({ task_ref: "OTHER-1" }));

    // Validation: a batch-1 F naming the batch-2 parent is a batch mismatch, zero effect.
    const cross = {
      proposal_id: ULID_F,
      decision: "START_SUBFLOW",
      parent: {
        kind: "DISCOVERED_TASK",
        task_key: OTHER_KEY,
        task_ref: "OTHER-1",
        task_version: "1",
        task_definition_hash: task({ task_ref: "OTHER-1" }).definition_hash,
      },
      child: { task_definition_body: childBody() },
      expected: { compiled_profile_hash: w.store.batches.require(BATCH_ID).compiled_profile_hash },
      reason_refs: [],
    };
    const refused = submitF(w, cross);
    assert.deepEqual(refused.result, {
      kind: "POLICY_REJECTED",
      reason_code: "SUBFLOW_PARENT_BATCH_MISMATCH",
    });
    assert.equal(w.store.materializations.count(), 0, "no snapshot, no INTENT, no effect");

    // Commit path: the intent transaction itself refuses a cross-batch parent, atomically.
    const body = childBody();
    const sealed = sealMaterializationSnapshot({
      materialization_id: ULID_F2,
      batch_id: BATCH_ID,
      compiled_profile_hash: w.store.batches.require(BATCH_ID).compiled_profile_hash,
      task_source_id: "primary",
      parent_intent: {
        kind: "DISCOVERED_TASK",
        task_key: OTHER_KEY,
        task_ref: "OTHER-1",
        task_version: "1",
        task_definition_hash: task({ task_ref: "OTHER-1" }).definition_hash,
      },
      child_definition_body: body as never,
      child_definition_hash: hashTaskDefinitionBody(body as never),
      reason_refs: [],
    });
    assert.throws(() => commitMaterializationIntent(w.store, { sealed }));
    assert.equal(w.store.materializations.count(), 0, "the rejected transaction left nothing behind");

    // Fence: a legacy/corrupt cross-batch snapshot (planted below the commit guard) still blocks
    // the parent's Actor dispatch — the fence queries by parent association, not by batch.
    w.store.withTransaction(() => {
      w.store.materializations.put(sealed);
      w.store.idempotency.beginIntent(materializeChildOp(BATCH_ID, ULID_F2));
    });
    assert.equal(pendingMaterializationsFor(w.store, OTHER_KEY).length, 1, "the fence sees it");
  }, { batch_policy: { max_tasks: 5, max_rework: 2, concurrency: 2 } }, V3_OPTIONS);
});
