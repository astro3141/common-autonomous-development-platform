/**
 * B4-AC2 — ExecutionPolicyV1 schema (TD §7.1b), including the drift-target default exception.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ProfileCompileError } from "../core/profile/errors.ts";
import { validateExecutionPolicy } from "../core/profile/validate-execution-policy.ts";
import {
  DRIFT_POLICY_DEFAULTS,
  DRIFT_TARGETS,
  EXECUTION_POLICY_TOP_LEVEL,
} from "../core/profile/types.ts";
import { validExecutionPolicy } from "./support/profile-fixtures.ts";

const rejects = (input: unknown, reason?: string): void => {
  assert.throws(
    () => validateExecutionPolicy(input),
    (error: unknown) =>
      error instanceof ProfileCompileError &&
      error.code === "COMPILE_ERROR" &&
      (reason === undefined || error.reason === reason),
  );
};

test("B4-AC2: a representative policy is accepted", () => {
  const policy = validateExecutionPolicy(validExecutionPolicy());

  assert.equal(policy.id, "guarded");
  assert.deepEqual(Object.keys(policy).sort(), [...EXECUTION_POLICY_TOP_LEVEL].sort());
  assert.equal(policy.repository_policy.remote_push, "FEATURE_BRANCH_ONLY");
  assert.equal(policy.recovery_policy.capability_downgrade, "HOLD");
});

test("B4-AC2: every one of the twelve top-level fields is required", () => {
  assert.equal(EXECUTION_POLICY_TOP_LEVEL.length, 12);
  for (const field of EXECUTION_POLICY_TOP_LEVEL) {
    const policy = validExecutionPolicy();
    delete policy[field];
    rejects(policy, "SCHEMA_INVALID");
  }
});

test("B4-AC2: an unknown top-level field is rejected", () => {
  rejects({ ...validExecutionPolicy(), capability_policy: {} }, "SCHEMA_INVALID");
  rejects({ ...validExecutionPolicy(), maturity_mode: "GUARDED" }, "SCHEMA_INVALID");
});

test("B4-AC2: integer bounds are enforced and never coerced", () => {
  const cases: ReadonlyArray<Record<string, unknown>> = [
    { max_tasks: 0, max_rework: 2, concurrency: 1 },
    { max_tasks: 3, max_rework: -1, concurrency: 1 },
    { max_tasks: 3, max_rework: 2, concurrency: 0 },
    { max_tasks: "3", max_rework: 2, concurrency: 1 },
    { max_tasks: 3.5, max_rework: 2, concurrency: 1 },
    { max_tasks: 3, max_rework: 2 },
  ];
  for (const batch of cases) {
    rejects({ ...validExecutionPolicy(), batch_policy: batch }, "SCHEMA_INVALID");
  }
});

test("B4-AC2: lowercase remote_push is invalid and is not normalized", () => {
  const policy = validExecutionPolicy();
  policy["repository_policy"] = {
    ...(policy["repository_policy"] as Record<string, unknown>),
    remote_push: "feature_branch_only",
  };
  rejects(policy, "SCHEMA_INVALID");
});

test("B4-AC2: repository_policy booleans reject non-boolean values", () => {
  const policy = validExecutionPolicy();
  policy["repository_policy"] = {
    ...(policy["repository_policy"] as Record<string, unknown>),
    allow_force_push: "true",
  };
  rejects(policy, "SCHEMA_INVALID");
});

test("B4-AC2: decision, assurance and capability vocabularies are closed", () => {
  const badDecision = validExecutionPolicy();
  badDecision["human_gate_policy"] = { required_decisions: ["APPROVE_EVERYTHING"] };
  rejects(badDecision, "SCHEMA_INVALID");

  const duplicateDecision = validExecutionPolicy();
  duplicateDecision["human_gate_policy"] = {
    required_decisions: ["PROPOSE_MERGE", "PROPOSE_MERGE"],
  };
  rejects(duplicateDecision, "DUPLICATE");

  const badAssurance = validExecutionPolicy();
  badAssurance["verification_policy"] = {
    required_verification: { unit: { accepted_assurance: ["TRUSTED"] } },
  };
  rejects(badAssurance, "SCHEMA_INVALID");

  const emptyAssurance = validExecutionPolicy();
  emptyAssurance["verification_policy"] = {
    required_verification: { unit: { accepted_assurance: [] } },
  };
  rejects(emptyAssurance, "SCHEMA_INVALID");

  const badCapability = validExecutionPolicy();
  badCapability["capability_requirements"] = {
    automatic_merge: { "repository.deploy": { accepted: ["ENFORCED"] } },
  };
  rejects(badCapability, "SCHEMA_INVALID");

  const badEnforcement = validExecutionPolicy();
  badEnforcement["capability_requirements"] = {
    automatic_merge: { "repository.merge": { accepted: ["TOTALLY_SAFE"] } },
  };
  rejects(badEnforcement, "SCHEMA_INVALID");
});

test("B4-AC2: drift and recovery domains are enforced", () => {
  const badAction = validExecutionPolicy();
  badAction["contract_drift_policy"] = { canonical_head: { action: "IGNORE" } };
  rejects(badAction, "SCHEMA_INVALID");

  const badTarget = validExecutionPolicy();
  badTarget["contract_drift_policy"] = { capability_policy: { action: "CONTINUE_SNAPSHOT" } };
  rejects(badTarget, "SCHEMA_INVALID");

  const badRecovery = validExecutionPolicy();
  badRecovery["recovery_policy"] = { capability_downgrade: "IGNORE" };
  rejects(badRecovery, "SCHEMA_INVALID");
});

test("B4-AC2: absent drift targets take the §11.2 defaults — the only implicit defaults", () => {
  const policy = validateExecutionPolicy(validExecutionPolicy());

  for (const target of DRIFT_TARGETS) {
    assert.ok(policy.contract_drift_policy[target], `${target} must be present after compile`);
  }
  assert.deepEqual(policy.contract_drift_policy.task_definition, DRIFT_POLICY_DEFAULTS.task_definition);
  assert.deepEqual(policy.contract_drift_policy.capability_requirements, {
    action: "REEVALUATE_AT_BOUNDARY",
  });
  // The explicitly supplied target keeps its own value.
  assert.deepEqual(policy.contract_drift_policy.canonical_head, {
    action: "HOLD_AT_BOUNDARY",
    boundary: "MERGE_ONLY",
  });
});
