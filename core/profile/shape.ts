/**
 * Small shared checks for the v1 validators (TD §7.1a–§7.1c).
 *
 * Plain predicates — no validation DSL, no reflection, no schema framework. Each validator below
 * spells its own structure out; these only remove the repeated "wrong type / unknown key" wording.
 */

import { canonicalize, type CanonicalObject, type CanonicalValue } from "../schemas/canonical-json.ts";
import { CanonicalizationError } from "../schemas/errors.ts";
import { ProfileCompileError, schemaError } from "./errors.ts";

/** A plain object in the restricted JSON model — anything else is a schema failure. */
export function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw schemaError(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw schemaError(path, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw schemaError(path, "expected an array");
  return value;
}

export function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string") throw schemaError(path, "expected a string");
  if (value.length === 0) throw schemaError(path, "must not be empty");
  return value;
}

export function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw schemaError(path, "expected a boolean");
  return value;
}

/** Integers only — a string that looks like a number is rejected, never coerced. */
export function asInteger(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw schemaError(path, "expected an integer");
  }
  if (value < minimum) throw schemaError(path, `must be >= ${minimum}`);
  return value;
}

export function asMember<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw schemaError(path, `expected one of ${allowed.join(" | ")}`);
  }
  return value as T;
}

/** Exactly these keys — missing or unknown members are both schema failures. */
export function exactKeys(
  object: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  for (const key of expected) {
    if (!Object.hasOwn(object, key)) throw schemaError(path, `missing required field "${key}"`);
  }
  for (const key of Object.keys(object)) {
    if (!expected.includes(key)) throw schemaError(path, `unknown field "${key}"`);
  }
}

/**
 * An adapter-owned opaque body. Core does not interpret it, but it must still be expressible in
 * the TD §6 restricted JSON model (floats and friends are rejected there, not here).
 */
export function asOpaqueConfig(value: unknown, path: string): CanonicalObject {
  const object = asObject(value, path);
  try {
    canonicalize(object);
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      throw schemaError(path, `config is not expressible in the restricted JSON model: ${error.message}`);
    }
    throw error;
  }
  return object as CanonicalObject;
}

/** A value anywhere in the restricted model (used for override values and approved values). */
export function asCanonicalValue(value: unknown, path: string): CanonicalValue {
  try {
    canonicalize(value);
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      throw schemaError(path, `not expressible in the restricted JSON model: ${error.message}`);
    }
    throw error;
  }
  return value as CanonicalValue;
}

/** Object keys used as identifiers must be non-empty. */
export function assertNonEmptyKeys(object: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(object)) {
    if (key.length === 0) throw schemaError(path, "identifier keys must not be empty");
  }
}

/** A list whose entries must be unique, reported as a DUPLICATE failure. */
export function assertUnique(values: readonly string[], path: string, what: string): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      throw new ProfileCompileError(
        "DUPLICATE",
        `${path}/${index}`,
        `duplicate ${what}: ${JSON.stringify(value)}`,
      );
    }
    seen.add(value);
  }
}
