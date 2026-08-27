/**
 * B6-AC25, B6-AC30, B6-AC31 — module boundaries: no filesystem in `core/contract`, no Batch 7
 * decision semantics and no Batch 8 domain persistence.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACT = join(ROOT, "core/contract");
const TASKSOURCE = join(ROOT, "core/tasksource");

const sourcesIn = (directory: string): string[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name));

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("B6-AC25: core/contract never touches a filesystem", () => {
  for (const file of sourcesIn(CONTRACT)) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(
      /from "node:fs"|readFileSync|writeFileSync|from "node:path"|resolve\(/.test(code),
      false,
      `${relative(ROOT, file)} reaches for the filesystem`,
    );
  }
});

test("B6-AC25: neither module invents a clock, randomness or an ID allocator", () => {
  for (const file of [...sourcesIn(CONTRACT), ...sourcesIn(TASKSOURCE)]) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [label, pattern] of [
      ["clock", /Date\.now|new Date\(/],
      ["randomness", /Math\.random|randomUUID|randomBytes/],
      ["id allocation", /generateUlid|newUlid|nextId|createId/],
      ["network or process", /node:(child_process|net|http|https)|\bfetch\(/],
    ] as const) {
      assert.equal(pattern.test(code), false, `${relative(ROOT, file)} contains ${label}`);
    }
  }
});

test("B6-AC30: no Batch 7 decision or V10 orchestration is pulled forward", () => {
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ["decision validator", /DecisionValidator|validateProposal|\bV1[01]\b|decision_log/],
    ["proposal vocabulary", /START_TASK|PROPOSE_MERGE|REQUEST_REWORK|CLOSE_BATCH/],
    ["backend gate orchestration", /POLICY_BACKEND_INCOMPATIBLE|BACKEND_INCOMPATIBLE/],
    ["operation taxonomy", /operation_id|operationId|automatic_merge/],
    ["state machine / coordinator", /Coordinator|StateMachine|\bHELD\b/],
  ];
  for (const file of [...sourcesIn(CONTRACT), ...sourcesIn(TASKSOURCE)]) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(code), false, `${relative(ROOT, file)} contains ${label}`);
    }
  }
});

test("B6-AC31: no domain table or migration was added", () => {
  // Batch 6 added no migration of its own; the foundation migration is still exactly v1's.
  const foundation = MIGRATIONS[0] as Migration;
  const tables = [...foundation.statements.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(
    (match) => match[1] as string,
  );

  assert.deepEqual(tables.sort(), ["blob", "decision_log", "idempotency"]);
  assert.equal(foundation.name, "foundation");

  for (const file of [...sourcesIn(CONTRACT), ...sourcesIn(TASKSOURCE)]) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(
      /CREATE TABLE|INSERT INTO|task_contract_snapshot|capability_grant\s*\(|operator_action/.test(code),
      false,
      `${relative(ROOT, file)} writes domain persistence`,
    );
  }
});

test("B6-AC31: the build result is an in-memory bundle, not a new envelope schema", () => {
  for (const file of [...sourcesIn(CONTRACT), ...sourcesIn(TASKSOURCE)]) {
    const content = readFileSync(file, "utf8");
    assert.equal(/task-contract-build-result|task-contract-draft|TaskContractDraft/.test(content), false);
  }
  // Only the two documented envelope names appear in these modules.
  const declared = [...sourcesIn(CONTRACT), ...sourcesIn(TASKSOURCE)].flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/"(platform\/[a-z-]+)"/g)].map((match) => match[1] as string),
  );
  assert.deepEqual([...new Set(declared)].sort(), ["platform/task-contract", "platform/task-definition"]);
});

test("no backend or project vocabulary in the Batch 6 modules", () => {
  const token = (...parts: readonly string[]): string => parts.join("");
  const forbidden: RegExp[] = [
    new RegExp(token("open", "claw"), "i"),
    new RegExp(token("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(`\\b${token("ac", "px?")}\\b`, "i"),
    new RegExp(token("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(token("session", "[-_]?", "key"), "i"),
    new RegExp(`\\b${token("a", "gy")}\\b`, "i"),
    new RegExp(token("PROJECT", "_STATUS")),
    new RegExp(token("READY", "_ITEM")),
    new RegExp(token("THIN", "_FOUNDATION")),
    new RegExp(token("MAJOR", "_FOUNDATION")),
    new RegExp(token("CONTRACT", "_CHANGE")),
    new RegExp(token("permission", "Mode")),
    new RegExp(token("tool_", "allowlist")),
  ];
  for (const file of [...sourcesIn(CONTRACT), ...sourcesIn(TASKSOURCE)]) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }
});
