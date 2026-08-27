/**
 * MVP1-B13 — end to end, driven by the production Coordinator.
 *
 * Nothing here calls B6–B12 directly: the point is that `tickOnce()` does. Below the Coordinator
 * everything is real — the SQLite store, the state machines, every sealed use-case — and the only
 * doubles are the four things genuinely outside the Platform. A test moves one external fact and
 * ticks; the Platform decides what that means.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { auditDecisionOp, auditorTurn1Op } from "../core/execution/audit-operations.ts";
import { actorTurnOp } from "../core/execution/actor-operations.ts";
import { supervisorSpawnOp, supervisorTurnOp } from "../core/execution/supervisor-operations.ts";
import { AUDITOR_VERDICT_PROTOCOL } from "./support/execution-fixtures.ts";
import type { PendingDecisionV1 } from "../core/humandecision/types.ts";
import { BATCH_ID, RUN_ID, TASK_KEY, withWorld, type DomainWorld } from "./support/domain-fixtures.ts";
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

/**
 * The MVP 1 single-task batch: one admission slot, so filling it closes admission in the very
 * transaction that filled it (§19.3a) and §20.2 can complete once that task goes terminal.
 */
const SINGLE_TASK_BATCH = { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } };

const CANDIDATE_A = "9a8b7c6d5e4f30211203344556677889900aabbc";
const CANDIDATE_B = "1122334455667788990011223344556677889900";

/** The Attempt under test. `current` goes undefined once it is terminal, so fall back to the row. */
const attemptKey = (w: CoordinatorWorld): string => {
  const current = w.store.attempts.current(TASK_KEY);
  if (current !== undefined) return current.attempt_key;
  const all = w.store.attempts.forTask(TASK_KEY);
  return (all.at(-1) as { attempt_key: string }).attempt_key;
};

const state = (w: CoordinatorWorld) => ({
  attempt: w.store.attempts.require(attemptKey(w)).state,
  task: w.store.tasks.require(TASK_KEY).platform_state,
  batch: w.store.batches.require(BATCH_ID).status,
  run: w.store.runs.require(RUN_ID).status,
});

/**
 * Scripts the verification backend to return a passing, correctly bound evidence set.
 *
 * Each candidate's run mints its own evidence identity, exactly as a real backend does — the rows
 * are immutable, so a rework's evidence is a new record rather than a rewrite of the old one.
 */
const EVIDENCE_ID: Readonly<Record<string, string>> = {
  [CANDIDATE_A]: "01JQ8ZK5T7RC9V2W4X6Y8Z0K01",
  [CANDIDATE_B]: "01JQ8ZK5T7RC9V2W4X6Y8Z0K02",
};

const verificationPasses = (w: CoordinatorWorld, candidate: string): void => {
  const attempt = w.store.attempts.require(attemptKey(w));
  const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
  w.verification.completeWith([
    evidenceItem({
      evidence_id: EVIDENCE_ID[candidate] as string,
      check_id: REQUIRED_CHECK,
      target_commit: candidate,
      task_contract_hash: hash,
    }),
  ]);
};

/** Scripts the Auditor's structured verdict for whatever cycle is currently under review. */
const auditorSays = (
  w: CoordinatorWorld,
  verdict: "AUDIT_PASS" | "FIX_REQUIRED",
  candidate: string,
): void => {
  const attempt = w.store.attempts.require(attemptKey(w));
  const review = {
    candidate_commit: candidate,
    task_contract_hash: w.store.contracts.hashOf(attempt.contract_snapshot_id) as string,
    // The Auditor echoes the evidence for *this* candidate, which is what it was given.
    evidence_ids: w.store.verificationEvidence
      .forAttempt(attempt.attempt_key)
      .filter((row) => row.target_commit === candidate)
      .map((row) => row.evidence_id),
  };
  // The Auditor's turn is whichever one the launch just started; the fake returns by handle.
  const handle = w.store.adapterMetadata
    .forEntity(attempt.attempt_key)
    .find((row) => row.key.startsWith("auditor_turn-1:") && row.key.endsWith(candidate));
  assert.notEqual(handle, undefined, "there is no durable Auditor turn handle for this candidate");
  w.runtime.turnResults.set(
    JSON.stringify(handle?.value),
    auditorTurnResult({ body: auditorVerdict(review, { verdict }), protocol: AUDITOR_VERDICT_PROTOCOL }),
  );
};

/** The audit gate settles as the Platform asked. */
const gateSettles = (w: CoordinatorWorld): void => {
  w.verification.settlement = { kind: "SETTLED" };
};

// --- E2E 1: the happy path -------------------------------------------------------------------------

test("B13-30: the production Coordinator drives one Task from discovery to a completed run", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);

    // --- §26 step 4: the Coordinator asks the Supervisor -----------------------------------------
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    assert.equal(w.store.idempotency.get(supervisorSpawnOp(BATCH_ID, 1))?.state, "DONE");
    assert.equal(w.store.idempotency.get(supervisorTurnOp(BATCH_ID, 1))?.state, "DONE");
    assert.equal(w.runtime.spawnCalls.length, 1, "one run-level Supervisor session");

    // B13-8 / §39 — the turn's own reply cannot select anything. Ticking again changes nothing.
    assert.equal(w.tick(), "SUPERVISOR_AWAITING_PROPOSAL");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.equal(w.runtime.sendCalls.length, 1, "and it is not asked again every tick");

    // --- §26 steps 5–7: the Proposal arrives through the Platform API, then activation ------------
    submitSupervisorProposal(w, world);
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
    assert.equal(world.store.attempts.current(TASK_KEY), undefined, "no Attempt yet");

    // §26 step 7 — the Coordinator crosses the activation boundary itself.
    assert.equal(w.tick(), "ACTIVATED");
    assert.deepEqual(state(w), {
      attempt: "READY",
      task: "ACTIVE",
      batch: "RUNNING",
      run: "RUNNING",
    });

    // --- §26 step 8: the Coordinator launches the Actor -------------------------------------------
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    assert.equal(state(w).attempt, "IMPLEMENTING");
    assert.equal(
      w.store.idempotency.get(actorTurnOp(attemptKey(w), 1))?.state,
      "DONE",
      "the initial turn is actor-turn:1",
    );

    // --- §26 steps 9–10: the Actor's candidate, confirmed with the repository ----------------------
    actorProduced(w, CANDIDATE_A, 1);
    assert.equal(w.tick(), "VERIFICATION_STARTED");
    assert.equal(state(w).attempt, "VERIFYING");
    assert.equal(w.store.attempts.require(attemptKey(w)).candidate_commit, CANDIDATE_A);

    // --- §26 steps 11–12: verification, then the Auditor -------------------------------------------
    verificationPasses(w, CANDIDATE_A);
    assert.equal(w.tick(), "AUDIT_STARTED");
    assert.equal(state(w).attempt, "AUDITING");
    assert.equal(
      w.store.idempotency.get(auditorTurn1Op(attemptKey(w), CANDIDATE_A))?.state,
      "DONE",
    );

    // --- §26 steps 13–15: the verdict and its settlement -------------------------------------------
    auditorSays(w, "AUDIT_PASS", CANDIDATE_A);
    gateSettles(w);
    assert.equal(w.tick(), "AUDIT_COMPLETED");
    assert.equal(state(w).attempt, "READY_TO_MERGE");
    assert.equal(w.store.auditRecords.count(), 1);
    assert.equal(
      w.store.idempotency.get(auditDecisionOp(attemptKey(w), CANDIDATE_A))?.state,
      "DONE",
    );

    // --- §26 step 16 / B13-41: the merge approval ---------------------------------------------------
    assert.equal(w.tick(), "MERGE_APPROVAL_OPENED");
    const open = w.store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open.length, 1, "exactly one MERGE_APPROVAL");
    const approval = open[0]?.body as PendingDecisionV1;
    assert.equal(approval.category, "MERGE_APPROVAL");
    assert.deepEqual(state(w), {
      attempt: "READY_TO_MERGE",
      task: "HELD",
      batch: "RUNNING",
      run: "RUNNING",
    });
    assert.equal(
      w.store.tasks.require(TASK_KEY).state_reason?.code,
      `BLOCKED_BY_DECISION:${approval.decision_id}`,
    );

    // --- §26 step 17: a person approves, and the Coordinator applies it -----------------------------
    mergeAnswer(w, approval.decision_id, "APPROVE");
    assert.equal(w.tick(), "MERGE_APPROVAL_APPLIED");
    assert.deepEqual(state(w), {
      attempt: "APPROVED_FOR_MANUAL_MERGE",
      task: "ACTIVE",
      batch: "RUNNING",
      run: "RUNNING",
    });
    // B13-21 — approval is permission, not a merge.
    assert.notEqual(state(w).attempt, "MERGED");
    assert.equal(w.store.tasks.require(TASK_KEY).state_reason, null);

    // Not merged yet: canonical has not moved.
    assert.equal(w.tick(), "NOTHING_TO_DO");
    assert.equal(state(w).attempt, "APPROVED_FOR_MANUAL_MERGE");

    // --- §26 step 18: the person merged; only the repository can say so -----------------------------
    w.repository.head = CANDIDATE_A;
    assert.equal(w.tick(), "MERGE_OBSERVED");
    assert.equal(state(w).attempt, "MERGED");
    assert.equal(state(w).task, "COMPLETED");

    // --- §26 step 19: batch and run completion ------------------------------------------------------
    assert.equal(w.tick(), "RUN_COMPLETED");
    assert.deepEqual(state(w), {
      attempt: "MERGED",
      task: "COMPLETED",
      batch: "COMPLETED",
      run: "COMPLETED",
    });

    // B13-33 — the Platform merged nothing, ever.
    assert.equal(
      w.repository.calls.some((call) => /prepare_merge|commit_merge/.test(call)),
      false,
    );
    assert.equal(w.store.idempotency.keysWithPrefix(`op:${attemptKey(w)}:merge`).length, 0);
  }, SINGLE_TASK_BATCH);
});

test("B13-42: the batch summary is enqueued once, and transport cannot undo the completion", () => {
  withWorld((world) => {
    const w = driveToCompletion(world);
    const summary = w.store.outbox
      .pending()
      .filter((row) => (row.payload as { event?: string }).event === "BATCH_COMPLETE");
    assert.equal(summary.length, 1, "exactly one batch-complete summary");
    assert.equal(summary[0]?.sent_at, null, "unsent until confirmed");

    // A delivery that cannot be confirmed leaves everything durable exactly as it is.
    const failing = w.report as unknown as { deliver: () => never };
    failing.deliver = () => {
      throw new Error("the transport is down");
    };
    assert.equal(w.tick(), "NOTHING_TO_DO");
    assert.deepEqual(state(w), {
      attempt: "MERGED",
      task: "COMPLETED",
      batch: "COMPLETED",
      run: "COMPLETED",
    });
    assert.equal(w.store.outbox.get(summary[0]?.op_key as string)?.sent_at, null);

    // A confirmed one records `sent_at`, using the row's own identity.
    const seen: { op_key: string; channel: string }[] = [];
    (w.report as unknown as { deliver: (request: never) => unknown }).deliver = (request) => {
      seen.push(request as unknown as { op_key: string; channel: string });
      return { delivered: true };
    };
    // One row per tick, oldest first, each with its own identity — until the summary is sent too.
    const summaryKey = summary[0]?.op_key as string;
    w.until(() => w.store.outbox.get(summaryKey)?.sent_at !== null, 6);
    assert.equal(
      seen.some((request) => request.op_key === summaryKey),
      true,
      "the batch summary was delivered under its own op_key",
    );
    for (const request of seen) {
      assert.notEqual(w.store.outbox.get(request.op_key)?.sent_at, null);
    }
  }, SINGLE_TASK_BATCH);
});

// --- E2E 2: the rework path --------------------------------------------------------------------------

test("B13-31: FIX_REQUIRED reworks the same Attempt and reaches a completed run", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    submitSupervisorProposal(w, world);
    assert.equal(world.store.attempts.current(TASK_KEY), undefined, "no Attempt yet");
    assert.equal(w.tick(), "ACTIVATED", "the Coordinator activates, not the test");
    const attempt = attemptKey(w);
    const contract = w.store.attempts.require(attempt).contract_snapshot_id;
    const base = w.store.attempts.require(attempt).base_head;

    // Candidate A is audited and sent back for changes.
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    actorProduced(w, CANDIDATE_A, 1);
    assert.equal(w.tick(), "VERIFICATION_STARTED");
    verificationPasses(w, CANDIDATE_A);
    assert.equal(w.tick(), "AUDIT_STARTED");
    auditorSays(w, "FIX_REQUIRED", CANDIDATE_A);
    gateSettles(w);
    assert.equal(w.tick(), "AUDIT_COMPLETED");
    assert.equal(state(w).attempt, "REWORKING");
    assert.equal(w.store.attempts.require(attempt).rework_count, 0, "B13-18: before the rework");

    // --- the rework itself --------------------------------------------------------------------------
    const spawns = w.runtime.spawnCalls.length;
    const workspaces = w.repository.workspaceCount;
    assert.equal(w.tick(), "REWORK_STARTED");
    assert.equal(state(w).attempt, "IMPLEMENTING");
    // B13-18 — the count moved first, and the turn is 2.
    assert.equal(w.store.attempts.require(attempt).rework_count, 1);
    assert.equal(w.store.idempotency.get(actorTurnOp(attempt, 2))?.state, "DONE");
    assert.equal(w.store.idempotency.keysWithPrefix(`op:${attempt}:actor-turn:3`).length, 0);
    // B13-19 — nothing was re-created.
    assert.equal(w.runtime.spawnCalls.length, spawns, "the same Actor session");
    assert.equal(w.repository.workspaceCount, workspaces, "the same workspace");
    assert.equal(w.store.attempts.require(attempt).contract_snapshot_id, contract);
    assert.equal(w.store.attempts.require(attempt).base_head, base);
    assert.equal(w.store.attempts.forTask(TASK_KEY).length, 1, "no Attempt N+1");

    // --- candidate B goes round again ---------------------------------------------------------------
    actorProduced(w, CANDIDATE_B, 2);
    assert.equal(w.tick(), "VERIFICATION_STARTED");
    assert.equal(w.store.attempts.require(attempt).candidate_commit, CANDIDATE_B);
    verificationPasses(w, CANDIDATE_B);
    assert.equal(w.tick(), "AUDIT_STARTED");
    auditorSays(w, "AUDIT_PASS", CANDIDATE_B);
    gateSettles(w);
    assert.equal(w.tick(), "AUDIT_COMPLETED");
    assert.equal(state(w).attempt, "READY_TO_MERGE");

    // B13-44 — the two cycles never collide.
    for (const [a, b] of [
      [auditorTurn1Op(attempt, CANDIDATE_A), auditorTurn1Op(attempt, CANDIDATE_B)],
      [auditDecisionOp(attempt, CANDIDATE_A), auditDecisionOp(attempt, CANDIDATE_B)],
    ]) {
      assert.notEqual(a, b);
      assert.equal(w.store.idempotency.get(a as string)?.state, "DONE");
      assert.equal(w.store.idempotency.get(b as string)?.state, "DONE");
    }
    assert.equal(w.store.auditRecords.forAttempt(attempt).length, 2, "one record per cycle");

    // --- and through the human merge to a completed run ----------------------------------------------
    assert.equal(w.tick(), "MERGE_APPROVAL_OPENED");
    const approval = w.store.pendingDecisions.openFor(TASK_KEY)[0]?.body as PendingDecisionV1;
    mergeAnswer(w, approval.decision_id, "APPROVE");
    assert.equal(w.tick(), "MERGE_APPROVAL_APPLIED");
    w.repository.head = CANDIDATE_B;
    assert.equal(w.tick(), "MERGE_OBSERVED");
    assert.equal(w.tick(), "RUN_COMPLETED");
    assert.deepEqual(state(w), {
      attempt: "MERGED",
      task: "COMPLETED",
      batch: "COMPLETED",
      run: "COMPLETED",
    });
  }, SINGLE_TASK_BATCH);
});

// --- shared driver --------------------------------------------------------------------------------------

/** The happy path again, compressed, for tests that assert on what it leaves behind. */
function driveToCompletion(world: DomainWorld): CoordinatorWorld {
  const w = coordinatorWorld(world);
  w.tick();
  submitSupervisorProposal(w, world);
  w.tick();
  w.tick();
  actorProduced(w, CANDIDATE_A, 1);
  w.tick();
  verificationPasses(w, CANDIDATE_A);
  w.tick();
  auditorSays(w, "AUDIT_PASS", CANDIDATE_A);
  gateSettles(w);
  w.tick();
  w.tick();
  const approval = w.store.pendingDecisions.openFor(TASK_KEY)[0]?.body as PendingDecisionV1;
  mergeAnswer(w, approval.decision_id, "APPROVE");
  w.tick();
  w.repository.head = CANDIDATE_A;
  w.tick();
  w.tick();
  assert.equal(w.store.runs.require(RUN_ID).status, "COMPLETED");
  return w;
}
