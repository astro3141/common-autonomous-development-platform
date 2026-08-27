/**
 * FileContractSourceReader — the file-backed `ContractSourceReader` (TD §10.2, §11.4).
 *
 * Raw bytes and nothing else. No decoding, no newline handling, no normalization and no
 * modification-time shortcut: §10.2 hashes the exact bytes precisely so that an encoding or
 * newline change stays visible as drift, and any cleverness here would hide one.
 *
 * A file that is not there is `ABSENT` — a successful observation that the declared source is
 * gone. Every other failure throws, and the caller reports `UNAVAILABLE`: "the source is missing"
 * and "I could not look" are different facts about the world.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ContractSourceRead, ContractSourceReader } from "../../core/contract/types.ts";

/** Injectable so a test needs no filesystem. Returns `undefined` for a source that is gone. */
export type ContractSourceBytesReader = (path: string) => Uint8Array | undefined;

const defaultReader: ContractSourceBytesReader = (path) => {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export class FileContractSourceReader implements ContractSourceReader {
  readonly #root: string;
  readonly #read: ContractSourceBytesReader;

  /** @param root the repository checkout the declared, repository-relative paths resolve against. */
  constructor(root: string, reader: ContractSourceBytesReader = defaultReader) {
    this.#root = root;
    this.#read = reader;
  }

  read_contract_source(path: string): ContractSourceRead {
    const bytes = this.#read(isAbsolute(path) ? path : join(this.#root, path));
    return bytes === undefined ? { kind: "ABSENT" } : { kind: "PRESENT", bytes };
  }
}
