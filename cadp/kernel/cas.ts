/**
 * Content-addressed storage (TD §2.3): `cas://sha256/<hex>` keys over the `cas_blob` table.
 * Insert-only; `sha256(bytes) == key` verified on write AND on every read — a mismatch on
 * read is a corruption incident (§2.6), surfaced as CasCorruption for the caller to seal.
 */

import { sha256Hex } from "./canonical.ts";
import { ConstitutionalStore } from "./store.ts";

export class CasCorruption extends Error {
  readonly cas_key: string;
  constructor(cas_key: string) {
    super(`CAS bytes at ${cas_key} do not re-digest to their key`);
    this.cas_key = cas_key;
  }
}

export class CasMissing extends Error {
  readonly cas_key: string;
  constructor(cas_key: string) {
    super(`CAS object ${cas_key} does not exist`);
    this.cas_key = cas_key;
  }
}

export function casKeyOf(bytes: Uint8Array): string {
  return `cas://sha256/${sha256Hex(bytes)}`;
}

export class Cas {
  readonly #store: ConstitutionalStore;
  readonly #clock: () => number;

  constructor(store: ConstitutionalStore, clock: () => number = Date.now) {
    this.#store = store;
    this.#clock = clock;
  }

  /** Insert-only put. Re-putting identical bytes is a no-op returning the same key. */
  put(bytes: Uint8Array): string {
    const key = casKeyOf(bytes);
    const existing = this.#store.blob(key);
    if (existing !== undefined) return key;
    this.#store.insertBlob(key, bytes, new Date(this.#clock()).toISOString());
    return key;
  }

  /** Verify-on-read (TD §2.3). Throws CasMissing / CasCorruption. */
  get(cas_key: string): Uint8Array {
    if (!/^cas:\/\/sha256\/[0-9a-f]{64}$/u.test(cas_key)) throw new CasMissing(cas_key);
    const bytes = this.#store.blob(cas_key);
    if (bytes === undefined) throw new CasMissing(cas_key);
    if (casKeyOf(bytes) !== cas_key) throw new CasCorruption(cas_key);
    return bytes;
  }

  has(cas_key: string): boolean {
    return this.#store.blob(cas_key) !== undefined;
  }
}
