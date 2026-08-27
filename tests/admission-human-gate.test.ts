/**
 * M1B4-AC17 ~ M1B4-AC21 — the Human Gate branch: an existing PendingHumanDecision opens, nothing
 * executes, and a later approval is re-validated against facts read again (TD §17, §17.3).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveHumanGateAndAdmit, submitProposal } from "../core/admission/submit-proposal.ts";
import { DECISION_VALIDATION_LOG_KIND } from "../core/decision/decision-log.ts";
import { commitDecisionResolution } from "../core/statemachine/transition-commit.ts";
import { blockedByDecision } from "../core/statemachine/types.ts";
import type { PendingDecisionResolution } from "../core/humandecision/types.ts";
import {
  BATCH_ID,
  discover,
  RUN_ID,
  TASK_KEY,
  withWorld,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import { selection, task } from "./support/decision-fixtures.ts";
import {
  authoritiesFor,
  DECISION_ID,
  manifestSetInput,
  REPORT_CHANNEL,
  StubTaskSource,
  type AdmissionWorld,
} from "./support/admission-fixtures.ts";

const OBSERVED_AT = "2026-08-11T09:00:00Z";
const RESOLVED_AT = "2026-08-11T15:00:00Z";

/** `LARGE_SCOPE` carries the HOLD_HUMAN disposition in the neutral Project Profile fixture. */
const gated = (world: DomainWorld) =>
  selection({ profile: world.profile, classification: "LARGE_SCOPE" });

const submitGated = (world: DomainWorld, authorities: AdmissionWorld, proposal?: unknown) =>
  submitProposal(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    proposal: proposal ?? gated(world),
    observed_at: OBSERVED_AT,
    decision_id: DECISION_ID,
    report_channel: REPORT_CHANNEL,
  });

const approve = (world: DomainWorld): void => {
  const resolution: PendingDecisionResolution = {
    kind: "OPTION",
    chosen_option: "APPROVE",
    free_form: null,
    resolved_by: "operator-1",
    resolved_at: RESOLVED_AT,
    approval_binding: null,
    applied_transition_ref: null,
  };
  commitDecisionResolution(world.store, DECISION_ID, resolution);
};

const resolveAndAdmit = (authorities: AdmissionWorld) =>
  resolveHumanGateAndAdmit(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    decision_id: DECISION_ID,
    observed_at: RESOLVED_AT,
  });

// --- opening the gate ----------------------------------------------------------------------

test("M1B4-AC17 / AC18 / §52: HUMAN_GATE_REQUIRED opens a decision and executes nothing", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);

    const result = submitGated(world, authorities);

    assert.deepEqual(result.result, { kind: "HUMAN_GATE_REQUIRED" });
    assert.equal(result.pending_decision_id, DECISION_ID);
    assert.equal(result.admitted, false);

    const stored = world.store.pendingDecisions.require(DECISION_ID);
    assert.equal(stored.body.status, "OPEN");
    // M1B4-AC18 — a proposal authorization gate, never the MVP 1 merge approval.
    assert.equal(stored.body.category, "HUMAN_GATE_APPROVAL");
    assert.notEqual(stored.body.category, "MERGE_APPROVAL");
    assert.equal(stored.body.subject.kind, "TASK");

    // §28 — the existing hold contract, not a new WAITING_APPROVAL state.
    const row = world.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "HELD");
    assert.equal(row.state_reason?.code, blockedByDecision(DECISION_ID));
    assert.equal(row.admitted_at, null, "a gate is not an admission");
    assert.equal(row.classification, null);

    // No execution side effect at all.
    assert.equal(world.store.attempts.forTask(TASK_KEY).length, 0);
    assert.equal(world.store.contracts.count(), 0);
    assert.equal(world.store.grants.count(), 0);
    assert.deepEqual(world.store.batchView.project(BATCH_ID), {
      admitted_task_count: 0,
      active_task_count: 0,
      active_writable_candidate_count: 0,
    });
    // §17.2's own notification is enqueued; nothing delivers it in this batch.
    assert.equal(world.store.outbox.count(), 1);
    assert.equal(world.store.outbox.pending().length, 1);
  });
});

test("M1B4-AC19 / §27: resubmitting the same Proposal does not open a second decision", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);

    const first = submitGated(world, authorities);
    const second = submitGated(world, authorities);

    assert.equal(second.result.kind, "HUMAN_GATE_REQUIRED");
    assert.equal(second.pending_decision_id, first.pending_decision_id);
    assert.equal(world.store.pendingDecisions.count(), 1);
    assert.equal(world.store.pendingDecisions.countByStatus("OPEN"), 1);
    assert.equal(world.store.outbox.count(), 1, "and no second notification");
    // Both submissions are still journalled — the result was real each time.
    assert.equal(
      world.store.decisions.read().filter((e) => e.kind === DECISION_VALIDATION_LOG_KIND).length,
      2,
    );
  });
});

// --- resolving the gate ---------------------------------------------------------------------

test("M1B4-AC20 / §52: an approval revalidated against unchanged facts admits the task", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    submitGated(world, authorities);
    approve(world);

    const result = resolveAndAdmit(authorities);

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, true);

    const row = world.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "SELECTED");
    assert.equal(row.classification, "LARGE_SCOPE");
    assert.equal(row.admitted_at, RESOLVED_AT);
    assert.equal(world.store.batchView.admitted(BATCH_ID), 1);

    // §30 — approval consented to this Proposal; it did not change the Compiled Profile.
    assert.equal(
      world.store.batchView.compiledProfileFor(BATCH_ID).effective.policy.auto_merge,
      false,
    );
    // The resolution records which transition it caused (§17.3).
    const stored = world.store.pendingDecisions.require(DECISION_ID);
    assert.equal(stored.body.status, "RESOLVED");
    assert.equal(stored.body.resolution?.applied_transition_ref, `transition:${result.transition_seq}`);
    // Still no Attempt, Contract or Grant — admission is where this batch stops.
    assert.equal(world.store.attempts.forTask(TASK_KEY).length, 0);
    assert.equal(world.store.contracts.count(), 0);
    assert.equal(world.store.grants.count(), 0);
  });
});

test("M1B4-AC20: the fresh revalidation re-reads every authority, not a cached input", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    const authorities = authoritiesFor(world, { taskSource: source });
    submitGated(world, authorities);
    approve(world);

    const before = source.calls.length;
    const repositoryBefore = authorities.repository.calls.length;
    resolveAndAdmit(authorities);

    assert.equal(source.calls.length > before, true, "the TaskSource was read again");
    assert.equal(
      authorities.repository.calls.length > repositoryBefore,
      true,
      "the canonical head was read again",
    );
  });
});

// --- stale approvals (§52) ---------------------------------------------------------------------

test("M1B4-AC21 / §52: an approval cannot bypass a TaskDefinition that drifted while it waited", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    const authorities = authoritiesFor(world, { taskSource: source });
    submitGated(world, authorities);
    approve(world);

    // The task changed between the request and the approval.
    source.definition = task({ version: "9" });
    const result = resolveAndAdmit(authorities);

    assert.deepEqual(result.result, { kind: "POLICY_REJECTED", reason_code: "TASK_DRIFT" });
    assert.equal(result.admitted, false);
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD", "the hold stands");
    assert.equal(world.store.batchView.admitted(BATCH_ID), 0);
  });
});

test("M1B4-AC21 / §52: an approval cannot bypass a canonical head that moved while it waited", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    submitGated(world, authorities);
    approve(world);

    authorities.repository.head = "head-canonical-later";
    const result = resolveAndAdmit(authorities);

    assert.deepEqual(result.result, {
      kind: "POLICY_REJECTED",
      reason_code: "REPOSITORY_STATE_MISMATCH",
    });
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
  });
});

test("M1B4-AC21 / §52: an approval cannot bypass a Backend that weakened while it waited", () => {
  withWorld(
    (world) => {
      discover(world);
      const authorities = authoritiesFor(world);
      submitGated(world, authorities);
      approve(world);

      // V10 is re-run against the manifests as they are now, not as they were at request time.
      const weakened = {
        ...authorities,
        manifests: manifestSetInput({ "repository.feature_write": { allow: "NOT_YET_AUDITED" } }),
      };
      const result = resolveAndAdmit(weakened as AdmissionWorld);

      assert.equal(result.result.kind, "BACKEND_INCOMPATIBLE");
      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
      assert.equal(world.store.batchView.admitted(BATCH_ID), 0);
    },
    {
      capability_requirements: {
        actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
      },
    },
  );
});

test("M1B4-AC21: an unresolved or rejected decision authorizes nothing", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    submitGated(world, authorities);

    // Still OPEN.
    assert.throws(() => resolveAndAdmit(authorities));

    commitDecisionResolution(world.store, DECISION_ID, {
      kind: "OPTION",
      chosen_option: "REJECT",
      free_form: null,
      resolved_by: "operator-1",
      resolved_at: RESOLVED_AT,
      approval_binding: null,
      applied_transition_ref: null,
    });
    assert.throws(() => resolveAndAdmit(authorities), /APPROVE/);

    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(world.store.batchView.admitted(BATCH_ID), 0);
  });
});
