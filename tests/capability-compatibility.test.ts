/**
 * B5-AC10, B5-AC11 — accepted-set membership only, with no assurance ranking and no effect from
 * `receipt_supported` (TD §12.2, M0-19).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCapabilityRequirements } from "../core/capability/compatibility.ts";
import { deriveRequestedCapabilities } from "../core/capability/derive.ts";
import { validateManifest } from "../core/capability/validate-manifest.ts";
import { validateExecutionPolicy } from "../core/profile/validate-execution-policy.ts";
import type { CapabilityRequirementMap, RuntimeManifestBody } from "../core/capability/types.ts";
import { validExecutionPolicy } from "./support/profile-fixtures.ts";
import { runtimeManifest, uniformEnforcement } from "./support/capability-fixtures.ts";

const policy = validateExecutionPolicy(validExecutionPolicy());
const actorRequested = deriveRequestedCapabilities(policy, "ACTOR");

const runtimeBody = (overrides: Record<string, unknown> = {}): RuntimeManifestBody => {
  const manifest = runtimeManifest();
  manifest["body"] = { ...(manifest["body"] as Record<string, unknown>), ...overrides };
  return validateManifest(manifest).body as RuntimeManifestBody;
};

const strong = runtimeBody();
const weak = runtimeBody({
  capability_enforcement: uniformEnforcement("NOT_YET_AUDITED", "NOT_YET_AUDITED"),
});

test("B5-AC10: every requirement satisfied → compatible", () => {
  const requirements: CapabilityRequirementMap = {
    "repository.feature_write": { accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE"] },
    "repository.canonical_write": { accepted: ["ENFORCED"] },
  };
  const result = evaluateCapabilityRequirements(actorRequested, strong, requirements);

  assert.equal(result.compatible, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checks.length, 2);
});

test("B5-AC10: one unsatisfied requirement → incompatible with deterministic detail", () => {
  const requirements: CapabilityRequirementMap = {
    "repository.merge": { accepted: ["ENFORCED"] },
  };
  const result = evaluateCapabilityRequirements(actorRequested, weak, requirements);

  assert.equal(result.compatible, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0], {
    capability: "repository.merge",
    requested: false,
    actual: "NOT_YET_AUDITED",
    accepted: ["ENFORCED"],
    passed: false,
  });
});

test("B5-AC10: multiple failures are reported in fixed vocabulary order", () => {
  const requirements: CapabilityRequirementMap = {
    "shell.execute": { accepted: ["ENFORCED"] },
    "repository.read": { accepted: ["ENFORCED"] },
    "destructive.reset_hard": { accepted: ["ENFORCED"] },
  };
  const result = evaluateCapabilityRequirements(actorRequested, weak, requirements);

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.capability),
    ["repository.read", "shell.execute", "destructive.reset_hard"],
  );
});

test("B5-AC10: NOT_YET_AUDITED passes only when the policy lists it", () => {
  const accepted: CapabilityRequirementMap = {
    "shell.execute": { accepted: ["ENFORCED", "NOT_YET_AUDITED"] },
  };
  const absent: CapabilityRequirementMap = {
    "shell.execute": { accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE"] },
  };

  assert.equal(evaluateCapabilityRequirements(actorRequested, weak, accepted).compatible, true);
  assert.equal(evaluateCapabilityRequirements(actorRequested, weak, absent).compatible, false);
});

test("B5-AC10: UNENFORCEABLE_CAPABILITY_BOUNDARY passes only when listed", () => {
  const body = runtimeBody({
    capability_enforcement: uniformEnforcement("ENFORCED", "UNENFORCEABLE_CAPABILITY_BOUNDARY"),
  });
  const listed: CapabilityRequirementMap = {
    "repository.canonical_write": { accepted: ["UNENFORCEABLE_CAPABILITY_BOUNDARY"] },
  };
  const notListed: CapabilityRequirementMap = {
    "repository.canonical_write": { accepted: ["ENFORCED"] },
  };

  assert.equal(evaluateCapabilityRequirements(actorRequested, body, listed).compatible, true);
  assert.equal(evaluateCapabilityRequirements(actorRequested, body, notListed).compatible, false);
});

test("B5-AC10: there is no assurance ranking — a 'stronger' value does not satisfy another", () => {
  const body = runtimeBody({
    capability_enforcement: uniformEnforcement("ENFORCED", "ENFORCED"),
  });
  const requirements: CapabilityRequirementMap = {
    "shell.execute": { accepted: ["AVAILABLE_WITH_REDUCED_ASSURANCE"] },
  };
  // ENFORCED is intuitively "stronger", but membership is the only test.
  assert.equal(evaluateCapabilityRequirements(actorRequested, body, requirements).compatible, false);
});

test("B5-AC10: requirement key order does not change the outcome", () => {
  const forward: CapabilityRequirementMap = {
    "repository.read": { accepted: ["ENFORCED"] },
    "shell.execute": { accepted: ["ENFORCED"] },
  };
  const reversed: CapabilityRequirementMap = {
    "shell.execute": { accepted: ["ENFORCED"] },
    "repository.read": { accepted: ["ENFORCED"] },
  };

  assert.deepEqual(
    evaluateCapabilityRequirements(actorRequested, strong, forward),
    evaluateCapabilityRequirements(actorRequested, strong, reversed),
  );
});

test("B5-AC10: an empty requirement map is vacuously compatible and reads no operation taxonomy", () => {
  const result = evaluateCapabilityRequirements(actorRequested, weak, {});
  assert.equal(result.compatible, true);
  assert.deepEqual(result.checks, []);
  // The primitive takes an already-selected requirement map — no operation_id parameter exists.
  assert.equal(evaluateCapabilityRequirements.length, 3);
});

test("B5-AC11: receipt_supported has no effect on compatibility", () => {
  const supported = runtimeBody({ receipt_supported: true });
  const unsupported = runtimeBody({ receipt_supported: false });
  const requirements: CapabilityRequirementMap = {
    "repository.read": { accepted: ["ENFORCED"] },
    "repository.canonical_write": { accepted: ["ENFORCED"] },
  };

  assert.deepEqual(
    evaluateCapabilityRequirements(actorRequested, supported, requirements),
    evaluateCapabilityRequirements(actorRequested, unsupported, requirements),
  );
  assert.equal(
    evaluateCapabilityRequirements(actorRequested, unsupported, requirements).compatible,
    true,
  );
});
