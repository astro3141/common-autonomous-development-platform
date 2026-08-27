/**
 * B4-AC3 / B4-AC7 / B4-AC8 / B4-AC9 — Approved Override scope, privilege direction and authority
 * binding (TD §7.1c, §7.2 rule 4–7).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileProfile } from "../core/profile/compiler.ts";
import { ProfileCompileError } from "../core/profile/errors.ts";
import { OVERRIDE_WHITELIST } from "../core/profile/override-policy.ts";
import { validateApprovedOverrides } from "../core/profile/validate-overrides.ts";
import type { ApprovalBindingView, ApprovedOverride } from "../core/profile/types.ts";
import {
  validExecutionPolicy,
  validProjectProfile,
} from "./support/profile-fixtures.ts";

const APPROVAL_HASH = `sha256:${"a".repeat(64)}`;

const compileWith = (
  items: readonly ApprovedOverride[],
  approvals: readonly ApprovalBindingView[] = [],
) =>
  compileProfile({
    projectProfile: validProjectProfile(),
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: { items },
    lookupApproval: (ref) => approvals.find((approval) => approval.ref === ref),
  });

const failsWith = (
  reason: string,
  items: readonly ApprovedOverride[],
  approvals: readonly ApprovalBindingView[] = [],
): void => {
  assert.throws(
    () => compileWith(items, approvals),
    (error: unknown) => error instanceof ProfileCompileError && error.reason === reason,
  );
};

// --- whitelist and shape ----------------------------------------------------------

test("B4-AC7: the whitelist is exactly the twelve v1 paths", () => {
  assert.deepEqual([...OVERRIDE_WHITELIST], [
    "auto_merge",
    "allow_auto_subflow",
    "batch_policy.max_tasks",
    "batch_policy.max_rework",
    "batch_policy.concurrency",
    "repository_policy.remote_push",
    "repository_policy.direct_canonical_write",
    "repository_policy.allow_force_push",
    "repository_policy.allow_tag_change",
    "repository_policy.allow_git_clean",
    "repository_policy.allow_reset_hard",
    "human_gate_policy.required_decisions",
  ]);
});

test("B4-AC7: non-whitelisted, Project Profile and arbitrary paths are rejected", () => {
  for (const fieldPath of [
    "classification_policy",
    "verification_policy",
    "capability_requirements",
    "contract_drift_policy",
    "recovery_policy",
    "repository.adapter",
    "classifications.ROUTINE_ITEM.default_execution_policy",
    "batch_policy",
    "some.arbitrary.path",
  ]) {
    assert.throws(
      () => validateApprovedOverrides({ items: [{ field_path: fieldPath, value: true }] }),
      (error: unknown) =>
        error instanceof ProfileCompileError && error.reason === "OVERRIDE_NOT_ALLOWED",
      `${fieldPath} must be rejected`,
    );
  }
});

test("B4-AC3: duplicate field_path and unknown item fields are rejected", () => {
  assert.throws(
    () =>
      validateApprovedOverrides({
        items: [
          { field_path: "auto_merge", value: false },
          { field_path: "auto_merge", value: true },
        ],
      }),
    (error: unknown) => error instanceof ProfileCompileError && error.reason === "DUPLICATE",
  );
  assert.throws(
    () => validateApprovedOverrides({ items: [{ field_path: "auto_merge", value: false, note: 1 }] }),
    (error: unknown) => error instanceof ProfileCompileError && error.reason === "SCHEMA_INVALID",
  );
  assert.deepEqual(validateApprovedOverrides({ items: [] }).items, []);
});

test("B4-AC3: override values are typed per path and never coerced", () => {
  failsWith("SCHEMA_INVALID", [{ field_path: "auto_merge", value: "true" }]);
  failsWith("SCHEMA_INVALID", [{ field_path: "batch_policy.max_tasks", value: "3" }]);
  failsWith("SCHEMA_INVALID", [{ field_path: "batch_policy.max_tasks", value: 0 }]);
  failsWith("SCHEMA_INVALID", [
    { field_path: "repository_policy.remote_push", value: "feature_branch_only" },
  ]);
  failsWith("SCHEMA_INVALID", [
    { field_path: "human_gate_policy.required_decisions", value: ["NOT_A_DECISION"] },
  ]);
});

// --- privilege direction ----------------------------------------------------------

test("B4-AC8: restrictive overrides need no approval and apply", () => {
  const result = compileWith([
    { field_path: "allow_auto_subflow", value: false },
    { field_path: "batch_policy.max_tasks", value: 1 },
    { field_path: "repository_policy.remote_push", value: "DENY" },
    {
      field_path: "human_gate_policy.required_decisions",
      value: ["PROPOSE_MERGE", "HOLD_TASK", "START_TASK"],
    },
  ]);

  assert.equal(result.body.effective.policy.allow_auto_subflow, false);
  assert.equal(result.body.effective.policy.batch_policy.max_tasks, 1);
  assert.equal(result.body.effective.policy.repository_policy.remote_push, "DENY");
  assert.equal(result.body.effective.policy.human_gate_policy.required_decisions.length, 3);
});

test("B4-AC8: permissive overrides without approval are rejected", () => {
  failsWith("OVERRIDE_APPROVAL_SHAPE", [{ field_path: "auto_merge", value: true }]);
  failsWith("OVERRIDE_APPROVAL_SHAPE", [{ field_path: "batch_policy.max_tasks", value: 9 }]);
  failsWith("OVERRIDE_APPROVAL_SHAPE", [
    { field_path: "repository_policy.allow_force_push", value: true },
  ]);
  failsWith("OVERRIDE_APPROVAL_SHAPE", [
    { field_path: "human_gate_policy.required_decisions", value: ["PROPOSE_MERGE"] },
  ]);
});

test("B4-AC8: a restrictive override carrying approval metadata is rejected", () => {
  failsWith("OVERRIDE_APPROVAL_SHAPE", [
    {
      field_path: "allow_auto_subflow",
      value: false,
      approval_ref: "operator-action:1",
      approval_hash: APPROVAL_HASH,
    },
  ]);
});

test("B4-AC8: a no-op override is rejected", () => {
  failsWith("OVERRIDE_NO_OP", [{ field_path: "auto_merge", value: false }]);
  failsWith("OVERRIDE_NO_OP", [
    { field_path: "human_gate_policy.required_decisions", value: ["HOLD_TASK", "PROPOSE_MERGE"] },
  ]);
});

test("B4-AC8: an incomparable required_decisions change is rejected", () => {
  failsWith("OVERRIDE_INCOMPARABLE", [
    { field_path: "human_gate_policy.required_decisions", value: ["PROPOSE_MERGE", "DEFER_TASK"] },
  ]);
});

// --- approval binding -------------------------------------------------------------

const permissive: ApprovedOverride = {
  field_path: "batch_policy.max_tasks",
  value: 9,
  approval_ref: "operator-action:1",
  approval_hash: APPROVAL_HASH,
};

const validApproval: ApprovalBindingView = {
  ref: "operator-action:1",
  status: "RESOLVED",
  field_path: "batch_policy.max_tasks",
  approved_value: 9,
  record_hash: APPROVAL_HASH,
};

test("B4-AC9: a fully matching approval binding is accepted", () => {
  const result = compileWith([permissive], [validApproval]);
  assert.equal(result.body.effective.policy.batch_policy.max_tasks, 9);
});

test("B4-AC9: every binding mismatch fails closed", () => {
  failsWith("APPROVAL_BINDING_INVALID", [permissive], []); // not found
  failsWith("APPROVAL_BINDING_INVALID", [permissive], [{ ...validApproval, status: "OPEN" }]);
  failsWith("APPROVAL_BINDING_INVALID", [permissive], [{ ...validApproval, status: "REVOKED" }]);
  failsWith(
    "APPROVAL_BINDING_INVALID",
    [permissive],
    [{ ...validApproval, field_path: "batch_policy.concurrency" }],
  );
  failsWith("APPROVAL_BINDING_INVALID", [permissive], [{ ...validApproval, approved_value: 8 }]);
  failsWith(
    "APPROVAL_BINDING_INVALID",
    [permissive],
    [{ ...validApproval, record_hash: `sha256:${"b".repeat(64)}` }],
  );
});

test("B4-AC9: a permissive override with no lookup supplied fails closed", () => {
  assert.throws(
    () =>
      compileProfile({
        projectProfile: validProjectProfile(),
        executionPolicy: validExecutionPolicy(),
        approvedOverrides: { items: [permissive] },
      }),
    (error: unknown) =>
      error instanceof ProfileCompileError && error.reason === "APPROVAL_BINDING_INVALID",
  );
});
