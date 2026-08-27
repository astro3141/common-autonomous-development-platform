/**
 * SHA-256 digest notation (TD §6 item 3): `sha256:<lowercase-hex>`.
 *
 * Internal primitive. Callers use the two distinct public hashing paths:
 *  - structured envelope hash → `core/schemas/envelope.ts`
 *  - Contract Source raw-byte hash → `core/contract/source-hash.ts`
 */

import { createHash } from "node:crypto";

export const DIGEST_ALGORITHM = "sha256";

/** `sha256:<lowercase-hex>` over the given bytes, with no normalization of any kind. */
export function sha256Digest(bytes: Uint8Array): string {
  const hex = createHash(DIGEST_ALGORITHM).update(bytes).digest("hex");
  return `${DIGEST_ALGORITHM}:${hex}`;
}

/** True for a well-formed digest in TD §6 notation. */
export function isDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
