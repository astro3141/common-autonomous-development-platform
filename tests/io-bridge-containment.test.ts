/**
 * IO bridge response-path containment (review 5501935839, BLOCKING_EXTERNAL_EFFECT).
 *
 * The python probe loads the production `bridge.py` and drives the exact reviewer
 * counterexamples through the real `send_turn` path: a model-plantable symlink at any
 * deterministic component of the response path must fail the turn closed before `send_round`,
 * external targets must stay untouched, ordinary paths must keep working, and cleanup must never
 * delete through indirection swapped in mid-turn.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("IO-C1: response-path containment holds against the symlink-escape counterexamples", () => {
  const work = mkdtempSync(join(tmpdir(), "adp-io-containment-"));
  try {
    const probe = spawnSync(
      "python3",
      [
        join(ROOT, "tests/support/io-bridge-containment-probe.py"),
        join(ROOT, "adapters/io-runtime/bridge.py"),
        work,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const verdict = JSON.parse(probe.stdout.trim().split("\n").at(-1)!) as Record<string, string>;
    assert.deepEqual(
      Object.fromEntries(Object.entries(verdict).map(([key, value]) => [key, value.split(" ")[0]])),
      {
        top_level_symlink_blocked: "PASS",
        top_level_external_untouched: "PASS",
        top_level_session_not_wedged: "PASS",
        nested_symlink_blocked: "PASS",
        nested_external_untouched: "PASS",
        normal_path_completes: "PASS",
        normal_path_cleaned_up: "PASS",
        planted_target_removed_not_followed: "PASS",
        midturn_swap_cleanup_stands_down: "PASS",
      },
      JSON.stringify(verdict),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
