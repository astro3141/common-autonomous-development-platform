/**
 * M1B1-AC1 ~ M1B1-AC9 — migration v3 is exactly the three TD §18.1c tables, applies on top of an
 * existing v2 database, and adds nothing else.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase, readForeignKeysEnabled } from "../core/store/database.ts";
import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";
import { tempStore } from "./support/temp-store.ts";

const FOUNDATION = ["blob", "decision_log", "idempotency", "schema_migrations"];
const DOMAIN_V2 = [
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
const ARTIFACTS_V3 = ["adapter_metadata", "audit_record", "verification_evidence"];

/** The eleven tables TD §18.1c forbids v3 from inventing. */
const FORBIDDEN = [
  "runtime_session",
  "runtime_turn",
  "workflow",
  "workflow_controller",
  "workspace",
  "coordinator_state",
  "scheduler_state",
  "recovery_state",
  "task_dependency",
  "generic_event",
  "adapter_registry",
];

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

test("V3-M1 / M1B1-AC1 / AC3 / AC4: a fresh database reaches the current version with 18 tables", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.schemaVersion, MIGRATIONS.length);
  } finally {
    store.close();
  }
  try {
    const present = tables(temp.path);
    assert.equal(present.length, 18);
    // §18.1g (D24) — the current schema adds exactly the one materialisation authority table on
    // top of the sealed v1/v2/v3 groups.
    assert.deepEqual(
      present.sort(),
      [...FOUNDATION, ...DOMAIN_V2, ...ARTIFACTS_V3, "child_materialization_snapshot"].sort(),
    );
  } finally {
    temp.dispose();
  }
});

test("V3-M2 / M1B1-AC5 / AC6: an existing v2 database gains only v3, keeping its data", () => {
  const temp = tempStore();

  // Build a v2 database and put a row in it.
  const v2Store = temp.open({ migrations: MIGRATIONS.slice(0, 2) });
  const bytes = new Uint8Array([1, 2, 3]);
  const contentHash = v2Store.withTransaction(() => v2Store.blobs.put(bytes));
  assert.equal(v2Store.schemaVersion, 2);
  assert.deepEqual(tables(temp.path).sort(), [...FOUNDATION, ...DOMAIN_V2].sort());
  v2Store.close();

  const upgraded = temp.open();
  try {
    assert.equal(upgraded.schemaVersion, MIGRATIONS.length);
    assert.deepEqual(upgraded.blobs.get(contentHash), bytes, "v1/v2 data survives the upgrade");

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
        { version: 3, name: "mvp1-artifacts" },
        { version: 4, name: "selection-scope" },
        { version: 5, name: "selection-binding" },
        { version: 6, name: "audit-decision-category" },
        { version: 7, name: "subflow-parent" },
      { version: 8, name: "subflow-succeeded" },
      { version: 9, name: "child-materialization" },
      ],
    );
  } finally {
    upgraded.close();
  }

  // Reopening an already-v3 database applies nothing.
  const stable = temp.open();
  try {
    assert.equal(stable.schemaVersion, MIGRATIONS.length);
  } finally {
    stable.close();
    temp.dispose();
  }
});

test("V3-M3 / M1B1-AC2: v3 declares exactly three tables", () => {
  const v3 = (MIGRATIONS[2] as Migration).statements;
  const created = [...v3.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(
    (match) => match[1] as string,
  );
  assert.deepEqual(created.sort(), ARTIFACTS_V3);
  assert.equal((MIGRATIONS[2] as Migration).name, "mvp1-artifacts");
});

test("V3-M4 / M1B1-AC7: none of the eleven forbidden tables exists", () => {
  const temp = tempStore();
  const store = temp.open();
  store.close();
  try {
    const present = tables(temp.path);
    const v3 = (MIGRATIONS[2] as Migration).statements;
    for (const forbidden of FORBIDDEN) {
      assert.equal(present.includes(forbidden), false, `${forbidden} must not exist`);
      assert.equal(
        new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${forbidden}\\b`).test(v3),
        false,
        `v3 must not create ${forbidden}`,
      );
    }
  } finally {
    temp.dispose();
  }
});

test("V3-M5 / M1B1-AC8: every v3 table is STRICT", () => {
  const temp = tempStore();
  const store = temp.open();
  store.close();
  try {
    const sql = inspect(temp.path, (database) =>
      (
        database
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string; sql: string }[]
      ).filter((row) => ARTIFACTS_V3.includes(row.name)),
    );
    assert.equal(sql.length, 3);
    for (const row of sql) assert.match(row.sql, /STRICT\s*$/, `${row.name} is not STRICT`);
  } finally {
    temp.dispose();
  }
});

test("V3-M6 / M1B1-AC9: the attempt foreign keys are declared and enforced", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const fks = inspect(temp.path, (database) => {
      assert.equal(readForeignKeysEnabled(database), true);
      return ["verification_evidence", "audit_record"].map((table) => ({
        table,
        list: database.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
          table: string;
          from: string;
          to: string;
        }[],
      }));
    });

    for (const { table, list } of fks) {
      assert.equal(list.length, 1, `${table} declares exactly one foreign key`);
      assert.deepEqual(
        { table: list[0]?.table, from: list[0]?.from, to: list[0]?.to },
        { table: "task_attempt", from: "attempt_key", to: "attempt_key" },
      );
    }

    // And a violation is actually rejected.
    assert.throws(() =>
      store.withTransaction(() =>
        store.auditRecords.put({
          audit_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F01",
          attempt_key: "attempt:task:alpha:missing:1",
          candidate_commit: "c1",
          task_contract_hash: `sha256:${"a".repeat(64)}`,
          envelope: {
            verdict: "AUDIT_PASS",
            findings: [],
            reviewed: {
              candidate_commit: "c1",
              task_contract_hash: `sha256:${"a".repeat(64)}`,
              evidence_ids: [],
            },
          },
          committed_via: "platform-audit-gate",
          recorded_at: "2026-08-09T10:00:00Z",
        }),
      ),
    );
  } finally {
    store.close();
    temp.dispose();
  }
});
