/**
 * Supervisor Proposal v1 strict validation (TD §9.1, M0-25) — the V1 step.
 *
 * Input is an already-structured value: nothing here parses natural language, and a model
 * utterance is never promoted to an authoritative fact. Validation is exact — unknown wrapper or
 * `expected` fields are rejected and no value is coerced, trimmed or case-normalized.
 *
 * Task existence, membership, repository state, capability and batch admission are all out of
 * scope for V1; they belong to V2–V11.
 */

import { isUlid } from "../schemas/identifiers.ts";
import { proposalInvalid } from "./errors.ts";
import {
  DECISION_TYPES,
  EXPECTED_FIELDS,
  PROPOSAL_FIELDS,
  PROPOSAL_VARIANT_BY_DECISION,
  SUBFLOW_PARENT_FIELDS,
  type DecisionType,
  type ProposalV1,
  type ProposalVariant,
  type SubflowParentIntentV1,
} from "./types.ts";

/**
 * Validates one Proposal and returns the typed variant.
 *
 * Throws `DecisionError("PROPOSAL_SCHEMA_INVALID")`; the validator maps that to
 * `POLICY_REJECTED(PROPOSAL_SCHEMA_INVALID)` rather than letting it escape.
 */
export function validateProposal(input: unknown): ProposalV1 {
  const raw = asObject(input, "");

  const decision = decisionOf(raw["decision"]);
  const variant = PROPOSAL_VARIANT_BY_DECISION[decision];
  exactKeys(raw, PROPOSAL_FIELDS[variant], "");

  const proposal_id = raw["proposal_id"];
  if (typeof proposal_id !== "string" || !isUlid(proposal_id)) {
    throw proposalInvalid("/proposal_id", "expected a ULID");
  }

  const expected = validateExpected(raw["expected"], variant);
  const reason_refs = validateReasonRefs(raw["reason_refs"]);

  if (variant === "BATCH_CONTROL") {
    return {
      variant,
      proposal_id,
      decision: "CLOSE_BATCH",
      expected: { compiled_profile_hash: expected["compiled_profile_hash"] as string },
      reason_refs,
    };
  }

  // `task_ref` is opaque: ':' and any other character are preserved verbatim (§6.1 D+).
  const task_ref = nonEmptyString(raw["task_ref"], "/task_ref");

  if (variant === "TASK_CONTROL") {
    return {
      variant,
      proposal_id,
      decision: decision as "HOLD_TASK" | "DEFER_TASK" | "RESUME_PARENT",
      task_ref,
      expected: {
        task_version: expected["task_version"] as string,
        task_definition_hash: expected["task_definition_hash"] as string,
        compiled_profile_hash: expected["compiled_profile_hash"] as string,
      },
      reason_refs,
    };
  }

  const repositorySensitive = {
    task_version: expected["task_version"] as string,
    task_definition_hash: expected["task_definition_hash"] as string,
    base_head: expected["base_head"] as string,
    compiled_profile_hash: expected["compiled_profile_hash"] as string,
  };

  if (variant === "REPOSITORY_SENSITIVE_TASK_CONTROL") {
    return {
      variant,
      proposal_id,
      decision: decision as "REQUEST_REWORK" | "PROPOSE_MERGE",
      task_ref,
      expected: repositorySensitive,
      reason_refs,
    };
  }

  const selection = {
    proposal_id,
    task_ref,
    classification: nonEmptyString(raw["classification"], "/classification"),
    pipeline_id: nonEmptyString(raw["pipeline_id"], "/pipeline_id"),
    actor_profile: nonEmptyString(raw["actor_profile"], "/actor_profile"),
    verification_profile: nonEmptyString(raw["verification_profile"], "/verification_profile"),
    repository_scope_id: nonEmptyString(raw["repository_scope_id"], "/repository_scope_id"),
    expected: repositorySensitive,
    reason_refs,
  };

  if (variant === "SUBFLOW_SELECTION") {
    // §9.2f — `parent` is the Supervisor's explicit relationship intent, exact four fields. A
    // parentless START_SUBFLOW simply is not an E and fails V1; there is no acceptance path that
    // picks a parent later.
    return {
      variant,
      decision: "START_SUBFLOW",
      parent: validateParentIntent(raw["parent"]),
      ...selection,
    };
  }

  return { variant: "TASK_SELECTION", decision: "START_TASK", ...selection };
}

/** §9.1 E — the exact four-field parent wrapper; unknown fields reject like every wrapper. */
function validateParentIntent(value: unknown): SubflowParentIntentV1 {
  const parent = asObject(value, "/parent");
  exactKeys(parent, SUBFLOW_PARENT_FIELDS, "/parent");
  return {
    task_key: nonEmptyString(parent["task_key"], "/parent/task_key"),
    attempt_key: nonEmptyString(parent["attempt_key"], "/parent/attempt_key"),
    task_contract_hash: nonEmptyString(parent["task_contract_hash"], "/parent/task_contract_hash"),
    attempt_state: nonEmptyString(parent["attempt_state"], "/parent/attempt_state"),
  };
}

// --- local predicates ---------------------------------------------------------------

function decisionOf(value: unknown): DecisionType {
  if (typeof value !== "string") throw proposalInvalid("/decision", "expected a string");
  if (!DECISION_TYPES.includes(value as DecisionType)) {
    throw proposalInvalid("/decision", `unknown decision ${JSON.stringify(value)}`);
  }
  return value as DecisionType;
}

/**
 * Every declared field present, nothing else. A field belonging to a different variant is
 * therefore rejected as unknown rather than quietly ignored.
 */
function exactKeys(
  object: Record<string, unknown>,
  fields: readonly string[],
  location: string,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(object, field)) {
      throw proposalInvalid(location, `missing required field "${field}"`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!fields.includes(key)) throw proposalInvalid(location, `unknown field "${key}"`);
  }
}

/**
 * The hash and head members are only ever compared for exact equality in V3/V8, so a malformed
 * value fails closed there as drift or a repository mismatch; V1 requires non-emptiness only and
 * does not impose a private grammar on them.
 */
function validateExpected(value: unknown, variant: ProposalVariant): Record<string, unknown> {
  const expected = asObject(value, "/expected");
  const fields = EXPECTED_FIELDS[variant];
  exactKeys(expected, fields, "/expected");
  for (const field of fields) nonEmptyString(expected[field], `/expected/${field}`);
  return expected;
}

/** Order preserved, duplicates preserved, empty list allowed — this is not a semantic set. */
function validateReasonRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw proposalInvalid("/reason_refs", "expected an array");
  return value.map((item, index) => nonEmptyString(item, `/reason_refs/${index}`));
}

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw proposalInvalid(location, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw proposalInvalid(location, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string") throw proposalInvalid(location, "expected a string");
  if (value.length === 0) throw proposalInvalid(location, "must not be empty");
  return value;
}
