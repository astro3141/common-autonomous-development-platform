/**
 * Meta-test over `manifest.ts` — the mapping is only assurance if it cannot rot silently.
 *
 * conformance tests are NOT authority themselves - they are the EXECUTABLE ASSURANCE PROJECTION of
 * TD authority; they are protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not because
 * changing them "amends the TD"). These four controls are what make that protection checkable:
 *
 *   MT1  every file a control maps to EXISTS in this directory — deleting or moving a mapped test
 *        fails here deterministically, naming the control that just lost its projection;
 *   MT2  every *.test.ts in this directory is mapped by a control or declared auxiliary — the
 *        directory is INTENTIONAL: no stowaways, no silent drops, and no auxiliary entry left
 *        pointing at a file that is gone;
 *   MT3  no control maps to an empty set — a coverage claim that cannot fail is not coverage;
 *   MT4  no *.test.ts anywhere in the repository (node_modules excluded) lives outside the three
 *        enumerated test directories. The verifiers discover tests RECURSIVELY from the repository
 *        root (bare `node --test`, see `cadp/product/surfaceBroker.ts`), so this is what pins the
 *        discovered SET: a test file cannot be parked somewhere the manifest does not account for,
 *        and a conformance file cannot be demoted by moving it into an unlisted directory. The
 *        sweep is deliberately WIDER than discovery — `node_modules` is the only exclusion, so
 *        dot-directories are walked too: a conformance file moved into one would escape both the
 *        verifiers' run and this directory's protection boundary, which is exactly the silent drop
 *        MT4 exists to catch.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

import { CONFORMANCE_AUXILIARY, CONFORMANCE_CONTROLS } from "./manifest.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The three directories that may hold test files, repo-relative. `cadp/tests/conformance` is gate
 * machinery; `cadp/tests/ops` (operational contracts) and `devharness/tests` (harness tests) are
 * not — but all three RUN in both verifiers. The split changes protection, never execution coverage.
 */
const TEST_DIRECTORIES = ["cadp/tests/conformance", "cadp/tests/ops", "devharness/tests"] as const;

/**
 * Every *.test.ts under `dir`, repo-relative. `node_modules` is the ONLY exclusion — dot-directories
 * are walked. `node --test`'s own recursive discovery skips them, which is precisely why this sweep
 * must not: a test file parked under a dot-directory is a file the verifiers never run and no
 * manifest entry accounts for, and that gap is the one MT4 is here to close.
 */
function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(relative(REPO_ROOT, child));
    }
  };
  walk(dir);
  return found.sort();
}

const conformanceFiles = readdirSync(CONFORMANCE_DIR).filter((f) => f.endsWith(".test.ts")).sort();

test("MT1: every control maps to test files that exist in cadp/tests/conformance/", () => {
  for (const { control, tests } of CONFORMANCE_CONTROLS) {
    for (const file of tests) {
      assert.ok(
        existsSync(join(CONFORMANCE_DIR, file)),
        `${control} maps to ${file}, which is not in cadp/tests/conformance/ — a mapped control lost its executable projection (deleted, renamed, or moved out of the protected directory)`,
      );
      assert.ok(file.endsWith(".test.ts") && !file.includes(sep) && !file.includes("/"), `${control} must map to a bare file name in this directory, got ${file}`);
    }
  }
});

test("MT2: every conformance test file is mapped or declared auxiliary — no stowaways, no silent drops", () => {
  const mapped = new Set(CONFORMANCE_CONTROLS.flatMap((c) => c.tests));
  const auxiliary = new Set(CONFORMANCE_AUXILIARY.map((a) => a.test));

  for (const file of conformanceFiles) {
    assert.ok(
      mapped.has(file) || auxiliary.has(file),
      `${file} sits in the protected conformance directory but no manifest control and no auxiliary entry accounts for it — map it to the control it projects, or declare it UNMAPPED-AUXILIARY with the reason`,
    );
  }
  // The reverse direction: an auxiliary declaration for a file that no longer exists is a stale
  // protection claim, and reads like coverage that is not there.
  for (const { test: file } of CONFORMANCE_AUXILIARY) {
    assert.ok(conformanceFiles.includes(file), `auxiliary entry ${file} names no file in cadp/tests/conformance/`);
  }
  // A file may be both mapped and auxiliary in neither direction by accident: state it once.
  for (const { test: file } of CONFORMANCE_AUXILIARY) {
    assert.equal(mapped.has(file), false, `${file} is declared auxiliary AND mapped to a control — state it once`);
  }
});

test("MT3: no control maps to an empty test set, and no control id is declared twice", () => {
  const seen = new Set<string>();
  for (const { control, tests } of CONFORMANCE_CONTROLS) {
    assert.ok(tests.length > 0, `${control} maps to no test — a control mapped to nothing is a coverage claim that cannot fail`);
    assert.equal(new Set(tests).size, tests.length, `${control} lists the same test file twice`);
    assert.equal(seen.has(control), false, `${control} is declared twice — merge the rows, the mapping is many-to-many within one entry`);
    seen.add(control);
  }
  assert.equal(new Set(CONFORMANCE_AUXILIARY.map((a) => a.test)).size, CONFORMANCE_AUXILIARY.length, "an auxiliary file is declared twice");
});

test("MT4: no *.test.ts exists anywhere in the repository outside the three enumerated directories", () => {
  const permitted = new Set(TEST_DIRECTORIES.map((d) => d.split("/").join(sep)));
  const strays: string[] = [];
  for (const file of testFilesUnder(REPO_ROOT)) {
    const parent = file.split(sep).slice(0, -1).join(sep);
    if (!permitted.has(parent)) strays.push(file);
  }
  assert.deepEqual(
    strays,
    [],
    `every test file must live DIRECTLY in one of ${TEST_DIRECTORIES.join(", ")} — a file elsewhere is discovered by the verifiers but accounted for by no manifest, and a nested one escapes this directory's protection boundary`,
  );

  // An enumerated directory that emptied out (or vanished) would satisfy the check above vacuously.
  for (const dir of TEST_DIRECTORIES) {
    const absolute = join(REPO_ROOT, dir);
    assert.ok(existsSync(absolute), `enumerated test directory ${dir} does not exist`);
    assert.ok(testFilesUnder(absolute).length > 0, `enumerated test directory ${dir} holds no test files`);
  }
});
