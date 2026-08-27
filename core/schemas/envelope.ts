/**
 * Versioned schema envelope and structured-object hashing.
 *
 * TD §6 item 4: every Platform hash is an **envelope-inclusive** hash.
 *
 *   { "schema": "...", "schema_version": 1, "body": { ... } }
 *
 * The canonical bytes of the whole envelope are hashed, so a schema_version change
 * is by construction a different hash.
 */

import { canonicalBytes, canonicalize, type CanonicalObject } from "./canonical-json.ts";
import { sha256Digest } from "./digest.ts";
import { CanonicalizationError } from "./errors.ts";

export interface SchemaEnvelope<Body extends CanonicalObject = CanonicalObject> {
  readonly schema: string;
  readonly schema_version: number;
  readonly body: Body;
}

/** Builds a validated envelope. Body content itself is validated at serialization time. */
export function makeEnvelope<Body extends CanonicalObject>(
  schema: string,
  schemaVersion: number,
  body: Body,
): SchemaEnvelope<Body> {
  const envelope = { schema, schema_version: schemaVersion, body } as SchemaEnvelope<Body>;
  assertEnvelopeShape(envelope);
  return envelope;
}

/** Canonical JSON text of the envelope (TD §6 item 2). */
export function canonicalizeEnvelope(envelope: SchemaEnvelope): string {
  assertEnvelopeShape(envelope);
  return canonicalize(toCanonicalObject(envelope));
}

/** Canonical UTF-8 bytes of the envelope — the exact input to {@link hashEnvelope}. */
export function canonicalEnvelopeBytes(envelope: SchemaEnvelope): Uint8Array {
  assertEnvelopeShape(envelope);
  return canonicalBytes(toCanonicalObject(envelope));
}

/** `sha256:<lowercase-hex>` of the envelope's canonical bytes (TD §6 items 3–4). */
export function hashEnvelope(envelope: SchemaEnvelope): string {
  return sha256Digest(canonicalEnvelopeBytes(envelope));
}

function toCanonicalObject(envelope: SchemaEnvelope): CanonicalObject {
  return {
    schema: envelope.schema,
    schema_version: envelope.schema_version,
    body: envelope.body,
  };
}

function assertEnvelopeShape(envelope: SchemaEnvelope): void {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new CanonicalizationError("INVALID_ENVELOPE", "", "envelope must be an object");
  }
  if (typeof envelope.schema !== "string" || envelope.schema.length === 0) {
    throw new CanonicalizationError("INVALID_ENVELOPE", "/schema", "schema must be a non-empty string");
  }
  if (!Number.isSafeInteger(envelope.schema_version) || envelope.schema_version < 1) {
    throw new CanonicalizationError(
      "INVALID_ENVELOPE",
      "/schema_version",
      "schema_version must be an integer >= 1",
    );
  }
  const body: unknown = envelope.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CanonicalizationError("INVALID_ENVELOPE", "/body", "body must be an object");
  }
  const extra = Object.keys(envelope).filter(
    (key) => key !== "schema" && key !== "schema_version" && key !== "body",
  );
  if (extra.length > 0) {
    throw new CanonicalizationError(
      "INVALID_ENVELOPE",
      "",
      `unexpected envelope member(s): ${extra.sort().join(", ")}`,
    );
  }
}
