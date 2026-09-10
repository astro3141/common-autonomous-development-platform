/**
 * Meta-conformance: the traceability manifest is TRUE of the directory, and the directory is
 * exactly what the protected invocation runs.
 *
 * Per manifest.ts's header definition, the conformance suite is the EXECUTABLE ASSURANCE PROJECTION
 * of TD authority. A projection that can shrink without anything failing is not a projection. These
 * legs make the two shrink modes deterministic failures:
 *
 *   MM1  a mapped or auxiliary test file that is DELETED or MOVED out of cadp/tests/conformance/
 *        fails here by name — the manifest names files, and a named file that is not there is a
 *        FAIL, not a silently skipped mapping;
 *   MM2  a test file that is ADDED to cadp/tests/conformance/ and referenced by nothing fails here —
 *        the directory is intentional, so a stowaway is as much a defect as a drop (an unreferenced
 *        file is one nobody has classified, and classification is the whole protection claim);
 *   MM3  an empty `tests` array fails here — a control whose projection is the empty set is a
 *        control that cannot be falsified, which reads as coverage while providing none;
 *   MM4  a *.test.ts anywhere in the repository outside the THREE directories the verifiers
 *        enumerate is a test NO verifier runs. That is the selection-bypass seam in its passive
 *        form: not a test that was weakened, but a test that quietly stopped being executed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { CONTROL_PROJECTIONS, UNMAPPED_AUXILIARY } from "./manifest.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The THREE leaf directories both verifiers enumerate, repo-relative with trailing slashes —
 * byte-identical to the argv tokens pinned in cadp/tests/conformance/conformance-sessions.test.ts
 * and executed by cadp/product/surfaceBroker.ts and .github/workflows/cadp-verify.yml.
 *
 * The invocation contract this encodes: EVERY test file lives DIRECTLY in one of these three
 * directories. Nothing may nest deeper — see MM4.
 */
const RUN_DIRS = ["cadp/tests/conformance/", "cadp/tests/ops/", "devharness/tests/"] as const;

/** Every *.test.ts under `dir`, repo-relative, recursing into subdirectories. */
function testFilesUnder(dir: string, skip: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (skip(entry)) continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".test.ts")) found.push(relative(REPO_ROOT, path).split("\\").join("/"));
    }
  };
  walk(dir);
  return found.sort();
}

test("MM1: every file the manifest names EXISTS in cadp/tests/conformance/", () => {
  for (const { control, tests } of CONTROL_PROJECTIONS) {
    for (const file of tests) {
      assert.ok(
        existsSync(join(CONFORMANCE_DIR, file)),
        `${control} maps ${file}, which is not in cadp/tests/conformance/ — a mapped control lost its projection (deleted, renamed, or moved to ops/)`,
      );
    }
  }
  // The auxiliary list carries the same guarantee: a protection-worthy file with no numbered
  // control is still a file whose disappearance must be loud.
  for (const { test: file } of UNMAPPED_AUXILIARY) {
    assert.ok(
      existsSync(join(CONFORMANCE_DIR, file)),
      `auxiliary entry ${file} is not in cadp/tests/conformance/ — a protected file was dropped`,
    );
  }
});

test("MM2: every *.test.ts in cadp/tests/conformance/ is referenced — no stowaways", () => {
  const referenced = new Set<string>([
    ...CONTROL_PROJECTIONS.flatMap((entry) => entry.tests),
    ...UNMAPPED_AUXILIARY.map((entry) => entry.test),
  ]);
  const present = readdirSync(CONFORMANCE_DIR).filter((name) => name.endsWith(".test.ts"));
  assert.ok(present.length > 0, "cadp/tests/conformance/ holds no test files at all");
  for (const file of present) {
    assert.ok(
      referenced.has(file),
      `${file} is in cadp/tests/conformance/ but no manifest entry and no auxiliary entry names it — classify it (map it to its control, or list it as UNMAPPED-AUXILIARY with the reason)`,
    );
  }
});

test("MM3: no control carries an empty projection", () => {
  for (const { control, tests } of CONTROL_PROJECTIONS) {
    assert.ok(tests.length > 0, `${control} has an empty tests array — a control with no falsification reads as coverage and provides none`);
  }
});

test("MM4: no *.test.ts anywhere in the repository outside the three enumerated directories", () => {
  // The verifiers name three leaf directories explicitly (no globs, no recursion assumption). A
  // test file outside them — or nested inside one of them — is a file no verifier executes.
  const skip = (name: string): boolean => name === "node_modules" || name === ".git";
  const everywhere = testFilesUnder(REPO_ROOT, skip);
  const enumerated = RUN_DIRS.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `${dir}${name}`),
  ).sort();

  assert.deepEqual(
    everywhere,
    enumerated,
    "every *.test.ts must sit DIRECTLY in cadp/tests/conformance/, cadp/tests/ops/ or devharness/tests/ — a file outside them, or nested one level deeper inside them, is never executed by either verifier",
  );
  for (const dir of RUN_DIRS) {
    assert.ok(
      enumerated.some((file) => file.startsWith(dir)),
      `${dir} holds no test files — a verifier directory that discovers nothing would report success having executed nothing`,
    );
  }
});
