/**
 * B6-AC9 ~ B6-AC17 — markdown-sections-v1 grammar, adapter config, multi-path semantics and
 * projections (TD §8.2).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TaskSourceError } from "../core/tasksource/errors.ts";
import {
  ProjectDocumentTaskSource,
  validateProjectDocumentConfig,
} from "../core/tasksource/project-document-task-source.ts";
import { hashTaskDefinitionBody } from "../core/tasksource/task-definition.ts";
import { readerFor, taskBlock } from "./support/task-fixtures.ts";

const CONTEXT = { observed_at: "2026-01-01T00:00:00.000Z" };

const sourceFor = (documents: Readonly<Record<string, string>>): ProjectDocumentTaskSource =>
  new ProjectDocumentTaskSource(
    { paths: Object.keys(documents), parser: "markdown-sections-v1" },
    readerFor(documents),
  );

const failsWith = (reason: string, run: () => unknown): void => {
  assert.throws(
    run,
    (error: unknown) => error instanceof TaskSourceError && error.reason === reason,
  );
};

// --- B6-AC9 config -----------------------------------------------------------------

test("B6-AC9: adapter config is exactly { paths, parser }", () => {
  const config = validateProjectDocumentConfig({
    paths: ["a.md", "b.md"],
    parser: "markdown-sections-v1",
  });
  assert.deepEqual(config.paths, ["a.md", "b.md"], "input order preserved");

  const bad = (input: unknown): void => failsWith("CONFIG_INVALID", () => validateProjectDocumentConfig(input));
  bad({ paths: ["a.md"] });
  bad({ parser: "markdown-sections-v1" });
  bad({ paths: ["a.md"], parser: "markdown-sections-v1", ready_marker: "READY" });
  bad({ paths: [], parser: "markdown-sections-v1" });
  bad({ paths: ["a.md", "a.md"], parser: "markdown-sections-v1" });
  bad({ paths: [""], parser: "markdown-sections-v1" });
  bad({ paths: ["a.md"], parser: "gfm-checklist-v1" });
});

// --- B6-AC10 grammar ---------------------------------------------------------------

test("B6-AC10: a valid task parses into all projections", () => {
  const source = sourceFor({ "plan.md": taskBlock() });

  const [candidate] = source.discover_tasks(CONTEXT);
  assert.equal(candidate?.task_ref, "T-101");
  assert.equal(candidate?.title, "Collector script cleanup");
  assert.equal(candidate?.external_state, "READY");
  assert.equal(candidate?.summary, "Free-form description text.");
  assert.equal(candidate?.discovered_at, CONTEXT.observed_at);

  const definition = source.get_task("T-101");
  assert.equal(definition.version, "1");
  assert.deepEqual(definition.body.references, ["docs/DESIGN.md#collector"]);
  assert.deepEqual(definition.body.acceptance_notes, [
    "Existing output remains byte-identical.",
    "No new warnings.",
  ]);
  assert.equal(definition.definition_hash, hashTaskDefinitionBody(definition.body));

  assert.deepEqual(source.get_dependencies("T-101"), [
    { task_ref: "T-101", depends_on_ref: "T-100", kind: "HARD" },
  ]);
  assert.equal(source.get_task_state("T-101"), "READY");
});

test("B6-AC11: all six external states parse; an unknown token fails", () => {
  for (const state of ["TODO", "READY", "IN_PROGRESS", "BLOCKED", "CLOSED", "UNKNOWN"]) {
    const source = sourceFor({ "plan.md": taskBlock({ state }) });
    assert.equal(source.get_task_state("T-101"), state);
  }
  failsWith("DOCUMENT_MALFORMED", () =>
    sourceFor({ "plan.md": taskBlock({ state: "DONE" }) }).discover_tasks(CONTEXT),
  );
  failsWith("DOCUMENT_MALFORMED", () =>
    sourceFor({ "plan.md": taskBlock({ state: "ready" }) }).discover_tasks(CONTEXT),
  );
});

test("B6-AC12: ':' survives in task refs and dependency refs", () => {
  const source = sourceFor({
    "plan.md": taskBlock({ ref: "epic:42:item:7", dependencies: ["- HARD: other:9:x"] }),
  });

  assert.equal(source.discover_tasks(CONTEXT)[0]?.task_ref, "epic:42:item:7");
  assert.deepEqual(source.get_dependencies("epic:42:item:7"), [
    { task_ref: "epic:42:item:7", depends_on_ref: "other:9:x", kind: "HARD" },
  ]);
});

test("B6-AC10: metadata must be present, unique and ordered", () => {
  const swapped = ["## Task", "version: 1", "task-ref: T-101", "state: READY", "title: T", "", "### Description", "", "### Dependencies", "", "### References", "", "### Acceptance", ""].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": swapped }).discover_tasks(CONTEXT));

  const duplicated = ["## Task", "task-ref: T-101", "task-ref: T-102", "version: 1", "state: READY", "title: T", "", "### Description", "", "### Dependencies", "", "### References", "", "### Acceptance", ""].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": duplicated }).discover_tasks(CONTEXT));

  const missing = ["## Task", "task-ref: T-101", "state: READY", "title: T", "", "### Description", "", "### Dependencies", "", "### References", "", "### Acceptance", ""].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": missing }).discover_tasks(CONTEXT));

  const emptyValue = ["## Task", "task-ref:", "version: 1", "state: READY", "title: T", "", "### Description", "", "### Dependencies", "", "### References", "", "### Acceptance", ""].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": emptyValue }).discover_tasks(CONTEXT));
});

test("B6-AC10: every subsection heading is required and ordered", () => {
  const noAcceptance = ["## Task", "task-ref: T-101", "version: 1", "state: READY", "title: T", "", "### Description", "", "### Dependencies", "", "### References", ""].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": noAcceptance }).discover_tasks(CONTEXT));

  const reordered = ["## Task", "task-ref: T-101", "version: 1", "state: READY", "title: T", "", "### Dependencies", "", "### Description", "", "### References", "", "### Acceptance", ""].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": reordered }).discover_tasks(CONTEXT));
});

test("B6-AC10: empty sections are allowed", () => {
  const source = sourceFor({
    "plan.md": taskBlock({ description: "", dependencies: [], references: [], acceptance: [] }),
  });

  const definition = source.get_task("T-101");
  assert.equal(definition.body.description, "");
  assert.deepEqual(definition.body.references, []);
  assert.deepEqual(definition.body.acceptance_notes, []);
  assert.deepEqual(source.get_dependencies("T-101"), []);
  // Empty description falls back to the title for the summary.
  assert.equal(source.discover_tasks(CONTEXT)[0]?.summary, "Collector script cleanup");
});

test("B6-AC10: description preserves line order and newlines; summary is the first non-empty line", () => {
  const description = ["", "   ", "first meaningful line", "second line", ""].join("\n");
  const source = sourceFor({ "plan.md": taskBlock({ description }) });

  assert.equal(source.get_task("T-101").body.description, "first meaningful line\nsecond line");
  assert.equal(source.discover_tasks(CONTEXT)[0]?.summary, "first meaningful line");
});

test("B6-AC10: malformed list items fail closed", () => {
  failsWith("DOCUMENT_MALFORMED", () =>
    sourceFor({ "plan.md": taskBlock({ dependencies: ["- MAYBE: T-100"] }) }).discover_tasks(CONTEXT),
  );
  failsWith("DOCUMENT_MALFORMED", () =>
    sourceFor({ "plan.md": taskBlock({ dependencies: ["- HARD:"] }) }).discover_tasks(CONTEXT),
  );
  failsWith("DOCUMENT_MALFORMED", () =>
    sourceFor({ "plan.md": taskBlock({ references: ["not a list item"] }) }).discover_tasks(CONTEXT),
  );
});

// --- B6-AC16 free prose ------------------------------------------------------------

test("B6-AC10: prose before a task block is ignored; prose inside a block is a violation", () => {
  // A block runs from `## Task` to the next `## Task` or EOF, so narrative belongs before the
  // first block; anything structurally unexpected inside one fails closed.
  const withProse = ["# Plan", "", "Some narrative paragraph.", "", taskBlock()].join("\n");
  assert.equal(sourceFor({ "plan.md": withProse }).discover_tasks(CONTEXT).length, 1);

  const insideBlock = ["## Task", "task-ref: T-101", "stray prose", "version: 1", "state: READY", "title: T", "", "### Description", "", "### Dependencies", "", "### References", "", "### Acceptance", ""].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": insideBlock }).discover_tasks(CONTEXT));

  const trailingProse = [taskBlock(), "Closing note."].join("\n");
  failsWith("DOCUMENT_MALFORMED", () => sourceFor({ "plan.md": trailingProse }).discover_tasks(CONTEXT));
});

// --- B6-AC13 / B6-AC14 / B6-AC15 multi-path ---------------------------------------

test("B6-AC13: discovery order is path order then document order", () => {
  const first = [taskBlock({ ref: "T-1" }), taskBlock({ ref: "T-2" })].join("\n");
  const second = taskBlock({ ref: "T-3" });
  const source = new ProjectDocumentTaskSource(
    { paths: ["b.md", "a.md"], parser: "markdown-sections-v1" },
    readerFor({ "a.md": second, "b.md": first }),
  );

  assert.deepEqual(
    source.discover_tasks(CONTEXT).map((candidate) => candidate.task_ref),
    ["T-1", "T-2", "T-3"],
  );
});

test("B6-AC14: a duplicate task_ref fails closed, in one file or across files", () => {
  const sameFile = [taskBlock({ ref: "T-1" }), taskBlock({ ref: "T-1" })].join("\n");
  failsWith("DUPLICATE_TASK_REF", () => sourceFor({ "plan.md": sameFile }).discover_tasks(CONTEXT));

  failsWith("DUPLICATE_TASK_REF", () =>
    sourceFor({ "a.md": taskBlock({ ref: "T-1" }), "b.md": taskBlock({ ref: "T-1" }) }).discover_tasks(
      CONTEXT,
    ),
  );
});

test("B6-AC15: an unreadable path or one malformed file yields no partial result", () => {
  const missingPath = new ProjectDocumentTaskSource(
    { paths: ["present.md", "absent.md"], parser: "markdown-sections-v1" },
    readerFor({ "present.md": taskBlock() }),
  );
  failsWith("DOCUMENT_UNREADABLE", () => missingPath.discover_tasks(CONTEXT));

  const oneBad = sourceFor({
    "a.md": taskBlock({ ref: "T-1" }),
    "b.md": taskBlock({ ref: "T-2", state: "NOPE" }),
  });
  failsWith("DOCUMENT_MALFORMED", () => oneBad.discover_tasks(CONTEXT));
});

test("B6-AC3: every candidate of one call uses context.observed_at, with no clock or mtime", () => {
  const source = sourceFor({
    "plan.md": [taskBlock({ ref: "T-1" }), taskBlock({ ref: "T-2" })].join("\n"),
  });
  const candidates = source.discover_tasks({ observed_at: "t-fixed" });

  assert.deepEqual(
    candidates.map((candidate) => candidate.discovered_at),
    ["t-fixed", "t-fixed"],
  );
  // A different observation time changes only that field.
  const later = source.discover_tasks({ observed_at: "t-later" });
  assert.equal(later[0]?.discovered_at, "t-later");
  assert.equal(later[0]?.task_ref, candidates[0]?.task_ref);
});

// --- B6-AC17 cross-method consistency ---------------------------------------------

test("B6-AC17: all four methods agree and hold no durable state", () => {
  const documents: Record<string, string> = {
    "plan.md": taskBlock({ ref: "T-1", state: "BLOCKED", dependencies: ["- SOFT: T-0"] }),
  };
  const source = new ProjectDocumentTaskSource(
    { paths: ["plan.md"], parser: "markdown-sections-v1" },
    readerFor(documents),
  );

  assert.equal(source.discover_tasks(CONTEXT)[0]?.external_state, "BLOCKED");
  assert.equal(source.get_task_state("T-1"), "BLOCKED");
  assert.equal(source.get_task("T-1").task_ref, "T-1");
  assert.deepEqual(source.get_dependencies("T-1"), [
    { task_ref: "T-1", depends_on_ref: "T-0", kind: "SOFT" },
  ]);

  failsWith("TASK_NOT_FOUND", () => source.get_task("T-999"));
  failsWith("TASK_NOT_FOUND", () => source.get_task_state("T-999"));
  failsWith("TASK_NOT_FOUND", () => source.get_dependencies("T-999"));
});

test("B6-AC16: the adapter exposes no projection capability", () => {
  const source = sourceFor({ "plan.md": taskBlock() });
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(source) as object).filter(
    (name) => name !== "constructor",
  );

  assert.deepEqual(surface.sort(), [
    "discover_tasks",
    "get_dependencies",
    "get_task",
    "get_task_state",
  ]);
  assert.equal(surface.some((name) => /projection|update|write/i.test(name)), false);
});
