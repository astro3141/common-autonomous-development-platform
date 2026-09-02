/**
 * Database open / configuration (TD D2, §18).
 *
 * Decision context (already fixed by TD): SQLite single file + WAL + single writer.
 * This module owns the one writable connection; nothing else in `core/store` opens a
 * connection, which is how the single-writer invariant is held inside the process.
 */

import { DatabaseSync } from "node:sqlite";

import { StoreError } from "./errors.ts";

export type { DatabaseSync };

export interface OpenDatabaseOptions {
  /**
   * #55 / §22.1 — an *observation* connection: SQLite-enforced read-only over the same WAL file.
   * A WAL reader neither blocks nor is blocked by the single writer, and any write attempt fails
   * at the database itself, so the single-writer invariant stays held by construction rather
   * than by reviewer discipline. The journal mode must already be WAL (the writer set it);
   * a read-only connection cannot and must not change it.
   */
  readonly read_only?: boolean;
}

/**
 * Opens the single writable connection and puts it in WAL mode, then verifies the mode by
 * querying the database rather than trusting the PRAGMA call.
 */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  if (options.read_only === true) {
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
      const mode = readJournalMode(database);
      if (mode !== "wal") {
        throw new StoreError(
          "JOURNAL_MODE_UNAVAILABLE",
          `journal_mode is "${mode}", expected "wal" (TD D2 requires WAL)`,
        );
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  const database = new DatabaseSync(filePath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    // Domain schema (TD §18.1a) relies on real FK enforcement; SQLite leaves it off by default.
    // Set outside any transaction, before migrations run.
    database.exec("PRAGMA foreign_keys = ON");
    if (!readForeignKeysEnabled(database)) {
      throw new StoreError(
        "JOURNAL_MODE_UNAVAILABLE",
        "foreign key enforcement could not be enabled (TD §18.1a requires it)",
      );
    }
    const mode = readJournalMode(database);
    if (mode !== "wal") {
      throw new StoreError(
        "JOURNAL_MODE_UNAVAILABLE",
        `journal_mode is "${mode}", expected "wal" (TD D2 requires WAL)`,
      );
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Whether the connection itself reports foreign key enforcement as on. */
export function readForeignKeysEnabled(database: DatabaseSync): boolean {
  const row = database.prepare("PRAGMA foreign_keys").get() as
    | { foreign_keys?: number }
    | undefined;
  return row?.foreign_keys === 1;
}

/** The journal mode the database itself reports, lowercased (e.g. `wal`). */
export function readJournalMode(database: DatabaseSync): string {
  const row = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  return String(row?.journal_mode ?? "").toLowerCase();
}
