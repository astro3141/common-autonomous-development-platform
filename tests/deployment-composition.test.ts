/**
 * Production composition root — Stage 1 acceptance (PREFLIGHT §7).
 *
 * The composition is wiring over sealed exports: it fills every dependency slot with a production
 * implementation, performs the settled `compile → bootstrap → supervisor grant → discovery`
 * opening, and contains no lifecycle logic of its own. Production code imports nothing from
 * `tests/support/*` or `testdoubles/*` — the source guard holds that, not a convention.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compose } from "../deployment/compose.ts";
import { openRun } from "../deployment/open-run.ts";
import { ConfigError, validateConfig } from "../deployment/config.ts";
import { backendV1Manifests } from "../deployment/manifests.ts";
import { validateManifestSet } from "../core/capability/manifest-set.ts";
import { FileReportAdapter } from "../adapters/file-report/index.ts";
import { ReportDeliveryError } from "../adapters/interfaces/report-adapter.ts";
import { pilotWorld, ScriptedGateway } from "./support/deployment-fixtures.ts";

const PRODUCTION_DIRS = ["deployment", "adapters", "core"];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

test("DEPLOY-1: production code imports nothing from tests/support or testdoubles", () => {
  for (const dir of PRODUCTION_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      assert.equal(
        /from\s+["'][^"']*(tests\/support|testdoubles)/.test(source),
        false,
        `${file} reaches into test-only code`,
      );
    }
  }
});

test("DEPLOY-2: compose fills every slot and the store opens at the current schema", () => {
  const world = pilotWorld();
  try {
    const composition = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    try {
      for (const slot of [
        "store",
        "repository",
        "runtime",
        "verification",
        "report",
        "taskSource",
        "profiles",
        "contractSources",
        "manifests",
        "preflight",
        "identities",
      ] as const) {
        assert.notEqual(composition.deps[slot], undefined, `${slot} is not filled`);
      }
      assert.equal(composition.store.journalMode, "wal");
      // The compiled profile is real and hash-bound.
      assert.match(composition.compiled.compiled_hash, /^sha256:[0-9a-f]{64}$/);
    } finally {
      composition.dispose();
    }
  } finally {
    world.dispose();
  }
});

test("DEPLOY-3: openRun performs the settled opening order and resumes over a restart", () => {
  const world = pilotWorld();
  try {
    const first = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    const opened = openRun(first);
    assert.match(opened.run_id, /^run:/);

    // Bootstrap wrote the run/batch, the supervisor grant, and the discovered task.
    const run = first.store.runs.require(opened.run_id);
    assert.equal(run.status, "RUNNING");
    const grants = first.store.grants.forRun(opened.run_id);
    assert.equal(grants.length, 1, "exactly one run-scoped SUPERVISOR grant");
    assert.equal(grants[0]?.role, "SUPERVISOR");
    const tasks = first.store.tasks.inBatch(opened.batch_id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.platform_state, "DISCOVERED");
    first.dispose();

    // A new process over the same directory resumes the same run instead of opening a second one.
    const second = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    const resumed = openRun(second);
    assert.deepEqual(resumed, opened);
    second.dispose();
  } finally {
    world.dispose();
  }
});

test("DEPLOY-4: the RA-4 preflight over this environment is BLOCKED, and compose still builds", () => {
  const world = pilotWorld();
  try {
    const composition = compose(world.config);
    try {
      const outcome = composition.deps.preflight();
      assert.equal(outcome.status, "BLOCKED", "no backend is installed here");
    } finally {
      composition.dispose();
    }
  } finally {
    world.dispose();
  }
});

test("DEPLOY-5: the Backend v1 manifest set validates and stays honest about receipts", () => {
  const set = validateManifestSet(backendV1Manifests({ backend_instance_id: "pilot-host" }));
  assert.equal(set.runtime.body.backend_kind, "RUNTIME");
  assert.equal((set.runtime.body as { receipt_supported: boolean }).receipt_supported, false);
  const enforcement = (
    set.runtime.body as {
      capability_enforcement: Record<string, { allow: string; deny: string }>;
    }
  ).capability_enforcement;
  assert.equal(enforcement["repository.canonical_write"]?.deny, "UNENFORCEABLE_CAPABILITY_BOUNDARY");
  assert.equal(enforcement["repository.merge"]?.deny, "UNENFORCEABLE_CAPABILITY_BOUNDARY");
  assert.equal(enforcement["repository.feature_write"]?.allow, "AVAILABLE_WITH_REDUCED_ASSURANCE");
});

test("DEPLOY-6: config validation fails closed", () => {
  assert.throws(() => validateConfig({}, "/tmp"), ConfigError);
  assert.throws(
    () => validateConfig({ project_id: "", store_path: "x" }, "/tmp"),
    ConfigError,
  );
});

test("DEPLOY-7: the file report transport is idempotent by op_key and durable across instances", () => {
  const world = pilotWorld();
  try {
    const first = new FileReportAdapter(join(world.base, "reports"));
    const request = {
      op_key: "op:batch:report-batch:complete",
      channel: "operations",
      payload: { event: "BATCH_COMPLETE" } as never,
    };
    assert.equal(first.deliver(request).delivered, true);
    assert.equal(first.deliver(request).delivered, true, "a replay is one logical notification");

    // A different payload under the same op_key is a conflict — held even by a new instance.
    const second = new FileReportAdapter(join(world.base, "reports"));
    assert.throws(
      () =>
        second.deliver({ ...request, payload: { event: "SOMETHING_ELSE" } as never }),
      ReportDeliveryError,
    );

    // Exactly one line was written for the logical notification.
    const log = readFileSync(join(world.base, "reports", "operations.jsonl"), "utf8");
    assert.equal(log.trim().split("\n").length, 1);
  } finally {
    world.dispose();
  }
});
