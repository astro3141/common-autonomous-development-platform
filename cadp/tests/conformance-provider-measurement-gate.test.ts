import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_PROVIDERS } from "../product/planProviders.ts";
import { REVIEW_PROVIDERS } from "../product/reviewProviders.ts";

test("reviewer and planner scan/effort slots stay absent until measured by a live container probe", () => {
  for (const [role, providers] of [
    ["review", REVIEW_PROVIDERS],
    ["plan", PLAN_PROVIDERS],
  ] as const) {
    for (const [provider, profile] of Object.entries(providers)) {
      assert.equal(profile.model_scan, undefined, `${role}:${provider} model_scan is unmeasured`);
      assert.equal(profile.sessions_subdir, undefined, `${role}:${provider} sessions_subdir is unmeasured`);
      assert.equal(profile.sessions_container_dir, undefined, `${role}:${provider} sessions_container_dir is unmeasured`);
      assert.equal(profile.effort_argv, undefined, `${role}:${provider} effort_argv is unmeasured`);
      assert.equal(profile.effort_scan, undefined, `${role}:${provider} effort_scan is unmeasured`);
    }
  }
});
