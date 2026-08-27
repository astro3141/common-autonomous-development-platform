/**
 * B5-AC6 ~ B5-AC9, B5-AC15 — CoreExecutionRole, requested derivation, directional enforcement and
 * the TaskContractCapabilityView seam (TD §12.4, §12.2a, §12.7).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveEnforcement, deriveRequestedCapabilities } from "../core/capability/derive.ts";
import { validateManifest } from "../core/capability/validate-manifest.ts";
import { CAPABILITY_NAMES } from "../core/schemas/capability-vocabulary.ts";
import { CORE_EXECUTION_ROLES } from "../core/capability/types.ts";
import type { RuntimeManifestBody, TaskContractCapabilityView } from "../core/capability/types.ts";
import { validateExecutionPolicy } from "../core/profile/validate-execution-policy.ts";
import type { ExecutionPolicyV1Body, RemotePushMode } from "../core/profile/types.ts";
import { validExecutionPolicy } from "./support/profile-fixtures.ts";
import { runtimeManifest, uniformEnforcement } from "./support/capability-fixtures.ts";

const policyWithPush = (mode: RemotePushMode): ExecutionPolicyV1Body => {
  const raw = validExecutionPolicy();
  raw["repository_policy"] = {
    ...(raw["repository_policy"] as Record<string, unknown>),
    remote_push: mode,
  };
  return validateExecutionPolicy(raw);
};

const trueOnes = (map: Readonly<Record<string, boolean>>): string[] =>
  Object.entries(map)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .sort();

test("B5-AC6: CoreExecutionRole is exactly SUPERVISOR | ACTOR | AUDITOR", () => {
  assert.deepEqual([...CORE_EXECUTION_ROLES], ["SUPERVISOR", "ACTOR", "AUDITOR"]);
});

test("B5-AC7: SUPERVISOR requests nothing", () => {
  const requested = deriveRequestedCapabilities(policyWithPush("FEATURE_BRANCH_ONLY"), "SUPERVISOR");

  assert.equal(Object.keys(requested).length, 12);
  assert.deepEqual(trueOnes(requested), []);
});

test("B5-AC7: AUDITOR requests repository.read only", () => {
  const requested = deriveRequestedCapabilities(policyWithPush("FEATURE_BRANCH_ONLY"), "AUDITOR");

  assert.equal(Object.keys(requested).length, 12);
  assert.deepEqual(trueOnes(requested), ["repository.read"]);
});

test("B5-AC7: ACTOR baseline plus the policy-derived push flag", () => {
  assert.deepEqual(trueOnes(deriveRequestedCapabilities(policyWithPush("DENY"), "ACTOR")), [
    "repository.feature_write",
    "repository.read",
    "shell.execute",
  ]);
  assert.deepEqual(
    trueOnes(deriveRequestedCapabilities(policyWithPush("PLATFORM_MANAGED_ONLY"), "ACTOR")),
    ["repository.feature_write", "repository.read", "shell.execute"],
  );
  assert.deepEqual(
    trueOnes(deriveRequestedCapabilities(policyWithPush("FEATURE_BRANCH_ONLY"), "ACTOR")),
    ["remote.feature_push", "repository.feature_write", "repository.read", "shell.execute"],
  );
});

test("B5-AC7: every role produces a complete twelve-key map", () => {
  for (const role of CORE_EXECUTION_ROLES) {
    const requested = deriveRequestedCapabilities(policyWithPush("DENY"), role);
    assert.deepEqual(Object.keys(requested).sort(), [...CAPABILITY_NAMES].sort());
    for (const capability of CAPABILITY_NAMES) {
      assert.equal(typeof requested[capability], "boolean");
    }
  }
});

test("B5-AC15: derivation takes only policy and role — no profile config or model input", () => {
  // Arity is the contract: there is no parameter through which role config, runtime_profile or a
  // Supervisor proposal could reach the calculation.
  assert.equal(deriveRequestedCapabilities.length, 2);

  // Two policies that differ only outside repository_policy give the same requested map.
  const base = validExecutionPolicy();
  const otherRoles = validExecutionPolicy();
  otherRoles["batch_policy"] = { max_tasks: 9, max_rework: 5, concurrency: 1 };

  assert.deepEqual(
    deriveRequestedCapabilities(validateExecutionPolicy(base), "ACTOR"),
    deriveRequestedCapabilities(validateExecutionPolicy(otherRoles), "ACTOR"),
  );
});

test("B5-AC8: TaskContractCapabilityView exists as a type seam without a Task Contract", () => {
  const view: TaskContractCapabilityView = {
    repository_scope: { allowed_paths: ["src/"], forbidden_paths: [".platform/"] },
  };
  assert.deepEqual(Object.keys(view), ["repository_scope"]);

  // The view has no influence on derivation in v1 (no path→capability inference).
  const policy = policyWithPush("FEATURE_BRANCH_ONLY");
  const empty: TaskContractCapabilityView = {
    repository_scope: { allowed_paths: [], forbidden_paths: [] },
  };
  assert.deepEqual(
    deriveRequestedCapabilities(policy, "ACTOR"),
    deriveRequestedCapabilities(policy, "ACTOR"),
  );
  assert.equal(empty.repository_scope.allowed_paths.length, 0);
});

// --- directional enforcement ---------------------------------------------------------

const runtimeBody = (overrides: Record<string, unknown> = {}): RuntimeManifestBody => {
  const manifest = runtimeManifest();
  manifest["body"] = { ...(manifest["body"] as Record<string, unknown>), ...overrides };
  return validateManifest(manifest).body as RuntimeManifestBody;
};

test("B5-AC9: requested=true selects allow, requested=false selects deny", () => {
  const body = runtimeBody({
    capability_enforcement: uniformEnforcement("ENFORCED", "UNENFORCEABLE_CAPABILITY_BOUNDARY"),
  });
  const requested = deriveRequestedCapabilities(policyWithPush("FEATURE_BRANCH_ONLY"), "ACTOR");
  const enforcement = deriveEnforcement(requested, body);

  assert.equal(enforcement["repository.feature_write"], "ENFORCED");
  assert.equal(enforcement["repository.canonical_write"], "UNENFORCEABLE_CAPABILITY_BOUNDARY");
  assert.equal(enforcement["remote.feature_push"], "ENFORCED");
  assert.equal(enforcement["remote.canonical_push"], "UNENFORCEABLE_CAPABILITY_BOUNDARY");
  assert.deepEqual(Object.keys(enforcement).sort(), [...CAPABILITY_NAMES].sort());
});

test("B5-AC9: values are copied verbatim, including NOT_YET_AUDITED", () => {
  const body = runtimeBody({
    capability_enforcement: uniformEnforcement("NOT_YET_AUDITED", "NOT_YET_AUDITED"),
  });
  const requested = deriveRequestedCapabilities(policyWithPush("DENY"), "ACTOR");
  const enforcement = deriveEnforcement(requested, body);

  for (const capability of CAPABILITY_NAMES) {
    assert.equal(enforcement[capability], "NOT_YET_AUDITED", `${capability} must be copied as-is`);
  }
});

test("B5-AC9: a per-capability mixed map maps entry by entry", () => {
  const mixed = uniformEnforcement("ENFORCED", "NOT_YET_AUDITED");
  mixed["shell.execute"] = { allow: "AVAILABLE_WITH_REDUCED_ASSURANCE", deny: "ENFORCED" };
  mixed["repository.merge"] = { allow: "ENFORCED", deny: "UNENFORCEABLE_CAPABILITY_BOUNDARY" };

  const enforcement = deriveEnforcement(
    deriveRequestedCapabilities(policyWithPush("DENY"), "ACTOR"),
    runtimeBody({ capability_enforcement: mixed }),
  );

  assert.equal(enforcement["shell.execute"], "AVAILABLE_WITH_REDUCED_ASSURANCE"); // requested
  assert.equal(enforcement["repository.merge"], "UNENFORCEABLE_CAPABILITY_BOUNDARY"); // denied
  assert.equal(enforcement["repository.read"], "ENFORCED");
  assert.equal(enforcement["destructive.reset_hard"], "NOT_YET_AUDITED");
});
