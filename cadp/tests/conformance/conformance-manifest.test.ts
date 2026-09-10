/**
 * Meta-test for the traceability manifest (`manifest.ts`).
 *
 * The manifest is only assurance if it cannot silently drift from the directory. These controls
 * make the drift DETERMINISTIC rather than reviewer-dependent, in both directions:
 *
 *   MT1  every mapped test file EXISTS in cadp/tests/conformance/ — deleting or moving a mapped
 *        test out of the protected directory fails here, by name, without a reviewer noticing;
 *   MT2  every *.test.ts in cadp/tests/conformance/ is referenced by at least one control entry or
 *        by AUXILIARY — the directory is INTENTIONAL: no stowaways (a file smuggled in to look
 *        protected), no silent drops (a file that quietly stopped being traced to anything);
 *   MT3  no control entry carries an empty `tests` array — a control with no projection is an
 *        assurance claim backed by nothing, and reads as covered when it is not.
 *
 * Note what MT1 does NOT claim: it is a projection-integrity check, not authority. A test may be
 * changed; the manifest and the gate exist so that WEAKENING it is a visible, human-decided act.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUXILIARY, CONTROL_MAPPINGS } from "./manifest.ts";

const DIR = dirname(fileURLToPath(import.meta.url));

const testFilesOnDisk = (): string[] => readdirSync(DIR).filter((f) => f.endsWith(".test.ts")).sort();

test("MT1: every manifest entry's every test file exists in cadp/tests/conformance/", () => {
  for (const entry of CONTROL_MAPPINGS) {
    for (const file of entry.tests) {
      assert.ok(
        file.endsWith(".test.ts"),
        `${entry.control} maps ${file}, which is not a *.test.ts basename — the manifest names files in this directory, never paths elsewhere`,
      );
      assert.ok(
        existsSync(join(DIR, file)),
        `${entry.control} maps ${file}, which is MISSING from cadp/tests/conformance/ — a mapped control lost its projection (deleted, renamed, or moved out of the protected directory)`,
      );
    }
  }
  for (const aux of AUXILIARY) {
    assert.ok(
      existsSync(join(DIR, aux.test)),
      `AUXILIARY names ${aux.test}, which is MISSING from cadp/tests/conformance/`,
    );
  }
});

test("MT2: every *.test.ts in cadp/tests/conformance/ is referenced by the manifest — no stowaways, no silent drops", () => {
  const referenced = new Set<string>([
    ...CONTROL_MAPPINGS.flatMap((entry) => entry.tests),
    ...AUXILIARY.map((aux) => aux.test),
  ]);
  const onDisk = testFilesOnDisk();
  assert.ok(onDisk.length > 0, "the conformance directory must contain test files");

  const unreferenced = onDisk.filter((f) => !referenced.has(f));
  assert.deepEqual(
    unreferenced,
    [],
    `these files sit in the protected directory but are traced to nothing — add a control entry, or AUXILIARY with its reason: ${unreferenced.join(", ")}`,
  );
});

test("MT3: no control entry has an empty tests array, and no control ID is declared twice", () => {
  for (const entry of CONTROL_MAPPINGS) {
    assert.ok(
      entry.tests.length > 0,
      `${entry.control} maps to NO test — a control whose projection is empty reads as covered while nothing falsifies it`,
    );
    assert.equal(
      new Set(entry.tests).size,
      entry.tests.length,
      `${entry.control} lists the same test file more than once`,
    );
  }

  const ids = CONTROL_MAPPINGS.map((entry) => entry.control);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(duplicates, [], `a control ID is declared twice, so one mapping hides the other: ${duplicates.join(", ")}`);

  const auxNames = AUXILIARY.map((aux) => aux.test);
  const auxDuplicates = auxNames.filter((name, i) => auxNames.indexOf(name) !== i);
  assert.deepEqual(auxDuplicates, [], `AUXILIARY lists the same file twice: ${auxDuplicates.join(", ")}`);

  for (const aux of AUXILIARY) {
    assert.ok(aux.reason.length > 0, `AUXILIARY entry ${aux.test} must state why it is protected`);
  }
});

test("MT4: the manifest and AUXILIARY partition the directory — an auxiliary file is not also mapped", () => {
  // Not a correctness requirement of the many-to-many mapping, but an honesty one: AUXILIARY means
  // "not (yet) tied to a numbered control". A file in both lists misreports its own traceability.
  const mapped = new Set(CONTROL_MAPPINGS.flatMap((entry) => entry.tests));
  const bothLists = AUXILIARY.map((aux) => aux.test).filter((name) => mapped.has(name));
  assert.deepEqual(bothLists, [], `these files are mapped to a numbered control AND listed as unmapped-auxiliary: ${bothLists.join(", ")}`);
});
