/**
 * Contract Source hashing — **raw bytes only**.
 *
 * TD §6 item 5 / §10.2: a Contract Source file is hashed as raw bytes (`content_hash`)
 * and is deliberately *not* run through canonical JSON normalization — newline and
 * encoding changes must remain observable as drift.
 *
 * This is a separate API and a separate module path from the structured envelope hash
 * in `core/schemas/envelope.ts`; the two must never be routed through one another.
 */

import { sha256Digest } from "../schemas/digest.ts";

/** `sha256:<lowercase-hex>` of the file's exact bytes. No normalization is applied. */
export function hashContractSourceBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Contract Source hashing accepts raw bytes only");
  }
  return sha256Digest(bytes);
}
