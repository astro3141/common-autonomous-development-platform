/**
 * M1B2-AC1, AC2, AC40, AC43 ~ AC48 — the discovery seam stays a callable primitive: no schema
 * change, no dependency persistence, no generic task patch, no Coordinator tick and no project or
 * backend vocabulary in Core.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { materializeDiscoveryPass } from "../core/discovery/materialize.ts";
import { openDatabase } from "../core/store/database.ts";
import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";
import { TaskStore } from "../core/store/lifecycle-stores.ts";
import { BATCH_ID, RUN_ID, withWorld } from "./support/domain-fixtures.ts";
import { ScriptedTaskSource } from "./support/scripted-task-source.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DISCOVERY = join(ROOT, "core/discovery");

/** Terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

const sources = (): string[] =>
  readdirSync(DISCOVERY)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(DISCOVERY, name));

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const scan = (label: string, patterns: readonly RegExp[]): void => {
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      const match = pattern.exec(code);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${label}: ${match?.[0] ?? ""}`);
    }
  }
};

// --- schema ------------------------------------------------------------------------------

test("M1B2-AC1 / AC2 / AC48: no migration was added and the v3 foundation is untouched", () => {
  assert.deepEqual(
    MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name })),
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
  assert.deepEqual(
    [...((MIGRATIONS[2] as Migration).statements.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g))]
      .map((match) => match[1] as string)
      .sort(),
    ["adapter_metadata", "audit_record", "verification_evidence"],
  );

  withWorld((world) => {
    assert.equal(world.store.schemaVersion, MIGRATIONS.length);
    materializeDiscoveryPass(world.store, new ScriptedTaskSource([{ ref: "T-1" }]), {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      context: { observed_at: "2026-08-10T09:00:00Z" },
    });

    const database = openDatabase(world.temp.path);
    try {
      const names = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_"));

      assert.equal(names.length, 18);
      for (const forbidden of [
        "task_dependency",
        "task_observation",
        "task_history",
        "task_projection",
        "discovery_state",
        "discovery_cursor",
        "scheduler_state",
      ]) {
        assert.equal(names.includes(forbidden), false, `${forbidden} must not exist`);
      }

      // M1B2-AC43 — a TaskSource read is not a canonical external side effect (I-TD2).
      const intents = database.prepare("SELECT count(*) AS n FROM idempotency").get() as {
        n: number;
      };
      assert.equal(intents.n, 0, "materialization wrote an idempotency INTENT");

      // M1B2-AC48 — the MVP1-B1 stores stayed empty and unchanged.
      for (const table of ["adapter_metadata", "verification_evidence", "audit_record"]) {
        const row = database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
        assert.equal(row.n, 0, `${table} was written by a discovery pass`);
      }
    } finally {
      database.close();
    }
  });
});

test("M1B2-AC40: nothing durable or in-memory persists dependencies", () => {
  scan("dependency persistence", [
    /get_dependencies|TaskDependency|depends_on/,
    /dependencyGraph|transitiveClosure|dependencyCache/i,
    /\bHARD\b|\bSOFT\b/,
  ]);
  const v3 = (MIGRATIONS[2] as Migration).statements;
  assert.equal(/depend/i.test(v3), false);
});

// --- store surface -------------------------------------------------------------------------

test("M1B2-AC26 / §55: TaskStore exposes no generic patch and no external-state setter", () => {
  const api = TaskStore.prototype as unknown as Record<string, unknown>;
  assert.deepEqual(
    Object.getOwnPropertyNames(TaskStore.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    // §18.1g (D24) — `bindMaterialization` is the one write-once NULL→binding setter of the
    // materialisation provenance column; it patches nothing else and never clears.
    // §18.1g (review 5496784502) — `materializationClaims` is a read-only cross-batch sweep of
    // binding-claiming rows, added so a wrong-id/cross-batch/duplicate claim is detectable as
    // corruption instead of hiding as absence. It writes nothing.
    [
      "bindMaterialization",
      "childrenOf",
      "discover",
      "get",
      "inBatch",
      "materializationClaims",
      "observe",
      "require",
      "write",
    ],
  );
  for (const forbidden of [
    "patch",
    "patchTask",
    "update",
    "updateTask",
    "set",
    "setState",
    "setExternalState",
    "applyExternalState",
    "merge",
    "upsert",
  ]) {
    assert.equal(typeof api[forbidden], "undefined", `TaskStore exposes ${forbidden}`);
  }

  // `observe` reaches exactly two columns; the lifecycle columns are unreachable from it.
  const store = readFileSync(join(ROOT, "core/store/lifecycle-stores.ts"), "utf8");
  const observe = store.slice(store.indexOf("  observe("), store.indexOf("  write(taskKey"));
  assert.match(observe, /UPDATE task SET external_snapshot_json = \?, updated_at = \?/);
  for (const forbidden of [
    "platform_state",
    "classification",
    "pipeline_id",
    "actor_profile",
    "verification_profile",
    "admitted_at",
    "state_reason",
  ]) {
    assert.equal(observe.includes(forbidden), false, `observe() can write ${forbidden}`);
  }
});

test("§34: the materializer never calls a lifecycle transition or admission helper", () => {
  scan("a lifecycle write", [
    /tasks\.write|attempts\.write|attempts\.create|contracts\.put|grants\./,
    /commitAdmission|commitAttemptFact|commitBatchFact|commitContractActivation|commitTaskDiscovery/,
    /SELECTED|ACTIVE|\bHELD\b|COMPLETED|\bFAILED\b|DEFERRED|INVALIDATED/,
    /assertAdmissible|admission_closed\s*[!=]/,
  ]);
  // `DISCOVERED` is the one Platform state a TaskSource observation may bring into existence, and
  // even that only through the store's narrow insert.
  const code = sources()
    .map((file) => stripComments(readFileSync(file, "utf8")))
    .join("\n");
  assert.equal(/DISCOVERED/.test(code), false, "the state literal is the store's, not this seam's");
});

// --- orchestration and adapters --------------------------------------------------------------

test("M1B2-AC46 / AC47: no adapter dependency, no scheduler and no clock", () => {
  scan("an adapter or orchestration", [
    /RuntimeAdapter|WorkflowAdapter|RepositoryAdapter|VerificationAdapter|ReportAdapter/,
    /from "\.\.\/\.\.\/adapters/,
    /setInterval|setTimeout|setImmediate|queueMicrotask/,
    /Date\.now|new Date\(|Math\.random|randomUUID/,
    /node:(fs|child_process|net|http|https)|\bfetch\(/,
    /DecisionValidator|validateDecision|TaskLookupView|START_TASK/,
    /update_task_projection|writeback/,
  ]);

  for (const file of sources()) {
    for (const specifier of [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map(
      (match) => match[1] as string,
    )) {
      assert.equal(
        specifier.startsWith(".") || specifier.startsWith("node:"),
        true,
        `${relative(ROOT, file)} imports a package: ${specifier}`,
      );
      assert.equal(specifier.includes("adapters"), false, `${relative(ROOT, file)} imports adapters`);
      assert.equal(
        specifier.includes("project-document"),
        false,
        `${relative(ROOT, file)} hardcodes a concrete TaskSource`,
      );
    }
  }
});

test("M1B2-AC47 / §56: the Coordinator gained no discovery behaviour", () => {
  // Comments are stripped first: Batch 9's prose about the Workflow `status` poll predates this
  // batch and says nothing about discovery.
  const coordinator = stripComments(
    readFileSync(join(ROOT, "core/coordinator/coordinator.ts"), "utf8"),
  );
  for (const term of [
    "materializeDiscoveryPass",
    "discover_tasks",
    "TaskSource",
    "core/discovery",
    "setInterval",
    "setTimeout",
    "pollTasks",
    "materialize",
  ]) {
    assert.equal(coordinator.includes(term), false, `the Coordinator now references ${term}`);
  }
});

// --- vocabulary ------------------------------------------------------------------------------

test("M1B2-AC44 / AC45: no project or backend vocabulary entered the discovery seam", () => {
  const forbidden: RegExp[] = [
    new RegExp(fragment("open", "claw"), "i"),
    new RegExp(fragment("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(`\\b${fragment("a", "cp")}\\b`, "i"),
    new RegExp(fragment("session", "[-_]?", "key"), "i"),
    new RegExp(`\\b${fragment("a", "gy")}\\b`, "i"),
    new RegExp(fragment("sl", "ack"), "i"),
    new RegExp(fragment("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(fragment("READY", "_ITEM")),
    new RegExp(fragment("PROJECT", "_STATUS")),
    new RegExp(fragment("THIN", "_FOUNDATION")),
    new RegExp(fragment("MAJOR", "_FOUNDATION")),
    new RegExp(fragment("CONTRACT", "_CHANGE")),
    new RegExp(fragment("Runtime", "Session")),
    new RegExp(fragment("work", "flow"), "i"),
    /\bU-\d\d\b/,
  ];
  for (const file of sources()) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }
});
