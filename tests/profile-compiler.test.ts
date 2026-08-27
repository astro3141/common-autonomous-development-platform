/**
 * B4-AC4 / B4-AC6 / B4-AC10 / B4-AC11 / B4-AC12 / B4-AC13 — classification resolution, effective
 * validation and the Compiled Profile envelope (TD §7.2, §7.3, §7.7).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileProfile } from "../core/profile/compiler.ts";
import { ProfileCompileError } from "../core/profile/errors.ts";
import { hashEnvelope, makeEnvelope } from "../core/schemas/envelope.ts";
import { isDigest } from "../core/schemas/digest.ts";
import { validateExecutionPolicy } from "../core/profile/validate-execution-policy.ts";
import { validateProjectProfile } from "../core/profile/validate-project-profile.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import {
  autoMergePolicy,
  noOverrides,
  validExecutionPolicy,
  validProjectProfile,
} from "./support/profile-fixtures.ts";

const compile = (
  projectProfile: unknown = validProjectProfile(),
  executionPolicy: unknown = validExecutionPolicy(),
  approvedOverrides: unknown = noOverrides(),
) => compileProfile({ projectProfile, executionPolicy, approvedOverrides });

const failsWith = (reason: string, project: unknown, policy: unknown): void => {
  assert.throws(
    () => compile(project, policy),
    (error: unknown) => error instanceof ProfileCompileError && error.reason === reason,
  );
};

// --- classification resolution ----------------------------------------------------

test("B4-AC6: absent explicit policy falls back to the Project Profile default", () => {
  const result = compile();
  assert.equal(result.body.effective.policy.classification_policy["ROUTINE_ITEM"], "AUTO_EXECUTE");
});

test("B4-AC6: an explicit Execution Policy value always wins", () => {
  const result = compile();
  // Profile default for LARGE_ITEM is HOLD_HUMAN; the policy declares AUTO_SUBFLOW.
  assert.equal(result.body.effective.policy.classification_policy["LARGE_ITEM"], "AUTO_SUBFLOW");
});

test("B4-AC6: an explicit classification unknown to the Profile is rejected", () => {
  const policy = validExecutionPolicy();
  policy["classification_policy"] = { NOT_DECLARED: "AUTO_EXECUTE" };
  failsWith("EFFECTIVE_INVALID", validProjectProfile(), policy);
});

test("B4-AC11: the resolved map covers exactly the Profile classification key set", () => {
  const result = compile();
  assert.deepEqual(
    Object.keys(result.body.effective.policy.classification_policy).sort(),
    ["LARGE_ITEM", "ROUTINE_ITEM"],
  );
});

// --- effective validation ---------------------------------------------------------

test("B4-AC11: auto_merge requires merge capability requirements", () => {
  const policy = autoMergePolicy();
  policy["capability_requirements"] = { other_operation: { "shell.execute": { accepted: ["ENFORCED"] } } };
  failsWith("EFFECTIVE_INVALID", validProjectProfile(), policy);
});

test("B4-AC11: auto_merge forbids CONTINUE_SNAPSHOT canonical_head drift", () => {
  const policy = autoMergePolicy();
  policy["contract_drift_policy"] = { canonical_head: { action: "CONTINUE_SNAPSHOT" } };
  failsWith("EFFECTIVE_INVALID", validProjectProfile(), policy);
});

test("B4-AC11: auto_merge forbids a required check accepted only as self-reported", () => {
  const policy = autoMergePolicy();
  policy["verification_policy"] = {
    required_verification: { unit: { accepted_assurance: ["WORKER_REPORTED", "INFERRED"] } },
  };
  failsWith("EFFECTIVE_INVALID", validProjectProfile(), policy);

  const mixed = autoMergePolicy();
  mixed["verification_policy"] = {
    required_verification: { unit: { accepted_assurance: ["WORKER_REPORTED", "REEXECUTED"] } },
  };
  assert.ok(compile(validProjectProfile(), mixed).compiled_hash);
});

test("auto_merge=false leaves the safety rules inapplicable", () => {
  const policy = validExecutionPolicy();
  policy["contract_drift_policy"] = { canonical_head: { action: "CONTINUE_SNAPSHOT" } };
  assert.ok(compile(validProjectProfile(), policy).compiled_hash);
});

// --- compiled profile envelope ----------------------------------------------------

test("B4-AC4: the compiled envelope has the exact schema, versions and body", () => {
  const result = compile();

  assert.equal(result.envelope.schema, "platform/compiled-profile");
  assert.equal(result.envelope.schema_version, 1);
  assert.equal(result.body.compiled_version, 1);
  assert.equal(result.body.merge_rules_version, 1);
  assert.deepEqual(Object.keys(result.body).sort(), [
    "approved_overrides",
    "compiled_version",
    "effective",
    "execution_policy",
    "merge_rules_version",
    "project_profile",
  ]);
});

test("B4-AC4: compiled_hash is not a member of the hashed body", () => {
  const result = compile();
  assert.equal("compiled_hash" in result.body, false);
  assert.equal(JSON.stringify(result.body).includes("compiled_hash"), false);
  assert.ok(isDigest(result.compiled_hash));
  assert.equal(result.compiled_hash, hashEnvelope(result.envelope));
});

test("B4-AC12: component hashes are the Batch 1 envelope hashes of their sources", () => {
  const result = compile();
  const project = validateProjectProfile(validProjectProfile());
  const policy = validateExecutionPolicy(validExecutionPolicy());

  assert.equal(
    result.body.project_profile.hash,
    hashEnvelope(makeEnvelope("platform/project-profile", 1, project as unknown as CanonicalObject)),
  );
  assert.equal(
    result.body.execution_policy.hash,
    hashEnvelope(makeEnvelope("platform/execution-policy", 1, policy as unknown as CanonicalObject)),
  );
  assert.equal(
    result.body.approved_overrides.hash,
    hashEnvelope(makeEnvelope("platform/approved-overrides", 1, { items: [] })),
  );
  assert.deepEqual(
    { id: result.body.project_profile.id, version: result.body.project_profile.version },
    { id: "alpha", version: 1 },
  );
});

test("B4-AC10: effective.project equals the validated profile and ignores overrides", () => {
  const result = compileProfile({
    projectProfile: validProjectProfile(),
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: { items: [{ field_path: "allow_auto_subflow", value: false }] },
  });

  assert.deepEqual(result.body.effective.project, validateProjectProfile(validProjectProfile()));
  assert.equal(result.body.effective.policy.allow_auto_subflow, false, "policy did change");
});

test("B4-AC11: downstream needs only effective.policy", () => {
  const result = compileProfile({
    projectProfile: validProjectProfile(),
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: { items: [{ field_path: "batch_policy.max_tasks", value: 1 }] },
  });

  const effective = result.body.effective.policy;
  assert.equal(effective.batch_policy.max_tasks, 1); // override applied
  assert.equal(effective.classification_policy["ROUTINE_ITEM"], "AUTO_EXECUTE"); // default resolved
  assert.equal(effective.classification_policy["LARGE_ITEM"], "AUTO_SUBFLOW"); // explicit resolved
});

// --- hash determinism -------------------------------------------------------------

test("B4-AC12: identical semantic inputs yield the same compiled hash", () => {
  assert.equal(compile().compiled_hash, compile().compiled_hash);

  // Key insertion order of the input documents must not matter (Batch 1 canonicalization).
  const shuffled = Object.fromEntries(Object.entries(validProjectProfile()).reverse());
  assert.equal(compile(shuffled).compiled_hash, compile().compiled_hash);
});

test("B4-AC12: a meaningful policy change changes the compiled hash", () => {
  const changed = validExecutionPolicy();
  changed["batch_policy"] = { max_tasks: 2, max_rework: 2, concurrency: 1 };

  assert.notEqual(compile(validProjectProfile(), changed).compiled_hash, compile().compiled_hash);
});

test("B4-AC13: merge_rules_version participates in the hashed body", () => {
  const result = compile();
  const tampered = {
    ...(result.envelope.body as unknown as Record<string, unknown>),
    merge_rules_version: 2,
  };

  assert.notEqual(
    hashEnvelope(makeEnvelope("platform/compiled-profile", 1, tampered as CanonicalObject)),
    result.compiled_hash,
    "a different merge algorithm version must produce a different compiled hash",
  );
});

test("B4-AC12: a resolved classification difference changes the compiled hash", () => {
  const policy = validExecutionPolicy();
  policy["classification_policy"] = {};

  assert.notEqual(compile(validProjectProfile(), policy).compiled_hash, compile().compiled_hash);
});
