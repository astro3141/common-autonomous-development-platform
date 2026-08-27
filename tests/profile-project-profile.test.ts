/**
 * B4-AC1 / B4-AC5 — ProjectProfileV1 schema and the project-semantics vs automation-authority
 * separation (TD §7.1a, §7.5).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ProfileCompileError } from "../core/profile/errors.ts";
import { validateProjectProfile } from "../core/profile/validate-project-profile.ts";
import { PROJECT_PROFILE_TOP_LEVEL } from "../core/profile/types.ts";
import { validProjectProfile } from "./support/profile-fixtures.ts";

const rejects = (input: unknown, reason?: string): void => {
  assert.throws(
    () => validateProjectProfile(input),
    (error: unknown) =>
      error instanceof ProfileCompileError &&
      error.code === "COMPILE_ERROR" &&
      (reason === undefined || error.reason === reason),
  );
};

test("B4-AC1: a representative profile is accepted and normalized", () => {
  const profile = validateProjectProfile(validProjectProfile());

  assert.equal(profile.id, "alpha");
  assert.equal(profile.version, 1);
  assert.deepEqual(Object.keys(profile).sort(), [...PROJECT_PROFILE_TOP_LEVEL].sort());
  assert.equal(profile.task_sources.length, 1);
  assert.deepEqual(profile.pipelines["standard"]?.steps, [
    "ACTOR",
    "VERIFY",
    "AUDITOR",
    "MERGE_GATE",
  ]);
});

test("B4-AC1: every one of the eleven top-level fields is required", () => {
  assert.equal(PROJECT_PROFILE_TOP_LEVEL.length, 11);
  for (const field of PROJECT_PROFILE_TOP_LEVEL) {
    const profile = validProjectProfile();
    delete profile[field];
    rejects(profile, "SCHEMA_INVALID");
  }
});

test("B4-AC1: an unknown top-level field is rejected", () => {
  rejects({ ...validProjectProfile(), extra: 1 }, "SCHEMA_INVALID");
});

test("B4-AC5: automation-authority fields are rejected by the exact top-level schema", () => {
  const authorityFields = [
    "auto_merge",
    "allow_auto_subflow",
    "batch_policy",
    "repository_policy",
    "human_gate_policy",
    "verification_policy",
    "classification_policy",
    "capability_requirements",
    "contract_drift_policy",
    "recovery_policy",
  ];
  for (const field of authorityFields) {
    rejects({ ...validProjectProfile(), [field]: {} }, "SCHEMA_INVALID");
  }
});

test("B4-AC1: id follows the §6.1 structural grammar", () => {
  rejects({ ...validProjectProfile(), id: "" }, "SCHEMA_INVALID");
  rejects({ ...validProjectProfile(), id: "alpha:beta" }, "SCHEMA_INVALID");
  rejects({ ...validProjectProfile(), version: 0 }, "SCHEMA_INVALID");
  rejects({ ...validProjectProfile(), version: 1.5 }, "SCHEMA_INVALID");
});

test("B4-AC1: duplicate task source id and contract source path are rejected", () => {
  const duplicateSource = validProjectProfile();
  duplicateSource["task_sources"] = [
    { id: "primary", adapter: "a", config: {} },
    { id: "primary", adapter: "b", config: {} },
  ];
  rejects(duplicateSource, "DUPLICATE");

  const duplicatePath = validProjectProfile();
  duplicatePath["contract_sources"] = [{ path: "SPEC.md" }, { path: "SPEC.md" }];
  rejects(duplicatePath, "DUPLICATE");
});

test("B4-AC1: adapter config stays opaque and is preserved verbatim", () => {
  const profile = validProjectProfile();
  const config = { nested: { list: [1, 2, 3], flag: true }, note: null, unknown_key: "kept" };
  profile["repository"] = { adapter: "example-repository", config };

  const validated = validateProjectProfile(profile);
  assert.deepEqual(validated.repository.config, config);
});

test("B4-AC1: a config outside the restricted JSON model is rejected", () => {
  const profile = validProjectProfile();
  profile["repository"] = { adapter: "example-repository", config: { ratio: 0.5 } };
  rejects(profile, "SCHEMA_INVALID");
});

test("B4-AC1: wrapper shapes are exact", () => {
  const extraWrapper = validProjectProfile();
  extraWrapper["hooks"] = { h: { adapter: "a", config: {}, extra: 1 } };
  rejects(extraWrapper, "SCHEMA_INVALID");

  const inlineScript = validProjectProfile();
  inlineScript["hooks"] = { h: { adapter: "a", config: {}, script: "rm -rf" } };
  rejects(inlineScript, "SCHEMA_INVALID");

  const emptyKey = validProjectProfile();
  emptyKey["roles"] = { "": { runtime_profile: "standard", config: {} } };
  rejects(emptyKey, "SCHEMA_INVALID");
});

test("B4-AC1: disposition and pipeline step vocabularies are closed", () => {
  const badDisposition = validProjectProfile();
  badDisposition["classifications"] = { X: { default_execution_policy: "AUTO_MERGE" } };
  rejects(badDisposition, "SCHEMA_INVALID");

  const badStep = validProjectProfile();
  badStep["pipelines"] = { standard: { steps: ["ACTOR", "DEPLOY"] } };
  rejects(badStep, "SCHEMA_INVALID");

  const emptySteps = validProjectProfile();
  emptySteps["pipelines"] = { standard: { steps: [] } };
  rejects(emptySteps, "SCHEMA_INVALID");
});

test("B4-AC1: pipeline step order and repetition carry no invented rule", () => {
  const profile = validProjectProfile();
  profile["pipelines"] = {
    unusual: {
      steps: ["AUDITOR", "ACTOR", "ACTOR", "HUMAN_GATE", "VERIFY"],
      auditor_profile: "review",
    },
  };
  const validated = validateProjectProfile(profile);
  assert.equal(validated.pipelines["unusual"]?.steps.length, 5);
});
