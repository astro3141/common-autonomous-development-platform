/**
 * B9-AC4, B9-AC10, B9-AC19 ~ B9-AC25 — `core/coordinator` stays an MVP 0 shell: no scheduler, no
 * mapper, no orchestration, no backend dependency and no new durable schema.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";
import { openDatabase } from "../core/store/database.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COORDINATOR = join(ROOT, "core/coordinator");

/** Forbidden terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

/**
 * The MVP 0 shell itself. MVP1-B13 added the production Coordinator beside it — these scans are
 * about the *shell*, which B13 left untouched, and the production file has its own guards in
 * `tests/b13-coordinator.test.ts`. Widening these to cover it would only mean deleting them.
 */
const SHELL = ["coordinator.ts", "types.ts", "index.ts"];

const sources = (): string[] =>
  readdirSync(COORDINATOR)
    .filter((name) => name.endsWith(".ts") && SHELL.includes(name))
    .map((name) => join(COORDINATOR, name));

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

test("B9-AC6: no timer, scheduler or background loop exists in the module", () => {
  scan("a scheduler", [
    /setInterval|setImmediate/,
    /setTimeout/,
    /\bsleep\b/i,
    /node:(timers|worker_threads|child_process)/,
    /Date\.now|new Date\(/,
    /cron|heartbeat/i,
    /requestAnimationFrame|queueMicrotask/,
  ]);
});

test("B9-AC10: no observation-to-lifecycle mapping exists", () => {
  scan("an observation mapper", [
    /ObservationMapper|observationMap/i,
    /AttemptFact|AttemptState|TaskState|BatchState/,
    /mappingTable|MAPPING_TABLE|mapping registry/i,
  ]);
  // And the module names none of the lifecycle vocabularies it must not interpret.
  scan("a lifecycle vocabulary", [
    /READY_TO_MERGE|IMPLEMENTING|VERIFYING|AUDITING|REWORKING/,
    /DISCOVERED|SELECTED|PAUSED_SAFELY/,
  ]);
});

test("B9-AC19 / B9-AC20 / B9-AC21: no orchestration is pulled forward", () => {
  scan("production orchestration", [
    /discover_tasks|get_task_state|external_snapshot/,
    /ReportAdapter|deliver\(|sent_at|outbox/i,
    /RuntimeAdapter|RepositoryAdapter|VerificationAdapter|TaskSource/,
    /spawn_session|send_turn|create_feature_workspace|audit_decide/,
    /validateDecision|TaskLookupView|RepositoryValidationView|DecisionValidationBatchView/,
    /commitAdmission|commitAttemptFact|commitBatchFact|commitPendingDecision/,
  ]);
});

test("B9-AC15: the module performs no durable mutation and no idempotency work", () => {
  scan("a mutation", [
    /INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE/,
    /withTransaction|BEGIN IMMEDIATE/,
    /decisions\.append|outbox\.enqueue|idempotency\./,
    /EffectRunner|SideEffectExecutor|OperationDispatcher/,
  ]);
});

test("B9-AC3 / B9-AC23: the Coordinator holds no state and declares no durable table", () => {
  scan("coordinator state", [
    /lastTick|tickCursor|retryCounter|workflowCache|pendingQueue|recoveryCache/,
    /coordinator_state|recovery_state|tick_cursor|scheduler_state/,
  ]);
  scan("a future recovery schema", [
    /RecoveryInput|RecoveryAction|RecoveryCommand|RecoveryPlan/,
    /AuthorityRegistry|RecoveryObservationSet/,
    /canonical_mutation_risk|NOT_APPLICABLE|UNAVAILABLE/,
    /Record<string,\s*unknown>/,
  ]);
});

test("B9-AC24 / B9-AC25: no backend package, project vocabulary or continuation concept", () => {
  const forbidden: RegExp[] = [
    new RegExp(fragment("open", "claw"), "i"),
    new RegExp(fragment("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(`\\b${fragment("a", "cp")}\\b`, "i"),
    new RegExp(fragment("session", "[-_]?", "key"), "i"),
    new RegExp(`\\b${fragment("a", "gy")}\\b`, "i"),
    new RegExp(fragment("READY", "_ITEM")),
    new RegExp(fragment("PROJECT", "_STATUS")),
    new RegExp(fragment("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(fragment("sl", "ack"), "i"),
    new RegExp(fragment("contin", "uation"), "i"),
    new RegExp(fragment("P3", "-H")),
  ];
  for (const file of sources()) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }

  // Only Core and the generic adapter interfaces are imported. This holds for every file in the
  // package, production Coordinator included: it composes Core use-cases and adapter *interfaces*.
  const packageFiles = readdirSync(COORDINATOR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(COORDINATOR, name));
  for (const file of packageFiles) {
    const imports = [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    for (const specifier of imports) {
      assert.equal(
        specifier.startsWith(".") || specifier.startsWith("node:"),
        true,
        `${relative(ROOT, file)} imports a package: ${specifier}`,
      );
      assert.equal(
        /adapters\/interfaces\//.test(specifier) || !specifier.includes("adapters"),
        true,
        `${relative(ROOT, file)} reaches past the adapter interfaces: ${specifier}`,
      );
    }
  }
});

test("B9-AC4 / B9-AC22: no migration and no new table were added", () => {
  // Batch 9 introduced no migration of its own; v3 belongs to MVP1-B1 (TD §18.1c).
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

  const temp = tempStore();
  const store = temp.open();
  assert.equal(store.schemaVersion, MIGRATIONS.length);
  store.close();
  try {
    const database = openDatabase(temp.path);
    try {
      const names = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_"));

      assert.equal(names.length, 18);
      for (const absent of ["coordinator_state", "recovery_state"]) {
        assert.equal(names.includes(absent), false, `${absent} must not exist`);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }

  // The migration source itself declares nothing new either.
  const v2 = (MIGRATIONS[1] as Migration).statements;
  for (const absent of ["coordinator_state", "recovery_state"]) {
    assert.equal(v2.includes(absent), false);
  }
});
