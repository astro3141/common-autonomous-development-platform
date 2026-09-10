import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvidenceDraft } from "../../kernel/ingress.ts";
import type { EvidenceEnvelopeV1 } from "../../kernel/records.ts";
import { submitBackendExecutionEvidence } from "../../product/backendExecution.ts";
import { appendRequestedEffort } from "../../product/effortArgv.ts";
import { PLAN_PROVIDERS } from "../../product/planProviders.ts";
import { REVIEW_PROVIDERS } from "../../product/reviewProviders.ts";
import { scanBackendModel } from "../../product/surfaceBroker.ts";
import { WORKER_EFFORT_ARGV, WORKER_PROVIDERS } from "../../product/workerProviders.ts";

test("measured worker layouts produce PRESENT observed effort with replayable locators", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-observed-effort-"));
  try {
    for (const provider of ["grok", "codex", "claude"] as const) {
      const sessions = join(root, provider);
      const fixture = provider === "grok"
        ? join(sessions, "%2Fws", "session-id", "chat_history.jsonl")
        : provider === "codex"
          ? join(sessions, "2026", "09", "07", "rollout-probe.jsonl")
          : join(sessions, "-ws", "session-id.jsonl");
      mkdirSync(join(fixture, ".."), { recursive: true });
      writeFileSync(fixture, `${JSON.stringify(provider === "claude" ? { effort: "high" } : { reasoning_effort: "high" })}\n`);
      const fact = scanBackendModel(WORKER_PROVIDERS[provider], sessions, "");
      assert.equal(fact.effort, "high");
      assert.equal(fact.effort_locator, `${fixture}#offset=1`);

      let draft: EvidenceDraft | undefined;
      await submitBackendExecutionEvidence({
        client: { submitEvidence: async (value) => { draft = value; return { evidence_id: "backend" } as EvidenceEnvelopeV1; } },
        provider, surface_role: "WORKER", subject_bindings: [], effort: fact.effort, effort_locator: fact.effort_locator,
      });
      assert.deepEqual((draft!.claim as { observed: Record<string, unknown> }).observed["effort"], {
        availability: "PRESENT", value: "high", locator: `${fixture}#offset=1`,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent or unmatched effort_scan preserves UNKNOWN", async () => {
  assert.deepEqual(scanBackendModel(REVIEW_PROVIDERS.codex, "/absent", '{"reasoning_effort":"high"}'), {});
  assert.equal(scanBackendModel(WORKER_PROVIDERS.codex, "/absent", "no effort here").effort, undefined);
  let draft: EvidenceDraft | undefined;
  await submitBackendExecutionEvidence({
    client: { submitEvidence: async (value) => { draft = value; return { evidence_id: "backend" } as EvidenceEnvelopeV1; } },
    provider: "codex", surface_role: "REVIEWER", subject_bindings: [],
  });
  assert.deepEqual((draft!.claim as { observed: Record<string, unknown> }).observed["effort"], { availability: "UNKNOWN" });
});

test("measured effort argv encodings expand only when the pair is set", () => {
  assert.deepEqual(appendRequestedEffort(["grok", "-p", "x"], { requested_effort: "high", effort_argv: WORKER_EFFORT_ARGV.grok }, "grok"), ["grok", "-p", "x", "--reasoning-effort", "high"]);
  assert.deepEqual(appendRequestedEffort(["codex", "exec", "x"], { requested_effort: "high", effort_argv: WORKER_EFFORT_ARGV.codex }, "codex"), ["codex", "exec", "x", "-c", "model_reasoning_effort=high"]);
  assert.deepEqual(appendRequestedEffort(["claude", "-p", "x"], { requested_effort: "high", effort_argv: WORKER_EFFORT_ARGV.claude }, "claude"), ["claude", "-p", "x", "--effort", "high"]);
  assert.throws(() => appendRequestedEffort([], { requested_effort: "high" }, "test"), /unpaired/u);
  assert.throws(() => appendRequestedEffort([], { effort_argv: WORKER_EFFORT_ARGV.grok }, "test"), /unpaired/u);
  assert.throws(() => appendRequestedEffort([], { requested_effort: "max", effort_argv: WORKER_EFFORT_ARGV.grok }, "test"), /measured allowed values/u);
});

test("only the measured codex reviewer pins requested effort; other profiles leave live argv unchanged", () => {
  for (const registries of [WORKER_PROVIDERS, PLAN_PROVIDERS]) {
    for (const profile of Object.values(registries)) {
      assert.equal(profile.requested_effort, undefined);
      assert.equal(profile.effort_argv, undefined);
    }
  }
  assert.equal(REVIEW_PROVIDERS.claude.requested_effort, undefined);
  assert.equal(REVIEW_PROVIDERS.claude.effort_argv, undefined);
  assert.equal(REVIEW_PROVIDERS.grok.requested_effort, undefined);
  assert.equal(REVIEW_PROVIDERS.grok.effort_argv, undefined);
  assert.equal(REVIEW_PROVIDERS.codex.requested_effort, "high");
  assert.deepEqual(REVIEW_PROVIDERS.codex.effort_argv, { flag: "-c", value_placement: "separate", value_prefix: "model_reasoning_effort=", allowed_values: ["high"] });
});
