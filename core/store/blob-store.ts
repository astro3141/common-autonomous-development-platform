/**
 * Content-addressed blob storage (TD §10.2, §18.1).
 *
 * The address is always computed here from the bytes with the Batch 1 Contract Source raw-byte
 * hash — callers cannot supply an address for content they are storing, so a wrong hash cannot
 * be trusted into the store. Bytes are stored verbatim: no normalization of any kind.
 */

import { hashContractSourceBytes } from "../contract/source-hash.ts";
import type { DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";

export class BlobStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /**
   * Stores the bytes and returns their `content_hash`. Re-inserting identical bytes is a no-op
   * (content-addressed dedup). If the stored bytes for that hash differ, the store fails closed
   * instead of overwriting.
   */
  put(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("blob content must be raw bytes");
    }
    const contentHash = hashContractSourceBytes(bytes);

    const existing = this.get(contentHash);
    if (existing !== undefined) {
      if (!equalBytes(existing, bytes)) {
        throw new StoreError(
          "BLOB_CONTENT_MISMATCH",
          `stored bytes for ${contentHash} do not match that content hash; refusing to overwrite`,
        );
      }
      return contentHash;
    }

    this.#database
      .prepare("INSERT INTO blob (content_hash, bytes) VALUES (?, ?)")
      .run(contentHash, bytes);
    return contentHash;
  }

  /** The exact bytes stored under `contentHash`, or `undefined` when absent. */
  get(contentHash: string): Uint8Array | undefined {
    const row = this.#database
      .prepare("SELECT bytes FROM blob WHERE content_hash = ?")
      .get(contentHash) as { bytes: Uint8Array } | undefined;
    return row?.bytes;
  }

  has(contentHash: string): boolean {
    return this.get(contentHash) !== undefined;
  }

  count(): number {
    const row = this.#database.prepare("SELECT count(*) AS n FROM blob").get() as { n: number };
    return row.n;
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
