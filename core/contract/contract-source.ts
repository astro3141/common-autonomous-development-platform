/**
 * Contract Source capture (TD §10.2, M0-22).
 *
 * Bytes come from the caller — this module never reads a filesystem. Each source is stored in the
 * existing content-addressed BlobStore, whose returned `content_hash` is both the integrity
 * identity and the lookup address. Raw bytes are never normalized, so a newline, BOM or encoding
 * difference stays visible as a different hash.
 *
 * The helper runs inside whatever transaction the caller owns; it never begins or commits one.
 */

import type { BlobStore } from "../store/blob-store.ts";
import { ContractError } from "./errors.ts";
import type { ContractSourceInput, ContractSourceRef } from "./types.ts";

/**
 * Captures the sources the Compiled Profile declared, in the **declared order**. The supplied
 * inputs must correspond exactly: a missing, extra or duplicated source fails closed, and the
 * caller's iteration order never becomes contract authority.
 */
export function captureContractSources(
  declaredPaths: readonly string[],
  inputs: readonly ContractSourceInput[],
  blobs: BlobStore,
): readonly ContractSourceRef[] {
  const supplied = new Map<string, Uint8Array>();
  for (const input of inputs) {
    if (typeof input.path !== "string" || input.path.length === 0) {
      throw mismatch("/contract_sources", "source path must be a non-empty string");
    }
    if (!(input.bytes instanceof Uint8Array)) {
      throw mismatch(`/contract_sources/${input.path}`, "source bytes must be raw bytes");
    }
    if (supplied.has(input.path)) {
      throw mismatch(`/contract_sources/${input.path}`, "duplicate contract source input");
    }
    supplied.set(input.path, input.bytes);
  }

  for (const path of supplied.keys()) {
    if (!declaredPaths.includes(path)) {
      throw mismatch(`/contract_sources/${path}`, "source is not declared by the Project Profile");
    }
  }

  return declaredPaths.map((path) => {
    const bytes = supplied.get(path);
    if (bytes === undefined) {
      throw mismatch(`/contract_sources/${path}`, "declared contract source was not supplied");
    }
    // BlobStore computes the raw SHA-256 itself, so the caller cannot assert an address.
    return { path, content_hash: blobs.put(bytes) };
  });
}

function mismatch(path: string, detail: string): ContractError {
  return new ContractError("CONTRACT_SOURCE_MISMATCH", path, detail);
}
