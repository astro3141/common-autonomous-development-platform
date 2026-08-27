/**
 * M1B1-AC13, M1B1-AC25 ~ M1B1-AC28 — the MVP1-B1 stores stay a storage foundation: no adapter, no
 * orchestration, no backend vocabulary and no invented scanning framework.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

const BATCH_SOURCES = [
  join(ROOT, "core/store/mvp1-artifact-stores.ts"),
  join(ROOT, "core/store/restricted-key-denylist.ts"),
  join(ROOT, "core/store/migrations.ts"),
];

/** The deny list exists to name the I-TD7 categories; everything else stays under full check. */
const STORE_ONLY = [join(ROOT, "core/store/mvp1-artifact-stores.ts")];

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const scan = (files: readonly string[], label: string, patterns: readonly RegExp[]): void => {
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      const match = pattern.exec(code);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${label}: ${match?.[0] ?? ""}`);
    }
  }
};

test("M1B1-AC27: the stores depend on no adapter and reach nothing outside SQLite", () => {
  scan(BATCH_SOURCES, "an adapter or external seam", [
    /RuntimeAdapter|WorkflowAdapter|RepositoryAdapter|VerificationAdapter|ReportAdapter/,
    /TaskSource|discover_tasks|get_task\(/,
    /from "\.\.\/\.\.\/adapters/,
    /node:(fs|child_process|net|http|https)|\bfetch\(/,
  ]);
  // The batch's own modules invent no clock or randomness (migrations.ts predates this batch).
  scan(STORE_ONLY.concat(join(ROOT, "core/store/restricted-key-denylist.ts")), "a clock", [
    /Date\.now|new Date\(/,
    /Math\.random|randomUUID|randomBytes/,
  ]);

  // Only Core-relative imports and node:sqlite-adjacent types.
  for (const file of BATCH_SOURCES) {
    const imports = [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    for (const specifier of imports) {
      assert.equal(
        specifier.startsWith(".") || specifier.startsWith("node:"),
        true,
        `${relative(ROOT, file)} imports a package: ${specifier}`,
      );
      assert.equal(specifier.includes("adapters"), false, `${relative(ROOT, file)} imports adapters`);
    }
  }
});

test("M1B1-AC25 / AC28: no audit, workflow or Coordinator orchestration is implemented", () => {
  // Scoped to the batch's own modules; migrations.ts carries the pre-existing Batch 2 runner.
  scan(STORE_ONLY, "orchestration", [
    /audit_decide|acquire_workflow_controller|spawn_session|send_turn/,
    /withTransaction|BEGIN IMMEDIATE/,
    /commitAdmission|commitAttemptFact|commitBatchFact|commitPendingDecision|commitContractActivation/,
    /from "\.\.\/coordinator|new Coordinator\(|tickOnce/,
    /idempotency|INTENT/,
    /outbox|sent_at|deliver\(/,
  ]);

  // The Coordinator itself is untouched by this batch.
  const coordinator = readFileSync(join(ROOT, "core/coordinator/coordinator.ts"), "utf8");
  for (const term of ["adapterMetadata", "verificationEvidence", "auditRecords"]) {
    assert.equal(coordinator.includes(term), false, `the Coordinator now references ${term}`);
  }
});

test("M1B1-AC13: no value scanner or DLP framework was invented", () => {
  scan(BATCH_SOURCES, "a scanner framework", [
    /entropy/i,
    /Scanner|Detector|Classifier|Redactor/,
    /process\.env/,
    /DLP|dataLossPrevention/i,
  ]);

  // The deny list is a plain key-name list, nothing more.
  const denyList = readFileSync(join(ROOT, "core/store/restricted-key-denylist.ts"), "utf8");
  assert.equal(denyList.split("\n").length < 40, true, "the deny list stays a short module");
  assert.equal(/new RegExp|exec\(|matchAll/.test(denyList), false, "no regex engine over values");
});

test("M1B1-AC26: no backend-specific vocabulary entered Core", () => {
  const forbidden: RegExp[] = [
    new RegExp(fragment("open", "claw"), "i"),
    new RegExp(fragment("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(`\\b${fragment("a", "cp")}\\b`, "i"),
    new RegExp(`\\b${fragment("a", "gy")}\\b`, "i"),
    new RegExp(fragment("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(fragment("sl", "ack"), "i"),
    new RegExp(fragment("READY", "_ITEM")),
    new RegExp(fragment("PROJECT", "_STATUS")),
    // committed_via must stay a generic provenance string, not a backend enum.
    new RegExp(fragment("DURABLE", "_JOBS", "_AUDIT_DECIDE")),
    new RegExp(fragment("OPEN", "CLAW", "_AUDIT")),
    new RegExp(fragment("A", "CP", "_GATE")),
  ];
  for (const file of BATCH_SOURCES) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }
});

test("M1B1-AC19 / AC22: no generation, version or single-audit constraint was introduced", () => {
  const v3 = readFileSync(join(ROOT, "core/store/migrations.ts"), "utf8");
  const section = v3.slice(v3.indexOf("const MIGRATION_V3"));
  for (const forbidden of [
    "generation",
    "superseded_by",
    "current_flag",
    "evidence_set",
    "UNIQUE (attempt_key)",
    "UNIQUE(attempt_key)",
  ]) {
    assert.equal(section.includes(forbidden), false, `v3 declares ${forbidden}`);
  }
  // Evidence and audit rows carry no version concept in the Core types either.
  scan(STORE_ONLY, "a version concept", [/\bgeneration\b/, /supersede/i, /\bcurrentFlag\b/]);
});
