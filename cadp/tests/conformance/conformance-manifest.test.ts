/**
 * Meta-control for the conformance directory (`manifest.ts`).
 *
 * Conformance tests are NOT authority themselves — they are the EXECUTABLE ASSURANCE PROJECTION of
 * TD authority; they are protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not because
 * changing them "amends the TD"). This file is what makes that protection FALSIFIABLE rather than
 * declarative: without it, a mapped control's test could be deleted, renamed or quietly relocated
 * and nothing would fail. With it, each of those is a deterministic red test.
 *
 * Four claims, each closing a distinct way the projection can be weakened without touching a TD:
 *   MF1  every file a mapping names EXISTS here      — deleting/moving a mapped test breaks the build
 *   MF2  every *.test.ts here is ACCOUNTED FOR       — no stowaways, no silent drops (the directory
 *                                                      is intentional; an unlisted file is a file
 *                                                      nobody decided to protect)
 *   MF3  no mapping is VACUOUS                       — an empty `tests` array is a coverage claim
 *                                                      with nothing behind it
 *   MF4  no *.test.ts under cadp/tests/ lives OUTSIDE the two named leaf dirs — the invocation
 *        contract both verifiers pin is "all test files live directly in cadp/tests/conformance/ or
 *        cadp/tests/ops/", and a file nested deeper would be discovered by NEITHER verifier
 */

import assert from "node:assert/strict";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AUXILIARY_TESTS, CONTROL_MAPPINGS } from "./manifest.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const TESTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const OPS_DIR = join(TESTS_DIR, "ops");

const testFilesIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".test.ts"));

test("MF1: every test file named by a manifest entry exists in cadp/tests/conformance/", () => {
  for (const entry of CONTROL_MAPPINGS) {
    for (const file of entry.tests) {
      assert.ok(
        existsSync(join(CONFORMANCE_DIR, file)),
        `${entry.control} maps ${file}, which is not in cadp/tests/conformance/ — a mapped control lost its executable projection`,
      );
    }
  }
  // The auxiliary list is a protection claim about real files, so it decays the same way.
  for (const aux of AUXILIARY_TESTS) {
    assert.ok(
      existsSync(join(CONFORMANCE_DIR, aux.test)),
      `auxiliary entry ${aux.test} is not in cadp/tests/conformance/`,
    );
  }
});

test("MF2: every *.test.ts in cadp/tests/conformance/ is referenced by a mapping or the auxiliary list", () => {
  const referenced = new Set<string>([
    ...CONTROL_MAPPINGS.flatMap((entry) => entry.tests),
    ...AUXILIARY_TESTS.map((aux) => aux.test),
  ]);
  const present = testFilesIn(CONFORMANCE_DIR);
  assert.ok(present.length > 0, "the conformance directory must not be empty");
  for (const file of present) {
    assert.ok(
      referenced.has(file),
      `${file} sits in cadp/tests/conformance/ but no manifest entry or auxiliary entry names it — protect it deliberately or move it to cadp/tests/ops/`,
    );
  }
  // Symmetric honesty: nothing may be listed that is not a conformance-directory test file.
  for (const file of referenced) {
    assert.ok(file.endsWith(".test.ts"), `manifest references ${file}, which is not a test file`);
    assert.ok(present.includes(file), `manifest references ${file}, which is not present in cadp/tests/conformance/`);
  }
});

test("MF3: no manifest entry claims a control with an empty test list", () => {
  for (const entry of CONTROL_MAPPINGS) {
    assert.ok(entry.control.length > 0, "every entry names a control");
    assert.ok(entry.tests.length > 0, `${entry.control} maps to no test file — a control claimed with nothing executing it`);
  }
  const controls = CONTROL_MAPPINGS.map((entry) => entry.control);
  assert.equal(new Set(controls).size, controls.length, "a control id appears twice — merge its test lists instead");
  const aux = AUXILIARY_TESTS.map((entry) => entry.test);
  assert.equal(new Set(aux).size, aux.length, "an auxiliary test is listed twice");
  for (const entry of AUXILIARY_TESTS) {
    assert.ok(entry.reason.length > 0, `${entry.test} is auxiliary without a stated reason`);
  }
});

test("MF4: no *.test.ts under cadp/tests/ lives outside the two named leaf directories", () => {
  // The invocation contract BOTH verifiers pin (surfaceBroker.ts /verify and
  // .github/workflows/cadp-verify.yml) names the two leaf directories explicitly and does not
  // recurse. A test file nested any deeper — cadp/tests/foo.test.ts, cadp/tests/support/x.test.ts,
  // cadp/tests/conformance/sub/y.test.ts — would be executed by NEITHER verifier while still
  // looking like coverage. This is the assertion that makes "flatten it" enforceable.
  const strays: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs, rel === "" ? name : `${rel}/${name}`);
      } else if (name.endsWith(".test.ts") && rel !== "conformance" && rel !== "ops") {
        strays.push(rel === "" ? name : `${rel}/${name}`);
      }
    }
  };
  walk(TESTS_DIR, "");
  assert.deepEqual(strays, [], "test files must sit DIRECTLY in cadp/tests/conformance/ or cadp/tests/ops/ — flatten them");

  // Both named directories must actually hold tests: an invocation that discovers nothing from one
  // of them is a silently empty suite, which GF8 also refuses at execution time.
  assert.ok(testFilesIn(CONFORMANCE_DIR).length > 0, "cadp/tests/conformance/ holds no test file");
  assert.ok(testFilesIn(OPS_DIR).length > 0, "cadp/tests/ops/ holds no test file");
});
