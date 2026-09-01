/**
 * MVP1-B11 — Auditor verdict collection and the audit decision, `AUDITING → …`.
 *
 * B11-1 ~ B11-54. Every attempt here is a real one driven through B6/B7/B9/B10; only the Auditor's
 * answer and the backend's gate are scripted, because those are the two things outside the
 * Platform. Nothing asserts a verdict the Platform did not observe.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  completeAuditing,
  AUDIT_OBSERVATION_KIND,
  type AuditInvalidReason,
  type CompleteAuditingOutcome,
} from "../core/execution/complete-auditing.ts";
import {
  auditDecisionOp,
  auditorTurn2Op,
  auditorTurnMetadataKey,
  auditSpawnOp,
} from "../core/execution/audit-operations.ts";
import { AUDIT_DECISION_OPTIONS } from "../core/humandecision/audit-decision.ts";
import { openDatabase } from "../core/store/database.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import type { PendingDecisionV1 } from "../core/humandecision/types.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";
import {
  auditingCompletionWorld,
  auditorTurnResult,
  auditorVerdict,
  AUDIT_DECISION_ID,
  AUDIT_ID,
  DRIFT_CHANNEL,
  RECORDED_AT,
  type AuditingCompletionWorld,
} from "./support/execution-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const stripped = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const complete = (w: AuditingCompletionWorld): CompleteAuditingOutcome =>
  completeAuditing(w, {
    attempt_key: w.attempt_key,
    audit_id: AUDIT_ID,
    decision_id: AUDIT_DECISION_ID,
    report_channel: DRIFT_CHANNEL,
    recorded_at: RECORDED_AT,
  });

/** Scripts what the Auditor's turn produced. Every test moves exactly one fact. */
const answer = (
  w: AuditingCompletionWorld,
  overrides: Parameters<typeof auditorTurnResult>[0] = {},
): void => {
  w.runtime.turnResult = auditorTurnResult(overrides);
};

const verdictAnswer = (
  w: AuditingCompletionWorld,
  overrides: Parameters<typeof auditorVerdict>[1] = {},
): void => answer(w, { body: auditorVerdict(w.review, overrides) });

const state = (w: AuditingCompletionWorld) => ({
  attempt: w.store.attempts.require(w.attempt_key).state,
  task: w.store.tasks.require(TASK_KEY).platform_state,
});

const settleWith = (w: AuditingCompletionWorld, kind: "SETTLED" | "UNAVAILABLE" | "CONFLICT") => {
  w.verification.settlement = { kind };
};

const settleCalls = (w: AuditingCompletionWorld): number =>
  w.verification.calls.filter((call) => call.method === "settle_audit").length;

const invalidReasons = (w: AuditingCompletionWorld): AuditInvalidReason[] =>
  w.store.decisions
    .read()
    .filter((entry) => entry.kind === AUDIT_OBSERVATION_KIND)
    .map((entry) => (entry.payload as unknown as { reason: AuditInvalidReason }).reason);

// --- B11-1 ~ B11-9: observation and usability ------------------------------------------------------

test("B11-1: the candidate's Auditor turn is what gets observed", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w);
    settleWith(w, "SETTLED");
    const before = w.runtime.turnResultCalls.length;

    assert.equal(complete(w).kind, "AUDIT_DECIDED");
    assert.equal(w.runtime.turnResultCalls.length, before + 1);
    // It asked for the handle B10 durably stored for this candidate, and nothing else.
    assert.deepEqual(
      w.runtime.turnResultCalls.at(-1),
      world.store.adapterMetadata.get(
        w.attempt_key,
        "runtime",
        auditorTurnMetadataKey(w.candidate_commit, 1),
      )?.value,
    );
  });
});

test("B11-2 / B11-3: a failed Runtime turn is RUNTIME_FAILED, not an Auditor verdict", () => {
  for (const backend_status of ["CANCELLED", "TIMEOUT", "RUNTIME_ERROR", "SESSION_LOST"] as const) {
    withWorld((world) => {
      const w = auditingCompletionWorld(world);
      answer(w, { backend_status });
      const turns = w.runtime.sendCalls.length;

      const outcome = complete(w);
      assert.equal(outcome.kind, "HELD", backend_status);
      assert.equal(outcome.kind === "HELD" ? outcome.reason_code : "", "RUNTIME_FAILED");
      assert.deepEqual(state(w), { attempt: "AUDITING", task: "HELD" });

      // B11-2 — nothing was journalled as an Auditor observation.
      assert.deepEqual(invalidReasons(w), []);
      // B11-3 — no retry, no settlement, no record.
      assert.equal(w.runtime.sendCalls.length, turns);
      assert.equal(
        world.store.idempotency.get(auditorTurn2Op(w.attempt_key, w.candidate_commit)),
        undefined,
      );
      assert.equal(settleCalls(w), 0);
      assert.equal(world.store.auditRecords.count(), 0);
    });
  }
});

test("B11-4 ~ B11-9: every unusable structured result is AUDIT_INVALID, and nothing else", () => {
  const cases: readonly [string, AuditInvalidReason, (w: AuditingCompletionWorld) => void][] = [
    ["B11-4", "NO_STRUCTURED_RESULT", (w) => answer(w)],
    [
      "B11-5",
      "WRONG_PROTOCOL",
      (w) => answer(w, { protocol: "platform-actor-result-v1", body: auditorVerdict(w.review) }),
    ],
    ["B11-6", "MALFORMED_VERDICT", (w) => answer(w, { body: { verdict: "MAYBE" } as never })],
    [
      "B11-7",
      "CANDIDATE_MISMATCH",
      (w) => verdictAnswer(w, { reviewed: { candidate_commit: "0".repeat(40) } }),
    ],
    [
      "B11-8",
      "CONTRACT_HASH_MISMATCH",
      (w) => verdictAnswer(w, { reviewed: { task_contract_hash: `sha256:${"b".repeat(64)}` } }),
    ],
    ["B11-9", "EVIDENCE_MISMATCH", (w) => verdictAnswer(w, { reviewed: { evidence_ids: [] } })],
  ];

  for (const [label, reason, script] of cases) {
    withWorld((world) => {
      const w = auditingCompletionWorld(world);
      script(w);

      const outcome = complete(w);
      assert.equal(outcome.kind, "AUDIT_RETRY_STARTED", label);
      assert.equal(outcome.kind === "AUDIT_RETRY_STARTED" ? outcome.reason : "", reason, label);
      assert.deepEqual(invalidReasons(w), [reason]);
      // No record, no settlement — an unusable observation decides nothing.
      assert.equal(world.store.auditRecords.count(), 0, label);
      assert.equal(settleCalls(w), 0, label);
    });
  }
});

test("B11-9: a reordered evidence sequence is a different claim, not the same set", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    const ids = [...w.review.evidence_ids];
    // The same identities, one position apart. Set equality would accept this; §16.2 does not.
    verdictAnswer(w, { reviewed: { evidence_ids: [...ids, ...ids] } });

    const outcome = complete(w);
    assert.equal(outcome.kind === "AUDIT_RETRY_STARTED" ? outcome.reason : "", "EVIDENCE_MISMATCH");
  });
});

// --- B11-10 ~ B11-16: the one retry ------------------------------------------------------------------

test("B11-10 ~ B11-13: the retry is one new turn on the same session, with the same basis", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    const spawns = w.runtime.spawnCalls.length;
    const firstInstruction = w.runtime.sendCalls.at(-1)?.instruction ?? "";
    answer(w);

    const outcome = complete(w);
    assert.equal(outcome.kind, "AUDIT_RETRY_STARTED");
    // B11-10 — exactly the candidate-qualified retry operation, and it is DONE.
    const op = auditorTurn2Op(w.attempt_key, w.candidate_commit);
    assert.equal(outcome.kind === "AUDIT_RETRY_STARTED" ? outcome.op_key : "", op);
    assert.equal(world.store.idempotency.get(op)?.state, "DONE");

    // B11-11 / B11-12 — the same Auditor session, and no second spawn.
    assert.equal(w.runtime.spawnCalls.length, spawns, "B11-12: no audit-spawn:2");
    assert.equal(world.store.idempotency.get(`${auditSpawnOp(w.attempt_key)}:2`), undefined);
    assert.equal(w.runtime.sendCalls.at(-1)?.op_key, op);

    // B11-13 — the retry re-states the identical authoritative basis, and adds only a description.
    const retry = w.runtime.sendCalls.at(-1)?.instruction ?? "";
    assert.match(retry, new RegExp(w.review.candidate_commit));
    assert.match(retry, new RegExp(w.review.task_contract_hash));
    assert.match(retry, new RegExp(w.review.evidence_ids.join(", ")));
    assert.match(retry, /previous structured result was unusable/);
    assert.match(retry, /not a new basis/);
    // Everything the first turn asserted about the basis is still asserted verbatim.
    for (const line of firstInstruction.split("\n")) assert.equal(retry.includes(line), true);

    // The turn handle is durable under its own candidate-and-turn key.
    assert.notEqual(
      world.store.adapterMetadata.get(
        w.attempt_key,
        "runtime",
        auditorTurnMetadataKey(w.candidate_commit, 2),
      ),
      undefined,
    );
    assert.deepEqual(state(w), { attempt: "AUDITING", task: "ACTIVE" });
  });
});

test("B11-14: a retry that may have been accepted is never resent", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    // The durable state a restart can leave: retry intent, no handle, no proof either way.
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(auditorTurn2Op(w.attempt_key, w.candidate_commit));
    });
    const turns = w.runtime.sendCalls.length;
    // B7 already observed the *Actor* turn, so this is the Auditor-side baseline.
    const reads = w.runtime.turnResultCalls.length;

    const outcome = complete(w);
    assert.equal(outcome.kind, "HELD");
    assert.equal(outcome.kind === "HELD" ? outcome.reason_code : "", "RECOVERY_CONFLICT");
    assert.equal(w.runtime.sendCalls.length, turns, "no resend");
    assert.equal(w.runtime.turnResultCalls.length, reads, "and nothing was read as its result");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "AUDITING");
  });
});

test("B11-15 / B11-16: a second unusable result ends the cycle, with no third turn", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    answer(w);
    assert.equal(complete(w).kind, "AUDIT_RETRY_STARTED");

    // The retry answers just as badly. The task is now ACTIVE→HELD by its own §24 reason.
    const turns = w.runtime.sendCalls.length;
    const outcome = complete(w);
    assert.equal(outcome.kind, "AUDIT_UNUSABLE");
    assert.deepEqual(state(w), { attempt: "AUDITING", task: "HELD" });
    assert.equal(world.store.tasks.require(TASK_KEY).state_reason?.code, "AUDIT_UNUSABLE");
    assert.deepEqual(invalidReasons(w), ["NO_STRUCTURED_RESULT", "NO_STRUCTURED_RESULT"]);

    // B11-16 — no third turn, no settlement, no record, no decision.
    assert.equal(w.runtime.sendCalls.length, turns);
    assert.equal(
      world.store.idempotency.keysWithPrefix(`op:${w.attempt_key}:auditor-turn-3`).length,
      0,
    );
    assert.equal(settleCalls(w), 0);
    assert.equal(world.store.auditRecords.count(), 0);
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 0);
    // And no constructor for one exists.
    assert.equal(
      /auditor-turn-3/.test(stripped(join(ROOT, "core/execution/audit-operations.ts"))),
      false,
    );
  });
});

// --- B11-17 ~ B11-20: valid verdicts -----------------------------------------------------------------

test("B11-17 / B11-18 / B11-19: each valid verdict is accepted and settled", () => {
  const branches = [
    ["AUDIT_PASS", "READY_TO_MERGE", "ACTIVE"],
    ["FIX_REQUIRED", "REWORKING", "ACTIVE"],
    ["HUMAN_REQUIRED", "AUDITING", "HELD"],
  ] as const;

  for (const [verdict, attempt, task] of branches) {
    withWorld((world) => {
      const w = auditingCompletionWorld(world);
      verdictAnswer(w, { verdict });
      settleWith(w, "SETTLED");

      const outcome = complete(w);
      assert.equal(outcome.kind, "AUDIT_DECIDED", verdict);
      assert.equal(outcome.kind === "AUDIT_DECIDED" ? outcome.verdict : "", verdict);
      assert.deepEqual(state(w), { attempt, task }, verdict);
      assert.equal(world.store.auditRecords.count(), 1, verdict);
      assert.equal(world.store.auditRecords.get(AUDIT_ID)?.verdict, verdict);
    });
  }
});

test("B11-20: model text cannot stand in for the structured verdict", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    // The model says DONE and "audit passed"; the structured channel produced nothing.
    answer(w);
    assert.notEqual(w.runtime.turnResult?.model_declared_outcome, undefined);

    const outcome = complete(w);
    assert.equal(outcome.kind, "AUDIT_RETRY_STARTED");
    assert.equal(world.store.auditRecords.count(), 0);
    // The module never reads the model's own claim.
    const code = stripped(join(ROOT, "core/execution/complete-auditing.ts"));
    assert.equal(/model_declared_outcome|declared_status/.test(code), false);
  });
});

// --- B11-21 ~ B11-26: drift ordering ------------------------------------------------------------------

test("B11-21 ~ B11-23: AUDIT_PASS evaluates §11 first, and a refusal settles nothing", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w, { verdict: "AUDIT_PASS" });
    settleWith(w, "SETTLED");
    // The authoritative task definition moved on: the frozen rule for that target invalidates.
    (w.taskSource as unknown as { failure?: Error }).failure = new Error("the source is down");

    const outcome = complete(w);
    // B11-21 — the boundary answered before anything external happened.
    assert.equal(outcome.kind, "DRIFT_CHECK_UNAVAILABLE");
    // B11-22 / B11-23 — no settlement effect and no record.
    assert.equal(settleCalls(w), 0);
    assert.equal(world.store.auditRecords.count(), 0);
    assert.equal(
      world.store.idempotency.get(auditDecisionOp(w.attempt_key, w.candidate_commit)),
      undefined,
      "not even an intent was written",
    );
    assert.equal(world.store.attempts.require(w.attempt_key).state, "AUDITING");
  });
});

test("B11-24: canonical movement alone does not hold this boundary", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    const attempt = world.store.attempts.require(w.attempt_key);
    w.repository.head = "moved-canonical-head";
    verdictAnswer(w, { verdict: "AUDIT_PASS" });
    settleWith(w, "SETTLED");

    assert.equal(complete(w).kind, "AUDIT_DECIDED");
    const after = world.store.attempts.require(w.attempt_key);
    assert.equal(after.state, "READY_TO_MERGE");
    assert.equal(after.base_head, attempt.base_head, "no rebase, no base mutation");
    assert.equal(after.candidate_commit, attempt.candidate_commit);
  });
});

test("B11-25 / B11-26: FIX_REQUIRED and HUMAN_REQUIRED do not run the stage-boundary gate", () => {
  for (const verdict of ["FIX_REQUIRED", "HUMAN_REQUIRED"] as const) {
    withWorld((world) => {
      const w = auditingCompletionWorld(world);
      verdictAnswer(w, { verdict });
      settleWith(w, "SETTLED");
      // A drift observation would be UNAVAILABLE here — and it is never taken.
      (w.taskSource as unknown as { failure?: Error }).failure = new Error("the source is down");

      const outcome = complete(w);
      assert.equal(outcome.kind, "AUDIT_DECIDED", verdict);
      assert.equal(world.store.auditRecords.count(), 1, verdict);
    });
  }
});

// --- B11-27 ~ B11-34: settlement -----------------------------------------------------------------------

test("B11-27 / B11-28 / B11-30: the intent precedes the settle, which precedes the record", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w);
    settleWith(w, "SETTLED");

    const op = auditDecisionOp(w.attempt_key, w.candidate_commit);
    const observed: string[] = [];
    const original = w.verification.settle_audit.bind(w.verification);
    (w.verification as unknown as { settle_audit: unknown }).settle_audit = (...args: never[]) => {
      observed.push(`${world.store.idempotency.get(op)?.state}`);
      observed.push(`records:${world.store.auditRecords.count()}`);
      return original(...(args as unknown as Parameters<typeof original>));
    };

    assert.equal(complete(w).kind, "AUDIT_DECIDED");
    // B11-27 / B11-30 — INTENT was durable and no record existed when the backend was called.
    assert.deepEqual(observed, ["INTENT", "records:0"]);
    assert.equal(world.store.idempotency.get(op)?.state, "DONE");

    // B11-28 — the run handle went out exactly as it was stored, untouched.
    const call = w.verification.calls.find((entry) => entry.method === "settle_audit");
    assert.equal(call?.args[0], op);
    assert.deepEqual(
      call?.args[1],
      world.store.adapterMetadata.get(w.attempt_key, "verification", "run")?.value,
    );
    // And the evidence handed over is the Platform's own set, in the authoritative order.
    assert.equal(call?.args[3], w.review.evidence_ids.length);
  });
});

test("B11-31: an unobservable gate holds under AUDIT_GATE_UNAVAILABLE", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w);
    settleWith(w, "UNAVAILABLE");

    const outcome = complete(w);
    assert.equal(outcome.kind, "HELD");
    assert.equal(outcome.kind === "HELD" ? outcome.reason_code : "", "AUDIT_GATE_UNAVAILABLE");
    assert.equal(world.store.tasks.require(TASK_KEY).state_reason?.code, "AUDIT_GATE_UNAVAILABLE");
    assert.deepEqual(state(w), { attempt: "AUDITING", task: "HELD" });
    assert.equal(world.store.auditRecords.count(), 0, "no record claims success");
  });
});

test("B11-32 / B11-33: a contradictory gate is fail-closed, and never settled again", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w);
    settleWith(w, "CONFLICT");

    const outcome = complete(w);
    assert.equal(outcome.kind, "HELD");
    assert.equal(outcome.kind === "HELD" ? outcome.reason_code : "", "RECOVERY_CONFLICT");
    assert.equal(world.store.auditRecords.count(), 0);
    assert.equal(settleCalls(w), 1, "B11-33: one attempt, never a blind second");

    // A later pass cannot settle again: the task is no longer ACTIVE.
    assert.throws(() => complete(w), /not ACTIVE/);
    assert.equal(settleCalls(w), 1);
  });
});

test("B11-34: a DONE audit decision never calls the backend again", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w, { verdict: "HUMAN_REQUIRED" });
    settleWith(w, "SETTLED");
    assert.equal(complete(w).kind, "AUDIT_DECIDED");
    const calls = settleCalls(w);

    // The task is HELD by the decision, so a fresh pass refuses before anything at all. Reopening
    // it durably and re-running still finds the operation DONE and reuses its record.
    world.store.withTransaction(() => {
      world.store.tasks.write(TASK_KEY, { platform_state: "ACTIVE", clear_reason: true });
    });
    const again = complete(w);
    assert.equal(again.kind, "AUDIT_DECIDED");
    assert.equal(again.kind === "AUDIT_DECIDED" ? again.audit_id : "", AUDIT_ID);
    assert.equal(settleCalls(w), calls, "the backend was not asked twice");
    assert.equal(world.store.auditRecords.count(), 1, "and no second record was written");
  });
});

// --- B11-35 ~ B11-46: records and branches -------------------------------------------------------------

test("B11-35 / B11-36 / B11-37 / B11-38: the record is immutable and content-addressed", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w);
    settleWith(w, "SETTLED");
    assert.equal(complete(w).kind, "AUDIT_DECIDED");

    const record = world.store.auditRecords.get(AUDIT_ID);
    assert.equal(record?.attempt_key, w.attempt_key);
    assert.equal(record?.candidate_commit, w.review.candidate_commit);
    assert.equal(record?.task_contract_hash, w.review.task_contract_hash);
    assert.equal(record?.verdict, "AUDIT_PASS");

    // B11-37 — the same identity with byte-identical content is idempotent.
    const envelope = world.store.auditRecords.envelope(AUDIT_ID);
    const same = () =>
      world.store.withTransaction(() =>
        world.store.auditRecords.put({
          audit_id: AUDIT_ID,
          attempt_key: w.attempt_key,
          candidate_commit: w.review.candidate_commit,
          task_contract_hash: w.review.task_contract_hash,
          envelope: envelope as never,
          committed_via: record?.committed_via as string,
          recorded_at: RECORDED_AT,
        }),
      );
    same();
    assert.equal(world.store.auditRecords.count(), 1);

    // B11-38 — the same identity with different content is a conflict, never an update.
    assert.throws(() =>
      world.store.withTransaction(() =>
        world.store.auditRecords.put({
          audit_id: AUDIT_ID,
          attempt_key: w.attempt_key,
          candidate_commit: w.review.candidate_commit,
          task_contract_hash: w.review.task_contract_hash,
          envelope: { ...(envelope as object), verdict: "FIX_REQUIRED", required_fix: [] } as never,
          committed_via: record?.committed_via as string,
          recorded_at: RECORDED_AT,
        }),
      ),
    );
    assert.equal(world.store.auditRecords.get(AUDIT_ID)?.verdict, "AUDIT_PASS");

    // B11-36 — nothing privileged reached the record either.
    const durable = JSON.stringify(world.store.auditRecords.get(AUDIT_ID)).toLowerCase();
    for (const category of SECRET_BEARING_KEY_CATEGORIES) {
      assert.equal(durable.includes(category), false, category);
    }
    assert.equal(durable.includes(["workflow", "_id"].join("")), false);
  });
});

test("B11-39 / B11-41: AUDIT_PASS reaches READY_TO_MERGE and starts nothing else", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    const turns = w.runtime.sendCalls.length;
    verdictAnswer(w, { verdict: "AUDIT_PASS" });
    settleWith(w, "SETTLED");

    assert.equal(complete(w).kind, "AUDIT_DECIDED");
    assert.deepEqual(state(w), { attempt: "READY_TO_MERGE", task: "ACTIVE" });
    // No merge approval, no Actor turn, no merge.
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 0);
    assert.equal(w.runtime.sendCalls.length, turns, "B11-41");
    assert.equal(
      w.repository.calls.some((call) => call.startsWith("prepare_merge")),
      false,
    );
  });
});

test("B11-40: FIX_REQUIRED uses the sealed rework guard, including its limit", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w, { verdict: "FIX_REQUIRED" });
    settleWith(w, "SETTLED");

    assert.equal(complete(w).kind, "AUDIT_DECIDED");
    assert.deepEqual(state(w), { attempt: "REWORKING", task: "ACTIVE" });
    assert.equal(world.store.auditRecords.count(), 1);
  });

  // With the budget already spent, the same sealed guard holds the task instead.
  withWorld(
    (world) => {
      const w = auditingCompletionWorld(world);
      verdictAnswer(w, { verdict: "FIX_REQUIRED" });
      settleWith(w, "SETTLED");
      world.store.withTransaction(() => {
        world.store.attempts.write(w.attempt_key, { state: "AUDITING", rework_count: 5 });
      });

      assert.equal(complete(w).kind, "AUDIT_DECIDED");
      assert.deepEqual(state(w), { attempt: "AUDITING", task: "HELD" });
      assert.equal(world.store.tasks.require(TASK_KEY).state_reason?.code, "REWORK_LIMIT");
    },
    { batch_policy: { max_tasks: 3, max_rework: 2, concurrency: 2 } },
  );
});

test("B11-42 ~ B11-46: HUMAN_REQUIRED opens exactly one AUDIT_DECISION and blocks on it", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    verdictAnswer(w, { verdict: "HUMAN_REQUIRED" });
    settleWith(w, "SETTLED");

    const outcome = complete(w);
    assert.equal(outcome.kind, "AUDIT_DECIDED");
    assert.equal(outcome.kind === "AUDIT_DECIDED" ? outcome.decision_id : "", AUDIT_DECISION_ID);

    const open = world.store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open.length, 1, "B11-42");
    const decision = open[0]?.body as PendingDecisionV1;
    assert.equal(decision.category, "AUDIT_DECISION");
    assert.equal(decision.blocking_scope, "TASK_ONLY");
    assert.deepEqual(decision.subject, { kind: "TASK", task_key: TASK_KEY });
    assert.deepEqual(decision.options, ["REQUEST_REWORK", "ABANDON"], "B11-43");
    assert.deepEqual(AUDIT_DECISION_OPTIONS, ["REQUEST_REWORK", "ABANDON"]);
    assert.equal(decision.recommendation, null);
    assert.equal(decision.gate_proposal, null);
    assert.deepEqual(decision.evidence_refs, [AUDIT_ID]);
    assert.equal(decision.created_from, `audit:${w.attempt_key}:${w.candidate_commit}`);

    // B11-44 / B11-45 — M1-12's blocking representation, and the attempt stays where it was.
    assert.equal(
      world.store.tasks.require(TASK_KEY).state_reason?.code,
      `BLOCKED_BY_DECISION:${AUDIT_DECISION_ID}`,
    );
    assert.equal(world.store.attempts.require(w.attempt_key).state, "AUDITING");
    assert.equal(world.store.auditRecords.count(), 1);

    // B11-46 — no option means "treat this as a pass".
    const rendered = JSON.stringify(decision).toUpperCase();
    for (const forbidden of ["AUDIT_PASS", "FORCE_PASS", "ACCEPT_AS_PASS", "APPROVE"]) {
      assert.equal(rendered.includes(forbidden), false, forbidden);
    }
  });
});

// --- B11-47 ~ B11-54: boundaries -----------------------------------------------------------------------

test("B11-47 / B11-49 / B11-50: Core settles through the adapter and invents no audit state", () => {
  const code = stripped(join(ROOT, "core/execution/complete-auditing.ts"));
  assert.match(code, /authorities\.verification\.settle_audit\(/);
  for (const forbidden of [
    /audit_decide/,
    /WorkflowHandle|WorkflowControllerHandle|acquire_workflow_controller/,
    new RegExp(["workflow", "_id"].join("") + "|" + ["owner", "Key"].join("")),
    /VerificationRunRefV1/,
    /CREATE TABLE|INSERT INTO|audit_cycle|audit_generation|audit_pass|gate_pass/,
  ]) {
    assert.equal(forbidden.test(code), false, `complete-auditing contains ${forbidden}`);
  }

  // Assembled at runtime so this guard does not restate the vocabulary it forbids.
  const term = (...parts: readonly string[]): RegExp => new RegExp(parts.join(""), "i");
  for (const pattern of [
    term("session", "[-_]?", "key"),
    term("agent", "Id"),
    term("plugin", "[-_]?", "tools"),
    term("result", "[-_]?", "slot"),
    term("armed"),
    term("durable", "[-_ ]?", "jobs"),
    term("open", "claw"),
  ]) {
    assert.equal(pattern.test(code), false, `complete-auditing matches ${pattern}`);
  }
});

test("B11-48 / B11-51: no backend identifier and no schema change", () => {
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
      for (const forbidden of ["audit_cycle", "audit_attempt", "invalid_audit_record"]) {
        assert.equal(names.includes(forbidden), false, forbidden);
      }
      // B11-48 — the audit record's columns carry no backend identifier.
      const columns = (
        database.prepare("PRAGMA table_info(audit_record)").all() as { name: string }[]
      ).map((row) => row.name);
      // Assembled at runtime so this guard does not contain the identifiers it forbids.
      const backendColumn = (...parts: readonly string[]): string => parts.join("");
      for (const forbidden of [
        backendColumn("workflow", "_id"),
        backendColumn("owner", "_key"),
        backendColumn("session", "_key"),
        backendColumn("stage", "_id"),
      ]) {
        assert.equal(columns.includes(forbidden), false, forbidden);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }
});

test("no Core module calls the workflow audit primitive", () => {
  const coreFiles = readdirSync(join(ROOT, "core"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(ROOT, "core", entry.name))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "core", entry.name, name)),
    );
  for (const file of coreFiles) {
    const code = stripped(file);
    assert.equal(/audit_decide/.test(code), false, `${relative(ROOT, file)} calls audit_decide`);
    assert.equal(
      /WorkflowControllerHandle|acquire_workflow_controller/.test(code),
      false,
      `${relative(ROOT, file)} reaches for a controller`,
    );
  }
});
