/**
 * MVP1-B7 boundaries — B7-27 / B7-29 and §32/§33/§47: what this batch must *not* have introduced.
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
const VERIFICATION = join(ROOT, "core/execution/start-verification.ts");

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("B7-29: the schema is still v5 / 18 tables and no workflow table was added", () => {
  assert.equal(MIGRATIONS.length, 9);
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.schemaVersion, 9);
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
      assert.equal(names.length, 18);
      // TD §18.1c names these as forbidden; a verification request is not a reason to add one.
      for (const forbidden of [
        "workflow",
        "workflow_controller",
        "verification_request",
        "evidence_request",
        "request_ledger",
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

test("B7C-4 / M1-9: Core reaches the verification backend only through VerificationAdapter", () => {
  const code = stripComments(readFileSync(VERIFICATION, "utf8"));
  // The whole point of the M1-9 correction: this is the one backend seam Core may name here.
  assert.match(code, /verification\.start_verification\(/);
  for (const forbidden of [
    /WorkflowAdapter|WorkflowHandle|WorkflowControllerHandle/,
    /acquire_workflow_controller|workflow\.start|workflow\.status|verification_workflow/,
    /RuntimePreflight|preflight/,
  ]) {
    assert.equal(forbidden.test(code), false, `start-verification contains ${forbidden}`);
  }
});

test("B7-19 / §32: the module produces no evidence and observes no run", () => {
  const code = stripComments(readFileSync(VERIFICATION, "utf8"));
  for (const forbidden of [
    /verificationEvidence|VerificationEvidence|run_verification/,
    /get_verification_result/,
    /\.status\(|\.resume\(|\.recover\(|audit_decide|auditRecords/,
    /VERIFICATION_PASSED|VERIFICATION_FAILED|AUDITING|assurance/,
    // §33 — no result channel work, and no structured-output reading at all.
    /structured_output|result_channel|ResultChannel|submit_/,
    // §5 / I-TD3 — the model's own claims are never read.
    /model_declared_outcome|declared_status/,
    // §15 — no new Actor turn is started here.
    /send_turn|spawn_session|REWORK_STARTED/,
  ]) {
    assert.equal(forbidden.test(code), false, `start-verification contains ${forbidden}`);
  }
});

test("B7-27 / §47: no backend or project vocabulary entered the execution module", () => {
  // Assembled from fragments so this guard does not contain the terms it forbids.
  const term = (...parts: readonly string[]): RegExp => new RegExp(parts.join(""), "i");
  const modules = readdirSync(join(ROOT, "core/execution"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(ROOT, "core/execution", name));
  assert.ok(modules.length >= 3);

  for (const file of modules) {
    const content = readFileSync(file, "utf8");
    for (const pattern of [
      term("session", "[-_]?", "key"),
      term("owner", "[-_]?", "key"),
      term("durable", "[-_ ]?", "jobs"),
      term("OPEN", "CLAW"),
      term("plugin", "[-_]?", "tools"),
      term("A", "cp", "Runtime"),
    ]) {
      assert.equal(pattern.test(content), false, `${relative(ROOT, file)} matches ${pattern}`);
    }
  }
});

test("B7-27: the module imports no adapter implementation", () => {
  const specifiers = [...readFileSync(VERIFICATION, "utf8").matchAll(/from "([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  for (const specifier of specifiers) {
    assert.equal(
      specifier.startsWith("../") || specifier.startsWith("./") || specifier.startsWith("node:"),
      true,
      `the module imports a package: ${specifier}`,
    );
    assert.equal(
      /local-git|backend-runtime-preflight|project-document/.test(specifier),
      false,
      `the module imports an implementation: ${specifier}`,
    );
  }
});

// --- B7C-1 / B7C-2: the VerificationAdapter surface is exactly M1-9's ---------------------------

test("B7C-1 / B7C-2: the synchronous callable is gone and the async pair is exact", () => {
  const contract = readFileSync(join(ROOT, "adapters/interfaces/verification-adapter.ts"), "utf8");
  const surface = contract.slice(contract.indexOf("export interface VerificationAdapter {"));
  const operations = [...surface.matchAll(/^\s{2}([a-z_]+)\(/gm)].map((match) => match[1]);
  // M1-13 — `settle_audit` joins the surface: Core holds only the opaque VerificationRunHandle,
  // so the audit gate is settled by whichever adapter owns that run's backend identity.
  assert.deepEqual(
    operations,
    ["start_verification", "get_verification_result", "settle_audit"],
    "B7C-2",
  );

  // B7C-1 — no production code *offers* the old synchronous execution authority any more. The
  // check is on code, not prose: the contract's own comment may still explain why it is gone.
  for (const file of [
    "adapters/interfaces/verification-adapter.ts",
    "adapters/interfaces/index.ts",
    "adapters/local-verification/local-verification-adapter.ts",
    "testdoubles/fake-verification-adapter.ts",
    "core/execution/start-verification.ts",
  ]) {
    assert.equal(
      /run_verification/.test(stripComments(readFileSync(join(ROOT, file), "utf8"))),
      false,
      `${file} still offers run_verification`,
    );
  }

  // The operation context is one field, and the two unions have no extra variants.
  const context = surface.length > 0 ? contract : "";
  const contextBody = context.slice(
    context.indexOf("export interface VerificationOperationContextV1 {"),
  );
  assert.deepEqual(
    [...contextBody.slice(0, contextBody.indexOf("\n}")).matchAll(/readonly (\w+):/g)].map(
      (match) => match[1],
    ),
    ["op_key"],
  );
  assert.equal((contract.match(/kind: "STARTED"|kind: "BLOCKED"/g) ?? []).length, 2);
  assert.equal(
    (contract.match(/state: "RUNNING"|state: "COMPLETED"|state: "FAILED"/g) ?? []).length,
    3,
  );
});

test("§30: only the LocalVerificationAdapter knows the verification/workflow glue", () => {
  const term = (...parts: readonly string[]): RegExp => new RegExp(parts.join(""), "i");
  const allowed = "adapters/local-verification/";
  const production = [
    ...readdirSync(join(ROOT, "core"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        readdirSync(join(ROOT, "core", entry.name))
          .filter((name) => name.endsWith(".ts"))
          .map((name) => join(ROOT, "core", entry.name, name)),
      ),
  ];
  for (const file of production) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(relative(ROOT, file).startsWith(allowed), false);
    for (const pattern of [
      /acquire_workflow_controller/,
      /WorkflowControllerHandle/,
      term("durable", "[-_ ]?", "jobs"),
    ]) {
      assert.equal(pattern.test(code), false, `${relative(ROOT, file)} matches ${pattern}`);
    }
  }
});
