import assert from "node:assert/strict";
import test, { after } from "node:test";

import { EXTERNAL_CHECK_NAME, projectCheckRuns } from "../../product/externalVerification.ts";
import { REFERENCE_ADAPTERS, REFERENCE_IDENTITIES } from "../../deployment/referencePolicy.ts";
import { makeHarness, reviewBodyPair, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { nowIso } from "../../kernel/canonical.ts";

after(() => stopSharedOpa());

const SHA = "e".repeat(40);
let step = 700;

// ---------------------------------------------------------------- projection (pure, fail-closed)

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: EXTERNAL_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    id: 42,
    html_url: "https://github.com/o/r/runs/42",
    started_at: "2026-09-07T00:00:00Z",
    completed_at: "2026-09-07T00:01:00Z",
    ...over,
  };
}

test("EV1: exactly one completed cadp-verify run projects PRESENT with its conclusion", () => {
  const p = projectCheckRuns({ check_runs: [run()] });
  assert.deepEqual(p, {
    status: "PRESENT",
    conclusion: "success",
    check_run_id: 42,
    html_url: "https://github.com/o/r/runs/42",
    // GitHub's second-precision timestamps are normalized to the K2 millisecond form — same
    // instant, kernel-admissible, and claim./completed_at == produced_at stays derivable.
    started_at: "2026-09-07T00:00:00.000Z",
    completed_at: "2026-09-07T00:01:00.000Z",
  });
  assert.equal(projectCheckRuns({ check_runs: [run({ conclusion: "failure" })] }).status, "PRESENT", "a completed failure is PRESENT evidence, not UNKNOWN");
});

test("EV2: everything else fails closed to UNKNOWN with an honest reason", () => {
  for (const [payload, why] of [
    [null, "non-object"],
    [{}, "no array"],
    [{ check_runs: [] }, "no run"],
    [{ check_runs: [run({ name: "other-check" })] }, "different check name"],
    [{ check_runs: [run({ status: "in_progress", conclusion: null })] }, "not completed"],
    [{ check_runs: [run(), run({ id: 43 })] }, "two completed runs are ambiguous"],
    [{ check_runs: [run({ completed_at: 7 })] }, "malformed timestamps"],
    [{ check_runs: [run({ completed_at: "not-a-date" })] }, "unparseable timestamps"],
  ] as const) {
    const p = projectCheckRuns(payload);
    assert.equal(p.status, "UNKNOWN", why);
    assert.ok(p.status === "UNKNOWN" && p.unknown_reason.length > 0, "reason is stated");
  }
});

// ---------------------------------------------------------------- registry honesty

test("EV3: verifier:github-actions is registered as an authoritative SOURCE-timestamped adapter", () => {
  const id = REFERENCE_IDENTITIES.find((i) => i.producer_ref === "verifier:github-actions");
  assert.ok(id !== undefined && id.identity_class.process_class === "evidence-adapter");
  const ad = REFERENCE_ADAPTERS.find((a) => a.producer_ref === "verifier:github-actions");
  assert.ok(ad !== undefined);
  assert.deepEqual(ad.evidence_kinds, ["VERIFICATION"]);
  assert.equal(ad.source_relation, "TARGET_AUTHORITY_OBSERVATION", "GitHub is the authority for its own check runs");
  assert.deepEqual(ad.produced_at_source, { kind: "SOURCE", claim_pointer: "/completed_at" });
});

// ---------------------------------------------------------------- policy gate (opt-in)

function sealActionsVerification(h: Harness, conclusion: string): string {
  const completedAt = nowIso(h.clock.fn);
  return h.ingress.submitEvidence(
    {
      evidence_kind: "VERIFICATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA }],
      availability: "PRESENT",
      claim_schema: "cadp.verification.github-actions.v1",
      claim: { head_sha: SHA, conclusion, check_run_id: 42, html_url: "https://github.com/o/r/runs/42", runner: "github-actions:cadp-verify", started_at: completedAt, completed_at: completedAt },
      produced_at: completedAt,
      producer_ref: "verifier:github-actions",
      source_ref: `check-run-${(step += 1)}`,
      source_relation: "TARGET_AUTHORITY_OBSERVATION",
    },
    { principal: "cadp-verifier-actions" },
  ).evidence_id;
}

function sealPrBase(h: Harness): string[] {
  const completedAt = nowIso(h.clock.fn);
  const verification = h.ingress.submitEvidence(
    {
      evidence_kind: "VERIFICATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA }],
      availability: "PRESENT",
      claim_schema: "cadp.verification.harness.v1",
      claim: { head_sha: SHA, clone_head: SHA, porcelain_empty: true, conclusion: "success", runner: "node --test", started_at: completedAt, completed_at: completedAt, output_digest: "0".repeat(64) },
      produced_at: completedAt,
      producer_ref: "verifier:harness",
      source_ref: `t-${(step += 1)}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.verifier,
  ).evidence_id;
  const review = h.ingress.submitEvidence(
    {
      evidence_kind: "REVIEW",
      subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA }],
      availability: "PRESENT",
      claim_schema: "cadp.review.v1",
      claim: { verdict: "APPROVE", ...reviewBodyPair(h, "external-verify review body") },
      producer_ref: "reviewer:claude-code",
      source_ref: `t-${(step += 1)}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.reviewer,
  ).evidence_id;
  const workStep = h.ingress.submitEvidence(
    {
      evidence_kind: "WORK_STEP",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000e7" },
        { authority_ref: "cadp-store:k04", namespace: "step-output", object_id: SHA },
      ],
      availability: "PRESENT",
      claim_schema: "cadp.work-step.v1",
      claim: { step_ordinal: (step += 1), summary: "implemented" },
      producer_ref: "workflow:cadp-work",
      source_ref: `ws-${step}`,
      source_relation: "SELF_REPORT",
    },
    PRINCIPALS.workflow,
  ).evidence_id;
  const backend = h.ingress.submitEvidence(
    {
      evidence_kind: "BACKEND_EXECUTION",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000e7" },
        { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "WORKER" },
      ],
      availability: "PRESENT",
      claim_schema: "cadp.backend-execution.v1",
      claim: {
        requested: { provider: "codex", model: "default" },
        observed: {
          provider: { availability: "PRESENT", value: "codex", locator: "t" },
          model: { availability: "PRESENT", value: "m", locator: "t" },
          version: { availability: "UNKNOWN" }, run_id: { availability: "UNKNOWN" }, effort: { availability: "UNKNOWN" },
        },
      },
      producer_ref: "backend-scan:codex",
      source_ref: `be-${(step += 1)}`,
      source_relation: "SELF_REPORT",
    },
    PRINCIPALS.backendScan,
  ).evidence_id;
  return [verification, review, workStep, backend];
}

function sealReviewerBackend(h: Harness): string {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "BACKEND_EXECUTION",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000e7" },
        { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "REVIEWER" },
      ],
      availability: "PRESENT",
      claim_schema: "cadp.backend-execution.v1",
      claim: {
        requested: { provider: "claude", model: "default" },
        observed: {
          provider: { availability: "PRESENT", value: "claude", locator: "t" },
          model: { availability: "PRESENT", value: "review-model", locator: "t" },
          version: { availability: "UNKNOWN" }, run_id: { availability: "UNKNOWN" }, effort: { availability: "UNKNOWN" },
        },
      },
      producer_ref: "backend-scan:claude",
      source_ref: `review-be-${(step += 1)}`,
      source_relation: "SELF_REPORT",
    },
    { principal: "cadp-backend-scan-claude" },
  ).evidence_id;
}

async function evalPr(h: Harness, refs: string[]): Promise<{ outcome: string; reasons: string[] }> {
  const material = { repo_id: "r-1", base_ref: "refs/heads/main", head_sha: SHA, title: "t", body: "b" };
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const request = h.ingress.sealEffectRequest(
    {
      effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-0000000000e7", step_ordinal: (step += 1), purpose: "pr-create" }, PRINCIPALS.workflow),
      requester_ref: "workflow:cadp-work",
      work_bindings: [],
      target_ref: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: "r-1" },
      operation_kind: "PR_CREATE",
      material_schema: "cadp.pr-create.v1",
      material_ref,
      prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const input = h.ingress.assembleAdmissionInput(request.effect_id, refs);
  const evaluated = await h.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION") throw new Error("expected decision");
  return { outcome: evaluated.decision.outcome, reasons: evaluated.decision.reason_codes };
}

test("EV4: with the param OFF (reference default), PR gates are byte-identical — no external evidence needed", async () => {
  const h = await makeHarness();
  try {
    const result = await evalPr(h, sealPrBase(h));
    assert.equal(result.outcome, "ALLOW", JSON.stringify(result));
  } finally {
    h.close();
  }
});

test("REVIEWER BACKEND_EXECUTION is not an implementer and preserves legal independent review", async () => {
  const h = await makeHarness();
  try {
    const result = await evalPr(h, [...sealPrBase(h), sealReviewerBackend(h)]);
    assert.equal(result.outcome, "ALLOW", JSON.stringify(result));
    assert.equal(result.reasons.includes("reviewer_product_not_independent"), false);
  } finally {
    h.close();
  }
});

test("EV5: with the param ON, a PR without external verification is refused with the dedicated reason", async () => {
  const h = await makeHarness({ paramOverrides: { require_external_verification: true } });
  try {
    const missing = await evalPr(h, sealPrBase(h));
    assert.notEqual(missing.outcome, "ALLOW");
    assert.ok(missing.reasons.includes("external_verification_missing"), JSON.stringify(missing.reasons));

    const withSuccess = await evalPr(h, [...sealPrBase(h), sealActionsVerification(h, "success")]);
    assert.equal(withSuccess.outcome, "ALLOW", JSON.stringify(withSuccess));

    const withFailure = await evalPr(h, [...sealPrBase(h), sealActionsVerification(h, "failure")]);
    assert.notEqual(withFailure.outcome, "ALLOW", "a completed failure never clears the gate");
    assert.ok(withFailure.reasons.includes("external_verification_missing"), JSON.stringify(withFailure.reasons));
  } finally {
    h.close();
  }
});
