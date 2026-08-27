/**
 * Transaction helper (TD §18.2: "하나의 state transition = 하나의 SQLite 트랜잭션").
 *
 * Single writer, so `BEGIN IMMEDIATE` takes the write lock up front. Nesting is not part of
 * any contract this batch implements and is rejected rather than emulated.
 */

import type { DatabaseSync } from "./database.ts";
import { StoreError } from "./errors.ts";

export class TransactionRunner {
  readonly #database: DatabaseSync;
  #active = false;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** True while a transaction opened through this runner is in progress. */
  get active(): boolean {
    return this.#active;
  }

  /**
   * Runs `body` inside one transaction: every write commits together, and any thrown error
   * rolls the whole transaction back so no partial transition survives.
   */
  run<T>(body: () => T): T {
    if (this.#active) {
      throw new StoreError(
        "NESTED_TRANSACTION",
        "a transaction is already active on the single writer",
      );
    }

    this.#database.exec("BEGIN IMMEDIATE");
    this.#active = true;
    let result: T;
    try {
      result = body();
    } catch (error) {
      this.#rollback();
      throw error;
    }

    try {
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    this.#active = false;
    return result;
  }

  #rollback(): void {
    try {
      this.#database.exec("ROLLBACK");
    } catch {
      // SQLite already ended the transaction; there is nothing left to undo.
    } finally {
      this.#active = false;
    }
  }
}
