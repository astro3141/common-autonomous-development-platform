/**
 * Operability honesty (#47/#48/#55) — merged authority coverage, rework reason provenance, and
 * the read-only observation surface that stays reachable while the lifecycle thread is blocked.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { monitorOnce } from "../core/coordinator/monitor.ts";
import { hashEnvelope } from "../core/schemas/envelope.ts";
import { commitAttemptFact } from "../core/statemachine/transition-commit.ts";
import { PlatformStore } from "../core/store/platform-store.ts";
import { startObserver } from "../deployment/observer.ts";
import { BATCH_ID, discover, RUN_ID, TASK_KEY, withWorld, world as makeWorld } from "./support/domain-fixtures.ts";
import {
  auditingCompletionWorld,
  auditorTurnResult,
  auditorVerdict,
  implementingWorld,
} from "./support/execution-fixtures.ts";
import { completeAuditing } from "../core/execution/complete-auditing.ts";

const TRIGGERS = {
  stale_after_ms: 60_000,
  intent_unresolved_after_ms: 60_000,
  config_ref: "test-config-v1",
};

// --- #47: merged per-authority coverage -----------------------------------------------------------

test("F2/#47: an authority that both answered and failed within one scan reports PARTIAL", () => {
  withWorld((world) => {
    // Two IMPLEMENTING attempts with durable turn projections: the runtime answers for one and
    // throws for the other. Last-write-wins would erase one of the two facts; merged coverage
    // must say PARTIAL whichever order the scan visits them in.
    const w = implementingWorld(world);
    // A second IMPLEMENTING attempt with its own durable turn projection, built from durable
    // rows so the scan visits two runtime observations in one pass.
    const secondTask = discover(world, "T-202");
    const secondAttempt = `attempt:${secondTask}:1`;
    const first = world.store.attempts.require(w.attempt_key);
    world.store.withTransaction(() => {
      world.store.tasks.write(secondTask, { platform_state: "ACTIVE" });
      // Contract snapshots are one-per-attempt: store a copy of the first envelope under a new id.
      const envelope = world.store.contracts.get(first.contract_snapshot_id)!;
      const body = { ...(envelope.body as Record<string, unknown>), snapshot_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0C02" };
      const secondEnvelope = { ...envelope, body };
      const contract_snapshot_id = world.store.contracts.put({
        body,
        envelope: secondEnvelope,
        hash: hashEnvelope(secondEnvelope as never),
      } as never);
      world.store.attempts.create({
        attempt_key: secondAttempt,
        task_key: secondTask,
        n: 1,
        contract_snapshot_id,
        base_head: first.base_head,
      });
      world.store.attempts.write(secondAttempt, { state: "IMPLEMENTING" });
      world.store.adapterMetadata.put({
        entity_key: secondAttempt,
        adapter_id: "runtime",
        key: "actor_turn:1",
        value: { probe: "fail" },
      });
    });

    let failEverything = false;
    const runtime = {
      get_turn_result(handle: unknown): unknown {
        if (failEverything || (handle as { probe?: string } | null)?.probe === "fail") {
          throw new Error("runtime unavailable for this attempt");
        }
        return { backend_status: "RUNNING" };
      },
    } as never;

    const report = monitorOnce(
      { store: world.store, runtime },
      { run_id: RUN_ID, now: "2026-09-02T12:00:00.000Z", trigger_config: TRIGGERS },
    );
    assert.equal(report.authority_coverage.runtime, "PARTIAL", "neither fact may be erased");
    assert.equal(report.authority_coverage.store, "AVAILABLE");

    // All-fail stays UNAVAILABLE and all-answer stays AVAILABLE — PARTIAL is only the mix.
    failEverything = true;
    const bothFail = monitorOnce(
      { store: world.store, runtime },
      { run_id: RUN_ID, now: "2026-09-02T12:00:00.000Z", trigger_config: TRIGGERS },
    );
    assert.equal(bothFail.authority_coverage.runtime, "UNAVAILABLE");
  }, { batch_policy: { max_tasks: 3, max_rework: 2, concurrency: 2 } });
});

// --- #48: rework reason provenance ----------------------------------------------------------------

test("F3/#48: IMPLEMENTING→REWORKING journals why — no candidate vs invalid candidate", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    const result = commitAttemptFact(world.store, {
      attempt_key: w.attempt_key,
      fact: { kind: "CANDIDATE_REJECTED", reason: "ABSENT" },
    });
    assert.equal(result.attempt_state, "REWORKING");
    const attempt = world.store.attempts.require(w.attempt_key);
    assert.equal(attempt.state_reason?.code, "NO_CANDIDATE_PRODUCED");
    assert.equal(attempt.state_reason?.log_seq, result.transition.seq, "provenance names its journal row");

    const journaled = world.store.decisions
      .read()
      .find((entry) => entry.seq === result.transition.seq);
    assert.equal(
      (journaled?.payload as { reason_code?: string | null })?.reason_code,
      "NO_CANDIDATE_PRODUCED",
      "the durable journal row itself says why",
    );
  });

  withWorld((world) => {
    const w = implementingWorld(world);
    const result = commitAttemptFact(world.store, {
      attempt_key: w.attempt_key,
      fact: { kind: "CANDIDATE_REJECTED", reason: "LINEAGE" },
    });
    assert.equal(world.store.attempts.require(w.attempt_key).state_reason?.code, "CANDIDATE_INVALID");
    void result;
  });
});

test("F3/#48: the audit-driven rework carries AUDIT_FIX_REQUIRED, distinct from no-candidate", () => {
  withWorld((world) => {
    const w = auditingCompletionWorld(world);
    w.runtime.turnResult = auditorTurnResult({
      body: auditorVerdict(w.review, { verdict: "FIX_REQUIRED" }),
    });
    w.verification.settlement = { kind: "SETTLED" };
    const outcome = completeAuditing(w, {
      attempt_key: w.attempt_key,
      audit_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F31",
      decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F32",
      report_channel: "operations",
      recorded_at: "2026-09-02T12:00:00.000Z",
    });
    assert.equal(outcome.kind, "AUDIT_DECIDED");
    const attempt = world.store.attempts.require(w.attempt_key);
    assert.equal(attempt.state, "REWORKING");
    assert.equal(attempt.state_reason?.code, "AUDIT_FIX_REQUIRED");
  });
});

// --- #55: the observation surface -----------------------------------------------------------------

test("F6/#55: the observation worker answers while this thread is blocked, and cannot write", async () => {
  const world = makeWorld();
  try {
    // Give the store something observable, then open the observation surface over the same file.
    implementingWorld(world);
    const observer = await startObserver({
      store_path: world.temp.path,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      // Warm read from this thread first: the projection answers and carries the run.
      const direct = await fetch(`http://127.0.0.1:${observer.port}/v1/runs/${encodeURIComponent(RUN_ID)}`);
      assert.equal(direct.status, 200);
      const projected = (await direct.json()) as { run: { run_id: string } | null };
      assert.equal(projected.run?.run_id, RUN_ID);

      // The #55 measurement, inverted: block THIS thread the way a model turn blocks the
      // lifecycle thread (spawnSync), and have a child process hit the observation surface
      // meanwhile. The child can only succeed if the worker's event loop is independent.
      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          `fetch("http://127.0.0.1:${observer.port}/v1/runs/${encodeURIComponent(RUN_ID)}", { signal: AbortSignal.timeout(5000) })
             .then((response) => response.text().then((body) => { console.log(response.status); console.log(body); }))
             .catch((error) => { console.error(String(error)); process.exit(1); });`,
        ],
        { encoding: "utf8", timeout: 20_000 },
      );
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout.split("\n")[0], "200", "answered while the main thread was blocked");
      assert.match(probe.stdout, /"platform_state"/u);

      // Monitor stays honest about what this surface can observe: store answers, runtime is a
      // failed observation (this surface holds no runtime authority), nothing is invented.
      const monitor = await fetch(
        `http://127.0.0.1:${observer.port}/v1/runs/${encodeURIComponent(RUN_ID)}/monitor`,
      );
      const monitorBody = (await monitor.json()) as {
        authority_coverage: { store: string; runtime: string };
      };
      assert.equal(monitorBody.authority_coverage.store, "AVAILABLE");
      assert.notEqual(monitorBody.authority_coverage.runtime, "AVAILABLE");

      // The surface accepts no mutation.
      const post = await fetch(`http://127.0.0.1:${observer.port}/v1/findings`, { method: "POST" });
      assert.equal(post.status, 405);
    } finally {
      await observer.stop();
    }

    // Read-only is database-enforced, not reviewer-enforced: a write through a read-only open
    // fails at SQLite itself, and the single writable connection stays the lifecycle's.
    const readOnly = PlatformStore.open(world.temp.path, { read_only: true });
    try {
      assert.equal(readOnly.tasks.require(TASK_KEY).batch_id, BATCH_ID);
      assert.throws(() =>
        readOnly.withTransaction(() => {
          readOnly.decisions.append({ kind: "observer_probe", refKey: "x", payload: {} as never });
        }),
      );
    } finally {
      readOnly.close();
    }
  } finally {
    world.dispose();
  }
});

