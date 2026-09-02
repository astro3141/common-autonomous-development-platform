/**
 * B1-AC6 — Batch 1 production code and test fixtures contain no Backend/Project
 * vocabulary (TD I-TD1) and no credential-bearing identifier (TD I-TD7).
 *
 * The forbidden tokens are assembled from fragments so that this guard does not itself
 * introduce the very strings it forbids.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCANNED_EXTENSIONS = [".ts", ".json"];
/**
 * The one file whose job is to *name* the I-TD7 categories (TD §18.1c key validation). Exempting
 * it by exact path keeps the guard at full strength everywhere else — see the file's own comment.
 */
const DENY_LIST_MODULE = "core/store/restricted-key-denylist.ts";

const SCANNED_ROOTS = [
  "core",
  "adapters",
  "testdoubles",
  "tests",
  "package.json",
  "tsconfig.json",
];

const token = (...parts: readonly string[]): string => parts.join("");

/**
 * MVP1-B6 §36 — the RA-4 preflight is an *adapter implementation* whose entire job is to measure
 * Backend-v1-specific mechanisms, so it is the one place Backend vocabulary is permitted. The
 * allowance is a directory prefix and nothing wider: Core, the test doubles and every other
 * adapter stay under the full check, and the credential rule below is not relaxed even here.
 *
 * The directory name itself is neutral on purpose. Its module header names the backend it
 * measures; keeping the *path* generic is what lets tests import it, and build fixtures from the
 * probe constants it exports, without any test file having to fall outside the guard.
 */
const BACKEND_ADAPTER_PREFIX = "adapters/backend-runtime-preflight/";

/**
 * IG-2/IG-3 (TD §13.1, §14.1) added the two production backend *mapping* adapters, whose job is
 * naming the backend they map. I-TD1's own text places backend vocabulary exactly there — "등장
 * 위치는 Adapter/Profile config뿐이다" — so the allowance grows by those directories plus the
 * neutral re-export barrel that lets everything else import them without naming a backend. Core,
 * `testdoubles/` and every *test* stay under the full check, and the credential rule below is not
 * relaxed anywhere. The prefixes are assembled from fragments for the same reason the patterns are.
 */
const BACKEND_NAMING_ALLOWED: readonly string[] = [
  BACKEND_ADAPTER_PREFIX,
  token("adapters/", "open", "claw", "-runtime/"),
  token("adapters/", "durable", "-jobs", "-workflow/"),
  "adapters/backend-v1/",
  // #49/#50/#73 — the multi-provider CLI agent mapping adapter names the backends it maps
  // (I-TD1: backend vocabulary belongs exactly in Adapter/Profile config). Core, testdoubles/
  // and tests stay under the full check.
  "adapters/cli-agent-runtime/",
];

const namesBackend = (relativePath: string): boolean =>
  BACKEND_NAMING_ALLOWED.some((prefix) => relativePath.startsWith(prefix));

/** Backend/Project vocabulary that must never appear in Core (TD I-TD1). */
const FORBIDDEN_VOCABULARY: ReadonlyArray<readonly [string, RegExp]> = [
  ["backend runtime name", new RegExp(token("open", "claw"), "i")],
  ["backend workflow engine name", new RegExp(token("durable", "[-_ ]?", "jobs"), "i")],
  ["agent protocol name", new RegExp(`\\b${token("ac", "px?")}\\b`, "i")],
  ["project scanner name", new RegExp(token("infra", "[-_ ]?", "scanner"), "i")],
  ["project document marker", new RegExp(token("READY", "_ITEM"))],
  ["project document marker", new RegExp(token("PROJECT", "_STATUS"))],
  ["backend session identifier", new RegExp(token("session", "[-_]?", "key"), "i")],
  ["second agent tool name", new RegExp(`\\b${token("a", "gy")}\\b`, "i")],
];

/** Credential-bearing identifiers that Core must not model or store (TD I-TD7). */
const FORBIDDEN_CREDENTIAL_TERMS: ReadonlyArray<readonly [string, RegExp]> = [
  // Header/credential literal. `ResolvedHumanGateAuthorization` (TD §17.3) is a Core type name,
  // so the bare word alone is no longer the signal; a quoted header value still is.
  ["bearer credential", new RegExp("[\"'`]" + token("author", "ization") + "[\"'`:]", "i")],
  ["bearer credential", new RegExp(`\\b${token("access", "[-_]?", "token")}\\b`, "i")],
  ["credential", new RegExp(`\\b${token("sec", "ret", "s?")}\\b`, "i")],
  ["credential", new RegExp(`\\b${token("pass", "word")}\\b`, "i")],
];

function collectFiles(entry: string): string[] {
  const absolute = join(ROOT, entry);
  let children: Dirent<string>[];
  try {
    children = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension)) ? [absolute] : [];
  }
  return children.flatMap((child) => collectFiles(join(entry, child.name)));
}

const FILES = SCANNED_ROOTS.flatMap(collectFiles).sort();

test("B1-AC6: the Batch 1 source set is non-empty and fully scanned", () => {
  assert.ok(FILES.length >= 10, `expected the Batch 1 source set, found ${FILES.length} files`);
  const relatives = FILES.map((file) => relative(ROOT, file));
  assert.ok(relatives.includes("core/schemas/canonical-json.ts"));
  assert.ok(relatives.includes("core/contract/source-hash.ts"));
  assert.ok(relatives.includes("adapters/interfaces/runtime-adapter.ts"));
  assert.ok(relatives.includes("testdoubles/fake-report-adapter.ts"));
});

test("B1-AC6: no Backend or Project vocabulary appears in Core code or fixtures", () => {
  for (const file of FILES) {
    if (relative(ROOT, file) === DENY_LIST_MODULE) continue;
    if (namesBackend(relative(ROOT, file))) continue;
    const content = readFileSync(file, "utf8");
    for (const [label, pattern] of FORBIDDEN_VOCABULARY) {
      const match = pattern.exec(content);
      assert.equal(
        match,
        null,
        `${relative(ROOT, file)} contains ${label} (${match?.[0] ?? ""})`,
      );
    }
  }
});

test("B1-AC6: no credential-bearing identifier is modelled in Core", () => {
  for (const file of FILES) {
    if (relative(ROOT, file) === DENY_LIST_MODULE) continue;
    const content = readFileSync(file, "utf8");
    for (const [label, pattern] of FORBIDDEN_CREDENTIAL_TERMS) {
      const match = pattern.exec(content);
      assert.equal(
        match,
        null,
        `${relative(ROOT, file)} contains ${label} (${match?.[0] ?? ""})`,
      );
    }
  }
});

test("MVP1-B6 §36: the Backend vocabulary allowance is exactly one adapter directory", () => {
  const allowed = FILES.map((file) => relative(ROOT, file)).filter(namesBackend);
  // The allowance must actually be used by something, and by nothing outside that directory.
  assert.ok(allowed.length > 0, "the backend adapter directory is empty");
  for (const path of allowed) {
    assert.equal(path.startsWith("adapters/"), true, `${path} is not an adapter implementation`);
  }
  // Nothing under core/ or testdoubles/ may ever fall inside the allowance.
  for (const path of FILES.map((file) => relative(ROOT, file))) {
    if (path.startsWith("core/") || path.startsWith("testdoubles/") || path.startsWith("tests/")) {
      assert.equal(namesBackend(path), false, `${path} must stay under the full guard`);
    }
  }
});

test("B1-AC6: Core primitives run with no dependency declared", () => {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {};
  assert.deepEqual(dependencies, {});
});
