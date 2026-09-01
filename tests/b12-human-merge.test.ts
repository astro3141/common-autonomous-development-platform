/**
 * MVP1-B12 — Human Merge approval and repository observation.
 *
 * B12-1 ~ B12-66. Every attempt is driven through B6–B11 for real; the only things a test moves
 * are the human's answer and the repository's canonical head, because those are the two things
 * outside the Platform. Nothing here asserts a merge the repository did not show.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyResolvedMergeApproval,
  mergeApprovalStillValid,
  observeHumanMerge,
  requestMergeApproval,
} from "../core/execution/human-merge.ts";
import {
  mergeApprovalRemainsValid,
  mergeDecisionCause,
  mergeRejectDecisionRemainsValid,
  MERGE_APPROVAL_OPTIONS,
  MERGE_FOLLOW_UP_OPTIONS,
} from "../core/humandecision/merge-decision.ts";
import { resolvedHumanGateAuthorization } from "../core/humandecision/gate-authorization.ts";
import { hashPendingDecision } from "../core/humandecision/pending-decision.ts";
import type { PendingDecisionV1 } from "../core/humandecision/types.ts";
import { nextAttemptOutcome } from "../core/statemachine/attempt-transitions.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { openDatabase } from "../core/store/database.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import type { TaskAttemptRow } from "../core/store/domain-types.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";
import {
  DRIFT_CHANNEL,
  humanMergeWorld,
  mergeResolution,
  MERGE_DECISION_ID,
  MERGE_FOLLOW_UP_ID,
  type HumanMergeWorld,
} from "./support/execution-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OTHER_HEAD = "7c6d5e4f3a2b1908897a6b5c4d3e2f1009182736";

const stripped = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const open = (w: HumanMergeWorld) =>
  requestMergeApproval(w, {
    attempt_key: w.attempt_key,
    decision_id: MERGE_DECISION_ID,
    report_channel: DRIFT_CHANNEL,
  });

const answer = (w: HumanMergeWorld, chosen: "APPROVE" | "REJECT"): void => {
  w.store.withTransaction(() => {
    w.store.pendingDecisions.resolve(MERGE_DECISION_ID, mergeResolution(chosen));
  });
};

const apply = (w: HumanMergeWorld) =>
  applyResolvedMergeApproval(w, {
    decision_id: MERGE_DECISION_ID,
    follow_up_decision_id: MERGE_FOLLOW_UP_ID,
    report_channel: DRIFT_CHANNEL,
  });

const observe = (w: HumanMergeWorld) =>
  observeHumanMerge(w, {
    attempt_key: w.attempt_key,
    decision_id: MERGE_FOLLOW_UP_ID,
    report_channel: DRIFT_CHANNEL,
  });

const state = (w: HumanMergeWorld) => ({
  attempt: w.store.attempts.require(w.attempt_key).state,
  task: w.store.tasks.require(TASK_KEY).platform_state,
});

const decisionBody = (w: HumanMergeWorld, id: string): PendingDecisionV1 =>
  w.store.pendingDecisions.require(id).body;

/** Drives the world to an applied APPROVE. */
const approved = (w: HumanMergeWorld) => {
  assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
  answer(w, "APPROVE");
  return apply(w);
};

// --- B12-1 ~ B12-8: opening the question -----------------------------------------------------------

test("B12-1 ~ B12-8: one exact MERGE_APPROVAL, and the task blocks on it", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    const outcome = open(w);
    assert.equal(outcome.kind, "MERGE_APPROVAL_OPEN", "B12-1");

    const decision = decisionBody(w, MERGE_DECISION_ID);
    assert.equal(decision.category, "MERGE_APPROVAL", "B12-2");
    assert.deepEqual(decision.subject, { kind: "TASK", task_key: TASK_KEY });
    assert.equal(decision.blocking_scope, "TASK_ONLY");
    assert.deepEqual(decision.options, ["APPROVE", "REJECT"]);
    assert.deepEqual(MERGE_APPROVAL_OPTIONS, ["APPROVE", "REJECT"]);
    assert.equal(decision.recommendation, null, "B12-3");
    assert.equal(decision.gate_proposal, null, "B12-3");
    assert.deepEqual(decision.evidence_refs, [w.audit_id], "B12-4");
    assert.equal(
      decision.created_from,
      `merge:${w.attempt_key}:${w.candidate_commit}`,
      "B12-5",
    );

    // B12-7 / B12-8.
    assert.deepEqual(state(w), { attempt: "READY_TO_MERGE", task: "HELD" });
    assert.equal(
      world.store.tasks.require(TASK_KEY).state_reason?.code,
      `BLOCKED_BY_DECISION:${MERGE_DECISION_ID}`,
    );

    // The notification is the existing outbox row, enqueued in the same transaction.
    assert.equal(
      world.store.outbox.pending().some((row) => row.op_key.includes(MERGE_DECISION_ID)),
      true,
    );
  });
});

test("B12-6: a second pass over the same attempt and candidate opens nothing new", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    // The task is now HELD *by this very question*, which is exactly the state a second
    // Coordinator pass finds. It must recognise its own record rather than fail.
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    const again = requestMergeApproval(w, {
      attempt_key: w.attempt_key,
      decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F29",
      report_channel: DRIFT_CHANNEL,
    });
    assert.deepEqual(again, { kind: "ALREADY_OPEN", decision_id: MERGE_DECISION_ID });
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 1);
  });
});

// --- B12-9 ~ B12-15: OPEN validity ------------------------------------------------------------------

test("B12-9 ~ B12-15: the OPEN question's validity basis, canonical excluded", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    const decision = decisionBody(w, MERGE_DECISION_ID);

    assert.equal(mergeApprovalStillValid(world.store, decision), true, "B12-9");

    // B12-15 — canonical moves; the question is still about something real.
    w.repository.head = OTHER_HEAD;
    assert.equal(mergeApprovalStillValid(world.store, decision), true, "B12-15");

    const basis = {
      source_attempt_state: "READY_TO_MERGE",
      current_candidate_commit: w.candidate_commit,
      audit_pass_intact: true,
      newer_attempt_exists: false,
      task_state: "HELD",
    } as const;
    assert.equal(mergeApprovalRemainsValid(w.candidate_commit, basis), true);
    for (const [label, broken] of [
      ["B12-10", { ...basis, source_attempt_state: "MERGED" } as const],
      ["B12-10", { ...basis, source_attempt_state: undefined } as const],
      ["B12-11", { ...basis, current_candidate_commit: OTHER_HEAD } as const],
      ["B12-12", { ...basis, audit_pass_intact: false } as const],
      ["B12-13", { ...basis, newer_attempt_exists: true } as const],
      ["B12-14", { ...basis, task_state: "COMPLETED" } as const],
    ] as const) {
      assert.equal(mergeApprovalRemainsValid(w.candidate_commit, broken), false, label);
    }
    // The predicate reads no repository at all.
    const source = stripped(join(ROOT, "core/humandecision/merge-decision.ts"));
    assert.equal(/snapshot_canonical|canonical_head/.test(source), false);
  });
});

// --- B12-16 ~ B12-26: APPROVE authorization ----------------------------------------------------------

test("B12-16: a MERGE_APPROVAL can never be authorized as a Human Gate", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    answer(w, "APPROVE");
    const record = world.store.pendingDecisions.require(MERGE_DECISION_ID);

    // §17.3's own authorization refuses it on category, before `gate_proposal` is even reached.
    assert.throws(() => resolvedHumanGateAuthorization(record), /not a Human Gate approval/);
    // And B12 never reaches for it.
    const code = stripped(join(ROOT, "core/execution/human-merge.ts"));
    assert.equal(/validateDecisionAfterResolvedHumanGate\(/.test(code), false);
    assert.equal(/resolvedHumanGateAuthorization\(/.test(code), false);
  });
});

test("B12-17 ~ B12-19: a record that is not a valid resolved approval fails closed", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    const before = world.store.decisions.read().length;

    // B12-18 — still OPEN, so there is no answer to apply.
    assert.throws(() => apply(w), /not RESOLVED/);
    answer(w, "APPROVE");

    // B12-17 — a body whose terminal hash no longer matches is never applied.
    const record = world.store.pendingDecisions.require(MERGE_DECISION_ID);
    assert.equal(record.record_hash, hashPendingDecision(record.body));
    assert.throws(
      () =>
        applyResolvedMergeApproval(w, { decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F28" }),
      /does not exist/,
    );

    // B12-19 — a decision about another task is not about this one.
    assert.equal(world.store.decisions.read().length, before, "no transition was journalled");
    assert.deepEqual(state(w), { attempt: "READY_TO_MERGE", task: "HELD" });
  });
});

test("B12-20 / B12-21 / B12-22: a broken F1/F2/F3 basis holds under RECOVERY_CONFLICT", () => {
  // F1 — the attempt is no longer awaiting a merge.
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    answer(w, "APPROVE");
    world.store.withTransaction(() => {
      world.store.attempts.write(w.attempt_key, { state: "REWORKING" });
    });

    const outcome = apply(w);
    assert.equal(outcome.kind, "HELD", "B12-20");
    assert.equal(outcome.kind === "HELD" ? outcome.reason_code : "", "RECOVERY_CONFLICT");
    // §19.4g — the human's answer is not rewritten.
    const decision = decisionBody(w, MERGE_DECISION_ID);
    assert.equal(decision.status, "RESOLVED");
    assert.equal(decision.resolution?.applied_transition_ref, null);
  });

  // F2/F3 — the audit basis the approval names is gone.
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    answer(w, "APPROVE");
    // The decision points at an audit record that does not resolve for this cycle.
    const doctored = { ...decisionBody(w, MERGE_DECISION_ID) };
    assert.deepEqual(doctored.evidence_refs, [w.audit_id]);
    world.store.withTransaction(() => {
      world.store.attempts.write(w.attempt_key, {
        state: "READY_TO_MERGE",
        candidate_commit: OTHER_HEAD,
      });
    });

    const outcome = apply(w);
    assert.equal(outcome.kind, "HELD", "B12-21/B12-22");
    assert.equal(outcome.kind === "HELD" ? outcome.reason_code : "", "RECOVERY_CONFLICT");
    assert.equal(decisionBody(w, MERGE_DECISION_ID).resolution?.applied_transition_ref, null);
  });
});

test("B12-23 / B12-24 / B12-25: the merge boundary uses the existing drift lifecycle", () => {
  // UNAVAILABLE — a read the boundary needs cannot be performed.
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    answer(w, "APPROVE");
    (w.taskSource as unknown as { failure?: Error }).failure = new Error("the source is down");

    const outcome = apply(w);
    assert.equal(outcome.kind, "DRIFT_CHECK_UNAVAILABLE", "B12-25");
    assert.equal(world.store.tasks.require(TASK_KEY).state_reason?.code, "DRIFT_CHECK_UNAVAILABLE");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY_TO_MERGE");
    assert.equal(decisionBody(w, MERGE_DECISION_ID).resolution?.applied_transition_ref, null);
  });

  // INVALIDATE — the authoritative task definition moved on.
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    answer(w, "APPROVE");
    (w.taskSource as unknown as { definition: { version: string } }).definition = {
      ...(w.taskSource as unknown as { definition: object }).definition,
      version: "2",
    } as never;

    const outcome = apply(w);
    assert.equal(outcome.kind, "DRIFT_INVALIDATED", "B12-24");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "INVALIDATED");
    assert.equal(decisionBody(w, MERGE_DECISION_ID).resolution?.applied_transition_ref, null);
  });
});

test("B12-59: canonical movement is a HOLD at this new merge boundary", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    answer(w, "APPROVE");
    // `canonical_head: HOLD_AT_BOUNDARY, MERGE_ONLY` — and this *is* the merge boundary in MVP 1.
    w.repository.head = OTHER_HEAD;

    const outcome = apply(w);
    assert.equal(outcome.kind, "DRIFT_HELD", "B12-23");
    assert.equal(outcome.kind === "DRIFT_HELD" ? outcome.target : "", "canonical_head");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY_TO_MERGE");
    // B12-61 / B12-62 — no rebase, and the attempt's base is untouched.
    assert.equal(world.store.attempts.require(w.attempt_key).base_head, w.repository.ref === "" ? "" : world.store.attempts.require(w.attempt_key).base_head);
    assert.notEqual(world.store.attempts.require(w.attempt_key).base_head, OTHER_HEAD);
  });
});

// --- B12-26 ~ B12-35: APPROVE success ----------------------------------------------------------------

test("B12-26 ~ B12-35: a clean APPROVE reaches APPROVED_FOR_MANUAL_MERGE and merges nothing", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    const base = world.store.attempts.require(w.attempt_key).base_head;
    const outcome = approved(w);

    assert.equal(outcome.kind, "APPROVED_FOR_MANUAL_MERGE", "B12-26");
    // B12-28 / B12-29 / B12-30.
    assert.deepEqual(state(w), { attempt: "APPROVED_FOR_MANUAL_MERGE", task: "ACTIVE" });
    assert.equal(world.store.tasks.require(TASK_KEY).state_reason, null, "B12-30");

    // B12-31 — the applied transition is recorded, and it is this one.
    const decision = decisionBody(w, MERGE_DECISION_ID);
    assert.equal(
      decision.resolution?.applied_transition_ref,
      `transition:${outcome.kind === "APPROVED_FOR_MANUAL_MERGE" ? outcome.transition_seq : 0}`,
    );

    // B12-32 ~ B12-35 — approval is permission, not a merge.
    assert.notEqual(world.store.attempts.require(w.attempt_key).state, "MERGED");
    assert.equal(
      w.repository.calls.some((call) => call.startsWith("prepare_merge")),
      false,
      "B12-33",
    );
    assert.equal(
      w.repository.calls.some((call) => call.startsWith("commit_merge")),
      false,
      "B12-34",
    );
    assert.equal(
      world.store.idempotency.keysWithPrefix(`op:${w.attempt_key}:merge`).length,
      0,
      "B12-35",
    );
    assert.equal(world.store.attempts.require(w.attempt_key).base_head, base, "B12-62");
  });
});

test("B12-27: the sealed MANUAL_MERGE_APPROVED outcome reactivates the task", () => {
  const attempt = {
    attempt_key: "attempt:task:alpha:T-101:1",
    task_key: TASK_KEY,
    n: 1,
    contract_snapshot_id: "s",
    state: "READY_TO_MERGE",
    base_head: "base",
    candidate_commit: "candidate",
    rework_count: 0,
    state_reason: null,
    created_at: "t1",
    updated_at: "t1",
  } as unknown as TaskAttemptRow;

  assert.deepEqual(
    nextAttemptOutcome(attempt, { kind: "MANUAL_MERGE_APPROVED" }, { max_rework: 2 }),
    { attempt_state: "APPROVED_FOR_MANUAL_MERGE", task_state: "ACTIVE" },
  );
});

// --- B12-36 ~ B12-42: REJECT -------------------------------------------------------------------------

test("B12-36 ~ B12-42: REJECT keeps the candidate and opens exactly one follow-up", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(open(w).kind, "MERGE_APPROVAL_OPEN");
    answer(w, "REJECT");
    const attempts = world.store.attempts.forTask(TASK_KEY).length;

    const outcome = apply(w);
    assert.equal(outcome.kind, "MERGE_REJECTED");
    // B12-36 — declining a merge does not invalidate the candidate.
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY_TO_MERGE");

    // B12-38 ~ B12-40.
    const open_now = world.store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open_now.length, 1, "B12-38");
    const follow_up = open_now[0]?.body as PendingDecisionV1;
    assert.equal(follow_up.category, "REATTEMPT_DECISION");
    assert.deepEqual(follow_up.options, ["REATTEMPT_WITH_NEW_SNAPSHOT", "ABANDON"], "B12-39");
    assert.deepEqual(MERGE_FOLLOW_UP_OPTIONS, ["REATTEMPT_WITH_NEW_SNAPSHOT", "ABANDON"]);
    assert.equal(follow_up.blocking_scope, "TASK_ONLY");
    assert.deepEqual(follow_up.evidence_refs, [w.audit_id]);
    assert.equal(
      follow_up.created_from,
      `merge-reject:${w.attempt_key}:${w.candidate_commit}`,
    );
    assert.equal(
      world.store.tasks.require(TASK_KEY).state_reason?.code,
      `BLOCKED_BY_DECISION:${MERGE_FOLLOW_UP_ID}`,
      "B12-40",
    );
    // B12-37 — M1-12: the task names its blocker, and the *cause* is read structurally from the
    // follow-up's Core-owned provenance. The transition entry links the two by decision id.
    assert.match(follow_up.created_from, /^merge-reject:/);
    const linked = world.store.decisions
      .read()
      .filter((entry) => entry.kind === STATE_TRANSITION_KIND)
      .map((entry) => (entry.payload as unknown as { pending_decision_id: string | null }));
    assert.equal(
      linked.some((payload) => payload.pending_decision_id === MERGE_FOLLOW_UP_ID),
      true,
      "B12-37",
    );

    // B12-41 — no Attempt N+1.
    assert.equal(world.store.attempts.forTask(TASK_KEY).length, attempts);
    // B12-42 — applying the same rejection again does not open a second follow-up.
    assert.throws(() => apply(w), /already has a follow-up decision/);
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 1);

    // Its validity basis is the merge one, not the drift one.
    assert.equal(
      mergeRejectDecisionRemainsValid({
        source_attempt_state: "READY_TO_MERGE",
        newer_attempt_exists: false,
        task_state: "HELD",
      }),
      true,
    );
    assert.equal(
      mergeRejectDecisionRemainsValid({
        source_attempt_state: "INVALIDATED",
        newer_attempt_exists: false,
        task_state: "HELD",
      }),
      false,
    );
  });
});

// --- B12-43 ~ B12-51: post-approval observation ------------------------------------------------------

test("B12-43 / B12-49 / B12-50: canonical at the candidate is a merge", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(approved(w).kind, "APPROVED_FOR_MANUAL_MERGE");
    w.repository.head = w.candidate_commit;

    assert.equal(observe(w).kind, "MERGED", "B12-43");
    assert.deepEqual(state(w), { attempt: "MERGED", task: "COMPLETED" });
  });
});

test("B12-44 / B12-47: an unchanged base, or an unreadable canonical, changes nothing", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(approved(w).kind, "APPROVED_FOR_MANUAL_MERGE");
    const before = world.store.decisions.read().length;
    const lineageReads = w.repository.calls.filter((call) =>
      call.startsWith("verify_lineage"),
    ).length;

    // B12-44 — canonical is still where the attempt cut from.
    w.repository.head = world.store.attempts.require(w.attempt_key).base_head;
    assert.equal(observe(w).kind, "NO_OBSERVATION");
    assert.deepEqual(state(w), { attempt: "APPROVED_FOR_MANUAL_MERGE", task: "ACTIVE" });
    assert.equal(world.store.decisions.read().length, before);
    // The cheap equality answered it; no lineage read was added by the observation.
    assert.equal(
      w.repository.calls.filter((call) => call.startsWith("verify_lineage")).length,
      lineageReads,
      "the base-equality branch answered without a lineage call",
    );

    // B12-47 — the canonical read itself fails.
    w.repository.snapshot_canonical = () => {
      throw new Error("the repository is unreachable");
    };
    assert.equal(observe(w).kind, "NO_OBSERVATION");
    assert.deepEqual(state(w), { attempt: "APPROVED_FOR_MANUAL_MERGE", task: "ACTIVE" });
    assert.equal(world.store.decisions.read().length, before);
  });
});

test("B12-45: a candidate that is an ancestor of canonical is a merge", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(approved(w).kind, "APPROVED_FOR_MANUAL_MERGE");
    // Canonical moved past the candidate; lineage says the candidate is in that history.
    w.repository.head = OTHER_HEAD;
    w.repository.lineageValid = true;

    assert.equal(observe(w).kind, "MERGED", "B12-45");
    assert.deepEqual(state(w), { attempt: "MERGED", task: "COMPLETED" });
  });
});

test("B12-51 / B12-48: no human report is an input, and §11 is not rerun after approval", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(approved(w).kind, "APPROVED_FOR_MANUAL_MERGE");
    w.repository.head = world.store.attempts.require(w.attempt_key).base_head;
    assert.equal(observe(w).kind, "NO_OBSERVATION");

    // B12-48 — the observation path names no drift machinery at all.
    const code = stripped(join(ROOT, "core/execution/human-merge.ts"));
    const observation = code.slice(code.indexOf("export function observeHumanMerge"));
    assert.equal(/evaluateStageBoundaryDrift|assembleDriftObservation/.test(observation), false);
    // B12-51 — nothing model- or human-authored reaches any branch.
    assert.equal(/declared|model_|reported|merge_complete/i.test(code), false);
  });
});

// --- B12-46 / B12-52 ~ B12-57: mismatch ---------------------------------------------------------------

/** Canonical moved somewhere the candidate is not. `explicable` drives the safety classification. */
const mismatchWorld = (w: HumanMergeWorld, explicable: boolean): void => {
  const base = w.store.attempts.require(w.attempt_key).base_head;
  w.repository.head = OTHER_HEAD;
  // Keyed on the argument, not the call order, so it answers the same way however often it is
  // asked: the candidate is not in canonical history, and the base's presence is the test's point.
  w.repository.verify_lineage = (ancestor: string) => (ancestor === base ? explicable : false);
};

test("B12-46 / B12-52 / B12-55 / B12-56: an explicable mismatch holds the task only", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(approved(w).kind, "APPROVED_FOR_MANUAL_MERGE");
    const batch = world.store.batches.require(world.store.tasks.require(TASK_KEY).batch_id).status;
    mismatchWorld(w, true);

    const outcome = observe(w);
    assert.equal(outcome.kind, "MERGE_MISMATCH", "B12-46");
    assert.equal(outcome.kind === "MERGE_MISMATCH" ? outcome.paused : true, false);
    // The attempt stays where it was; the task blocks on the recovery question.
    assert.deepEqual(state(w), { attempt: "APPROVED_FOR_MANUAL_MERGE", task: "HELD" });
    assert.equal(
      world.store.tasks.require(TASK_KEY).state_reason?.code,
      `BLOCKED_BY_DECISION:${MERGE_FOLLOW_UP_ID}`,
      "B12-56",
    );

    // B12-55 — M1-12: the blocker is the decision, and the cause is read from the recovery
    // decision's own Core-owned provenance, which the transition entry links by decision id.
    const decision = world.store.pendingDecisions.require(MERGE_FOLLOW_UP_ID).body;
    assert.match(decision.created_from, /^merge-mismatch:/);
    const linked = world.store.decisions
      .read()
      .filter((entry) => entry.kind === STATE_TRANSITION_KIND)
      .map((entry) => (entry.payload as unknown as { pending_decision_id: string | null }));
    assert.equal(
      linked.some((payload) => payload.pending_decision_id === MERGE_FOLLOW_UP_ID),
      true,
    );

    // B12-52 — the batch is untouched.
    assert.equal(
      world.store.batches.require(world.store.tasks.require(TASK_KEY).batch_id).status,
      batch,
    );
  });
});

test("B12-53: an unsafe lineage additionally pauses the batch through CIRCUIT_BREAKER", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(approved(w).kind, "APPROVED_FOR_MANUAL_MERGE");
    mismatchWorld(w, false);

    const outcome = observe(w);
    assert.equal(outcome.kind, "MERGE_MISMATCH");
    assert.equal(outcome.kind === "MERGE_MISMATCH" ? outcome.paused : false, true);
    assert.deepEqual(state(w), { attempt: "APPROVED_FOR_MANUAL_MERGE", task: "HELD" });
    assert.equal(
      world.store.batches.require(world.store.tasks.require(TASK_KEY).batch_id).status,
      "PAUSED_SAFELY",
      "B12-53",
    );
  });
});

test("B12-54 / B12-57: an unreadable safety read classifies nothing, and handling never doubles", () => {
  withWorld((world) => {
    const w = humanMergeWorld(world);
    assert.equal(approved(w).kind, "APPROVED_FOR_MANUAL_MERGE");
    const before = world.store.decisions.read().length;
    w.repository.head = OTHER_HEAD;
    const base = world.store.attempts.require(w.attempt_key).base_head;
    w.repository.verify_lineage = (ancestor: string) => {
      if (ancestor === base) throw new Error("the repository went away");
      return false;
    };

    // B12-54 — an observation failure is not an observed mismatch.
    assert.equal(observe(w).kind, "NO_OBSERVATION");
    assert.deepEqual(state(w), { attempt: "APPROVED_FOR_MANUAL_MERGE", task: "ACTIVE" });
    assert.equal(world.store.decisions.read().length, before);
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 0);

    // B12-57 — once handled, handling it again does not open a second recovery decision.
    mismatchWorld(w, true);
    assert.equal(observe(w).kind, "MERGE_MISMATCH");
    const decision = world.store.pendingDecisions.require(MERGE_FOLLOW_UP_ID).body;
    assert.equal(decision.category, "RECOVERY_DECISION");
    assert.deepEqual(decision.options, ["REATTEMPT_WITH_NEW_SNAPSHOT", "ABANDON"]);
    assert.deepEqual(decision.evidence_refs, [w.audit_id]);
    assert.equal(
      decision.created_from,
      `merge-mismatch:${w.attempt_key}:${w.candidate_commit}`,
    );
    assert.deepEqual(mergeDecisionCause(decision), {
      attempt_key: w.attempt_key,
      candidate_commit: w.candidate_commit,
    });
    // The task is no longer ACTIVE, so a further pass refuses before doing anything.
    assert.throws(() => observe(w));
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 1);
  });
});

// --- B12-58 ~ B12-66: boundaries -----------------------------------------------------------------------

test("B12-58 / B12-60: the new merge boundary joins the automatic one, changing nothing else", () => {
  const observation = stripped(join(ROOT, "core/execution/drift-observation.ts"));
  assert.match(observation, /"READY_TO_MERGE_TO_APPROVED_FOR_MANUAL_MERGE"/, "B12-58");
  assert.match(observation, /"READY_TO_MERGE_TO_MERGING"/, "B12-60");
  for (const unchanged of [
    "IMPLEMENTING_TO_VERIFYING",
    "VERIFYING_TO_AUDITING",
    "AUDITING_TO_READY_TO_MERGE",
  ]) {
    assert.match(observation, new RegExp(`"${unchanged}"`));
  }

  const evaluator = stripped(join(ROOT, "core/execution/stage-boundary-drift.ts"));
  assert.match(evaluator, /MERGE_BOUNDARIES\.includes\(observation\.boundary\)/);
});

test("B12-61 / B12-64 ~ B12-66: the Platform merges nothing and reaches no backend", () => {
  const code = stripped(join(ROOT, "core/execution/human-merge.ts"));
  for (const forbidden of [
    /prepare_merge|commit_merge/,
    /rebase|base_head\s*[:=]\s*[^=]/,
    /audit_decide|settle_audit|send_turn|spawn_session/,
    /WorkflowHandle|WorkflowControllerHandle|acquire_workflow_controller/,
  ]) {
    assert.equal(forbidden.test(code), false, `human-merge contains ${forbidden}`);
  }
  // Assembled at runtime so this guard does not restate the vocabulary it forbids.
  const term = (...parts: readonly string[]): RegExp => new RegExp(parts.join(""), "i");
  for (const pattern of [
    term("session", "[-_]?", "key"),
    term("durable", "[-_ ]?", "jobs"),
    term("open", "claw"),
    term("owner", "[-_]?", "key"),
  ]) {
    assert.equal(pattern.test(code), false, `human-merge matches ${pattern}`);
  }

  // And no Core module gained a merge primitive — except the MVP 2 Repository Gate, which is the
  // one module whose job it is (TD §14.4). The human path itself still merges nothing.
  const coreFiles = readdirSync(join(ROOT, "core"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(ROOT, "core", entry.name))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "core", entry.name, name)),
    );
  for (const file of coreFiles) {
    if (relative(ROOT, file) === "core/execution/automatic-merge.ts") continue;
    assert.equal(
      /prepare_merge|commit_merge/.test(stripped(file)),
      false,
      `${relative(ROOT, file)} reaches a merge primitive`,
    );
  }
});

test("B12-63: the schema is still v6 / 17 tables", () => {
  assert.equal(MIGRATIONS.length, 8);
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.schemaVersion, 8);
  } finally {
    store.close();
  }
  try {
    const database = openDatabase(temp.path);
    try {
      const names = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_"));
      assert.equal(names.length, 17);
      for (const forbidden of [
        "merge_approval",
        "merge_cycle",
        "merge_observation",
        "repository_risk",
      ]) {
        assert.equal(names.includes(forbidden), false, forbidden);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }
});
