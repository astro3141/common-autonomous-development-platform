/**
 * OPERATIONAL mechanics of the executor-profile payload and the broker's surface-prompt bytes.
 *
 * Deliberately NOT in `cadp/tests/conformance/`: the CONTRACT legs — the closed key sets, the
 * verbatim copy, the typed digests, the malformed refusals — live in
 * `cadp/tests/conformance/conformance-execution-request.test.ts` under EP-B1/EP-C1. What is pinned
 * here is the per-provider SNAPSHOT: which keys each live profile actually contributes today and
 * which prompt bytes the broker hands each surface. Those change whenever a measured profile field
 * or a prompt template legitimately changes, so they are operational facts that must stay visible
 * and re-measurable, not assurance boundaries that must stay gate-protected.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutorProfilePayload, executorProfileKeys } from "../../product/executionContract.ts";
import { PLAN_PROVIDERS, PLAN_PROMPT_SENTINEL } from "../../product/planProviders.ts";
import { REVIEW_PROVIDERS, DIFF_PROMPT_SENTINEL } from "../../product/reviewProviders.ts";
import { buildReviewPrompt, spawnSafeText } from "../../product/surfaceBroker.ts";
import { WORKER_PROVIDERS, WORK_ITEM_SENTINEL, workerArgv } from "../../product/workerProviders.ts";

/** The exact keys each live profile contributes to its payload today. */
const PAYLOAD_KEYS: Record<string, readonly string[]> = {
  "WORKER/codex": ["argv_template", "auth_files", "auth_subdir", "sessions_subdir", "identity_class_product", "model_scan", "effort_scan"],
  "WORKER/grok": ["argv_template", "auth_files", "auth_subdir", "sessions_subdir", "identity_class_product", "model_scan", "effort_scan"],
  "WORKER/claude": ["argv_template", "auth_files", "auth_subdir", "auth_env", "sessions_subdir", "sessions_container_dir", "identity_class_product", "model_scan", "effort_scan"],
  // can_read_workspace is present on every reviewer profile: it landed after the TD's key listing
  // and the verbatim principle carries it into the payload.
  "REVIEWER/claude": ["argv_template", "auth_method", "can_read_workspace", "sessions_subdir", "sessions_container_dir", "model_scan", "identity_class_product", "verdict_format"],
  "REVIEWER/grok": ["argv_template", "auth_method", "can_read_workspace", "sessions_subdir", "model_scan", "identity_class_product", "verdict_format"],
  "REVIEWER/codex": ["argv_template", "auth_method", "can_read_workspace", "sessions_subdir", "model_scan", "requested_effort", "effort_argv", "identity_class_product", "verdict_format"],
  "PLANNER/claude": ["argv_template", "auth_method", "sessions_subdir", "sessions_container_dir", "model_scan", "identity_class_product"],
  "PLANNER/grok": ["argv_template", "auth_method", "sessions_subdir", "model_scan", "identity_class_product"],
  "PLANNER/codex": ["argv_template", "auth_method", "sessions_subdir", "model_scan", "identity_class_product"],
};

test("the per-provider payload key snapshot matches the live registries", () => {
  const roles = [
    { role: "WORKER" as const, registry: WORKER_PROVIDERS as Readonly<Record<string, unknown>> },
    { role: "REVIEWER" as const, registry: REVIEW_PROVIDERS as Readonly<Record<string, unknown>> },
    { role: "PLANNER" as const, registry: PLAN_PROVIDERS as Readonly<Record<string, unknown>> },
  ];
  const seen: string[] = [];
  for (const { role, registry } of roles) {
    for (const provider of Object.keys(registry)) {
      const name = `${role}/${provider}`;
      seen.push(name);
      const expected = PAYLOAD_KEYS[name];
      assert.ok(expected !== undefined, `${name} is a live profile with no snapshot — add one deliberately`);
      assert.deepEqual(
        Object.keys(buildExecutorProfilePayload(role, provider)).sort(),
        [...expected].sort(),
        `${name}: a measured profile field changed — re-measure, then update this snapshot in the same edit`,
      );
      // Every snapshot key is inside the role's closed set, so a snapshot can never widen one.
      for (const key of expected) assert.ok(executorProfileKeys(role).includes(key), `${name}.${key} is outside the role's closed key set`);
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(PAYLOAD_KEYS).sort(), "the snapshot lists exactly the live profiles");
});

test("the bytes the WORKER surface receives are the same string the argv carries", () => {
  // The worker's `surface-prompt` is the work item as substituted at WORK_ITEM_SENTINEL, so the
  // digested string and the spawned argv element must be one and the same value.
  const work_item = 'add a "--json" flag — é 漢';
  const surface_prompt = spawnSafeText(work_item);
  assert.equal(surface_prompt, work_item, "spawnSafeText is identity on NUL-free input, so live argv is unchanged");
  for (const provider of Object.keys(WORKER_PROVIDERS) as Array<keyof typeof WORKER_PROVIDERS>) {
    const argv = workerArgv(provider, surface_prompt);
    const template = WORKER_PROVIDERS[provider].argv_template;
    assert.ok(template.includes(WORK_ITEM_SENTINEL), `${provider} must carry the sentinel`);
    assert.ok(argv.includes(surface_prompt), `${provider} argv must carry exactly the digested prompt string`);
    assert.ok(!argv.includes(WORK_ITEM_SENTINEL), `${provider} argv must not carry an unsubstituted sentinel`);
  }
});

test("the bytes the REVIEWER surface receives are capability-scoped, and the sentinels are intact", () => {
  const diff = "diff --git a/x.ts b/x.ts\n@@\n-a\n+b\n";
  const claude = buildReviewPrompt("claude", "c".repeat(40), "work item", diff);
  const grok = buildReviewPrompt("grok", "c".repeat(40), "work item", diff);
  // The mount instruction rides only on a profile whose measured argv can read files, so the two
  // surfaces genuinely receive different bytes for the same caller arguments.
  assert.ok(!claude.includes("/candidate"), "the claude reviewer has its read tools disallowed");
  assert.ok(grok.includes("/candidate"), "the grok reviewer's measured allow-list is a read capability");
  assert.ok(claude.endsWith(diff) && grok.endsWith(diff));
  assert.ok(REVIEW_PROVIDERS.grok.argv_template.includes(DIFF_PROMPT_SENTINEL));
  assert.ok(PLAN_PROVIDERS.grok.argv_template.includes(PLAN_PROMPT_SENTINEL));
});
