/**
 * B7-AC12 ~ B7-AC21 — V1 to V7 (TD §9.2, §9.2a, §9.2b).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DecisionError } from "../core/decision/errors.ts";
import { validateDecision, type DecisionValidationInput } from "../core/decision/validator.ts";
import type { DecisionValidationResult } from "../core/decision/types.ts";
import {
  batchControl,
  batchView,
  compiled,
  enforcementWith,
  found,
  inputFor,
  manifests,
  repositoryControl,
  selection,
  task,
  taskControl,
  HEAD,
} from "./support/decision-fixtures.ts";

const profile = compiled();

const rejected = (reason: string): DecisionValidationResult => ({
  kind: "POLICY_REJECTED",
  reason_code: reason as never,
});
const ACCEPTED: DecisionValidationResult = { kind: "ACCEPTED" };
const GATE: DecisionValidationResult = { kind: "HUMAN_GATE_REQUIRED" };

/** Reads of the late-step views are counted so short-circuiting can be observed directly. */
function countingInput(base: DecisionValidationInput): {
  input: DecisionValidationInput;
  counts: Record<"repository" | "manifests" | "batch", number>;
} {
  const counts = { repository: 0, manifests: 0, batch: 0 };
  const input = { ...base } as Record<string, unknown>;
  for (const key of ["repository", "manifests", "batch"] as const) {
    const stored = base[key];
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        counts[key] += 1;
        return stored;
      },
    });
  }
  return { input: input as unknown as DecisionValidationInput, counts };
}

// --- V1 ------------------------------------------------------------------------------

test("B7-AC12: a structurally invalid Proposal is rejected at V1 and nothing else is consulted", () => {
  const { input, counts } = countingInput(
    inputFor({ ...selection({ profile }), priority: "high" }, profile),
  );
  assert.deepEqual(validateDecision(input), rejected("PROPOSAL_SCHEMA_INVALID"));
  assert.deepEqual(counts, { repository: 0, manifests: 0, batch: 0 });
});

// --- V2 ------------------------------------------------------------------------------

test("B7-AC13: an unknown task is rejected for every task-bearing variant", () => {
  for (const proposal of [
    selection({ profile }),
    repositoryControl({ profile }),
    taskControl({ profile }),
  ]) {
    assert.deepEqual(
      validateDecision(inputFor(proposal, profile, { task: { status: "NOT_FOUND" } })),
      rejected("TASK_NOT_FOUND"),
    );
  }
});

test("B7-AC13: a missing task view is a caller-contract failure, not a rejection", () => {
  assert.throws(
    () => validateDecision(inputFor(selection({ profile }), profile, { task: undefined })),
    (error: unknown) =>
      error instanceof DecisionError && error.reason === "VALIDATOR_INPUT_INVALID",
  );
});

// --- V3 ------------------------------------------------------------------------------

test("B7-AC14: a version-only mismatch is task drift", () => {
  // Same body, different adapter version — invisible to the definition hash by design (§8.1a).
  const proposal = selection({ profile, definition: task({ version: "2" }) });
  assert.deepEqual(
    validateDecision(inputFor(proposal, profile, { task: found(task({ version: "1" })) })),
    rejected("TASK_DRIFT"),
  );
});

test("B7-AC14: a definition-hash-only mismatch is task drift", () => {
  const proposal = selection({ profile });
  const expected = { ...(proposal["expected"] as Record<string, unknown>) };
  expected["task_definition_hash"] = `sha256:${"0".repeat(64)}`;
  assert.deepEqual(
    validateDecision(inputFor({ ...proposal, expected }, profile)),
    rejected("TASK_DRIFT"),
  );
});

test("B7-AC14: a compiled-profile-hash-only mismatch is profile drift", () => {
  const proposal = selection({ profile });
  const expected = { ...(proposal["expected"] as Record<string, unknown>) };
  expected["compiled_profile_hash"] = `sha256:${"0".repeat(64)}`;
  assert.deepEqual(
    validateDecision(inputFor({ ...proposal, expected }, profile)),
    rejected("PROFILE_DRIFT"),
  );
});

test("B7-AC15: task drift outranks profile drift, and version outranks the definition hash", () => {
  const proposal = selection({ profile, definition: task({ version: "2" }) });
  const expected = { ...(proposal["expected"] as Record<string, unknown>) };
  expected["task_definition_hash"] = `sha256:${"0".repeat(64)}`;
  expected["compiled_profile_hash"] = `sha256:${"1".repeat(64)}`;

  assert.deepEqual(
    validateDecision(inputFor({ ...proposal, expected }, profile)),
    rejected("TASK_DRIFT"),
  );
});

test("B7-AC14: CLOSE_BATCH checks only the compiled profile and needs no task at all", () => {
  const fresh = inputFor(batchControl({ profile }), profile, { task: undefined });
  assert.deepEqual(validateDecision(fresh), ACCEPTED);

  const stale = inputFor(
    { ...batchControl({ profile }), expected: { compiled_profile_hash: `sha256:${"0".repeat(64)}` } },
    profile,
    { task: undefined },
  );
  assert.deepEqual(validateDecision(stale), rejected("PROFILE_DRIFT"));
});

// --- V4 ------------------------------------------------------------------------------

test("B7-AC16: an undeclared classification is rejected", () => {
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile, classification: "UNKNOWN_KIND" }), profile)),
    rejected("CLASSIFICATION_UNKNOWN"),
  );
});

test("B7-AC16: control variants carry no classification and are unaffected by V4", () => {
  for (const proposal of [
    repositoryControl({ profile }),
    taskControl({ profile }),
    batchControl({ profile }),
  ]) {
    assert.deepEqual(validateDecision(inputFor(proposal, profile)), ACCEPTED);
  }
});

// --- V5 / V7 -------------------------------------------------------------------------

test("B7-AC17: START_TASK follows the disposition table", () => {
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile, classification: "IMPLEMENTABLE" }), profile)),
    ACCEPTED,
  );
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile, classification: "LARGE_SCOPE" }), profile)),
    GATE,
  );
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile, classification: "SPLIT_NEEDED" }), profile)),
    rejected("DECISION_NOT_ALLOWED"),
  );
});

test("B7-AC17: START_SUBFLOW follows the disposition table when subflows are allowed", () => {
  const subflow = (classification: string): DecisionValidationResult =>
    validateDecision(
      inputFor(selection({ profile, decision: "START_SUBFLOW", classification }), profile),
    );

  assert.deepEqual(subflow("SPLIT_NEEDED"), ACCEPTED);
  assert.deepEqual(subflow("LARGE_SCOPE"), GATE);
  assert.deepEqual(subflow("IMPLEMENTABLE"), rejected("DECISION_NOT_ALLOWED"));
});

test("B7-AC18: allow_auto_subflow=false cannot be bypassed by a human gate", () => {
  // Both gate rules are armed and the disposition is the matching one; the policy still wins.
  const closed = compiled({
    allow_auto_subflow: false,
    human_gate_policy: { required_decisions: ["START_SUBFLOW"] },
  });
  for (const classification of ["SPLIT_NEEDED", "LARGE_SCOPE", "IMPLEMENTABLE"]) {
    assert.deepEqual(
      validateDecision(
        inputFor(
          selection({ profile: closed, decision: "START_SUBFLOW", classification }),
          closed,
        ),
      ),
      rejected("DECISION_NOT_ALLOWED"),
    );
  }
});

test("B7-AC19: PROPOSE_MERGE passes V5 whatever auto_merge says", () => {
  assert.deepEqual(
    validateDecision(inputFor(repositoryControl({ profile }), profile)),
    ACCEPTED,
    "auto_merge=false must not remove the human merge path",
  );

  const auto = compiled({
    auto_merge: true,
    capability_requirements: { automatic_merge: { "repository.merge": { accepted: ["ENFORCED"] } } },
  });
  assert.deepEqual(
    validateDecision(inputFor(repositoryControl({ profile: auto }), auto)),
    ACCEPTED,
  );
});

test("B7-AC17: the remaining control decisions pass V5", () => {
  for (const proposal of [
    repositoryControl({ profile, decision: "REQUEST_REWORK" }),
    taskControl({ profile, decision: "HOLD_TASK" }),
    taskControl({ profile, decision: "DEFER_TASK" }),
    taskControl({ profile, decision: "RESUME_PARENT" }),
    batchControl({ profile }),
  ]) {
    assert.deepEqual(validateDecision(inputFor(proposal, profile)), ACCEPTED);
  }
});

// --- V6 ------------------------------------------------------------------------------

test("B7-AC20: an unknown pipeline, actor profile or verification profile is rejected", () => {
  const cases = [
    { pipeline_id: "no-such-pipeline" },
    { actor_profile: "no-such-role" },
    { verification_profile: "no-such-verification" },
  ];
  for (const override of cases) {
    assert.deepEqual(
      validateDecision(inputFor({ ...selection({ profile }), ...override }, profile)),
      rejected("PROFILE_REFERENCE_UNKNOWN"),
    );
  }
});

test("B7-AC20: control variants select no profiles and are unaffected by V6", () => {
  assert.deepEqual(validateDecision(inputFor(taskControl({ profile }), profile)), ACCEPTED);
});

// --- V7 ------------------------------------------------------------------------------

test("B7-AC21: either gate rule alone produces one HUMAN_GATE_REQUIRED", () => {
  const gated = compiled({ human_gate_policy: { required_decisions: ["HOLD_TASK"] } });
  assert.deepEqual(validateDecision(inputFor(taskControl({ profile: gated }), gated)), GATE);

  assert.deepEqual(
    validateDecision(inputFor(selection({ profile, classification: "LARGE_SCOPE" }), profile)),
    GATE,
  );

  const both = compiled({ human_gate_policy: { required_decisions: ["START_TASK"] } });
  assert.deepEqual(
    validateDecision(
      inputFor(selection({ profile: both, classification: "LARGE_SCOPE" }), both),
    ),
    GATE,
  );
});

test("B7-AC21: an earlier failure outranks the gate", () => {
  const gated = compiled({ human_gate_policy: { required_decisions: ["START_TASK"] } });
  assert.deepEqual(
    validateDecision(
      inputFor({ ...selection({ profile: gated }), pipeline_id: "no-such-pipeline" }, gated),
    ),
    rejected("PROFILE_REFERENCE_UNKNOWN"),
    "V6 runs before V7",
  );
});

test("B7-AC21: the gate short-circuits V8 through V11", () => {
  // Every later step would fail: the head differs, the manifest is too weak and the batch is full.
  const gated = compiled({
    human_gate_policy: { required_decisions: ["START_TASK"] },
    capability_requirements: {
      actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
    },
    batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 },
  });
  const { input, counts } = countingInput(
    inputFor(selection({ profile: gated }), gated, {
      repository: { canonical_head: `${HEAD}-moved` },
      manifests: manifests(
        enforcementWith({ "repository.feature_write": { allow: "NOT_YET_AUDITED" } }),
      ),
      batch: batchView({
        admitted_task_count: 5,
        active_task_count: 5,
        active_writable_candidate_count: 3,
      }),
    }),
  );

  assert.deepEqual(validateDecision(input), GATE);
  assert.deepEqual(
    counts,
    { repository: 0, manifests: 0, batch: 0 },
    "no later authority was consulted",
  );
});
