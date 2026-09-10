/**
 * META-TEST of the conformance traceability manifest.
 *
 * The manifest (`manifest.ts`) is only worth having if it cannot silently rot. These controls make
 * every way of losing a conformance test FAIL DETERMINISTICALLY rather than quietly:
 *
 *   MF1  every test file a manifest entry names EXISTS in this directory — delete or move a mapped
 *        test and the control it projected is named in the failure;
 *   MF2  every *.test.ts in this directory is referenced by an entry or by the auxiliary list —
 *        the directory is INTENTIONAL: no stowaways (an unmapped file quietly gaining gate
 *        protection) and no silent drops (a file dropped from the manifest but left on disk);
 *   MF3  the manifest is well-formed: no empty `tests` array, no duplicate control id, and no file
 *        counted BOTH as mapped and as unmapped-auxiliary;
 *   MF4  the INVOCATION CONTRACT the two verifiers depend on: every *.test.ts in the repository
 *        (node_modules excluded) sits DIRECTLY in one of the three leaf directories
 *        `VERIFIER_TEST_ARGV` names, and each of those three actually contains tests. A file
 *        nested deeper, or parked in a fourth directory, is not executed by the pinned invocation
 *        — so it is a conformance failure here rather than an invisible gap there.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AUXILIARY_TRACE, CONTROL_TRACE } from "./manifest.ts";
import { VERIFIER_TEST_DIRS } from "../../product/surfaceBroker.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFORMANCE_DIR = "cadp/tests/conformance/";

/** Every `*.test.ts` basename physically present in this directory. */
function conformanceFilesOnDisk(): string[] {
  return readdirSync(HERE).filter((f) => f.endsWith(".test.ts")).sort();
}

/** Every `*.test.ts` in the repository as a root-relative path, node_modules and .git excluded. */
function repoTestFiles(): string[] {
  const found: string[] = [];
  const walk = (relDir: string): void => {
    for (const entry of readdirSync(REPO_ROOT + relDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const rel = `${relDir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (entry.name.endsWith(".test.ts")) found.push(rel);
    }
  };
  walk("");
  return found.sort();
}

test("MF1: every test file a manifest entry names exists in cadp/tests/conformance/", () => {
  const onDisk = new Set(conformanceFilesOnDisk());
  for (const entry of CONTROL_TRACE) {
    for (const file of entry.tests) {
      assert.ok(
        onDisk.has(file),
        `${entry.control} maps ${file}, which is not in ${CONFORMANCE_DIR} — a mapped conformance test was deleted, renamed or moved out of the protected directory`,
      );
    }
  }
  for (const aux of AUXILIARY_TRACE) {
    assert.ok(onDisk.has(aux.test), `auxiliary entry ${aux.test} is not in ${CONFORMANCE_DIR}`);
    assert.ok(aux.why.length > 0, `auxiliary entry ${aux.test} must say why it is protected`);
  }
});

test("MF2: every test file in cadp/tests/conformance/ is referenced — no stowaways, no silent drops", () => {
  const referenced = new Set([...CONTROL_TRACE.flatMap((e) => e.tests), ...AUXILIARY_TRACE.map((a) => a.test)]);
  const unreferenced = conformanceFilesOnDisk().filter((f) => !referenced.has(f));
  assert.deepEqual(
    unreferenced,
    [],
    "these protected test files are in no manifest entry and no auxiliary entry — map them to their control, or record them as UNMAPPED-AUXILIARY with a reason",
  );
});

test("MF3: the manifest is well-formed — no empty mapping, no duplicate control, no double-counted file", () => {
  const seen = new Set<string>();
  for (const entry of CONTROL_TRACE) {
    assert.ok(entry.control.length > 0, "every entry declares a control id");
    assert.ok(entry.tests.length > 0, `${entry.control} maps no test — a control with no projection must be absent, never present-but-empty`);
    assert.equal(new Set(entry.tests).size, entry.tests.length, `${entry.control} repeats a test file`);
    assert.ok(!seen.has(entry.control), `${entry.control} appears twice — one entry per control, with every test file it maps`);
    seen.add(entry.control);
  }
  const mapped = new Set(CONTROL_TRACE.flatMap((e) => e.tests));
  for (const aux of AUXILIARY_TRACE) {
    assert.ok(
      !mapped.has(aux.test),
      `${aux.test} is listed as UNMAPPED-AUXILIARY while a control also maps it — it is mapped, so drop the auxiliary entry`,
    );
  }
  assert.equal(new Set(AUXILIARY_TRACE.map((a) => a.test)).size, AUXILIARY_TRACE.length, "an auxiliary file is listed twice");
});

test("MF4: every repository test file lives DIRECTLY in one of the three leaf directories the verifiers run", () => {
  assert.deepEqual([...VERIFIER_TEST_DIRS], [CONFORMANCE_DIR, "cadp/tests/ops/", "devharness/tests/"], "the pinned verifier directories are these three");
  const leaves = new Set(VERIFIER_TEST_DIRS);
  const files = repoTestFiles();
  const outside = files.filter((f) => !leaves.has(f.slice(0, f.lastIndexOf("/") + 1)));
  assert.deepEqual(
    outside,
    [],
    `these test files are not executed by the pinned invocation (node --test ${VERIFIER_TEST_DIRS.map((d) => `${d}*.test.ts`).join(" ")}) — flatten them into one of the three named directories`,
  );
  for (const dir of VERIFIER_TEST_DIRS) {
    const count = files.filter((f) => f.startsWith(dir)).length;
    assert.ok(count > 0, `${dir} is named by the verifier invocation but holds no test file — the selector would discover nothing`);
  }
});
