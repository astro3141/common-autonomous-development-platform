/**
 * Profile Compiler (TD §7.1–§7.7).
 *
 * Pure and deterministic: normalized objects in, Compiled Profile out. No I/O, no clock, no
 * randomness, no YAML. Every failure is a `ProfileCompileError` raised before a Compiled Profile
 * exists — nothing is coerced or defaulted beyond the drift targets the TD explicitly allows.
 */

import { hashEnvelope, makeEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { ProfileCompileError } from "./errors.ts";
import {
  applyOverride,
  canonicalEquals,
  privilegeDirection,
  readPolicyValue,
  typeOverrideValue,
  type OverridePath,
} from "./override-policy.ts";
import { validateApprovedOverrides } from "./validate-overrides.ts";
import { validateExecutionPolicy } from "./validate-execution-policy.ts";
import { validateProjectProfile } from "./validate-project-profile.ts";
import {
  APPROVED_OVERRIDES_SCHEMA,
  COMPILED_PROFILE_SCHEMA,
  COMPILED_VERSION,
  EXECUTION_POLICY_SCHEMA,
  MERGE_OPERATION_ID,
  MERGE_RULES_VERSION,
  PROJECT_PROFILE_SCHEMA,
  type ApprovalLookup,
  type ApprovedOverride,
  type CompiledProfileV1Body,
  type ExecutionPolicyV1Body,
  type ProjectProfileV1Body,
} from "./types.ts";

export interface CompileInput {
  readonly projectProfile: unknown;
  readonly executionPolicy: unknown;
  readonly approvedOverrides: unknown;
  /** Required only when a privilege-expanding override is present (TD §7.2 rule 7). */
  readonly lookupApproval?: ApprovalLookup;
}

export interface CompileResult {
  readonly envelope: SchemaEnvelope<CanonicalObject>;
  readonly compiled_hash: string;
  readonly body: CompiledProfileV1Body;
}

export function compileProfile(input: CompileInput): CompileResult {
  const project = validateProjectProfile(input.projectProfile);
  const policy = validateExecutionPolicy(input.executionPolicy);
  const overrides = validateApprovedOverrides(input.approvedOverrides);

  const projectHash = hashEnvelope(
    makeEnvelope(PROJECT_PROFILE_SCHEMA, 1, project as unknown as CanonicalObject),
  );
  const policyHash = hashEnvelope(
    makeEnvelope(EXECUTION_POLICY_SCHEMA, 1, policy as unknown as CanonicalObject),
  );
  const overridesHash = hashEnvelope(
    makeEnvelope(APPROVED_OVERRIDES_SCHEMA, 1, overrides as unknown as CanonicalObject),
  );

  const resolved = resolveClassificationPolicy(project, policy);
  const effectivePolicy = applyOverrides(resolved, overrides.items, input.lookupApproval);

  validateEffective(project, effectivePolicy);

  const body: CompiledProfileV1Body = {
    project_profile: { id: project.id, version: project.version, hash: projectHash },
    execution_policy: { id: policy.id, version: policy.version, hash: policyHash },
    approved_overrides: { hash: overridesHash },
    compiled_version: COMPILED_VERSION,
    merge_rules_version: MERGE_RULES_VERSION,
    effective: { project, policy: effectivePolicy },
  };

  // compiled_hash is the hash of this envelope; it is deliberately not a member of the body.
  const envelope = makeEnvelope(
    COMPILED_PROFILE_SCHEMA,
    1,
    body as unknown as CanonicalObject,
  );
  return { envelope, compiled_hash: hashEnvelope(envelope), body };
}

/**
 * TD §7.2 rule 2 — the Execution Policy's explicit value always wins; otherwise the Project
 * Profile's default is adopted. No more-restrictive comparison takes place here.
 */
function resolveClassificationPolicy(
  project: ProjectProfileV1Body,
  policy: ExecutionPolicyV1Body,
): ExecutionPolicyV1Body {
  for (const name of Object.keys(policy.classification_policy)) {
    if (!Object.hasOwn(project.classifications, name)) {
      throw new ProfileCompileError(
        "EFFECTIVE_INVALID",
        `/classification_policy/${name}`,
        "classification is not declared by the Project Profile",
      );
    }
  }

  const resolved: Record<string, ExecutionPolicyV1Body["classification_policy"][string]> = {};
  for (const [name, entry] of Object.entries(project.classifications)) {
    const explicit = policy.classification_policy[name];
    resolved[name] = explicit ?? entry.default_execution_policy;
  }
  return { ...policy, classification_policy: resolved };
}

function applyOverrides(
  policy: ExecutionPolicyV1Body,
  items: readonly ApprovedOverride[],
  lookupApproval: ApprovalLookup | undefined,
): ExecutionPolicyV1Body {
  let current = policy;
  for (const item of items) {
    const path = item.field_path as OverridePath;
    const where = `override:${path}`;
    const typedValue = typeOverrideValue(path, item.value);
    const direction = privilegeDirection(path, readPolicyValue(current, path), typedValue);

    if (direction === "SAME") {
      throw new ProfileCompileError(
        "OVERRIDE_NO_OP",
        where,
        "override value equals the current effective value",
      );
    }
    if (direction === "INCOMPARABLE") {
      throw new ProfileCompileError(
        "OVERRIDE_INCOMPARABLE",
        where,
        "a single override may not both add and remove required decisions",
      );
    }

    if (direction === "RESTRICTIVE") {
      if (item.approval_ref !== undefined || item.approval_hash !== undefined) {
        throw new ProfileCompileError(
          "OVERRIDE_APPROVAL_SHAPE",
          where,
          "a privilege-reducing override must not carry approval metadata",
        );
      }
    } else {
      assertApproved(item, path, typedValue, lookupApproval);
    }

    current = applyOverride(current, path, typedValue);
  }
  return current;
}

/** TD §7.2 rule 6 — a privilege-expanding override needs an authoritative approval binding. */
function assertApproved(
  item: ApprovedOverride,
  path: OverridePath,
  typedValue: unknown,
  lookupApproval: ApprovalLookup | undefined,
): void {
  const where = `override:${path}`;
  if (item.approval_ref === undefined || item.approval_hash === undefined) {
    throw new ProfileCompileError(
      "OVERRIDE_APPROVAL_SHAPE",
      where,
      "a privilege-expanding override requires approval_ref and approval_hash",
    );
  }
  if (lookupApproval === undefined) {
    throw new ProfileCompileError(
      "APPROVAL_BINDING_INVALID",
      where,
      "no approval lookup was supplied for a privilege-expanding override",
    );
  }

  const record = lookupApproval(item.approval_ref);
  if (record === undefined) {
    throw new ProfileCompileError(
      "APPROVAL_BINDING_INVALID",
      where,
      `approval record ${JSON.stringify(item.approval_ref)} does not exist`,
    );
  }
  if (record.status !== "RESOLVED") {
    throw new ProfileCompileError(
      "APPROVAL_BINDING_INVALID",
      where,
      `approval record status is ${record.status}, expected RESOLVED`,
    );
  }
  if (record.field_path !== item.field_path) {
    throw new ProfileCompileError(
      "APPROVAL_BINDING_INVALID",
      where,
      `approval scope ${JSON.stringify(record.field_path)} does not match the override field_path`,
    );
  }
  // "Exact match" is field-domain equality (§7.2 rule 6, M0-13): both sides are validated against
  // the field's domain and normalized the same way, so a reordered semantic set is not a mismatch.
  let approvedValue: unknown;
  try {
    approvedValue = typeOverrideValue(path, record.approved_value);
  } catch {
    throw new ProfileCompileError(
      "APPROVAL_BINDING_INVALID",
      where,
      "approved value is not valid for this field",
    );
  }
  if (!canonicalEquals(approvedValue, typedValue)) {
    throw new ProfileCompileError(
      "APPROVAL_BINDING_INVALID",
      where,
      "approved value does not exactly match the override value",
    );
  }
  // The record hash is never normalized — it is the authoritative envelope hash, compared raw.
  if (record.record_hash !== item.approval_hash) {
    throw new ProfileCompileError(
      "APPROVAL_BINDING_INVALID",
      where,
      "approval_hash does not match the referenced record hash",
    );
  }
}

/** TD §7.3 S1–S12 (S1/S12 are enforced above, at the point where the inputs are known). */
function validateEffective(
  project: ProjectProfileV1Body,
  policy: ExecutionPolicyV1Body,
): void {
  // S2 — the resolved map covers exactly the Project Profile classification key set.
  const projectNames = Object.keys(project.classifications).sort();
  const resolvedNames = Object.keys(policy.classification_policy).sort();
  if (projectNames.length !== resolvedNames.length ||
      projectNames.some((name, index) => name !== resolvedNames[index])) {
    throw new ProfileCompileError(
      "EFFECTIVE_INVALID",
      "/classification_policy",
      "resolved classification policy must cover exactly the Project Profile classifications",
    );
  }

  // S4a (M1-10) — an auditing pipeline must name a *declared* role for its Auditor. The schema
  // already guarantees presence and shape; what only the composed profile can check is that the
  // reference resolves. No default role is ever substituted.
  for (const [pipeline_id, pipeline] of Object.entries(project.pipelines)) {
    if (!pipeline.steps.includes("AUDITOR")) continue;
    const auditor_profile = pipeline.auditor_profile;
    if (auditor_profile === undefined || project.roles[auditor_profile] === undefined) {
      throw new ProfileCompileError(
        "EFFECTIVE_INVALID",
        `/pipelines/${pipeline_id}/auditor_profile`,
        `auditor_profile must reference a declared role, not ${JSON.stringify(auditor_profile)}`,
      );
    }
  }

  if (!policy.auto_merge) return;

  // S9 — auto_merge requires a declared enforcement requirement for the merge operation.
  const mergeRequirements = policy.capability_requirements[MERGE_OPERATION_ID];
  if (mergeRequirements === undefined || Object.keys(mergeRequirements).length === 0) {
    throw new ProfileCompileError(
      "EFFECTIVE_INVALID",
      `/capability_requirements/${MERGE_OPERATION_ID}`,
      "auto_merge=true requires declared capability requirements for the merge operation",
    );
  }

  // S10 — auto_merge may not run with canonical_head drift set to CONTINUE_SNAPSHOT (§11.2).
  if (policy.contract_drift_policy.canonical_head.action === "CONTINUE_SNAPSHOT") {
    throw new ProfileCompileError(
      "EFFECTIVE_INVALID",
      "/contract_drift_policy/canonical_head",
      "auto_merge=true forbids CONTINUE_SNAPSHOT for canonical_head drift",
    );
  }

  // S11 — no required check may be satisfiable by self-reported evidence alone (§15.3).
  for (const [checkId, requirement] of Object.entries(
    policy.verification_policy.required_verification,
  )) {
    const weakOnly = requirement.accepted_assurance.every(
      (level) => level === "WORKER_REPORTED" || level === "INFERRED",
    );
    if (weakOnly) {
      throw new ProfileCompileError(
        "EFFECTIVE_INVALID",
        `/verification_policy/required_verification/${checkId}`,
        "auto_merge=true forbids a required check accepted only as WORKER_REPORTED/INFERRED",
      );
    }
  }
}
