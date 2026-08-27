/**
 * B6-AC1 ~ B6-AC8 — TaskSourceV1 surface, TaskDefinitionBodyV1 and hash identity (TD §8.1, §8.1a).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TaskSourceError } from "../core/tasksource/errors.ts";
import {
  hashTaskDefinitionBody,
  normalizeTaskDefinition,
  normalizeTaskDefinitionBody,
} from "../core/tasksource/task-definition.ts";
import {
  DEPENDENCY_KINDS,
  EXTERNAL_TASK_STATES,
  TASK_DEFINITION_BODY_FIELDS,
} from "../core/tasksource/types.ts";
import type { TaskDiscoveryContextV1, TaskSourceV1 } from "../core/tasksource/types.ts";
import { hashEnvelope, makeEnvelope } from "../core/schemas/envelope.ts";
import { isDigest } from "../core/schemas/digest.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: "Collector script cleanup",
  description: "Free-form description text.",
  references: ["docs/DESIGN.md#collector"],
  acceptance_notes: ["Existing output remains byte-identical."],
  ...overrides,
});

const rejects = (input: unknown, reason = "DEFINITION_INVALID"): void => {
  assert.throws(
    () => normalizeTaskDefinitionBody(input),
    (error: unknown) => error instanceof TaskSourceError && error.reason === reason,
  );
};

// --- B6-AC1 / B6-AC2 / B6-AC4 surface ---------------------------------------------

test("B6-AC1: TaskSourceV1 declares exactly four read operations and no projection", () => {
  const source = readFileSync(join(ROOT, "core/tasksource/types.ts"), "utf8");
  const block = source.slice(source.indexOf("export interface TaskSourceV1 {"));
  const methods = [...block.slice(0, block.indexOf("\n}")).matchAll(/^\s{2}([a-z_]+)\(/gm)].map(
    (match) => match[1] as string,
  );

  assert.deepEqual(methods, ["discover_tasks", "get_task", "get_dependencies", "get_task_state"]);
  // Judge declarations, not the prose that explains why projection is absent.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.equal(code.includes("update_task_projection"), false);

  // A structurally complete implementation needs exactly those four members.
  const implementation: TaskSourceV1 = {
    discover_tasks: () => [],
    get_task: () => {
      throw new Error("unused");
    },
    get_dependencies: () => [],
    get_task_state: () => "UNKNOWN",
  };
  assert.deepEqual(Object.keys(implementation).sort(), [
    "discover_tasks",
    "get_dependencies",
    "get_task",
    "get_task_state",
  ]);
});

test("B6-AC2: TaskDiscoveryContextV1 has exactly one field", () => {
  const context: TaskDiscoveryContextV1 = { observed_at: "t1" };
  assert.deepEqual(Object.keys(context), ["observed_at"]);

  const source = readFileSync(join(ROOT, "core/tasksource/types.ts"), "utf8");
  const block = source.slice(
    source.indexOf("export interface TaskDiscoveryContextV1 {"),
  );
  const fields = [...block.slice(0, block.indexOf("\n}")).matchAll(/readonly (\w+):/g)];
  assert.equal(fields.length, 1);
});

test("B6-AC4: generic vocabularies are exact", () => {
  assert.deepEqual(
    [...EXTERNAL_TASK_STATES],
    ["TODO", "READY", "IN_PROGRESS", "BLOCKED", "CLOSED", "UNKNOWN"],
  );
  assert.deepEqual([...DEPENDENCY_KINDS], ["HARD", "SOFT"]);
});

// --- B6-AC5 body ------------------------------------------------------------------

test("B6-AC5: a valid body normalizes to exactly four fields", () => {
  const normalized = normalizeTaskDefinitionBody(body());
  assert.deepEqual(Object.keys(normalized).sort(), [...TASK_DEFINITION_BODY_FIELDS].sort());
});

test("B6-AC5: empty description and empty lists are allowed; empty title is not", () => {
  const normalized = normalizeTaskDefinitionBody(
    body({ description: "", references: [], acceptance_notes: [] }),
  );
  assert.equal(normalized.description, "");
  assert.deepEqual(normalized.references, []);
  assert.deepEqual(normalized.acceptance_notes, []);

  rejects(body({ title: "" }));
  rejects(body({ description: 1 }));
  rejects(body({ references: ["ok", ""] }));
  rejects(body({ acceptance_notes: [1] }));
  rejects(body({ references: "not-an-array" }));
});

test("B6-AC5: missing and unknown body fields are rejected", () => {
  for (const field of TASK_DEFINITION_BODY_FIELDS) {
    const partial = body();
    delete partial[field];
    rejects(partial);
  }
  rejects(body({ priority: "high" }));
});

test("B6-AC5: arrays keep order and duplicates", () => {
  const normalized = normalizeTaskDefinitionBody(
    body({ references: ["z", "a", "z"], acceptance_notes: ["b", "a"] }),
  );
  assert.deepEqual(normalized.references, ["z", "a", "z"]);
  assert.deepEqual(normalized.acceptance_notes, ["b", "a"]);
});

// --- B6-AC6 / B6-AC7 hash identity -------------------------------------------------

test("B6-AC6: the definition hash is the platform/task-definition v1 envelope hash of the body", () => {
  const normalized = normalizeTaskDefinitionBody(body());
  const hash = hashTaskDefinitionBody(normalized);

  assert.ok(isDigest(hash));
  assert.equal(
    hash,
    hashEnvelope(makeEnvelope("platform/task-definition", 1, normalized as unknown as CanonicalObject)),
  );
});

test("B6-AC7: task_ref and version are outside the definition hash", () => {
  const base = normalizeTaskDefinition({ task_ref: "T-101", version: "1", body: body() });
  const otherRef = normalizeTaskDefinition({ task_ref: "epic:42:item:7", version: "1", body: body() });
  const otherVersion = normalizeTaskDefinition({ task_ref: "T-101", version: "9-b", body: body() });
  const otherBody = normalizeTaskDefinition({
    task_ref: "T-101",
    version: "1",
    body: body({ title: "Different" }),
  });

  assert.equal(base.definition_hash, otherRef.definition_hash);
  assert.equal(base.definition_hash, otherVersion.definition_hash);
  assert.notEqual(base.definition_hash, otherBody.definition_hash);
  assert.equal(otherRef.task_ref, "epic:42:item:7", "':' stays intact in the ref");
});

test("B6-AC8: an adapter-supplied hash is recomputed and must match exactly", () => {
  const computed = hashTaskDefinitionBody(normalizeTaskDefinitionBody(body()));

  const accepted = normalizeTaskDefinition({
    task_ref: "T-101",
    version: "1",
    definition_hash: computed,
    body: body(),
  });
  assert.equal(accepted.definition_hash, computed);

  assert.throws(
    () =>
      normalizeTaskDefinition({
        task_ref: "T-101",
        version: "1",
        definition_hash: `sha256:${"0".repeat(64)}`,
        body: body(),
      }),
    (error: unknown) =>
      error instanceof TaskSourceError && error.reason === "DEFINITION_HASH_MISMATCH",
  );
});

test("B6-AC8: task_ref and version must be non-empty strings", () => {
  const fails = (raw: { task_ref: unknown; version: unknown }): void => {
    assert.throws(
      () =>
        normalizeTaskDefinition({
          task_ref: raw.task_ref as string,
          version: raw.version as string,
          body: body(),
        }),
      (error: unknown) => error instanceof TaskSourceError && error.reason === "DEFINITION_INVALID",
    );
  };
  fails({ task_ref: "", version: "1" });
  fails({ task_ref: "T-101", version: "" });
  fails({ task_ref: 1, version: "1" });
});
