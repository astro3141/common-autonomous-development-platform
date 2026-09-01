/**
 * Task Contract v1 validation and hashing (TD §10.1, M0-21).
 *
 * `hash` is the envelope hash, returned alongside the envelope and never stored in the body.
 */

import { hashEnvelope, makeEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import { isUlid } from "../schemas/identifiers.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { normalizeTaskDefinitionBody } from "../tasksource/task-definition.ts";
import { contractError } from "./errors.ts";
import {
  SUBFLOW_BINDING_FIELDS,
  SUBFLOW_PARENT_SUSPEND_STATES,
  TASK_CONTRACT_BODY_FIELDS,
  TASK_CONTRACT_SCHEMA,
  type SubflowBindingV1,
  type TaskContractV1Body,
} from "./types.ts";

export interface TaskContractResult {
  readonly envelope: SchemaEnvelope<CanonicalObject>;
  readonly hash: string;
  readonly body: TaskContractV1Body;
}

/**
 * Validates the exact body and returns the envelope with its hash. §10.1a: a body carrying
 * `subflow_binding` is the exact 13-field subflow child Contract and seals as schema v2; a body
 * without it is the exact 12-field v1. There is no nullable-parent v1 and no placeholder v2.
 */
export function sealTaskContract(input: unknown): TaskContractResult {
  const body = validateTaskContractBody(input);
  const version = body.subflow_binding === undefined ? 1 : 2;
  const envelope = makeEnvelope(TASK_CONTRACT_SCHEMA, version, body as unknown as CanonicalObject);
  return { envelope, hash: hashEnvelope(envelope), body };
}

export function validateTaskContractBody(input: unknown): TaskContractV1Body {
  const body = asObject(input, "");
  const subflow = Object.hasOwn(body, "subflow_binding");
  exactKeys(
    body,
    "",
    subflow ? [...TASK_CONTRACT_BODY_FIELDS, "subflow_binding"] : TASK_CONTRACT_BODY_FIELDS,
  );
  if (Object.hasOwn(body, "hash") || Object.hasOwn(body, "task_contract_hash")) {
    throw contractError("", "the contract hash must not be a body field");
  }

  const snapshot_id = nonEmpty(body["snapshot_id"], "/snapshot_id");
  if (!isUlid(snapshot_id)) throw contractError("/snapshot_id", "expected a ULID");

  const task = asObject(body["task"], "/task");
  exactKeys(task, "/task", ["ref", "version", "definition_hash", "body_copy"]);

  const contractSources = asArray(body["contract_sources"], "/contract_sources");
  const seenPaths = new Set<string>();
  const sources = contractSources.map((entry, index) => {
    const path = `/contract_sources/${index}`;
    const item = asObject(entry, path);
    exactKeys(item, path, ["path", "content_hash"]);
    const sourcePath = nonEmpty(item["path"], `${path}/path`);
    if (seenPaths.has(sourcePath)) throw contractError(path, "duplicate contract source path");
    seenPaths.add(sourcePath);
    return { path: sourcePath, content_hash: nonEmpty(item["content_hash"], `${path}/content_hash`) };
  });

  const scope = asObject(body["repository_scope"], "/repository_scope");
  exactKeys(scope, "/repository_scope", ["allowed_paths", "forbidden_paths"]);

  const requirements = asObject(body["backend_requirements"], "/backend_requirements");
  exactKeys(requirements, "/backend_requirements", [
    "runtime_manifest_hash",
    "workflow_manifest_hash",
    "repository_manifest_hash",
    "verification_manifest_hash",
    "provenance",
  ]);
  const provenance = asObject(requirements["provenance"], "/backend_requirements/provenance");
  exactKeys(provenance, "/backend_requirements/provenance", [
    "runtime_adapter_version",
    "backend_instance_id",
  ]);

  const grants = asObject(body["capability_grants"], "/capability_grants");
  exactKeys(grants, "/capability_grants", ["actor", "auditor"]);

  const subflow_binding = subflow ? validateSubflowBinding(body["subflow_binding"]) : undefined;

  return {
    ...(subflow_binding === undefined ? {} : { subflow_binding }),
    snapshot_id,
    task: {
      ref: nonEmpty(task["ref"], "/task/ref"),
      version: nonEmpty(task["version"], "/task/version"),
      definition_hash: nonEmpty(task["definition_hash"], "/task/definition_hash"),
      body_copy: normalizeTaskDefinitionBody(task["body_copy"], "/task/body_copy"),
    },
    attempt: ordinal(body["attempt"], "/attempt"),
    base_head: nonEmpty(body["base_head"], "/base_head"),
    compiled_profile_hash: nonEmpty(body["compiled_profile_hash"], "/compiled_profile_hash"),
    contract_sources: sources,
    pipeline_id: nonEmpty(body["pipeline_id"], "/pipeline_id"),
    verification_profile: nonEmpty(body["verification_profile"], "/verification_profile"),
    repository_scope: {
      allowed_paths: stringList(scope["allowed_paths"], "/repository_scope/allowed_paths"),
      forbidden_paths: stringList(scope["forbidden_paths"], "/repository_scope/forbidden_paths"),
    },
    backend_requirements: {
      runtime_manifest_hash: nonEmpty(
        requirements["runtime_manifest_hash"],
        "/backend_requirements/runtime_manifest_hash",
      ),
      workflow_manifest_hash: nonEmpty(
        requirements["workflow_manifest_hash"],
        "/backend_requirements/workflow_manifest_hash",
      ),
      repository_manifest_hash: nonEmpty(
        requirements["repository_manifest_hash"],
        "/backend_requirements/repository_manifest_hash",
      ),
      verification_manifest_hash: nonEmpty(
        requirements["verification_manifest_hash"],
        "/backend_requirements/verification_manifest_hash",
      ),
      provenance: {
        runtime_adapter_version: nonEmpty(
          provenance["runtime_adapter_version"],
          "/backend_requirements/provenance/runtime_adapter_version",
        ),
        backend_instance_id: nonEmpty(
          provenance["backend_instance_id"],
          "/backend_requirements/provenance/backend_instance_id",
        ),
      },
    },
    capability_grants: {
      actor: grantRef(grants["actor"], "/capability_grants/actor"),
      auditor: grantRef(grants["auditor"], "/capability_grants/auditor"),
    },
    completion_conditions: stringList(body["completion_conditions"], "/completion_conditions"),
  };
}

// --- local predicates ---------------------------------------------------------------

function grantRef(value: unknown, path: string): { grant_id: string; grant_hash: string } {
  const ref = asObject(value, path);
  exactKeys(ref, path, ["grant_id", "grant_hash"]);
  const grant_id = nonEmpty(ref["grant_id"], `${path}/grant_id`);
  if (!isUlid(grant_id)) throw contractError(`${path}/grant_id`, "expected a ULID");
  return { grant_id, grant_hash: nonEmpty(ref["grant_hash"], `${path}/grant_hash`) };
}

/** §10.1a — the exact five-field relation freeze, validated before sealing. */
function validateSubflowBinding(value: unknown): SubflowBindingV1 {
  const binding = asObject(value, "/subflow_binding");
  exactKeys(binding, "/subflow_binding", SUBFLOW_BINDING_FIELDS);
  const state = nonEmpty(binding["parent_attempt_state_at_suspend"], "/subflow_binding/parent_attempt_state_at_suspend");
  if (!SUBFLOW_PARENT_SUSPEND_STATES.includes(state)) {
    throw contractError("/subflow_binding/parent_attempt_state_at_suspend", `not a suspendable state: ${state}`);
  }
  const ref = nonEmpty(binding["suspension_transition_ref"], "/subflow_binding/suspension_transition_ref");
  if (!/^transition:[1-9]\d*$/.test(ref)) {
    throw contractError("/subflow_binding/suspension_transition_ref", "expected transition:<journal seq>");
  }
  return {
    parent_task_key: nonEmpty(binding["parent_task_key"], "/subflow_binding/parent_task_key"),
    parent_attempt_key: nonEmpty(binding["parent_attempt_key"], "/subflow_binding/parent_attempt_key"),
    parent_task_contract_hash: nonEmpty(
      binding["parent_task_contract_hash"],
      "/subflow_binding/parent_task_contract_hash",
    ),
    parent_attempt_state_at_suspend: state,
    suspension_transition_ref: ref,
  };
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw contractError(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw contractError(path, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(path, "expected an array");
  return value;
}

function exactKeys(
  object: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  for (const key of expected) {
    if (!Object.hasOwn(object, key)) throw contractError(path, `missing required field "${key}"`);
  }
  for (const key of Object.keys(object)) {
    if (!expected.includes(key)) throw contractError(path, `unknown field "${key}"`);
  }
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string") throw contractError(path, "expected a string");
  if (value.length === 0) throw contractError(path, "must not be empty");
  return value;
}

function ordinal(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw contractError(path, "expected a non-negative integer");
  }
  return value;
}

function stringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw contractError(path, "expected an array");
  return value.map((item, index) => nonEmpty(item, `${path}/${index}`));
}
