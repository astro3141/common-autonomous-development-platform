import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_PROVIDERS } from "../product/planProviders.ts";
import { REVIEW_PROVIDERS } from "../product/reviewProviders.ts";
import { WORKER_PROVIDERS } from "../product/workerProviders.ts";

test("reviewer and planner model scans are measured while effort slots stay absent", () => {
  for (const [role, providers] of [
    ["review", REVIEW_PROVIDERS],
    ["plan", PLAN_PROVIDERS],
  ] as const) {
    for (const [provider, profile] of Object.entries(providers)) {
      assert.ok(profile.model_scan !== undefined, `${role}:${provider} model_scan is measured`);
      assert.equal(profile.sessions_subdir, `${provider}-sessions`, `${role}:${provider} preserve name`);
      assert.equal(profile.sessions_container_dir, provider === "claude" ? "projects" : undefined, `${role}:${provider} container layout`);
      const pinsMeasuredEffort = role === "review" && provider === "codex";
      assert.equal(profile.requested_effort, pinsMeasuredEffort ? "high" : undefined, `${role}:${provider} requested_effort`);
      assert.deepEqual(profile.effort_argv, pinsMeasuredEffort
        ? { flag: "-c", value_placement: "separate", value_prefix: "model_reasoning_effort=", allowed_values: ["high"] }
        : undefined, `${role}:${provider} effort_argv`);
      assert.equal(profile.effort_scan, undefined, `${role}:${provider} effort_scan is unmeasured`);
    }
  }
});

test("worker effort scans are measured while requested effort stays deployment-unset", () => {
  for (const [provider, profile] of Object.entries(WORKER_PROVIDERS)) {
    assert.ok(profile.effort_scan !== undefined, `worker:${provider} effort_scan is measured`);
    assert.equal(profile.requested_effort, undefined);
    assert.equal(profile.effort_argv, undefined);
  }
});
