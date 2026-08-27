/**
 * Platform Core — deterministic contract foundation (TD §6, §6.1).
 *
 * Contract Source raw-byte hashing is intentionally *not* re-exported here; it is a
 * separate path (`core/contract/source-hash.ts`) so structured-object hashing and
 * raw-file hashing cannot be reached through one another (TD §6 items 4–5).
 */

export {
  canonicalBytes,
  canonicalize,
  compareCodePoints,
  type CanonicalObject,
  type CanonicalValue,
} from "./canonical-json.ts";
export { DIGEST_ALGORITHM, isDigest } from "./digest.ts";
export {
  canonicalEnvelopeBytes,
  canonicalizeEnvelope,
  hashEnvelope,
  makeEnvelope,
  type SchemaEnvelope,
} from "./envelope.ts";
export {
  CanonicalizationError,
  ContractPrimitiveError,
  IdentifierError,
  type CanonicalizationErrorCode,
} from "./errors.ts";
export { attemptKey, batchId, opKey, runId, taskKey } from "./identifiers.ts";
