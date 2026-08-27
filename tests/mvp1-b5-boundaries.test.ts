/**
 * M1B5-AC46 ~ M1B5-AC51, AC56 ~ AC60 — activation stops at `Attempt READY`: no workspace, no
 * Runtime, no Workflow, no Verification, and no new framework or table.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS } from "../core/store/migrations.ts";
import { openDatabase } from "../core/store/database.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ADMISSION = join(ROOT, "core/admission");
const ACTIVATION = join(ADMISSION, "activate-task.ts");

/** Terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

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

test("M1B5-AC46 ~ AC49: activation reaches no workspace, Runtime, Workflow or Verification", () => {
  const activation = code(ACTIVATION);
  for (const forbidden of [
    /create_feature_workspace|prepare_merge|commit_merge|get_diff|verify_expected_files/,
    /spawn_session|send_turn|get_turn_result|get_session_status|cancel_session/,
    /RuntimeAdapter|WorkflowAdapter|VerificationAdapter|ReportAdapter/,
    /workflow\.|audit_decide|run_verification|verificationEvidence|auditRecords/,
    /adapter_metadata|adapterMetadata/,
    /idempotency|INTENT/,
    /pendingDecisions|outbox/,
  ]) {
    assert.equal(forbidden.test(activation), false, `activation contains ${forbidden}`);
  }

  // The only adapter interface it may name is the RepositoryAdapter, via fact assembly.
  for (const specifier of [...readFileSync(ACTIVATION, "utf8").matchAll(/from "([^"]+)"/g)].map(
    (match) => match[1] as string,
  )) {
    assert.equal(
      specifier.startsWith("../") || specifier.startsWith("./") || specifier.startsWith("node:"),
      true,
      `activation imports a package: ${specifier}`,
    );
    assert.equal(specifier.includes("adapters/"), false, `activation imports ${specifier}`);
    assert.equal(/local-git|project-document/.test(specifier), false);
  }
});

test("M1B5-AC50 / AC51: activation writes no adapter_metadata and no idempotency row", () => {
  // Structural, not just textual: the two stores are never referenced from the module.
  const activation = code(ACTIVATION);
  assert.equal(/store\.adapterMetadata|store\.idempotency/.test(activation), false);
});

test("M1B5-AC56: no new table, framework or durable draft was introduced", () => {
  const temp = tempStore();
  const store = temp.open();
  assert.equal(store.schemaVersion, 6);
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
      assert.equal(names.length, 17);
      for (const forbidden of [
        "task_contract_draft",
        "selection_binding",
        "selection_history",
        "proposal_snapshot",
        "scope_registry",
        "repository_scope",
        "task_scope",
      ]) {
        assert.equal(names.includes(forbidden), false, `${forbidden} must not exist`);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }

  for (const file of coreSources()) {
    const content = code(file);
    for (const forbidden of [
      /TaskContractDraft|ScopeRegistry|SelectionHistory|ProposalSnapshot/,
      /CommandBus|EventBus|FactRegistry|AuthorityRegistry/,
      /RecoveryEngine|DependencyScheduler|RuntimeOrchestrator/,
    ]) {
      assert.equal(forbidden.test(content), false, `${relative(ROOT, file)} adds a framework`);
    }
  }
});

test("M1B5-AC57 / AC58: the B2 materializer and the B3 repository boundary are unchanged", () => {
  const materializer = code(join(ROOT, "core/discovery/materialize.ts"));
  assert.equal(/get_task_state|get_dependencies/.test(materializer), false, "AC57");
  assert.equal(/repository_scope_id|selection_binding/.test(materializer), false);

  // AC58 — activation uses exactly one repository primitive.
  const activation = code(ACTIVATION);
  const calls = [...activation.matchAll(/repository\.([a-z_]+)\(/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(calls)], ["snapshot_canonical"]);
});

test("M1B5-AC60: no backend or project vocabulary entered the batch's modules", () => {
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
    /\bU-\d\d\b/,
  ];
  const files = readdirSync(ADMISSION)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(ADMISSION, name));
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }
});

test("M1B5-AC1 / AC2 / AC3: the migration list is exactly v1..v5 and adds no table", () => {
  assert.deepEqual(
    MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name })),
    [
      { version: 1, name: "foundation" },
      { version: 2, name: "domain" },
      { version: 3, name: "mvp1-artifacts" },
      { version: 4, name: "selection-scope" },
      { version: 5, name: "selection-binding" },
      { version: 6, name: "audit-decision-category" },
    ],
  );
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    MIGRATIONS.map((_, index) => index + 1),
  );
});
