/**
 * B5-M1 ~ B5-M8, B5-P1 ~ B5-P6, B5-D1 ~ B5-D6 — the M1-6/M1-7 contract corrections: migrations
 * v4/v5, the Project Profile's `repository_scopes`, and the Proposal's `repository_scope_id`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileProfile } from "../core/profile/compiler.ts";
import { validateProjectProfile } from "../core/profile/validate-project-profile.ts";
import { PROJECT_PROFILE_TOP_LEVEL } from "../core/profile/types.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import { validateDecision } from "../core/decision/validator.ts";
import { openDatabase } from "../core/store/database.ts";
import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";
import { PlatformStore } from "../core/store/platform-store.ts";
import { tempStore } from "./support/temp-store.ts";
import {
  batchView,
  compiled,
  executionPolicy,
  found,
  manifests,
  projectProfile,
  selection,
  taskControl,
  HEAD,
} from "./support/decision-fixtures.ts";

const columns = (path: string, table: string): string[] => {
  const database = openDatabase(path);
  try {
    return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    database.close();
  }
};

const tables = (path: string): string[] => {
  const database = openDatabase(path);
  try {
    return (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_"));
  } finally {
    database.close();
  }
};

// --- migrations ---------------------------------------------------------------------------

test("B5-M1 / B5-M4 ~ B5-M8: a fresh database reaches v6 with the two nullable columns", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.schemaVersion, 6, "B5-M4");
    assert.equal(MIGRATIONS.length, 6);
  } finally {
    store.close();
  }
  try {
    assert.equal(tables(temp.path).length, 17, "B5-M5");
    const task = columns(temp.path, "task");
    assert.equal(task.includes("repository_scope_id"), true, "B5-M6");
    assert.equal(task.includes("selection_binding_json"), true, "B5-M7");

    // B5-M8 — v4 and v5 add columns only; the table set is exactly what v1–v3 created.
    for (const [index] of [4, 5].entries()) {
      const migration = MIGRATIONS[index + 3] as Migration;
      assert.equal(/CREATE TABLE/.test(migration.statements), false, `${migration.name} adds a table`);
      assert.match(migration.statements, /ALTER TABLE task ADD COLUMN/);
    }
    assert.deepEqual(
      MIGRATIONS.slice(3).map((migration) => migration.name),
      ["selection-scope", "selection-binding", "audit-decision-category"],
    );
    // M1-13 — v6 rebuilds one table to widen a CHECK vocabulary; the table set is unchanged.
    const v6 = MIGRATIONS[5] as Migration;
    assert.match(v6.statements, /DROP TABLE pending_human_decision/);
    assert.match(v6.statements, /RENAME TO pending_human_decision/);
    assert.equal(tables(temp.path).length, 17);

    // Both columns are nullable — a DISCOVERED task legitimately has neither (§18.1e).
    const database = openDatabase(temp.path);
    try {
      const info = database.prepare("PRAGMA table_info(task)").all() as {
        name: string;
        notnull: number;
      }[];
      for (const name of ["repository_scope_id", "selection_binding_json"]) {
        assert.equal(info.find((row) => row.name === name)?.notnull, 0, `${name} must be nullable`);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }
});

test("B5-M2 / B5-M3: v3 upgrades through v4/v5 to v6, and reopening applies nothing twice", () => {
  const temp = tempStore();

  // A database that only ever saw v1–v3, exactly as MVP1-B4 left it.
  const old = temp.open({ migrations: MIGRATIONS.slice(0, 3) });
  assert.equal(old.schemaVersion, 3);
  assert.equal(columns(temp.path, "task").includes("repository_scope_id"), false);
  old.close();

  // v3 → v4 → v5.
  const upgraded = temp.open();
  assert.equal(upgraded.schemaVersion, 6);
  upgraded.close();

  // v4 → v5 alone.
  const temp4 = tempStore();
  const atFour = temp4.open({ migrations: MIGRATIONS.slice(0, 4) });
  assert.equal(atFour.schemaVersion, 4);
  atFour.close();
  const toLatest = temp4.open();
  assert.equal(toLatest.schemaVersion, 6, "B5-M2");
  toLatest.close();

  try {
    // B5-M3 — reopening a migrated database is a no-op and never duplicates a column.
    for (const path of [temp, temp4]) {
      const reopened = path.open();
      assert.equal(reopened.schemaVersion, 6);
      reopened.close();
      const task = columns(path.path, "task");
      assert.equal(task.filter((name) => name === "repository_scope_id").length, 1);
      assert.equal(task.filter((name) => name === "selection_binding_json").length, 1);
      assert.equal(tables(path.path).length, 17);
    }
  } finally {
    temp.dispose();
    temp4.dispose();
  }
});

test("B5-M8: the applied v1/v2/v3 bodies are untouched by this batch", () => {
  const v3 = MIGRATIONS.slice(0, 3);
  assert.deepEqual(
    v3.map((migration) => migration.name),
    ["foundation", "domain", "mvp1-artifacts"],
  );
  for (const migration of v3) {
    assert.equal(/repository_scope_id|selection_binding_json/.test(migration.statements), false);
  }
});

// --- Project Profile ------------------------------------------------------------------------

test("B5-P1 ~ B5-P3 / B5-P5: repository_scopes is required, exact, and never defaulted", () => {
  assert.equal(PROJECT_PROFILE_TOP_LEVEL.includes("repository_scopes"), true);
  assert.equal(PROJECT_PROFILE_TOP_LEVEL.length, 11);

  const withoutScopes = projectProfile();
  delete (withoutScopes as Record<string, unknown>)["repository_scopes"];
  assert.throws(() => validateProjectProfile(withoutScopes), /repository_scopes/, "B5-P1");

  // B5-P2 / B5-P5 — an empty map is a compile failure, not "everything is allowed".
  assert.throws(() => validateProjectProfile(projectProfile({ repository_scopes: {} })));

  for (const broken of [
    { collector: { allowed_paths: ["src"] } },
    { collector: { allowed_paths: ["src"], forbidden_paths: [], extra: 1 } },
    { collector: { allowed_paths: "src", forbidden_paths: [] } },
    { collector: { allowed_paths: [""], forbidden_paths: [] } },
    { "": { allowed_paths: ["src"], forbidden_paths: [] } },
  ]) {
    assert.throws(
      () => validateProjectProfile(projectProfile({ repository_scopes: broken })),
      "B5-P3",
    );
  }

  // No hidden fallback anywhere: the validator never invents a scope.
  const validated = validateProjectProfile(projectProfile());
  assert.deepEqual(Object.keys(validated.repository_scopes).sort(), ["collector", "docs_only"]);
  assert.equal(JSON.stringify(validated.repository_scopes).includes('"**"'), false);
  assert.equal(JSON.stringify(validated.repository_scopes).includes('"."'), false);
});

test("B5-P4 / B5-P6: scope arrays are order-sensitive and ride the compiled hash", () => {
  const base = compileProfile({
    projectProfile: projectProfile(),
    executionPolicy: executionPolicy(),
    approvedOverrides: { items: [] },
  });

  // B5-P6 — the compiled profile carries the declared scopes verbatim.
  assert.deepEqual(base.body.effective.project.repository_scopes, {
    collector: { allowed_paths: ["src", "docs"], forbidden_paths: ["src/vendor"] },
    docs_only: { allowed_paths: ["docs"], forbidden_paths: [] },
  });

  // B5-P4 — reordering a generic array is a different Profile, so a different hash.
  const reordered = compileProfile({
    projectProfile: projectProfile({
      repository_scopes: {
        collector: { allowed_paths: ["docs", "src"], forbidden_paths: ["src/vendor"] },
        docs_only: { allowed_paths: ["docs"], forbidden_paths: [] },
      },
    }),
    executionPolicy: executionPolicy(),
    approvedOverrides: { items: [] },
  });
  assert.notEqual(reordered.compiled_hash, base.compiled_hash);
});

// --- Proposal and V6 ------------------------------------------------------------------------

test("B5-D1 ~ B5-D3 / B5-D6: only selection variants carry a scope id, and never a path body", () => {
  const profile = compiled();

  for (const decision of ["START_TASK", "START_SUBFLOW"] as const) {
    const proposal = selection({ profile, decision });
    assert.equal(validateProposal(proposal).variant, "TASK_SELECTION");

    const missing = { ...proposal };
    delete (missing as Record<string, unknown>)["repository_scope_id"];
    assert.throws(() => validateProposal(missing), /repository_scope_id/, `B5-D1/${decision}`);
    assert.throws(() => validateProposal({ ...proposal, repository_scope_id: "" }));
  }

  // B5-D3 — a control variant that names a scope is rejected as an unknown field.
  assert.throws(() =>
    validateProposal({ ...taskControl({ profile }), repository_scope_id: "collector" }),
  );

  // B5-D6 — the Model cannot express a path body at all: those keys are simply unknown.
  for (const smuggled of [
    { allowed_paths: ["/"] },
    { forbidden_paths: [] },
    { repository_scope: { allowed_paths: ["/"], forbidden_paths: [] } },
  ]) {
    assert.throws(() => validateProposal({ ...selection({ profile }), ...smuggled }));
  }
  const parsed = validateProposal(selection({ profile }));
  assert.equal("allowed_paths" in parsed, false);
  assert.equal(parsed.variant, "TASK_SELECTION");
  if (parsed.variant === "TASK_SELECTION") {
    assert.equal(typeof parsed.repository_scope_id, "string");
  }
});

test("B5-D4 / B5-D5: V6 validates the scope reference against the compiled profile", () => {
  const profile = compiled();
  const input = (repository_scope_id: string) => ({
    proposal: selection({ profile, repository_scope_id }),
    compiled_profile: profile.body,
    compiled_profile_hash: profile.compiled_hash,
    task: found(),
    repository: { canonical_head: HEAD },
    manifests: manifests(),
    batch: batchView(),
  });

  assert.deepEqual(validateDecision(input("collector")), { kind: "ACCEPTED" }, "B5-D4");
  assert.deepEqual(validateDecision(input("docs_only")), { kind: "ACCEPTED" });
  assert.deepEqual(validateDecision(input("not-declared")), {
    kind: "POLICY_REJECTED",
    reason_code: "PROFILE_REFERENCE_UNKNOWN",
  });
});

test("B5-M4: PlatformStore reports the migrated version on a real file", () => {
  const temp = tempStore();
  const store = PlatformStore.open(temp.path);
  try {
    assert.equal(store.schemaVersion, 6);
  } finally {
    store.close();
    temp.dispose();
  }
});
