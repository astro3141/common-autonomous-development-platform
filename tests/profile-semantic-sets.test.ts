/**
 * B4-AC14 — schema-declared semantic sets normalize to a canonical order before hashing
 * (TD §6 M0-13, §7.1b, §7.1c, §7.2 rule 6).
 *
 * The negative half matters as much as the positive: generic arrays must stay order-sensitive.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileProfile } from "../core/profile/compiler.ts";
import { ProfileCompileError } from "../core/profile/errors.ts";
import { validateApprovedOverrides } from "../core/profile/validate-overrides.ts";
import { validateExecutionPolicy } from "../core/profile/validate-execution-policy.ts";
import { validateProjectProfile } from "../core/profile/validate-project-profile.ts";
import { hashEnvelope, makeEnvelope } from "../core/schemas/envelope.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import type { ApprovalBindingView, ApprovedOverride } from "../core/profile/types.ts";
import {
  noOverrides,
  validExecutionPolicy,
  validProjectProfile,
} from "./support/profile-fixtures.ts";

const policyHash = (policy: unknown): string =>
  hashEnvelope(
    makeEnvelope(
      "platform/execution-policy",
      1,
      validateExecutionPolicy(policy) as unknown as CanonicalObject,
    ),
  );

const overridesHash = (overrides: unknown): string =>
  hashEnvelope(
    makeEnvelope(
      "platform/approved-overrides",
      1,
      validateApprovedOverrides(overrides) as unknown as CanonicalObject,
    ),
  );

const compileWith = (policy: unknown, overrides: unknown = noOverrides()) =>
  compileProfile({
    projectProfile: validProjectProfile(),
    executionPolicy: policy,
    approvedOverrides: overrides,
  });

// --- S1: human_gate_policy.required_decisions -------------------------------------

test("B4-AC14: required_decisions permutations normalize to one canonical order", () => {
  const a = validExecutionPolicy();
  a["human_gate_policy"] = { required_decisions: ["PROPOSE_MERGE", "HOLD_TASK", "CLOSE_BATCH"] };
  const b = validExecutionPolicy();
  b["human_gate_policy"] = { required_decisions: ["HOLD_TASK", "CLOSE_BATCH", "PROPOSE_MERGE"] };

  assert.deepEqual(validateExecutionPolicy(a), validateExecutionPolicy(b));
  assert.deepEqual(validateExecutionPolicy(a).human_gate_policy.required_decisions, [
    "CLOSE_BATCH",
    "HOLD_TASK",
    "PROPOSE_MERGE",
  ]);
  assert.equal(policyHash(a), policyHash(b));
  assert.equal(compileWith(a).compiled_hash, compileWith(b).compiled_hash);
});

// --- S2: verification accepted_assurance ------------------------------------------

test("B4-AC14: accepted_assurance permutations normalize to one canonical order", () => {
  const a = validExecutionPolicy();
  a["verification_policy"] = {
    required_verification: {
      unit: { accepted_assurance: ["REEXECUTED", "ARTIFACT_VERIFIED", "LOG_VERIFIED"] },
    },
  };
  const b = validExecutionPolicy();
  b["verification_policy"] = {
    required_verification: {
      unit: { accepted_assurance: ["LOG_VERIFIED", "REEXECUTED", "ARTIFACT_VERIFIED"] },
    },
  };

  assert.deepEqual(
    validateExecutionPolicy(a).verification_policy.required_verification["unit"]
      ?.accepted_assurance,
    ["ARTIFACT_VERIFIED", "LOG_VERIFIED", "REEXECUTED"],
  );
  assert.equal(policyHash(a), policyHash(b));
  assert.equal(compileWith(a).compiled_hash, compileWith(b).compiled_hash);
});

// --- S3: capability accepted -------------------------------------------------------

test("B4-AC14: capability accepted permutations normalize to one canonical order", () => {
  const a = validExecutionPolicy();
  a["capability_requirements"] = {
    automatic_merge: {
      "repository.merge": { accepted: ["NOT_YET_AUDITED", "ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE"] },
    },
  };
  const b = validExecutionPolicy();
  b["capability_requirements"] = {
    automatic_merge: {
      "repository.merge": { accepted: ["ENFORCED", "NOT_YET_AUDITED", "AVAILABLE_WITH_REDUCED_ASSURANCE"] },
    },
  };

  assert.deepEqual(
    validateExecutionPolicy(a).capability_requirements["automatic_merge"]?.["repository.merge"]
      ?.accepted,
    ["AVAILABLE_WITH_REDUCED_ASSURANCE", "ENFORCED", "NOT_YET_AUDITED"],
  );
  assert.equal(policyHash(a), policyHash(b));
  assert.equal(compileWith(a).compiled_hash, compileWith(b).compiled_hash);
});

// --- S4: approved_overrides.items --------------------------------------------------

test("B4-AC14: override items permutations normalize by field_path", () => {
  const items: ApprovedOverride[] = [
    { field_path: "repository_policy.remote_push", value: "DENY" },
    { field_path: "allow_auto_subflow", value: false },
    { field_path: "batch_policy.max_tasks", value: 1 },
  ];
  const forward = { items };
  const reversed = { items: [...items].reverse() };

  assert.deepEqual(validateApprovedOverrides(forward), validateApprovedOverrides(reversed));
  assert.deepEqual(
    validateApprovedOverrides(forward).items.map((item) => item.field_path),
    ["allow_auto_subflow", "batch_policy.max_tasks", "repository_policy.remote_push"],
  );
  assert.equal(overridesHash(forward), overridesHash(reversed));

  const a = compileWith(validExecutionPolicy(), forward);
  const b = compileWith(validExecutionPolicy(), reversed);
  assert.deepEqual(a.body.effective.policy, b.body.effective.policy);
  assert.equal(a.compiled_hash, b.compiled_hash);
});

test("B4-AC14: a different override value still changes the hash", () => {
  const a = { items: [{ field_path: "batch_policy.max_tasks", value: 1 }] };
  const b = { items: [{ field_path: "batch_policy.max_tasks", value: 2 }] };
  assert.notEqual(overridesHash(a), overridesHash(b));
});

// --- override value normalization --------------------------------------------------

test("B4-AC14: a reordered required_decisions override value is the same value", () => {
  const base = validExecutionPolicy();
  base["human_gate_policy"] = { required_decisions: ["PROPOSE_MERGE"] };

  const forward = compileWith(base, {
    items: [
      {
        field_path: "human_gate_policy.required_decisions",
        value: ["PROPOSE_MERGE", "HOLD_TASK", "START_TASK"],
      },
    ],
  });
  const reordered = compileWith(base, {
    items: [
      {
        field_path: "human_gate_policy.required_decisions",
        value: ["START_TASK", "PROPOSE_MERGE", "HOLD_TASK"],
      },
    ],
  });

  assert.deepEqual(
    forward.body.effective.policy.human_gate_policy.required_decisions,
    ["HOLD_TASK", "PROPOSE_MERGE", "START_TASK"],
  );
  assert.equal(forward.compiled_hash, reordered.compiled_hash);
});

test("B4-AC14: a reordered but identical set is still a no-op override", () => {
  const base = validExecutionPolicy(); // required_decisions: PROPOSE_MERGE, HOLD_TASK
  assert.throws(
    () =>
      compileWith(base, {
        items: [
          {
            field_path: "human_gate_policy.required_decisions",
            value: ["HOLD_TASK", "PROPOSE_MERGE"],
          },
        ],
      }),
    (error: unknown) => error instanceof ProfileCompileError && error.reason === "OVERRIDE_NO_OP",
  );
});

// --- approval binding comparison ---------------------------------------------------

const APPROVAL_HASH = `sha256:${"c".repeat(64)}`;

const permissiveSetOverride: ApprovedOverride = {
  field_path: "human_gate_policy.required_decisions",
  value: ["PROPOSE_MERGE"],
  approval_ref: "operator-action:7",
  approval_hash: APPROVAL_HASH,
};

const compileWithApproval = (approval: ApprovalBindingView) =>
  compileProfile({
    projectProfile: validProjectProfile(),
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: { items: [permissiveSetOverride] },
    lookupApproval: (ref) => (ref === approval.ref ? approval : undefined),
  });

test("B4-AC14: approved_value matching uses field normalization, not raw array order", () => {
  // The record stores the same one-element set; a multi-element reordering case is covered below.
  const result = compileWithApproval({
    ref: "operator-action:7",
    status: "RESOLVED",
    field_path: "human_gate_policy.required_decisions",
    approved_value: ["PROPOSE_MERGE"],
    record_hash: APPROVAL_HASH,
  });
  assert.deepEqual(result.body.effective.policy.human_gate_policy.required_decisions, [
    "PROPOSE_MERGE",
  ]);
});

test("B4-AC14: a reordered approved_value set matches the override value", () => {
  const base = validExecutionPolicy();
  base["human_gate_policy"] = { required_decisions: ["START_TASK", "PROPOSE_MERGE", "HOLD_TASK"] };

  const result = compileProfile({
    projectProfile: validProjectProfile(),
    executionPolicy: base,
    approvedOverrides: {
      items: [
        {
          field_path: "human_gate_policy.required_decisions",
          value: ["PROPOSE_MERGE", "HOLD_TASK"],
          approval_ref: "operator-action:7",
          approval_hash: APPROVAL_HASH,
        },
      ],
    },
    lookupApproval: () => ({
      ref: "operator-action:7",
      status: "RESOLVED",
      field_path: "human_gate_policy.required_decisions",
      approved_value: ["HOLD_TASK", "PROPOSE_MERGE"], // same set, other order
      record_hash: APPROVAL_HASH,
    }),
  });

  assert.deepEqual(result.body.effective.policy.human_gate_policy.required_decisions, [
    "HOLD_TASK",
    "PROPOSE_MERGE",
  ]);
});

test("B4-AC14: approval_hash comparison is never normalized", () => {
  assert.throws(
    () =>
      compileWithApproval({
        ref: "operator-action:7",
        status: "RESOLVED",
        field_path: "human_gate_policy.required_decisions",
        approved_value: ["PROPOSE_MERGE"],
        record_hash: `sha256:${"d".repeat(64)}`,
      }),
    (error: unknown) =>
      error instanceof ProfileCompileError && error.reason === "APPROVAL_BINDING_INVALID",
  );
});

test("B4-AC14: a genuinely different approved value is still a mismatch", () => {
  assert.throws(
    () =>
      compileWithApproval({
        ref: "operator-action:7",
        status: "RESOLVED",
        field_path: "human_gate_policy.required_decisions",
        approved_value: ["HOLD_TASK"],
        record_hash: APPROVAL_HASH,
      }),
    (error: unknown) =>
      error instanceof ProfileCompileError && error.reason === "APPROVAL_BINDING_INVALID",
  );
});

// --- negative: generic arrays stay order-sensitive ---------------------------------

test("B4-AC14: pipeline steps keep lifecycle order and change the profile hash", () => {
  const forward = validProjectProfile();
  forward["pipelines"] = { standard: { steps: ["ACTOR", "VERIFY"] } };
  const reversed = validProjectProfile();
  reversed["pipelines"] = { standard: { steps: ["VERIFY", "ACTOR"] } };

  assert.deepEqual(validateProjectProfile(forward).pipelines["standard"]?.steps, ["ACTOR", "VERIFY"]);
  assert.deepEqual(validateProjectProfile(reversed).pipelines["standard"]?.steps, ["VERIFY", "ACTOR"]);

  const hashOf = (profile: unknown): string =>
    hashEnvelope(
      makeEnvelope(
        "platform/project-profile",
        1,
        validateProjectProfile(profile) as unknown as CanonicalObject,
      ),
    );
  assert.notEqual(hashOf(forward), hashOf(reversed));
});

test("B4-AC14: opaque config arrays are not reordered by Core", () => {
  const profile = validProjectProfile();
  profile["repository"] = {
    adapter: "example-repository",
    config: { ordered: ["z", "a", "m"] },
  };
  assert.deepEqual(validateProjectProfile(profile).repository.config, { ordered: ["z", "a", "m"] });
});

test("B4-AC14: contract_sources order is preserved (not a declared set)", () => {
  const profile = validProjectProfile();
  profile["contract_sources"] = [{ path: "Z.md" }, { path: "A.md" }];
  assert.deepEqual(
    validateProjectProfile(profile).contract_sources.map((entry) => entry.path),
    ["Z.md", "A.md"],
  );
});
