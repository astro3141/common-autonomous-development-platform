/**
 * BackendCapabilityManifestV1 validation and hashing (TD §12.2a).
 *
 * The envelope is checked, the body is validated exactly, and the hash is computed with the
 * Batch 1 primitive from the validated body — so a manifest's hash always binds what was checked.
 */

import { canonicalize, type CanonicalObject } from "../schemas/canonical-json.ts";
import { CanonicalizationError } from "../schemas/errors.ts";
import { hashEnvelope, makeEnvelope } from "../schemas/envelope.ts";
import { manifestError } from "./errors.ts";
import {
  BACKEND_KINDS,
  BACKEND_MANIFEST_SCHEMA,
  CAPABILITY_NAMES,
  ENFORCEMENT_ASSURANCES,
  MANIFEST_COMMON_FIELDS,
  RUNTIME_ONLY_FIELDS,
  type BackendManifestBody,
  type CapabilityName,
  type DirectionalEnforcement,
  type EnforcementAssurance,
  type RuntimeManifestBody,
  type ValidatedManifest,
} from "./types.ts";

/** Hash of a validated manifest body, as its own `platform/backend-capability-manifest` v1 envelope. */
export function hashManifest(body: BackendManifestBody): string {
  return hashEnvelope(makeEnvelope(BACKEND_MANIFEST_SCHEMA, 1, body as unknown as CanonicalObject));
}

/** Validates a full manifest envelope and returns the validated body with its hash. */
export function validateManifest(input: unknown): ValidatedManifest {
  const envelope = asObject(input, "");
  for (const key of Object.keys(envelope)) {
    if (!["schema", "schema_version", "body"].includes(key)) {
      throw manifestError("", `unknown envelope field "${key}"`);
    }
  }
  if (envelope["schema"] !== BACKEND_MANIFEST_SCHEMA) {
    throw manifestError("/schema", `expected "${BACKEND_MANIFEST_SCHEMA}"`);
  }
  if (envelope["schema_version"] !== 1) {
    throw manifestError("/schema_version", "expected 1");
  }

  const body = validateManifestBody(envelope["body"]);
  return { body, hash: hashManifest(body) };
}

/** Narrowing helper for the RUNTIME component. */
export function isRuntimeManifest(
  manifest: ValidatedManifest,
): manifest is ValidatedManifest<RuntimeManifestBody> {
  return manifest.body.backend_kind === "RUNTIME";
}

function validateManifestBody(input: unknown): BackendManifestBody {
  const body = asObject(input, "/body");
  const kind = asMember(body["backend_kind"], "/body/backend_kind", BACKEND_KINDS);
  const expected =
    kind === "RUNTIME" ? [...MANIFEST_COMMON_FIELDS, ...RUNTIME_ONLY_FIELDS] : MANIFEST_COMMON_FIELDS;

  for (const key of expected) {
    if (!Object.hasOwn(body, key)) throw manifestError("/body", `missing required field "${key}"`);
  }
  for (const key of Object.keys(body)) {
    if (!expected.includes(key)) {
      // Runtime-only fields on a non-Runtime manifest land here.
      throw manifestError("/body", `unknown field "${key}" for backend_kind ${kind}`);
    }
  }

  const common: BackendManifestBody = {
    backend_kind: kind,
    adapter_id: asNonEmptyString(body["adapter_id"], "/body/adapter_id"),
    adapter_version: asNonEmptyString(body["adapter_version"], "/body/adapter_version"),
    // I-TD7 is a producer contract: Core checks the shape only and never guesses at value syntax.
    backend_instance_id: asNonEmptyString(body["backend_instance_id"], "/body/backend_instance_id"),
    features: asOpaque(body["features"], "/body/features"),
  };

  if (kind !== "RUNTIME") return common;

  const runtime: RuntimeManifestBody = {
    ...common,
    backend_kind: "RUNTIME",
    receipt_supported: asBoolean(body["receipt_supported"], "/body/receipt_supported"),
    capability_enforcement: capabilityEnforcement(body["capability_enforcement"]),
  };
  return runtime;
}

/** The directional map must cover all twelve capabilities — omission has no semantics. */
function capabilityEnforcement(
  input: unknown,
): Readonly<Record<CapabilityName, DirectionalEnforcement>> {
  const path = "/body/capability_enforcement";
  const object = asObject(input, path);

  for (const key of Object.keys(object)) {
    if (!(CAPABILITY_NAMES as readonly string[]).includes(key)) {
      throw manifestError(path, `unknown capability "${key}"`);
    }
  }

  const result = {} as Record<CapabilityName, DirectionalEnforcement>;
  for (const capability of CAPABILITY_NAMES) {
    const entry = object[capability];
    if (entry === undefined) {
      throw manifestError(path, `missing capability "${capability}"`);
    }
    const entryPath = `${path}/${capability}`;
    const directional = asObject(entry, entryPath);
    for (const key of Object.keys(directional)) {
      if (key !== "allow" && key !== "deny") {
        throw manifestError(entryPath, `unknown field "${key}"`);
      }
    }
    result[capability] = {
      allow: asMember(directional["allow"], `${entryPath}/allow`, ENFORCEMENT_ASSURANCES),
      deny: asMember(directional["deny"], `${entryPath}/deny`, ENFORCEMENT_ASSURANCES),
    };
  }
  return result;
}

// --- local shape predicates (kept here so failures carry capability reasons, not profile ones) ---

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw manifestError(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw manifestError(path, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string") throw manifestError(path, "expected a string");
  if (value.length === 0) throw manifestError(path, "must not be empty");
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw manifestError(path, "expected a boolean");
  return value;
}

function asMember<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw manifestError(path, `expected one of ${allowed.join(" | ")}`);
  }
  return value as T;
}

/** Adapter-owned body: Core checks only that it fits the restricted JSON model (§6). */
function asOpaque(value: unknown, path: string): CanonicalObject {
  const object = asObject(value, path);
  try {
    canonicalize(object);
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      throw manifestError(path, `not expressible in the restricted JSON model: ${error.message}`);
    }
    throw error;
  }
  return object as CanonicalObject;
}

export type { EnforcementAssurance };
