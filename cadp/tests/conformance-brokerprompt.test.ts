import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { spawnSafeText } from "../product/surfaceBroker.ts";

/** U+0000, constructed rather than written literally so this file holds no raw NUL byte. */
const NUL = String.fromCharCode(0);

/**
 * The defect: a committed file whose first NUL sits past git's 8 KiB
 * binary-detection window is diffed as TEXT, so `git diff --stat --patch` returns raw NUL bytes.
 * The broker embedded that patch in the reviewer prompt and passed the prompt as a spawn argv
 * element, and Node rejects such an argv outright — the whole review run died before the surface
 * ever started. Escaping keeps the run alive AND keeps the reviewer told where the binary sits.
 */
test("§4.1 a NUL-bearing prompt is escaped into a spawn-safe argv element, surrounding text intact", () => {
  const raw = `diff --git a/blob.bin b/blob.bin\n+header${NUL}${NUL}tail\n`;

  // Pre-condition: the unsanitized string is exactly what Node refuses.
  assert.throws(
    () => spawnSync(process.execPath, ["-e", "0", raw]),
    /null bytes/u,
  );

  const safe = spawnSafeText(raw);
  assert.ok(!safe.includes(NUL));
  assert.equal(safe, "diff --git a/blob.bin b/blob.bin\n+header\\0\\0tail\n");

  // Spawn-safe in fact, not just by inspection: the escaped prompt survives a real argv round-trip.
  const echoed = spawnSync(process.execPath, ["-e", "process.stdout.write(process.argv[1])", safe]);
  assert.equal(echoed.status, 0);
  assert.equal(echoed.stdout.toString("utf8"), safe);
});

test("§4.1 NUL-free text is returned identical, so no existing verdict can change", () => {
  const untouched = [
    "",
    'You are reviewing the exact committed change below (commit abc123) implementing: "fix the thing".',
    "diff --git a/x.ts b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n",
    "backslashes \\0 \\n and unicode — é 漢 🙂 stay as they are",
    String.fromCharCode(9) + String.fromCharCode(27) + " control characters other than NUL are untouched",
  ];
  for (const text of untouched) assert.equal(spawnSafeText(text), text);

  // Idempotent: the escape's own output contains no NUL, so a second pass is a no-op. The broker
  // sanitizes the diff and then the whole prompt containing it; that must not double-escape.
  const once = spawnSafeText(`a${NUL}b`);
  assert.equal(spawnSafeText(once), once);
});
