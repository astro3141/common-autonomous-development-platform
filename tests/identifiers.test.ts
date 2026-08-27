/**
 * B1-AC7 + ID-1…ID-7 — generic identifiers follow the TD §6.1 namespace form, compose
 * injectively under the D+ positional rule, carry no backend-native reference, and introduce
 * no codec or surrogate identity.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { attemptKey, batchId, opKey, runId, taskKey } from "../core/schemas/identifiers.ts";
import { IdentifierError } from "../core/schemas/errors.ts";

const ULID = "01JQ8ZK5T7RC9V2W4X6Y8Z0ABC";

// --- B1-AC7: namespace form, determinism, no backend reference --------------------

test("B1-AC7: identifiers use the TD §6.1 namespace form", () => {
  const run = runId(ULID);
  const batch = batchId(run, 0);
  const task = taskKey("alpha", "item-7");
  const attempt = attemptKey(task, 1);

  assert.equal(run, `run:${ULID}`);
  assert.equal(batch, `batch:run:${ULID}:0`);
  assert.equal(task, "task:alpha:item-7");
  assert.equal(attempt, "attempt:task:alpha:item-7:1");
  assert.equal(opKey(attempt, "start"), "op:attempt:task:alpha:item-7:1:start");
  assert.equal(opKey(attempt, "notify", "second"), "op:attempt:task:alpha:item-7:1:notify:second");
  assert.equal(opKey(batch, "close"), `op:batch:run:${ULID}:0:close`);
});

test("B1-AC7: constructors take no backend-native reference and generate no identity", () => {
  // Arity is part of the contract: no constructor accepts a workflow id, PR number,
  // session handle or any other backend reference, and none reads a clock or RNG.
  assert.equal(runId.length, 1); // caller-supplied ULID
  assert.equal(batchId.length, 2);
  assert.equal(taskKey.length, 2);
  assert.equal(attemptKey.length, 2);
  assert.equal(opKey.length, 3); // scope, operation, optional qualifier
});

test("B1-AC7: structural grammar violations are rejected instead of being coerced", () => {
  const cases: ReadonlyArray<() => string> = [
    () => runId("not-a-ulid"),
    () => runId(ULID.toLowerCase()),
    () => runId(`${ULID}X`),
    () => runId("01JQ8ZK5T7RC9V2W4X6Y8Z0ABI"), // I is not in Crockford base32
    () => batchId(ULID, 0), // missing run: namespace
    () => batchId(runId(ULID), -1),
    () => batchId(runId(ULID), 1.5),
    () => attemptKey("alpha:item-7", 1), // not a task_key
    () => attemptKey(taskKey("alpha", "item-7"), -1),
    () => opKey("task:alpha:item-7", "start"), // scope must be attempt_key or batch_id
  ];
  for (const [index, run] of cases.entries()) {
    assert.throws(run, IdentifierError, `case ${index} should have been rejected`);
  }
});

// --- ID-1: opaque ref preservation ------------------------------------------------

test("ID-1: adapter-scoped opaque external_task_ref is accepted verbatim, including ':'", () => {
  const opaqueRefs = ["item:7", "docs/plan.md:L42", "provider:project:item"];
  for (const ref of opaqueRefs) {
    const key = taskKey("alpha", ref);
    assert.equal(key, `task:alpha:${ref}`);
    // Core stores the ref unchanged: no escaping, no normalization, no interpretation.
    assert.equal(key.slice("task:alpha:".length), ref);
  }
});

test("ID-1: Core imposes no charset on the opaque ref", () => {
  for (const ref of ["", " spaced ref ", "ref\nwith\nnewlines", "한글-참조", "a:b:c:d:e"]) {
    assert.equal(taskKey("alpha", ref), `task:alpha:${ref}`);
  }
});

// --- ID-2: task_key injectivity ---------------------------------------------------

test("ID-2: distinct (project_id, external_task_ref) tuples yield distinct task keys", () => {
  const tuples: ReadonlyArray<readonly [string, string]> = [
    ["a", "b:c"],
    ["a-b", "c"],
    ["a", "b-c"],
    ["a", ":b:c"],
    ["a", ""],
    ["", "a"],
  ];
  const keys = tuples.map(([projectId, ref]) => taskKey(projectId, ref));
  assert.equal(new Set(keys).size, tuples.length, `collision among ${JSON.stringify(keys)}`);
});

test("ID-2: the former collision pair is resolved by project_id grammar, not by ref restriction", () => {
  // project_id is a Core/Profile-owned structural segment → ':' is rejected there.
  assert.throws(() => taskKey("a:b", "c"), IdentifierError);
  // The opaque ref keeps its ':' and composes normally.
  assert.equal(taskKey("a", "b:c"), "task:a:b:c");
});

// --- ID-3: nested attempt injectivity ---------------------------------------------

test("ID-3: distinct (task_key, attempt_n) tuples yield distinct attempt keys", () => {
  const tuples: ReadonlyArray<readonly [string, number]> = [
    [taskKey("a", "r"), 1],
    [taskKey("a", "r:1"), 1],
    [taskKey("a", "r:1"), 2],
    [taskKey("a", "r"), 11],
    [taskKey("a", "r:1:2"), 3],
    [taskKey("a", "r:11"), 1],
  ];
  const keys = tuples.map(([task, n]) => attemptKey(task, n));
  assert.equal(new Set(keys).size, tuples.length, `collision among ${JSON.stringify(keys)}`);
});

test("ID-3: a decimal-looking suffix in the opaque ref does not merge with the ordinal", () => {
  // ref="r:1" with n=2 must not equal ref="r" with n=1 followed by anything.
  assert.equal(attemptKey(taskKey("a", "r:1"), 2), "attempt:task:a:r:1:2");
  assert.equal(attemptKey(taskKey("a", "r"), 1), "attempt:task:a:r:1");
  assert.notEqual(attemptKey(taskKey("a", "r:1"), 2), attemptKey(taskKey("a", "r"), 1));
});

// --- ID-4: op_key ambiguity regression --------------------------------------------

test("ID-4: a pure decimal operation is rejected, so the ordinal-absorption collision cannot form", () => {
  const scopeA = attemptKey(taskKey("a", "r:1"), 1); // attempt:task:a:r:1:1
  const scopeB = attemptKey(taskKey("a", "r"), 1); // attempt:task:a:r:1

  // Without the rule, opKey(scopeB, "1", "z") would render the same string as
  // opKey(scopeA, "z") — the decimal operation would be read as the attempt ordinal.
  assert.equal(opKey(scopeA, "z"), "op:attempt:task:a:r:1:1:z");
  assert.throws(() => opKey(scopeB, "1", "z"), IdentifierError);
  assert.throws(() => opKey(scopeB, "2"), IdentifierError);
  assert.throws(() => opKey(scopeB, "007"), IdentifierError);

  // Operations that merely contain digits stay legal.
  assert.equal(opKey(scopeB, "actor-turn", "1"), "op:attempt:task:a:r:1:actor-turn:1");
});

test("ID-4: distinct op tuples over colon-bearing scopes yield distinct op keys", () => {
  const tuples: ReadonlyArray<readonly [string, string, string | undefined]> = [
    [attemptKey(taskKey("a", "r"), 1), "merge", "abc"],
    [attemptKey(taskKey("a", "r"), 1), "merge", undefined],
    [attemptKey(taskKey("a", "r:1"), 1), "merge", "abc"],
    [attemptKey(taskKey("a", "r"), 11), "merge", "abc"],
    [attemptKey(taskKey("a", "r"), 1), "merge-x", "abc"],
    [batchId(runId(ULID), 1), "merge", "abc"],
  ];
  const keys = tuples.map(([scope, operation, qualifier]) => opKey(scope, operation, qualifier));
  assert.equal(new Set(keys).size, tuples.length, `collision among ${JSON.stringify(keys)}`);
});

test("ID-4: an empty operation is rejected", () => {
  assert.throws(() => opKey(attemptKey(taskKey("a", "r"), 1), ""), IdentifierError);
});

// --- ID-5: qualifier structural boundary ------------------------------------------

test("ID-5: a qualifier containing ':' is rejected", () => {
  const scope = attemptKey(taskKey("a", "r"), 1);
  assert.throws(() => opKey(scope, "report-pending", "a:b"), IdentifierError);
  assert.throws(() => opKey(scope, "start:extra"), IdentifierError);
});

test("ID-5: TD op examples decompose into a single operation and a single qualifier", () => {
  const attempt = attemptKey(taskKey("alpha", "item-7"), 1);
  // TD §14.4 G5 / §19.3 / §17.2 (D+ normalized).
  assert.equal(opKey(attempt, "merge", "0f1e2d"), "op:attempt:task:alpha:item-7:1:merge:0f1e2d");
  assert.equal(opKey(attempt, "verify", "0f1e2d"), "op:attempt:task:alpha:item-7:1:verify:0f1e2d");
  assert.equal(opKey(attempt, "actor-turn", "1"), "op:attempt:task:alpha:item-7:1:actor-turn:1");
  assert.equal(opKey(attempt, "contract"), "op:attempt:task:alpha:item-7:1:contract");
  assert.equal(
    opKey(attempt, "report-pending", "d-42"),
    "op:attempt:task:alpha:item-7:1:report-pending:d-42",
  );
});

// --- ID-6: deterministic stability -------------------------------------------------

test("ID-6: the same logical tuple always produces the same identifier", () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(runId(ULID), `run:${ULID}`);
    assert.equal(
      opKey(attemptKey(taskKey("alpha", "docs/plan.md:L42"), 2), "verify", "0f1e2d"),
      "op:attempt:task:alpha:docs/plan.md:L42:2:verify:0f1e2d",
    );
  }
});

// --- ID-7: no codec, no surrogate, no decode framework ------------------------------

test("ID-7: the identifier module introduces no codec, surrogate or decoding framework", () => {
  const modulePath = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    "core/schemas/identifiers.ts",
  );
  // Comments are stripped so the scan judges executable code, not prose about it.
  const source = readFileSync(modulePath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ["percent encoding", /encodeURI|decodeURI|escape\(/],
    ["base64/base32 encoding", /base64|base32|btoa|atob|Buffer\./i],
    ["hash-derived surrogate", /createHash|sha256|digest/i],
    ["random identity", /randomUUID|Math\.random|crypto\./i],
    ["clock-derived identity", /Date\.now|new Date/],
    ["decoding framework", /export function (parse|decode|split|explode)/],
  ];
  for (const [label, pattern] of forbidden) {
    assert.equal(pattern.exec(source), null, `identifiers.ts introduces ${label}`);
  }

  // The module's only dependency is the error type — no crypto, no fs, no encoder.
  const imports = [...source.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["./errors.ts"]);
});
