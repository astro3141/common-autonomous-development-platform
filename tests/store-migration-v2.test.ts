/**
 * B8-AC1, B8-AC2, B8-AC38 — migration v2 is exactly the ten TD §18.1a domain tables, applies
 * deterministically on top of v1, and rolls back whole.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase, readForeignKeysEnabled } from "../core/store/database.ts";
import { StoreError } from "../core/store/errors.ts";
import { MIGRATIONS, migrate, readSchemaVersion, type Migration } from "../core/store/migrations.ts";
import { tempStore } from "./support/temp-store.ts";

const FOUNDATION = ["blob", "decision_log", "idempotency", "schema_migrations"];
const DOMAIN = [
  "batch",
  "capability_grant",
  "compiled_profile_snapshot",
  "operator_action",
  "pending_human_decision",
  "platform_run",
  "report_outbox",
  "task",
  "task_attempt",
  "task_contract_snapshot",
];
const DEFERRED = ["verification_evidence", "audit_record", "adapter_metadata"];

const inspect = <T>(path: string, run: (database: ReturnType<typeof openDatabase>) => T): T => {
  const database = openDatabase(path);
  try {
    return run(database);
  } finally {
    database.close();
  }
};

const tables = (path: string): string[] =>
  inspect(path, (database) =>
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_")),
  );

test("B8-AC1: migration v2 adds exactly the ten domain tables", () => {
  // Applied through v2 only, so this stays a statement about v2 rather than the newest schema.
  const temp = tempStore();
  const store = temp.open({ migrations: MIGRATIONS.slice(0, 2) });
  store.close();
  try {
    assert.deepEqual(tables(temp.path).sort(), [...FOUNDATION, ...DOMAIN].sort());
  } finally {
    temp.dispose();
  }
});

test("B8-AC38: migration v2 creates none of the tables it deferred", () => {
  // The three tables belong to migration v3 (TD §18.1c); v2 must still not mention them.
  const temp = tempStore();
  const store = temp.open({ migrations: MIGRATIONS.slice(0, 2) });
  store.close();
  try {
    const present = tables(temp.path);
    for (const deferred of DEFERRED) {
      assert.equal(present.includes(deferred), false, `${deferred} is not a v2 table`);
    }
    const v2 = (MIGRATIONS[1] as Migration).statements;
    for (const deferred of DEFERRED) assert.equal(v2.includes(deferred), false);
  } finally {
    temp.dispose();
  }
});

test("B8-AC1: every v2 table is STRICT", () => {
  const temp = tempStore();
  const store = temp.open({ migrations: MIGRATIONS.slice(0, 2) });
  store.close();
  try {
    const sql = inspect(temp.path, (database) =>
      (
        database
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string; sql: string }[]
      ).filter((row) => DOMAIN.includes(row.name)),
    );
    assert.equal(sql.length, DOMAIN.length);
    for (const row of sql) {
      assert.match(row.sql, /STRICT\s*$/, `${row.name} is not STRICT`);
    }
  } finally {
    temp.dispose();
  }
});

test("B8-AC2: a fresh database applies v1 then v2, and a v1 database upgrades", () => {
  const temp = tempStore();
  // A database that only ever saw the foundation migration.
  const first = temp.open({ migrations: [MIGRATIONS[0] as Migration] });
  assert.equal(first.schemaVersion, 1);
  assert.deepEqual(tables(temp.path).sort(), FOUNDATION.sort());
  first.close();

  const upgraded = temp.open({ migrations: MIGRATIONS.slice(0, 2) });
  try {
    assert.equal(upgraded.schemaVersion, 2);
    assert.deepEqual(tables(temp.path).sort(), [...FOUNDATION, ...DOMAIN].sort());
  } finally {
    upgraded.close();
  }

  // Reopening an already-v2 database applies nothing.
  const stable = temp.open({ migrations: MIGRATIONS.slice(0, 2) });
  try {
    assert.equal(stable.schemaVersion, 2);
    const rows = inspect(temp.path, (database) =>
      database
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all() as { version: number; name: string }[],
    );
    assert.deepEqual(
      rows.map((row) => ({ version: row.version, name: row.name })),
      [
        { version: 1, name: "foundation" },
        { version: 2, name: "domain" },
      ],
    );
  } finally {
    stable.close();
    temp.dispose();
  }
});

test("B8-AC2: a failing v2 rolls back completely and is not recorded", () => {
  const temp = tempStore();
  const database = openDatabase(temp.path);
  try {
    assert.throws(
      () =>
        migrate(database, [
          MIGRATIONS[0] as Migration,
          {
            version: 2,
            name: "domain",
            statements: `
              CREATE TABLE platform_run (run_id TEXT PRIMARY KEY) STRICT;
              THIS IS NOT SQL;
            `,
          },
        ]),
      (error: unknown) => error instanceof StoreError && error.code === "MIGRATION_FAILED",
    );
    assert.equal(readSchemaVersion(database), 1);
  } finally {
    database.close();
  }
  try {
    assert.deepEqual(tables(temp.path).sort(), FOUNDATION.sort(), "no v2 table survived");
  } finally {
    temp.dispose();
  }
});

test("B8-AC2: the migration sequence stays contiguous", () => {
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    MIGRATIONS.map((_, index) => index + 1),
  );
});

test("B8-AC1: foreign keys are enforced and the partial unique indexes exist", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const indexes = inspect(temp.path, (database) => {
      assert.equal(readForeignKeysEnabled(database), true);
      return (
        database
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
          .all() as { name: string; sql: string }[]
      );
    });

    const partial = indexes.filter((index) => /WHERE/i.test(index.sql));
    assert.deepEqual(
      partial.map((index) => index.name).sort(),
      [
        "capability_grant_role_per_attempt",
        "capability_grant_supervisor_per_run",
        "task_attempt_single_non_terminal",
      ],
    );

    // A FK violation is actually rejected rather than silently accepted.
    assert.throws(() =>
      store.withTransaction(() =>
        store.batches.create({
          batch_id: "batch:run:missing:1",
          run_id: "run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZZ",
          ordinal: 1,
          compiled_profile_hash: `sha256:${"0".repeat(64)}`,
        }),
      ),
    );
  } finally {
    store.close();
    temp.dispose();
  }
});
