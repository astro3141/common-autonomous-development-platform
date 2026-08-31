/**
 * MVP1-B6 areas U, V and §3/§31/§32/§36/§38 — what this batch must *not* have introduced.
 *
 * The schema stays v5/17 tables, no new durable vocabulary appears, the Coordinator stays the
 * MVP 0 shell, and RA-2 / RA-3 remain untouched.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openDatabase } from "../core/store/database.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXECUTION = join(ROOT, "core/execution/start-implementation.ts");

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const code = (file: string): string => stripComments(readFileSync(file, "utf8"));

const coreSources = (): string[] =>
  readdirSync(join(ROOT, "core"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(ROOT, "core", entry.name))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "core", entry.name, name)),
    );

// --- area V: the schema is untouched -----------------------------------------------------------

test("B6-29 (V): the schema is still v5 with the same 17 tables and no new migration", () => {
  assert.equal(MIGRATIONS.length, 7);
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.name),
    [
      "foundation",
      "domain",
      "mvp1-artifacts",
      "selection-scope",
      "selection-binding",
      // M1-13 — the AUDIT_DECISION category; a CHECK rebuild, not a new table.
      "audit-decision-category",
      // MVP 3 — SUSPENDED + parent_task_key; a CHECK rebuild, not a new table.
      "subflow-parent",
    ],
  );

  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.schemaVersion, 7);
  } finally {
    store.close();
  }
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
      assert.equal(names.length, 17);
      // §3 — none of the durable tables this batch was forbidden to invent exists.
      for (const forbidden of [
        "runtime_session",
        "runtime_turn",
        "workspace",
        "operation",
        "recovery",
        "coordinator_state",
        "scheduler_state",
      ]) {
        assert.equal(names.includes(forbidden), false, `${forbidden} was created`);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }
});

// --- area U: no later-stage integration ---------------------------------------------------------

test("B6-26 / B6-27 / B6-28 (U): the module reaches no Workflow, Verification or Auditor", () => {
  const execution = code(EXECUTION);
  for (const forbidden of [
    /WorkflowAdapter|workflow\.|WorkflowHandle|WorkflowSpec|acquire_workflow_controller/,
    /VerificationAdapter|run_verification|verificationEvidence/,
    /audit_decide|auditRecords|AuditorVerdict/,
    // §31 — RA-2 is not closed here: no result collection of any kind.
    /get_turn_result|RuntimeTurnResult|structured_output|RuntimeResultChannel/,
    /inspect_candidate|candidate_commit|CANDIDATE_OBSERVED|VERIFYING/,
    // §29 — merges and human decisions belong to later stages.
    /prepare_merge|commit_merge|pendingDecisions|outbox|PendingDecision/,
    // §38 — no scheduler was pulled forward.
    /setInterval|setTimeout|cron|queue|event ?bus|command ?bus/i,
    /retryCounter|backoff|circuitBreaker|circuit_breaker/i,
  ]) {
    assert.equal(forbidden.test(execution), false, `start-implementation contains ${forbidden}`);
  }
});

test("B6-26: the module imports no adapter implementation", () => {
  const specifiers = [...readFileSync(EXECUTION, "utf8").matchAll(/from "([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  for (const specifier of specifiers) {
    assert.equal(
      specifier.startsWith("../") || specifier.startsWith("./") || specifier.startsWith("node:"),
      true,
      `the execution module imports a package: ${specifier}`,
    );
    assert.equal(
      /local-git|backend-runtime-preflight|project-document/.test(specifier),
      false,
      `the execution module imports an implementation: ${specifier}`,
    );
  }
  // Adapter *interfaces* are exactly what it may name.
  assert.equal(specifiers.some((specifier) => specifier.includes("adapters/interfaces/")), true);
});

// --- §38: the Coordinator stayed a shell ---------------------------------------------------------

test("B6-1 (§38): the MVP 0 Coordinator shell is unchanged", () => {
  // MVP1-B13 added the production Coordinator beside the shell; the shell itself still performs
  // no execution work, which is what this guard has always been about.
  const files = readdirSync(join(ROOT, "core/coordinator")).sort();
  for (const shell of ["coordinator.ts", "index.ts", "types.ts"]) {
    assert.equal(files.includes(shell), true, shell);
  }
  const coordinator = code(join(ROOT, "core/coordinator/coordinator.ts"));
  assert.equal(/startImplementation|create_feature_workspace|spawn_session/.test(coordinator), false);
});

// --- §36: no backend vocabulary crossed into Core --------------------------------------------------

test("B6-30 (§36): no Backend or Project vocabulary entered Core production code", () => {
  // Assembled from fragments so this guard does not contain the terms it forbids.
  const term = (...parts: readonly string[]): RegExp => new RegExp(parts.join(""), "i");
  const forbidden = [
    term("session", "[-_]?", "key"),
    term("OPEN", "CLAW", "_TOOLS_MCP"),
    term("A", "cp", "Runtime"),
    term("start", "Turn"),
    term("durable", "[-_ ]?", "jobs"),
    term("PROJECT", "_STATUS"),
    term("READY", "_ITEM"),
  ];
  for (const file of [...coreSources(), ...testdoubleSources()]) {
    if (relative(ROOT, file) === "core/store/restricted-key-denylist.ts") continue;
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `${relative(ROOT, file)} matches ${pattern}`);
    }
  }
});

function testdoubleSources(): string[] {
  return readdirSync(join(ROOT, "testdoubles"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(ROOT, "testdoubles", name));
}

// --- §3: no generic framework -----------------------------------------------------------------------

test("B6-23 (§3): no generic operation framework, codec or registry was introduced", () => {
  for (const file of [...coreSources(), join(ROOT, "adapters/interfaces/runtime-adapter.ts")]) {
    const content = code(file);
    for (const forbidden of [
      /HandleCodec|IdentityRegistry|identity_registry|TurnLedger|turn_ledger/i,
      /OperationFramework|OperationDispatcher|EffectRunner|SideEffectExecutor/i,
      /AdapterContext</,
    ]) {
      assert.equal(forbidden.test(content), false, `${relative(ROOT, file)} contains ${forbidden}`);
    }
  }
});
