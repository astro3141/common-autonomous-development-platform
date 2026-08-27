/**
 * TaskDefinition normalization and hash identity (TD §8.1a).
 *
 * One shared helper so every adapter — including Platform-owned ones — produces the same hash.
 * The adapter's own `definition_hash` is never trusted blindly: it is recomputed and compared.
 */

import { hashEnvelope, makeEnvelope } from "../schemas/envelope.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { TaskSourceError } from "./errors.ts";
import {
  TASK_DEFINITION_BODY_FIELDS,
  TASK_DEFINITION_SCHEMA,
  type RawTaskDefinition,
  type TaskDefinition,
  type TaskDefinitionBodyV1,
} from "./types.ts";

/** `platform/task-definition` v1 envelope hash over the normalized body only. */
export function hashTaskDefinitionBody(body: TaskDefinitionBodyV1): string {
  return hashEnvelope(makeEnvelope(TASK_DEFINITION_SCHEMA, 1, body as unknown as CanonicalObject));
}

/** Validates the exact four-field body (§8.1a). Arrays keep their order and duplicates. */
export function normalizeTaskDefinitionBody(input: unknown, location = ""): TaskDefinitionBodyV1 {
  const body = asObject(input, `${location}/body`);

  for (const field of TASK_DEFINITION_BODY_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      throw invalid(`${location}/body`, `missing required field "${field}"`);
    }
  }
  for (const key of Object.keys(body)) {
    if (!TASK_DEFINITION_BODY_FIELDS.includes(key)) {
      throw invalid(`${location}/body`, `unknown field "${key}"`);
    }
  }

  const description = body["description"];
  if (typeof description !== "string") {
    throw invalid(`${location}/body/description`, "expected a string");
  }

  return {
    title: nonEmptyString(body["title"], `${location}/body/title`),
    description,
    references: stringList(body["references"], `${location}/body/references`),
    acceptance_notes: stringList(body["acceptance_notes"], `${location}/body/acceptance_notes`),
  };
}

/**
 * Normalization boundary (§8.1a): validate the body, recompute the hash, and require an
 * adapter-supplied hash to match exactly. The result always carries a verified `definition_hash`.
 */
export function normalizeTaskDefinition(
  raw: RawTaskDefinition,
  location = "",
): TaskDefinition {
  const task_ref = nonEmptyString(raw.task_ref, `${location}/task_ref`);
  const version = nonEmptyString(raw.version, `${location}/version`);
  const body = normalizeTaskDefinitionBody(raw.body, location);
  const computed = hashTaskDefinitionBody(body);

  if (raw.definition_hash !== undefined && raw.definition_hash !== computed) {
    throw new TaskSourceError(
      "DEFINITION_HASH_MISMATCH",
      `${location}/definition_hash`,
      "adapter-supplied definition_hash does not match the recomputed Platform hash",
    );
  }

  return { task_ref, version, definition_hash: computed, body };
}

// --- local predicates ---------------------------------------------------------------

function invalid(location: string, detail: string): TaskSourceError {
  return new TaskSourceError("DEFINITION_INVALID", location, detail);
}

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(location, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(location, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string") throw invalid(location, "expected a string");
  if (value.length === 0) throw invalid(location, "must not be empty");
  return value;
}

function stringList(value: unknown, location: string): readonly string[] {
  if (!Array.isArray(value)) throw invalid(location, "expected an array");
  return value.map((item, index) => nonEmptyString(item, `${location}/${index}`));
}
