/**
 * TD §17.4 (v1.5 PR #43 amendment, D22) — PendingDecision resolution application.
 *
 * Resolution is not itself a lifecycle effect: the durable RESOLVED record is the person's
 * answer, and only the exact category × origin × option mapping — with fresh revalidation —
 * turns it into a transition. A refused application spends its one judgement, leaves
 * `RESOLVED(applied_transition_ref = null)` and keeps the safe-held state.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyOpKey } from "../core/execution/apply-resolved-decision.ts";
import { nextAttemptOutcome } from "../core/statemachine/attempt-transitions.ts";
import {
  commitTaskAbandonment,
  commitTaskReattemptReentry,
} from "../core/statemachine/transition-commit.ts";
import { abandonedByDecision, reattemptRequired } from "../core/statemachine/types.ts";
import { AUDITOR_VERDICT_PROTOCOL } from "./support/execution-fixtures.ts";
import { BATCH_ID, RUN_ID, TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  auditorVerdict,
  auditorTurnResult,
  evidenceItem,
  REQUIRED_CHECK,
} from "./support/execution-fixtures.ts";
import {
  actorProduced,
  coordinatorWorld,
  mergeAnswer,
  submitSupervisorProposal,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";

const CANDIDATE = "9a8b7c6d5e4f30211203344556677889900aabbc";
const SINGLE = { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } };

type World = Parameters<Parameters<typeof withWorld>[0]>[0];

/** Drives the fixture task to a settled Auditor verdict; returns after AUDIT_COMPLETED's tick. */
function driveToAuditVerdict(
  world: World,
  verdict: "AUDIT_PASS" | "FIX_REQUIRED" | "HUMAN_REQUIRED",
): CoordinatorWorld {
  const w = coordinatorWorld(world);
  assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
  submitSupervisorProposal(w, world);
  assert.equal(w.tick(), "ACTIVATED");
  assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
  actorProduced(w, CANDIDATE, 1);
  assert.equal(w.tick(), "VERIFICATION_STARTED");
  const attempt = w.store.attempts.current(TASK_KEY)!;
  const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
  w.verification.completeWith([
    evidenceItem({ check_id: REQUIRED_CHECK, target_commit: CANDIDATE, task_contract_hash: hash }),
  ]);
  assert.equal(w.tick(), "AUDIT_STARTED");
  const review = {
    candidate_commit: CANDIDATE,
    task_contract_hash: hash,
    evidence_ids: w.store.verificationEvidence
      .forAttempt(attempt.attempt_key)
      .filter((row) => row.target_commit === CANDIDATE)
      .map((row) => row.evidence_id),
  };
  const handle = w.store.adapterMetadata
    .forEntity(attempt.attempt_key)
    .find((row) => row.key.startsWith("auditor_turn-1:") && row.key.endsWith(CANDIDATE));
  w.runtime.turnResults.set(
    JSON.stringify(handle?.value),
    auditorTurnResult({ body: auditorVerdict(review, { verdict }), protocol: AUDITOR_VERDICT_PROTOCOL }),
  );
  w.verification.settlement = { kind: "SETTLED" };
  assert.equal(w.tick(), "AUDIT_COMPLETED");
  return w;
}

function resolveDecision(w: CoordinatorWorld, decision_id: string, chosen_option: string): void {
  w.store.withTransaction(() => {
    w.store.pendingDecisions.resolve(decision_id, {
      kind: "OPTION",
      chosen_option,
      free_form: null,
      resolved_by: "operator@example",
      resolved_at: "2026-09-01T10:00:00.000Z",
      approval_binding: null,
      applied_transition_ref: null,
    });
  });
}

// --- AUDIT_DECISION ------------------------------------------------------------------------------

test("17.4-1: RESOLVED alone moves nothing; the mapped application does — AUDIT REQUEST_REWORK", () => {
  withWorld((world) => {
    const w = driveToAuditVerdict(world, "HUMAN_REQUIRED");
    const open = w.store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open.length, 1);
    const decision = open[0]!.body;
    assert.equal(decision.category, "AUDIT_DECISION");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "HELD");

    // Resolution is a durable answer, not a lifecycle effect: nothing moved yet.
    resolveDecision(w, decision.decision_id, "REQUEST_REWORK");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "AUDITING");

    // The tick applies the exact mapping row: AUDITING→REWORKING + task HELD→ACTIVE, one txn.
    assert.equal(w.tick(), "DECISION_APPLIED");
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "REWORKING");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
    const applied = w.store.pendingDecisions.require(decision.decision_id);
    assert.notEqual(applied.body.resolution?.applied_transition_ref, null, "the ref is recorded");

    // The same Attempt and Contract continue through the ordinary rework path.
    assert.equal(w.tick(), "REWORK_STARTED");
    assert.equal(w.store.attempts.current(TASK_KEY)?.rework_count, 1);
  }, SINGLE);
});

test("17.4-2: AUDIT ABANDON fails the Attempt and the Task with the exact decision as reason", () => {
  withWorld((world) => {
    const w = driveToAuditVerdict(world, "HUMAN_REQUIRED");
    const decision = w.store.pendingDecisions.openFor(TASK_KEY)[0]!.body;
    resolveDecision(w, decision.decision_id, "ABANDON");

    assert.equal(w.tick(), "DECISION_APPLIED");
    const attempt = w.store.attempts.forTask(TASK_KEY)[0]!;
    assert.equal(attempt.state, "FAILED");
    assert.equal(attempt.state_reason?.code, abandonedByDecision(decision.decision_id));
    const task = w.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "FAILED");
    assert.equal(task.state_reason?.code, abandonedByDecision(decision.decision_id));
  }, SINGLE);
});

test("17.4-3: a refused application spends its one judgement — no background retry, safe-held kept", () => {
  withWorld((world) => {
    // max_rework 0: REQUEST_REWORK's fresh guard (remaining rework) must refuse.
    const w = driveToAuditVerdict(world, "HUMAN_REQUIRED");
    const decision = w.store.pendingDecisions.openFor(TASK_KEY)[0]!.body;
    resolveDecision(w, decision.decision_id, "REQUEST_REWORK");

    assert.equal(w.tick(), "DECISION_APPLICATION_REFUSED");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "HELD", "safe-held is preserved");
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "AUDITING", "the Attempt did not move");
    const record = w.store.pendingDecisions.require(decision.decision_id);
    assert.equal(record.body.resolution?.applied_transition_ref, null, "RESOLVED(null) stands");
    assert.equal(w.store.idempotency.get(applyOpKey(decision.decision_id))?.state, "DONE");

    // The judgement is spent: the next tick does not re-apply or re-refuse the same record.
    const journalBefore = w.store.decisions.count();
    assert.notEqual(w.tick(), "DECISION_APPLICATION_REFUSED");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(w.store.decisions.count(), journalBefore, "no repeated judgement journal writes");
  }, { batch_policy: { max_tasks: 1, max_rework: 0, concurrency: 1 } });
});

// --- REATTEMPT_DECISION (merge-reject origin) + RESELECTION re-entry -----------------------------

test("17.4-4: merge-reject REATTEMPT invalidates the source, re-enters via RESELECTION, and builds Attempt 2", () => {
  withWorld((world) => {
    const w = driveToAuditVerdict(world, "AUDIT_PASS");
    assert.equal(w.tick(), "MERGE_APPROVAL_OPENED");
    const approval = w.store.pendingDecisions.openFor(TASK_KEY)[0]!.body;
    mergeAnswer(w, approval.decision_id, "REJECT");
    assert.equal(w.tick(), "BLOCKED", "the rejection parks the task on the follow-up question");

    const followUp = w.store.pendingDecisions
      .openFor(TASK_KEY)
      .map((row) => row.body)
      .find((body) => body.category === "REATTEMPT_DECISION");
    assert.notEqual(followUp, undefined);
    resolveDecision(w, followUp!.decision_id, "REATTEMPT_WITH_NEW_SNAPSHOT");

    assert.equal(w.tick(), "DECISION_APPLIED");
    const source = w.store.attempts.forTask(TASK_KEY)[0]!;
    assert.equal(source.state, "INVALIDATED");
    assert.equal(source.state_reason?.code, "REATTEMPT_REQUESTED");
    const task = w.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, reattemptRequired(followUp!.decision_id));

    // §17.4 — REATTEMPT_REQUIRED is a re-entry reason: a fresh START_TASK Proposal passes as a
    // RESELECTION (max_tasks 1 already consumed) and activation builds Contract + Attempt 2.
    submitSupervisorProposal(w, world);
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
    assert.equal(w.tick(), "ACTIVATED");
    const fresh = w.store.attempts.current(TASK_KEY)!;
    assert.equal(fresh.n, 2, "a new Attempt, never a resurrected one");
    assert.notEqual(fresh.contract_snapshot_id, source.contract_snapshot_id, "a new frozen Contract");
  }, SINGLE);
});

// --- guard-level falsification (the sealed state machine owns source legality) -------------------

test("17.4-5: the RESOLVED_DECISION_APPLIED guard refuses wrong sources and spent budgets", () => {
  const attempt = (state: string, rework = 0) =>
    ({ attempt_key: "attempt:t:1", state, rework_count: rework }) as never;
  const limits = { max_rework: 2 };

  // AUDIT_REWORK requires AUDITING and remaining rework.
  assert.throws(() =>
    nextAttemptOutcome(attempt("VERIFYING"), { kind: "RESOLVED_DECISION_APPLIED", application: { kind: "AUDIT_REWORK" } }, limits),
  );
  assert.throws(() =>
    nextAttemptOutcome(attempt("AUDITING", 2), { kind: "RESOLVED_DECISION_APPLIED", application: { kind: "AUDIT_REWORK" } }, limits),
  );
  assert.deepEqual(
    nextAttemptOutcome(attempt("AUDITING"), { kind: "RESOLVED_DECISION_APPLIED", application: { kind: "AUDIT_REWORK" } }, limits),
    { attempt_state: "REWORKING", task_state: "ACTIVE" },
  );

  // REATTEMPT over a live Attempt requires a merge-pending source.
  assert.throws(() =>
    nextAttemptOutcome(
      attempt("IMPLEMENTING"),
      { kind: "RESOLVED_DECISION_APPLIED", application: { kind: "REATTEMPT", decision_id: "d", attempt_reason: "REATTEMPT_REQUESTED" } },
      limits,
    ),
  );
  const reattempted = nextAttemptOutcome(
    attempt("APPROVED_FOR_MANUAL_MERGE"),
    { kind: "RESOLVED_DECISION_APPLIED", application: { kind: "REATTEMPT", decision_id: "d", attempt_reason: "RECOVERY_CONFLICT" } },
    limits,
  );
  assert.equal(reattempted.attempt_state, "INVALIDATED");
  assert.equal(reattempted.attempt_reason_code, "RECOVERY_CONFLICT");
  assert.equal(reattempted.task_reason_code, reattemptRequired("d"));

  // ALLOW_FROZEN leaves the Attempt exactly where it is.
  assert.deepEqual(
    nextAttemptOutcome(attempt("VERIFYING"), { kind: "RESOLVED_DECISION_APPLIED", application: { kind: "ALLOW_FROZEN" } }, limits),
    { attempt_state: "VERIFYING", task_state: "ACTIVE" },
  );
});

test("17.4-6: the task-only re-entry and abandonment commits fail closed outside their exact source", () => {
  withWorld((world) => {
    const w = driveToAuditVerdict(world, "HUMAN_REQUIRED");
    // The task is HELD but a *non-terminal* Attempt exists → both task-only commits refuse.
    assert.throws(() =>
      commitTaskReattemptReentry(w.store, { task_key: TASK_KEY, decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0DD1" }),
    );
    assert.throws(() =>
      commitTaskAbandonment(w.store, { task_key: TASK_KEY, decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0DD1" }),
    );
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "HELD", "nothing moved");
    void BATCH_ID;
    void RUN_ID;
  }, SINGLE);
});
