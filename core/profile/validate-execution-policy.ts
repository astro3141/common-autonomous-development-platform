/**
 * ExecutionPolicyV1 validation (TD §7.1b).
 *
 * Exactly twelve top-level fields, all required. No implicit defaults anywhere — the single
 * exception the TD grants is the *inner* drift targets, whose §11.2 defaults fill in when a target
 * is absent.
 */

import { ProfileCompileError, schemaError } from "./errors.ts";
import { sortCanonicalStrings } from "./semantic-set.ts";
import {
  asBoolean,
  asInteger,
  asMember,
  asNonEmptyString,
  asObject,
  assertNonEmptyKeys,
  assertUnique,
  exactKeys,
} from "./shape.ts";
import {
  ASSURANCE_LEVELS,
  CAPABILITY_NAMES,
  DECISION_TYPES,
  DRIFT_ACTIONS,
  DRIFT_POLICY_DEFAULTS,
  DRIFT_TARGETS,
  ENFORCEMENT_ASSURANCES,
  EXECUTION_DISPOSITIONS,
  EXECUTION_POLICY_TOP_LEVEL,
  REMOTE_PUSH_MODES,
  type BatchPolicy,
  type CapabilityName,
  type CapabilityRequirements,
  type DriftRule,
  type DriftTarget,
  type ExecutionDisposition,
  type ExecutionPolicyV1Body,
  type HumanGatePolicy,
  type RecoveryPolicy,
  type RepositoryPolicy,
  type VerificationPolicy,
} from "./types.ts";

export function validateExecutionPolicy(input: unknown): ExecutionPolicyV1Body {
  const body = asObject(input, "");
  exactKeys(body, "", EXECUTION_POLICY_TOP_LEVEL as readonly string[]);

  return {
    id: asNonEmptyString(body["id"], "/id"),
    version: asInteger(body["version"], "/version", 1),
    classification_policy: classificationPolicy(body["classification_policy"]),
    auto_merge: asBoolean(body["auto_merge"], "/auto_merge"),
    allow_auto_subflow: asBoolean(body["allow_auto_subflow"], "/allow_auto_subflow"),
    batch_policy: batchPolicy(body["batch_policy"]),
    repository_policy: repositoryPolicy(body["repository_policy"]),
    human_gate_policy: humanGatePolicy(body["human_gate_policy"]),
    verification_policy: verificationPolicy(body["verification_policy"]),
    capability_requirements: capabilityRequirements(body["capability_requirements"]),
    contract_drift_policy: contractDriftPolicy(body["contract_drift_policy"]),
    recovery_policy: recoveryPolicy(body["recovery_policy"]),
  };
}

function classificationPolicy(value: unknown): Readonly<Record<string, ExecutionDisposition>> {
  const object = asObject(value, "/classification_policy");
  assertNonEmptyKeys(object, "/classification_policy");
  const result: Record<string, ExecutionDisposition> = {};
  for (const [name, disposition] of Object.entries(object)) {
    result[name] = asMember(
      disposition,
      `/classification_policy/${name}`,
      EXECUTION_DISPOSITIONS,
    );
  }
  return result;
}

function batchPolicy(value: unknown): BatchPolicy {
  const object = asObject(value, "/batch_policy");
  exactKeys(object, "/batch_policy", ["max_tasks", "max_rework", "concurrency"]);
  return {
    max_tasks: asInteger(object["max_tasks"], "/batch_policy/max_tasks", 1),
    max_rework: asInteger(object["max_rework"], "/batch_policy/max_rework", 0),
    concurrency: asInteger(object["concurrency"], "/batch_policy/concurrency", 1),
  };
}

function repositoryPolicy(value: unknown): RepositoryPolicy {
  const path = "/repository_policy";
  const object = asObject(value, path);
  exactKeys(object, path, [
    "remote_push",
    "direct_canonical_write",
    "allow_force_push",
    "allow_tag_change",
    "allow_git_clean",
    "allow_reset_hard",
  ]);
  return {
    // Uppercase canonical values only — a lowercase spelling is invalid, never normalized.
    remote_push: asMember(object["remote_push"], `${path}/remote_push`, REMOTE_PUSH_MODES),
    direct_canonical_write: asBoolean(
      object["direct_canonical_write"],
      `${path}/direct_canonical_write`,
    ),
    allow_force_push: asBoolean(object["allow_force_push"], `${path}/allow_force_push`),
    allow_tag_change: asBoolean(object["allow_tag_change"], `${path}/allow_tag_change`),
    allow_git_clean: asBoolean(object["allow_git_clean"], `${path}/allow_git_clean`),
    allow_reset_hard: asBoolean(object["allow_reset_hard"], `${path}/allow_reset_hard`),
  };
}

function humanGatePolicy(value: unknown): HumanGatePolicy {
  const path = "/human_gate_policy";
  const object = asObject(value, path);
  exactKeys(object, path, ["required_decisions"]);
  const raw = object["required_decisions"];
  if (!Array.isArray(raw)) throw schemaError(`${path}/required_decisions`, "expected an array");
  const decisions = raw.map((entry, index) =>
    asMember(entry, `${path}/required_decisions/${index}`, DECISION_TYPES),
  );
  assertUnique(decisions, `${path}/required_decisions`, "decision type");
  // Semantic set (§7.1b M0-13): canonical order is code-point ascending.
  return { required_decisions: sortCanonicalStrings(decisions) };
}

function verificationPolicy(value: unknown): VerificationPolicy {
  const path = "/verification_policy";
  const object = asObject(value, path);
  exactKeys(object, path, ["required_verification"]);
  const required = asObject(object["required_verification"], `${path}/required_verification`);
  assertNonEmptyKeys(required, `${path}/required_verification`);

  const result: Record<string, { accepted_assurance: readonly ("REEXECUTED" | "ARTIFACT_VERIFIED" | "LOG_VERIFIED" | "WORKER_REPORTED" | "INFERRED")[] }> = {};
  for (const [checkId, entry] of Object.entries(required)) {
    const checkPath = `${path}/required_verification/${checkId}`;
    const body = asObject(entry, checkPath);
    exactKeys(body, checkPath, ["accepted_assurance"]);
    const raw = body["accepted_assurance"];
    if (!Array.isArray(raw)) throw schemaError(`${checkPath}/accepted_assurance`, "expected an array");
    if (raw.length === 0) throw schemaError(`${checkPath}/accepted_assurance`, "must not be empty");
    const levels = raw.map((level, index) =>
      asMember(level, `${checkPath}/accepted_assurance/${index}`, ASSURANCE_LEVELS),
    );
    assertUnique(levels, `${checkPath}/accepted_assurance`, "assurance level");
    result[checkId] = { accepted_assurance: sortCanonicalStrings(levels) };
  }
  return { required_verification: result };
}

function capabilityRequirements(value: unknown): CapabilityRequirements {
  const path = "/capability_requirements";
  const object = asObject(value, path);
  assertNonEmptyKeys(object, path);

  const result: Record<
    string,
    Partial<Record<CapabilityName, { accepted: readonly ("ENFORCED" | "AVAILABLE_WITH_REDUCED_ASSURANCE" | "UNENFORCEABLE_CAPABILITY_BOUNDARY" | "NOT_YET_AUDITED")[] }>>
  > = {};
  for (const [operationId, entry] of Object.entries(object)) {
    const operationPath = `${path}/${operationId}`;
    const capabilities = asObject(entry, operationPath);
    const perOperation: Partial<Record<CapabilityName, { accepted: readonly ("ENFORCED" | "AVAILABLE_WITH_REDUCED_ASSURANCE" | "UNENFORCEABLE_CAPABILITY_BOUNDARY" | "NOT_YET_AUDITED")[] }>> = {};
    for (const [capability, requirement] of Object.entries(capabilities)) {
      const capabilityName = asMember(capability, `${operationPath}/${capability}`, CAPABILITY_NAMES);
      const requirementPath = `${operationPath}/${capability}`;
      const body = asObject(requirement, requirementPath);
      exactKeys(body, requirementPath, ["accepted"]);
      const raw = body["accepted"];
      if (!Array.isArray(raw)) throw schemaError(`${requirementPath}/accepted`, "expected an array");
      if (raw.length === 0) throw schemaError(`${requirementPath}/accepted`, "must not be empty");
      const accepted = raw.map((level, index) =>
        asMember(level, `${requirementPath}/accepted/${index}`, ENFORCEMENT_ASSURANCES),
      );
      assertUnique(accepted, `${requirementPath}/accepted`, "enforcement assurance");
      perOperation[capabilityName] = { accepted: sortCanonicalStrings(accepted) };
    }
    result[operationId] = perOperation;
  }
  return result;
}

function contractDriftPolicy(value: unknown): Readonly<Record<DriftTarget, DriftRule>> {
  const path = "/contract_drift_policy";
  const object = asObject(value, path);
  for (const key of Object.keys(object)) {
    if (!(DRIFT_TARGETS as readonly string[]).includes(key)) {
      throw schemaError(path, `unknown drift target "${key}"`);
    }
  }

  const result = {} as Record<DriftTarget, DriftRule>;
  for (const target of DRIFT_TARGETS) {
    const entry = object[target];
    if (entry === undefined) {
      // TD §7.1b: the only implicit defaults in the whole policy are these inner drift targets.
      result[target] = DRIFT_POLICY_DEFAULTS[target];
      continue;
    }
    const targetPath = `${path}/${target}`;
    const body = asObject(entry, targetPath);
    for (const key of Object.keys(body)) {
      if (key !== "action" && key !== "boundary") {
        throw schemaError(targetPath, `unknown field "${key}"`);
      }
    }
    const action = asMember(body["action"], `${targetPath}/action`, DRIFT_ACTIONS);
    if (Object.hasOwn(body, "boundary")) {
      result[target] = {
        action,
        boundary: asMember(body["boundary"], `${targetPath}/boundary`, ["MERGE_ONLY"] as const),
      };
    } else {
      result[target] = { action };
    }
  }
  return result;
}

function recoveryPolicy(value: unknown): RecoveryPolicy {
  const path = "/recovery_policy";
  const object = asObject(value, path);
  exactKeys(object, path, ["capability_downgrade"]);
  return {
    capability_downgrade: asMember(
      object["capability_downgrade"],
      `${path}/capability_downgrade`,
      ["HOLD", "PAUSE"] as const,
    ),
  };
}

/** Re-exported so the compiler can report a duplicate consistently. */
export { ProfileCompileError };
