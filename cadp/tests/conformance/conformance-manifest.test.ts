/**
 * Meta-test for the traceability manifest (see manifest.ts for the DEFINITION this serves).
 *
 * The manifest is a document; these legs are what make it load-bearing. Deleting or moving a mapped
 * test breaks CM1 deterministically; adding a file to the protected directory without declaring it
 * breaks CM2; mapping a control to nothing breaks CM3; and parking a test file anywhere outside the
 * three directories the verifiers actually name breaks CM4 — the invocation contract is "every test
 * file lives DIRECTLY in one of the three enumerated leaf directories", so a nested or stray file is
 * a file no verifier would execute.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { CONTROL_MAP, UNMAPPED_AUXILIARY } from "./manifest.ts";
import { VERIFIER_TEST_DIRS } from "../../product/surfaceBroker.ts";

const CONFORMANCE_DIR = import.meta.dirname;
const REPO_ROOT = join(CONFORMANCE_DIR, "..", "..", "..");

/** The *.test.ts basenames actually sitting in this directory. */
function conformanceFiles(): string[] {
  return readdirSync(CONFORMANCE_DIR).filter((f) => f.endsWith(".test.ts")).sort();
}

/** Every *.test.ts in the repository, repo-relative and posix-shaped, node_modules excluded. */
function repoTestFiles(dir: string = REPO_ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) repoTestFiles(full, found);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(relative(REPO_ROOT, full).split(sep).join("/"));
  }
  return found;
}

test("CM1: every test file the manifest maps EXISTS in cadp/tests/conformance/", () => {
  const present = new Set(conformanceFiles());
  for (const entry of CONTROL_MAP) {
    for (const file of entry.tests) {
      assert.ok(present.has(file), `${entry.control} maps ${file}, which is not a test file in cadp/tests/conformance/ — a mapped control lost its executable projection`);
      assert.ok(statSync(join(CONFORMANCE_DIR, file)).isFile(), `${file} must be a regular file`);
    }
  }
  for (const aux of UNMAPPED_AUXILIARY) {
    assert.ok(present.has(aux.test), `auxiliary entry ${aux.test} is not a test file in cadp/tests/conformance/`);
    assert.ok(aux.why.length > 0, `auxiliary entry ${aux.test} must state why it is protection-worthy`);
  }
});

test("CM2: every test file in cadp/tests/conformance/ is declared — no stowaways, no silent drops", () => {
  const declared = new Set<string>([...CONTROL_MAP.flatMap((e) => e.tests), ...UNMAPPED_AUXILIARY.map((a) => a.test)]);
  const undeclared = conformanceFiles().filter((f) => !declared.has(f));
  assert.deepEqual(undeclared, [], "the protected directory is INTENTIONAL: every file in it is mapped to a control or listed as auxiliary");
});

test("CM3: no manifest entry maps a control to nothing, and no id or auxiliary file repeats", () => {
  const controls = new Set<string>();
  for (const entry of CONTROL_MAP) {
    assert.ok(entry.tests.length > 0, `${entry.control} maps no test — an empty mapping is an unfalsified control wearing a traceability badge`);
    assert.equal(new Set(entry.tests).size, entry.tests.length, `${entry.control} lists a test file twice`);
    assert.ok(entry.control.includes("-"), `control id ${entry.control} must be <doc>-<id>`);
    assert.ok(!controls.has(entry.control), `control ${entry.control} appears twice — merge its tests into one many-to-many entry`);
    controls.add(entry.control);
  }
  const auxNames = UNMAPPED_AUXILIARY.map((a) => a.test);
  assert.equal(new Set(auxNames).size, auxNames.length, "an auxiliary file is listed twice");
});

test("CM4: every *.test.ts in the repository sits DIRECTLY in one of the three invoked directories", () => {
  // The verifiers name leaf directories, not globs and not a recursive root: on the surface image's
  // Node, discovery does not descend. A test file one level deeper is a test file nobody runs, and
  // "nobody runs it" is exactly the weakening this protection exists to prevent.
  const dirs = VERIFIER_TEST_DIRS.map((d) => d.replace(/\/$/u, ""));
  assert.deepEqual(dirs, ["cadp/tests/conformance", "cadp/tests/ops", "devharness/tests"], "the enumerated directories are pinned with the verifier argv");
  const stray = repoTestFiles().filter((f) => !dirs.includes(f.slice(0, f.lastIndexOf("/"))));
  assert.deepEqual(stray, [], "every test file must live directly in cadp/tests/conformance/, cadp/tests/ops/ or devharness/tests/ — nested or stray files are never executed by either verifier");
});
