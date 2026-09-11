/**
 * Meta-test for the conformance traceability manifest.
 *
 * Conformance tests are not authority themselves — they are the EXECUTABLE ASSURANCE PROJECTION of
 * TD authority (see `manifest.ts` for the definition in full). This file is what makes the
 * projection tamper-evident: a mapped control whose test file is deleted, renamed or moved out of
 * `cadp/tests/conformance/` fails MT1 deterministically, and a file that appears in the directory
 * without being claimed by any control fails MT2. Neither can happen quietly.
 *
 * MT4 pins the INVOCATION CONTRACT the two verifiers depend on: every `*.test.ts` in the
 * repository lives in exactly one of the three enumerated leaf directories. The verifiers discover
 * tests recursively from the repository root (`node --test`, no positional selectors), so a test
 * file parked anywhere else would still RUN — what MT4 protects is the classification itself: an
 * assurance test must be in `conformance/` (protected) or knowingly in `ops/` / `devharness/`
 * (unprotected), never in a third place where nobody classified it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROL_MAP, UNMAPPED_AUXILIARY } from "./manifest.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The three leaf directories a `*.test.ts` file may live in, repo-relative with trailing slash. */
const TEST_DIRECTORIES = ["cadp/tests/conformance/", "cadp/tests/ops/", "devharness/tests/"] as const;

const conformanceFiles = readdirSync(CONFORMANCE_DIR).filter((f) => f.endsWith(".test.ts"));

test("MT1: every test file a control maps to EXISTS in cadp/tests/conformance/", () => {
  assert.ok(conformanceFiles.length > 0, "the conformance directory must hold test files");
  for (const entry of CONTROL_MAP) {
    for (const file of entry.tests) {
      assert.ok(
        existsSync(join(CONFORMANCE_DIR, file)),
        `${entry.control} maps to ${file}, which is not in cadp/tests/conformance/ — a mapped control lost its executable projection (deleted, renamed, or moved to ops/)`,
      );
    }
  }
  for (const aux of UNMAPPED_AUXILIARY) {
    assert.ok(
      existsSync(join(CONFORMANCE_DIR, aux.test)),
      `auxiliary entry ${aux.test} is not in cadp/tests/conformance/ — remove the entry deliberately or restore the file`,
    );
  }
});

test("MT2: every conformance test file is claimed by a control or the auxiliary list (no stowaways, no silent drops)", () => {
  const claimed = new Set<string>([...CONTROL_MAP.flatMap((e) => e.tests), ...UNMAPPED_AUXILIARY.map((a) => a.test)]);
  for (const file of conformanceFiles) {
    assert.ok(
      claimed.has(file),
      `${file} sits in cadp/tests/conformance/ unreferenced — the directory is intentional: map it to a control or list it as UNMAPPED-AUXILIARY with its reason`,
    );
  }
  // The two lists partition the directory: a file is either traced to a control or explicitly
  // pending, never both (otherwise "unmapped" stops meaning anything).
  const mapped = new Set(CONTROL_MAP.flatMap((e) => e.tests));
  for (const aux of UNMAPPED_AUXILIARY) {
    assert.ok(!mapped.has(aux.test), `${aux.test} is listed as UNMAPPED-AUXILIARY but a control already maps to it`);
  }
});

test("MT3: no control entry is empty, and no control id is declared twice", () => {
  const seen = new Set<string>();
  for (const entry of CONTROL_MAP) {
    assert.ok(entry.tests.length > 0, `${entry.control} has an empty tests array — a control with no executable leg is not traced, it is dropped`);
    assert.equal(new Set(entry.tests).size, entry.tests.length, `${entry.control} lists a test file twice`);
    assert.ok(!seen.has(entry.control), `control ${entry.control} is declared twice — merge the entries so the mapping stays single-valued`);
    seen.add(entry.control);
  }
  const seenAux = new Set<string>();
  for (const aux of UNMAPPED_AUXILIARY) {
    assert.ok(aux.reason.length > 0, `${aux.test} must state why it is protection-worthy`);
    assert.ok(!seenAux.has(aux.test), `${aux.test} is listed twice in UNMAPPED_AUXILIARY`);
    seenAux.add(aux.test);
  }
});

test("MT4: every *.test.ts in the repository lives directly in one of the three enumerated directories", () => {
  const found: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const nextRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(join(absolute, entry.name), nextRelative);
      else if (entry.name.endsWith(".test.ts")) found.push(nextRelative);
    }
  };
  walk(REPO_ROOT, "");

  assert.ok(found.length > 0, "the walk found no test files at all — the repo root resolution is wrong");
  for (const file of found) {
    const directory = file.slice(0, file.lastIndexOf("/") + 1);
    assert.ok(
      (TEST_DIRECTORIES as readonly string[]).includes(directory),
      `${file} is a test file outside the enumerated directories (${TEST_DIRECTORIES.join(", ")}) — every test must be classified: protected conformance, or knowingly unprotected ops/devharness`,
    );
  }
  // Each enumerated directory must actually hold tests: an empty one means a whole suite vanished.
  for (const directory of TEST_DIRECTORIES) {
    assert.ok(found.some((f) => f.startsWith(directory)), `${directory} holds no test files — a whole suite was dropped`);
  }
});
