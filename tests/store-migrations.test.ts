/**
 * B2-AC3 — migration determinism (TD §18: `schema_migrations`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { StoreError } from "../core/store/errors.ts";
import { MIGRATIONS, migrate, readSchemaVersion, type Migration } from "../core/store/migrations.ts";
import { openDatabase } from "../core/store/database.ts";
import { tempStore } from "./support/temp-store.ts";

const FOUNDATION_TABLES = ["blob", "decision_log", "idempotency", "schema_migrations"];

function tableNames(path: string): string[] {
  const database = openDatabase(path);
  try {
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return rows.map((row) => row.name).filter((name) => !name.startsWith("sqlite_"));
  } finally {
    database.close();
  }
}

test("B2-AC3: a fresh database migrates to the current version", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.schemaVersion, MIGRATIONS.length);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC3: migration v1 creates only the foundation tables", () => {
  // Applied on its own, so this stays a statement about v1 rather than about the newest schema.
  const temp = tempStore();
  const store = temp.open({ migrations: [MIGRATIONS[0] as Migration] });
  store.close();
  try {
    assert.deepEqual(tableNames(temp.path), FOUNDATION_TABLES);
  } finally {
    temp.dispose();
  }
});

test("B2-AC3: reopening applies nothing twice", () => {
  const temp = tempStore();
  const first = temp.open();
  first.close();
  const second = temp.open();
  assert.equal(second.schemaVersion, MIGRATIONS.length);
  second.close();
  const third = temp.open();
  try {
    assert.equal(third.schemaVersion, MIGRATIONS.length);
    const database = openDatabase(temp.path);
    try {
      const rows = database
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all() as { version: number; name: string }[];
      assert.deepEqual(
        rows.map((row) => ({ version: row.version, name: row.name })),
        MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name })),
      );
    } finally {
      database.close();
    }
  } finally {
    third.close();
    temp.dispose();
  }
});

test("B2-AC3: migration order is a deterministic contiguous sequence", () => {
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    MIGRATIONS.map((_, index) => index + 1),
  );

  const temp = tempStore();
  const database = openDatabase(temp.path);
  try {
    assert.throws(
      () =>
        migrate(database, [
          { version: 2, name: "out-of-order", statements: "CREATE TABLE a (x TEXT) STRICT;" },
        ]),
      (error: unknown) =>
        error instanceof StoreError && error.code === "MIGRATION_SEQUENCE_INVALID",
    );
  } finally {
    database.close();
    temp.dispose();
  }
});

test("B2-AC3: a partially failing migration is rolled back and not recorded", () => {
  const temp = tempStore();
  const database = openDatabase(temp.path);
  try {
    assert.throws(
      () =>
        migrate(database, [
          {
            version: 1,
            name: "half-broken",
            statements: `
              CREATE TABLE first_half (x TEXT) STRICT;
              CREATE TABLE second_half (x TEXT) STRICT;
              THIS IS NOT SQL;
            `,
          },
        ]),
      (error: unknown) => error instanceof StoreError && error.code === "MIGRATION_FAILED",
    );

    assert.equal(readSchemaVersion(database), 0);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    assert.deepEqual(
      tables.map((row) => row.name).filter((name) => !name.startsWith("sqlite_")),
      ["schema_migrations"],
      "no table from the failed migration may survive",
    );
  } finally {
    database.close();
    temp.dispose();
  }
});

test("B2-AC3: a database from a newer build is not silently downgraded", () => {
  const temp = tempStore();
  const store = temp.open();
  store.close();

  const database = openDatabase(temp.path);
  try {
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(99, "from-the-future", "t0001");

    assert.throws(
      () => migrate(database),
      (error: unknown) => error instanceof StoreError && error.code === "SCHEMA_VERSION_AHEAD",
    );
    assert.equal(readSchemaVersion(database), 99, "the recorded version must be left untouched");
  } finally {
    database.close();
    temp.dispose();
  }
});
