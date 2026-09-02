/**
 * IO bridge response transport (reviews 5501935839 + 5502523861, BLOCKING_EXTERNAL_EFFECT).
 *
 * The response is fileless: a bridge-owned one-shot per-turn unix socket + in-memory slot feeds
 * the pinned runner's `response_reader` branch, so the original workspace response-file attack
 * class — including the reviewer's pre-write TOCTOU swap — is unreachable rather than checked
 * for. The python probe drives the real `send_turn`/`_TurnResponseChannel` code: zero workspace
 * response-file effect, external targets byte-identical under plant+swap, server-decided turn
 * correlation, duplicate/stale/malformed deliveries rejected, timeout never demoted to success.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("IO-C1: the fileless response transport defeats the pre-write TOCTOU class", () => {
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
        fileless_normal_completes: "PASS",
        no_workspace_response_file: "PASS",
        channel_outside_workspace_and_state: "PASS",
        prewrite_swap_turn_completes: "PASS",
        prewrite_swap_external_intact: "PASS",
        prewrite_swap_no_response_json_anywhere: "PASS",
        duplicate_delivery_rejected: "PASS",
        malformed_delivery_times_out: "PASS",
        stale_delivery_cannot_cross_turns: "PASS",
        timeout_releases_active_turn: "PASS",
        cleanup_swap_external_socket_survives: "PASS",
        cleanup_identity_relative_unlink: "PASS",
        cleanup_late_delivery_refused: "PASS",
      },
      JSON.stringify(verdict),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
