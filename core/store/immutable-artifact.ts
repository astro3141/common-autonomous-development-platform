/**
 * Shared conflict rules for the immutable artifact tables (TD §18.1a).
 *
 * Three small functions, not a framework: `compiled_profile_snapshot`, `task_contract_snapshot`,
 * `capability_grant` and `operator_action` all obey the same rule set —
 *
 *   same identity + same canonical content  → idempotent success
 *   same identity + different content       → fail-closed conflict
 *   stored bytes that no longer hash to the recorded hash → corruption
 *
 * The envelope is always stored whole: a body-only row could not be re-hashed on load.
 */

import { canonicalizeEnvelope, hashEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { StoreError } from "./errors.ts";

/** Canonical text of an envelope — the exact bytes an artifact row stores. */
export function envelopeText(envelope: SchemaEnvelope<CanonicalObject>): string {
  return canonicalizeEnvelope(envelope);
}

/**
 * Re-inserting the identical canonical envelope under the same identity is a no-op; different
 * content under the same identity is refused rather than overwritten.
 */
export function assertSameContent(
  what: string,
  identity: string,
  storedJson: string,
  incomingJson: string,
): void {
  if (storedJson !== incomingJson) {
    throw new StoreError(
      "ARTIFACT_CONFLICT",
      `${what} ${identity} is already stored with different content; refusing to overwrite`,
    );
  }
}

/** Parses a stored envelope and verifies it still hashes to the hash recorded beside it. */
export function loadVerifiedEnvelope(
  what: string,
  identity: string,
  envelopeJson: string,
  expectedHash: string,
): SchemaEnvelope<CanonicalObject> {
  let envelope: SchemaEnvelope<CanonicalObject>;
  try {
    envelope = JSON.parse(envelopeJson) as SchemaEnvelope<CanonicalObject>;
  } catch {
    throw new StoreError("ARTIFACT_CORRUPT", `${what} ${identity} does not hold parseable JSON`);
  }

  let actual: string;
  try {
    actual = hashEnvelope(envelope);
  } catch (error) {
    throw new StoreError(
      "ARTIFACT_CORRUPT",
      `${what} ${identity} is not a valid envelope: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (actual !== expectedHash) {
    throw new StoreError(
      "ARTIFACT_CORRUPT",
      `${what} ${identity} hashes to ${actual}, but ${expectedHash} was recorded`,
    );
  }
  return envelope;
}
