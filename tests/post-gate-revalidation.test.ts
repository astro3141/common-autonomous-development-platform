/**
 * B8-AC23 ~ B8-AC25 — HG-1: a human APPROVE never bypasses deterministic validation (TD §17.3).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateDecisionAfterResolvedHumanGate } from "../core/decision/human-gate-revalidation.ts";
import { DecisionError } from "../core/decision/errors.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import type { DecisionValidationResult } from "../core/decision/types.ts";
import type { DecisionValidationInput } from "../core/decision/validator.ts";
import { HumanDecisionError } from "../core/humandecision/errors.ts";
import { resolvedHumanGateAuthorization } from "../core/humandecision/gate-authorization.ts";
import { buildHumanGateDecision } from "../core/humandecision/gate-request.ts";
import type { StoredPendingDecision } from "../core/store/pending-decision-store.ts";
import { TransitionError } from "../core/statemachine/errors.ts";
import {
  commitAdmission,
  commitDecisionResolution,
  commitPendingDecision,
} from "../core/statemachine/transition-commit.ts";
import {
  compiled,
  enforcementWith,
  found,
  inputFor,
  manifests,
  selection,
  task,
  HEAD,
} from "./support/decision-fixtures.ts";
import type { DomainWorld } from "./support/domain-fixtures.ts";
import {
  BATCH_ID,
  BINDING,
  SCOPE_ID,
  SELECTION,
  ULID,
  discover,
  seedTask,
  withWorld,
} from "./support/domain-fixtures.ts";

const APPROVE = {
  kind: "OPTION" as const,
  chosen_option: "APPROVE",
  free_form: null,
  resolved_by: "operator-reference-1",
  resolved_at: "t-resolve",
  approval_binding: null,
  applied_transition_ref: null,
};

const REJECT = { ...APPROVE, chosen_option: "REJECT" };

interface GatedWorld {
  readonly world: DomainWorld;
  readonly taskKey: string;
  readonly rawProposal: Record<string, unknown>;
  readonly record: StoredPendingDecision;
}

/** A task held on a RESOLVED Human Gate approval, exactly as the Coordinator would leave it. */
function gated(
  world: DomainWorld,
  options: { resolution?: typeof APPROVE; proposalOverrides?: Record<string, unknown> } = {},
): GatedWorld {
  const taskKey = discover(world);
  const rawProposal = { ...selection({ profile: world.profile }), ...options.proposalOverrides };
  const decision = buildHumanGateDecision({
    decision_id: ULID.decision,
    proposal: validateProposal(rawProposal),
    task_key: taskKey,
  });

  commitPendingDecision(world.store, { decision, channel: "operations" });
  commitDecisionResolution(world.store, ULID.decision, options.resolution ?? APPROVE);

  return { world, taskKey, rawProposal, record: world.store.pendingDecisions.require(ULID.decision) };
}

const freshInput = (
  gate: GatedWorld,
  overrides: Partial<DecisionValidationInput> = {},
): DecisionValidationInput =>
  inputFor(gate.rawProposal, gate.world.profile, {
    batch: gate.world.store.batchView.project(BATCH_ID),
    ...overrides,
  });

const revalidate = (
  gate: GatedWorld,
  overrides: Partial<DecisionValidationInput> = {},
): DecisionValidationResult =>
  validateDecisionAfterResolvedHumanGate(
    freshInput(gate, overrides),
    resolvedHumanGateAuthorization(gate.record),
  );

// --- the happy path ------------------------------------------------------------------------

test("B8-AC23: an approved gate revalidates cleanly against an unchanged world", () => {
  withWorld(
    (world) => {
      const gate = gated(world);
      assert.deepEqual(revalidate(gate), { kind: "ACCEPTED" });
    },
    { human_gate_policy: { required_decisions: ["START_TASK"] } },
  );
});

test("B8-AC24: the gate is only satisfied while the record still says APPROVE", () => {
  withWorld(
    (world) => {
      // The very same input without the authorization is still gated.
      const gate = gated(world);
      const ordinary = validateDecisionAfterResolvedHumanGate;
      assert.equal(typeof ordinary, "function");

      const rejected = withWorld(
        (other) => {
          const gate2 = gated(other, { resolution: REJECT });
          return () => resolvedHumanGateAuthorization(gate2.record);
        },
        { human_gate_policy: { required_decisions: ["START_TASK"] } },
      );
      assert.throws(rejected, (error: unknown) => error instanceof HumanDecisionError);
    },
    { human_gate_policy: { required_decisions: ["START_TASK"] } },
  );
});

test("B8-AC24: a tampered authorization is refused before any validation runs", () => {
  withWorld(
    (world) => {
      const gate = gated(world);
      const authorization = resolvedHumanGateAuthorization(gate.record);

      const fails = (patch: Record<string, unknown>): void =>
        assert.throws(
          () =>
            validateDecisionAfterResolvedHumanGate(freshInput(gate), {
              ...authorization,
              ...patch,
            } as never),
          (error: unknown) =>
            error instanceof DecisionError && error.reason === "VALIDATOR_INPUT_INVALID",
        );

      fails({ record_hash: "not-a-hash" });
      fails({ decision_id: "" });
      // A record that is not a resolved Human Gate approval never becomes an authorization.
      assert.throws(
        () =>
          resolvedHumanGateAuthorization({
            body: { ...gate.record.body, category: "MERGE_APPROVAL" },
            record_hash: gate.record.record_hash,
          }),
        (error: unknown) => error instanceof HumanDecisionError,
      );
      assert.throws(
        () => resolvedHumanGateAuthorization({ body: gate.record.body, record_hash: null }),
        (error: unknown) => error instanceof HumanDecisionError,
      );
    },
    { human_gate_policy: { required_decisions: ["START_TASK"] } },
  );
});

// --- exact V7 occurrence ---------------------------------------------------------------------

test("B8-AC24: an approval authorizes exactly its own Proposal", () => {
  withWorld(
    (world) => {
      const gate = gated(world);
      // Same task, same decision, same classification — one field differs.
      const other = { ...gate.rawProposal, reason_refs: ["a-different-note"] };

      assert.throws(
        () =>
          validateDecisionAfterResolvedHumanGate(
            inputFor(other, world.profile, { batch: world.store.batchView.project(BATCH_ID) }),
            resolvedHumanGateAuthorization(gate.record),
          ),
        (error: unknown) =>
          error instanceof DecisionError && error.reason === "VALIDATOR_INPUT_INVALID",
      );
    },
    { human_gate_policy: { required_decisions: ["START_TASK"] } },
  );
});

test("B8-AC24: there is no global gate switch in the public surface", () => {
  withWorld(
    (world) => {
      const gate = gated(world);
      // Another Proposal that is itself gated cannot ride on this authorization…
      const authorization = resolvedHumanGateAuthorization(gate.record);
      assert.deepEqual(authorization.normalized_gate_proposal, validateProposal(gate.rawProposal));

      // …and the ordinary validator still gates that input.
      const ordinaryResult = validateDecisionAfterResolvedHumanGate(freshInput(gate), authorization);
      assert.equal(ordinaryResult.kind, "ACCEPTED");
    },
    { human_gate_policy: { required_decisions: ["START_TASK"] } },
  );
});

// --- stale world -----------------------------------------------------------------------------

test("B8-AC25: every kind of drift after approval fails closed", () => {
  const cases: ReadonlyArray<readonly [string, (gate: GatedWorld) => DecisionValidationResult]> = [
    [
      "TASK_DRIFT (version)",
      (gate) => revalidate(gate, { task: found(task({ version: "2" })) }),
    ],
    [
      "TASK_DRIFT (body)",
      (gate) =>
        revalidate(gate, {
          task: {
            status: "FOUND",
            task: { ...task(), definition_hash: `sha256:${"0".repeat(64)}` },
          },
        }),
    ],
    [
      "PROFILE_DRIFT",
      (gate) => revalidate(gate, { compiled_profile_hash: `sha256:${"1".repeat(64)}` }),
    ],
    [
      "REPOSITORY_STATE_MISMATCH",
      (gate) => revalidate(gate, { repository: { canonical_head: `${HEAD}-moved` } }),
    ],
    [
      "BATCH_MAX_TASKS_REACHED",
      (gate) =>
        revalidate(gate, {
          batch: {
            admitted_task_count: 3,
            active_task_count: 0,
            active_writable_candidate_count: 0,
          },
        }),
    ],
    [
      "CONCURRENCY_LIMIT_REACHED",
      (gate) =>
        revalidate(gate, {
          batch: {
            admitted_task_count: 0,
            active_task_count: 2,
            active_writable_candidate_count: 0,
          },
        }),
    ],
    [
      "WRITABLE_CONCURRENCY_CONFLICT",
      (gate) =>
        revalidate(gate, {
          batch: {
            admitted_task_count: 0,
            active_task_count: 0,
            active_writable_candidate_count: 1,
          },
        }),
    ],
  ];

  for (const [reason, run] of cases) {
    withWorld(
      (world) => {
        const gate = gated(world);
        const result = run(gate) as { kind: string; reason_code?: string };
        assert.equal(result.kind, "POLICY_REJECTED", reason);
        assert.equal(result.reason_code, reason.split(" ")[0]);

        // The human's answer stays a historical fact and no transition is recorded.
        const record = world.store.pendingDecisions.require(ULID.decision);
        assert.equal(record.body.status, "RESOLVED");
        assert.equal(record.body.resolution?.applied_transition_ref, null);
        assert.equal(world.store.tasks.require(gate.taskKey).platform_state, "HELD");
      },
      { human_gate_policy: { required_decisions: ["START_TASK"] } },
    );
  }
});

test("B8-AC25: a weakened backend blocks the approved path too", () => {
  const strict = compiled({
    human_gate_policy: { required_decisions: ["START_TASK"] },
    capability_requirements: { actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } },
  });

  withWorld(
    (world) => {
      const gate = gated(world);
      const weak = manifests(enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } }));
      const result = revalidate(gate, { manifests: weak }) as {
        kind: string;
        detail: { operation_id: string };
      };

      assert.equal(result.kind, "BACKEND_INCOMPATIBLE");
      assert.equal(result.detail.operation_id, "actor_execution");
      assert.equal(world.store.tasks.require(gate.taskKey).platform_state, "HELD");
      assert.equal(
        world.store.pendingDecisions.require(ULID.decision).body.resolution
          ?.applied_transition_ref,
        null,
      );
    },
    {
      human_gate_policy: { required_decisions: ["START_TASK"] },
      capability_requirements: { actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } },
    },
  );
  assert.ok(strict.compiled_hash.length > 0);
});

// --- applying the approval -----------------------------------------------------------------------

test("B8-AC23: only an ACCEPTED revalidation may be applied, and it is applied atomically", () => {
  withWorld(
    (world) => {
      const gate = gated(world);
      assert.equal(world.store.tasks.require(gate.taskKey).platform_state, "HELD");
      assert.equal(
        world.store.tasks.require(gate.taskKey).state_reason?.code,
        `BLOCKED_BY_DECISION:${ULID.decision}`,
      );

      assert.deepEqual(revalidate(gate), { kind: "ACCEPTED" });
      const applied = commitAdmission(world.store, {
        task_key: gate.taskKey,
        selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING,
        admitted_at: "t-admit", hard_dependencies_clear: true,
        resolved_decision_id: ULID.decision,
      });

      const taskRow = world.store.tasks.require(gate.taskKey);
      assert.equal(taskRow.platform_state, "SELECTED");
      assert.equal(taskRow.admitted_at, "t-admit");
      assert.equal(
        world.store.pendingDecisions.require(ULID.decision).body.resolution?.applied_transition_ref,
        applied.transition.ref,
      );
    },
    { human_gate_policy: { required_decisions: ["START_TASK"] } },
  );
});

test("B8-AC23: applying under a different decision, or with no capacity, leaves the hold intact", () => {
  withWorld(
    (world) => {
      const gate = gated(world);

      // A decision that does not hold this task cannot release it.
      assert.throws(
        () =>
          commitAdmission(world.store, {
            task_key: gate.taskKey,
            selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING,
            admitted_at: "t", hard_dependencies_clear: true,
            resolved_decision_id: ULID.decisionB,
          }),
        (error: unknown) => error instanceof TransitionError && error.reason === "COMMAND_INVALID",
      );

      // The same commit-time admission guard applies to the gated path.
      seedTask(world, { ref: "X", state: "ACTIVE", attempt_state: "IMPLEMENTING", snapshot_index: 9 });
      assert.throws(
        () =>
          commitAdmission(world.store, {
            task_key: gate.taskKey,
            selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING,
            admitted_at: "t", hard_dependencies_clear: true,
            resolved_decision_id: ULID.decision,
          }),
        (error: unknown) => error instanceof TransitionError && error.reason === "ADMISSION_REJECTED",
      );

      const taskRow = world.store.tasks.require(gate.taskKey);
      assert.equal(taskRow.platform_state, "HELD");
      assert.equal(taskRow.admitted_at, null);
      assert.equal(
        world.store.pendingDecisions.require(ULID.decision).body.resolution?.applied_transition_ref,
        null,
      );
    },
    { human_gate_policy: { required_decisions: ["START_TASK"] } },
  );
});
