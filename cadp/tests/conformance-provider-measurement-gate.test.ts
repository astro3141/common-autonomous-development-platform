import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_PROVIDERS } from "../product/planProviders.ts";
import { REVIEW_PROVIDERS } from "../product/reviewProviders.ts";

test("reviewer and planner model scans are measured while effort slots stay absent", () => {
  for (const [role, providers] of [
    ["review", REVIEW_PROVIDERS],
    ["plan", PLAN_PROVIDERS],
  ] as const) {
    for (const [provider, profile] of Object.entries(providers)) {
      assert.ok(profile.model_scan !== undefined, `${role}:${provider} model_scan is measured`);
      assert.equal(profile.sessions_subdir, `${provider}-sessions`, `${role}:${provider} preserve name`);
      assert.equal(profile.sessions_container_dir, provider === "claude" ? "projects" : undefined, `${role}:${provider} container layout`);
      assert.equal(profile.requested_effort, undefined, `${role}:${provider} requested_effort is unmeasured`);
      assert.equal(profile.effort_argv, undefined, `${role}:${provider} effort_argv is unmeasured`);
      assert.equal(profile.effort_scan, undefined, `${role}:${provider} effort_scan is unmeasured`);
    }
  }
});
