/**
 * B7-AC8, B7-AC29, B7-AC30 — V11 admission/concurrency and the global first-failure order
 * (TD §9.2e, §9.2).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DecisionError } from "../core/decision/errors.ts";
import { validateDecision } from "../core/decision/validator.ts";
import {
  BATCH_VIEW_FIELDS,
  DECISION_REJECT_REASONS,
  DECISION_RESULT_KINDS,
  type DecisionValidationResult,
} from "../core/decision/types.ts";
import {
  batchControl,
  batchView,
  compiled,
  enforcementWith,
  inputFor,
  manifests,
  repositoryControl,
  selection,
  task,
  taskControl,
  HEAD,
} from "./support/decision-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = compiled();
const ACCEPTED: DecisionValidationResult = { kind: "ACCEPTED" };
const rejected = (reason: string): DecisionValidationResult => ({
  kind: "POLICY_REJECTED",
  reason_code: reason as never,
});

// --- result contract ------------------------------------------------------------------

test("B7-AC10 / B7-AC11: the result kinds and the reject vocabulary are exact", () => {
  assert.deepEqual(
    [...DECISION_RESULT_KINDS],
    ["ACCEPTED", "HUMAN_GATE_REQUIRED", "POLICY_REJECTED", "BACKEND_INCOMPATIBLE"],
  );
  assert.deepEqual(
    [...DECISION_REJECT_REASONS],
    [
      "PROPOSAL_SCHEMA_INVALID",
      "TASK_NOT_FOUND",
      "TASK_DRIFT",
      "PROFILE_DRIFT",
      "CLASSIFICATION_UNKNOWN",
      "DECISION_NOT_ALLOWED",
      "PROFILE_REFERENCE_UNKNOWN",
      "REPOSITORY_STATE_MISMATCH",
      "CAPABILITY_DERIVATION_FAILED",
      "BATCH_MAX_TASKS_REACHED",
      "CONCURRENCY_LIMIT_REACHED",
      "WRITABLE_CONCURRENCY_CONFLICT",
      // §9.2f (D22) — the seven subflow parent-binding reasons. The twelve MVP 0/1 reasons above
      // are sealed and unchanged.
      "SUBFLOW_PARENT_NOT_FOUND",
      "SUBFLOW_PARENT_STALE",
      "SUBFLOW_PARENT_INELIGIBLE",
      "SUBFLOW_PARENT_BATCH_MISMATCH",
      "SUBFLOW_RELATION_CONFLICT",
      "SUBFLOW_CYCLE_DETECTED",
      "SUBFLOW_PIPELINE_INVALID",
    ],
  );
  assert.equal(DECISION_REJECT_REASONS.length, 19);
});

// --- B7-AC8 read model ------------------------------------------------------------------

test("B7-AC8: the batch view is exactly three non-negative integer counts", () => {
  assert.deepEqual(
    [...BATCH_VIEW_FIELDS],
    ["admitted_task_count", "active_task_count", "active_writable_candidate_count"],
  );

  const fails = (batch: Record<string, unknown>): void =>
    assert.throws(
      () => validateDecision(inputFor(selection({ profile }), profile, { batch: batch as never })),
      (error: unknown) =>
        error instanceof DecisionError && error.reason === "VALIDATOR_INPUT_INVALID",
    );

  fails({ ...batchView(), admitted_task_count: -1 });
  fails({ ...batchView(), active_task_count: 1.5 });
  fails({ ...batchView(), active_writable_candidate_count: "0" });
  fails({ ...batchView(), held_task_count: 0 });
  assert.throws(
    () => validateDecision(inputFor(selection({ profile }), profile, { batch: undefined })),
    (error: unknown) => error instanceof DecisionError && error.reason === "VALIDATOR_INPUT_INVALID",
  );
});

// --- B7-AC29 rules ------------------------------------------------------------------------

test("B7-AC29: below every limit a selection is admitted", () => {
  assert.deepEqual(
    validateDecision(
      inputFor(selection({ profile }), profile, {
        batch: batchView({ admitted_task_count: 2, active_task_count: 1 }),
      }),
    ),
    ACCEPTED,
  );
});

test("B7-AC29: reaching max_tasks or the concurrency limit rejects the admission", () => {
  // batch_policy is { max_tasks: 3, concurrency: 2 }; equality already blocks.
  assert.deepEqual(
    validateDecision(
      inputFor(selection({ profile }), profile, { batch: batchView({ admitted_task_count: 3 }) }),
    ),
    rejected("BATCH_MAX_TASKS_REACHED"),
  );
  assert.deepEqual(
    validateDecision(
      inputFor(selection({ profile }), profile, { batch: batchView({ active_task_count: 2 }) }),
    ),
    rejected("CONCURRENCY_LIMIT_REACHED"),
  );
});

test("B7-AC29: only a pipeline containing an ACTOR step competes for the writable slot", () => {
  const writable = batchView({ active_writable_candidate_count: 1 });

  assert.deepEqual(
    validateDecision(
      inputFor(selection({ profile, pipeline_id: "standard" }), profile, { batch: writable }),
    ),
    rejected("WRITABLE_CONCURRENCY_CONFLICT"),
  );
  assert.deepEqual(
    validateDecision(
      inputFor(selection({ profile, pipeline_id: "review_only" }), profile, { batch: writable }),
    ),
    ACCEPTED,
    "a review-only pipeline needs no writable slot",
  );
});

test("B7-AC29: V11 applies to new admissions only", () => {
  const full = batchView({
    admitted_task_count: 9,
    active_task_count: 9,
    active_writable_candidate_count: 9,
  });
  for (const proposal of [
    repositoryControl({ profile, decision: "REQUEST_REWORK" }),
    repositoryControl({ profile, decision: "PROPOSE_MERGE" }),
    taskControl({ profile, decision: "HOLD_TASK" }),
    taskControl({ profile, decision: "RESUME_PARENT" }),
    batchControl({ profile }),
  ]) {
    assert.deepEqual(validateDecision(inputFor(proposal, profile, { batch: full })), ACCEPTED);
  }
});

test("B7-AC29: rework limits and lifecycle legality are not duplicated into V11", () => {
  const code = readFileSync(join(ROOT, "core/decision/validator.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const pattern of [/max_rework/, /rework_count/, /READY_TO_MERGE/, /AttemptState/, /TaskState/]) {
    assert.equal(pattern.test(code), false, `${pattern} belongs to the state machine`);
  }
});

// --- B7-AC30 first failure ------------------------------------------------------------------

test("B7-AC30: V11 rules resolve in order when all three would fail", () => {
  const all = batchView({
    admitted_task_count: 3,
    active_task_count: 2,
    active_writable_candidate_count: 1,
  });
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile }), profile, { batch: all })),
    rejected("BATCH_MAX_TASKS_REACHED"),
  );

  assert.deepEqual(
    validateDecision(
      inputFor(selection({ profile }), profile, {
        batch: batchView({ active_task_count: 2, active_writable_candidate_count: 1 }),
      }),
    ),
    rejected("CONCURRENCY_LIMIT_REACHED"),
  );
});

test("B7-AC30: task drift outranks a repository mismatch", () => {
  const proposal = selection({ profile, definition: task({ version: "2" }) });
  assert.deepEqual(
    validateDecision(
      inputFor(proposal, profile, { repository: { canonical_head: `${HEAD}-moved` } }),
    ),
    rejected("TASK_DRIFT"),
  );
});

test("B7-AC30: the whole chain resolves at its first failing step", () => {
  // One input that would fail V2, V4, V6, V8, V10 and V11 at once; each step is then repaired.
  const strict = compiled({
    capability_requirements: { actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } },
  });
  const weak = manifests(enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } }));
  const broken = {
    task: { status: "NOT_FOUND" } as const,
    repository: { canonical_head: `${HEAD}-moved` },
    manifests: weak,
    batch: batchView({ admitted_task_count: 3 }),
  };

  const proposal = (classification: string, pipeline_id: string): Record<string, unknown> =>
    selection({ profile: strict, classification, pipeline_id });

  // V2
  assert.deepEqual(
    validateDecision(inputFor(proposal("UNKNOWN_KIND", "no-such-pipeline"), strict, broken)),
    rejected("TASK_NOT_FOUND"),
  );
  // V4 (task repaired)
  const withTask = { ...broken, task: undefined };
  assert.deepEqual(
    validateDecision(
      inputFor(proposal("UNKNOWN_KIND", "no-such-pipeline"), strict, {
        ...withTask,
        task: inputFor(proposal("IMPLEMENTABLE", "standard"), strict).task,
      }),
    ),
    rejected("CLASSIFICATION_UNKNOWN"),
  );
  // V6
  assert.deepEqual(
    validateDecision(
      inputFor(proposal("IMPLEMENTABLE", "no-such-pipeline"), strict, {
        repository: broken.repository,
        manifests: weak,
        batch: broken.batch,
      }),
    ),
    rejected("PROFILE_REFERENCE_UNKNOWN"),
  );
  // V8
  assert.deepEqual(
    validateDecision(
      inputFor(proposal("IMPLEMENTABLE", "standard"), strict, {
        repository: broken.repository,
        manifests: weak,
        batch: broken.batch,
      }),
    ),
    rejected("REPOSITORY_STATE_MISMATCH"),
  );
  // V10
  const v10 = validateDecision(
    inputFor(proposal("IMPLEMENTABLE", "standard"), strict, {
      manifests: weak,
      batch: broken.batch,
    }),
  ) as { kind: string };
  assert.equal(v10.kind, "BACKEND_INCOMPATIBLE");
  // V11
  assert.deepEqual(
    validateDecision(inputFor(proposal("IMPLEMENTABLE", "standard"), strict, { batch: broken.batch })),
    rejected("BATCH_MAX_TASKS_REACHED"),
  );
  // Nothing left to fail.
  assert.deepEqual(
    validateDecision(inputFor(proposal("IMPLEMENTABLE", "standard"), strict)),
    ACCEPTED,
  );
});
