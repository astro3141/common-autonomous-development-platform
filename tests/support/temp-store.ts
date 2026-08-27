/**
 * Test support: a throwaway store file per test, with a deterministic clock.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlatformStore, type PlatformStoreOptions } from "../../core/store/platform-store.ts";

export interface TempStore {
  readonly path: string;
  readonly directory: string;
  open(options?: PlatformStoreOptions): PlatformStore;
  dispose(): void;
}

/** A counting clock so timestamps in tests are deterministic and ordered. */
export function fixedClock(prefix = "t"): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return `${prefix}${String(tick).padStart(4, "0")}`;
  };
}

/** Creates a temporary directory holding one store file; `open()` may be called repeatedly. */
export function tempStore(): TempStore {
  const directory = mkdtempSync(join(tmpdir(), "platform-store-"));
  const path = join(directory, "platform.db");
  return {
    path,
    directory,
    open(options: PlatformStoreOptions = {}) {
      return PlatformStore.open(path, { now: fixedClock(), ...options });
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
