/**
 * Delegated merge decision (AGENT_DECISION) conformance.
 *
 * The deployment's Human may delegate the MERGE gate — and only the merge gate — to exact agent
 * producers via policy param delegated_merge_producers. The delegation is recorded honestly:
 * the envelope kind is AGENT_DECISION with the agent's own producer_ref, never a Human's.
 *
 *   AD1  delegation on: AGENT_DECISION with exact scope satisfies the merge gate
 *   AD2  reference default (empty list): the same envelope satisfies NOTHING — delegation is opt-in
 *   AD3  POLICY_ACTIVATE is never delegated: constitution changes keep requiring HUMAN_DECISION
 *   AD4  exact scope: an agent decision for effect X does not clear effect Y; human_ok unaffected
 *   AD5  independence: a delegate NOT independent of the run's implementer cannot self-approve —
 *        an independent one can (Spec §8.4 extended to the machine decision; §3 incompatible duties)
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, reviewBodyPair, stopSharedOpa, PRINCIPALS } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";
import { nowIso } from "../../kernel/canonical.ts";
import type { EvidenceEnvelopeV1 } from "../../kernel/records.ts";
import { REFERENCE_IDENTITIES, REFERENCE_ADAPTERS } from "../../deployment/referencePolicy.ts";

after(() => stopSharedOpa());

const SHA = "c".repeat(40);
let step = 500;

function sealMergeBase(h: Harness): { verification: string; review: string; workStep: string } {
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
      source_ref: `test-${step}`,
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
      claim: { verdict: "APPROVE", ...reviewBodyPair(h, "delegation review body") },
      producer_ref: "reviewer:claude-code",
      source_ref: `test-${step}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.reviewer,
  ).evidence_id;
  // Independence is fail-closed over an EMPTY implementer set (13th-pilot fix), so every merge
  // evaluation needs the run's implementer evidence present.
  return { verification, review, workStep: sealWorkStep(h) };
}

function sealOp(h: Harness, operation_kind: "PR_MERGE" | "POLICY_ACTIVATE"): string {
  const material = operation_kind === "PR_MERGE"
    ? { repo_id: "r-1", pr_number: 9, expected_head_sha: SHA, merge_method: "merge" }
    : { proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 99 } };
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const request = h.ingress.sealEffectRequest(
    {
      effect_id: h.ingress.allocateEffectId({
        schema: "cadp.allocation-key.v1",
        work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
        step_ordinal: (step += 1),
        purpose: operation_kind === "PR_MERGE" ? "pr-merge" : "policy-activate",
      }, PRINCIPALS.workflow),
      requester_ref: "workflow:cadp-work",
      work_bindings: [],
      target_ref: operation_kind === "PR_MERGE"
        ? { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: "r-1" }
        : { authority_ref: "cadp-store:k04", target_type: "POLICY_ACTIVATION", target_id: "cadp-v04" },
      operation_kind,
      material_schema: operation_kind === "PR_MERGE" ? "cadp.pr-merge.v1" : "cadp.policy-activate.v1",
      material_ref,
      prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  return request.effect_id;
}

function agentApprove(h: Harness, effect_id: string): EvidenceEnvelopeV1 {
  const request = h.store.effectRequest(effect_id)!;
  return h.ingress.submitEvidence(
    {
      evidence_kind: "AGENT_DECISION",
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
      availability: "PRESENT",
      claim_schema: "cadp.human-decision.v1",
      claim: {
        principal: "agent:claude-owner",
        decision: "APPROVE",
        scope: { effect_id, target_ref: request.target_ref, material_digest: request.material_digest.value },
        presented_request_digest: request.request_digest,
        statement: "delegated owner-agent approval (conformance)",
        issued_at: nowIso(h.clock.fn),
      },
      producer_ref: "agent:claude-owner",
      source_ref: `agent-approval-${effect_id}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    { principal: "cadp-agent-owner" },
  );
}

async function evaluate(h: Harness, effect_id: string, evidence: string[]): Promise<{ outcome: string; reasons: string[] }> {
  const input = h.ingress.assembleAdmissionInput(effect_id, evidence);
  const evaluated = await h.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION") return { outcome: evaluated.kind, reasons: [] };
  return { outcome: evaluated.decision.outcome, reasons: [...evaluated.decision.reason_codes] };
}

const DELEGATED = { paramOverrides: { delegated_merge_producers: ["agent:claude-owner"] } };

test("AD1: with delegation, an exactly-scoped AGENT_DECISION satisfies the merge gate", async () => {
  const h = await makeHarness(DELEGATED);
  try {
    const base = sealMergeBase(h);
    const merge = sealOp(h, "PR_MERGE");
    const before = await evaluate(h, merge, [base.verification, base.review, base.workStep]);
    assert.equal(before.outcome, "REQUIRE_EVIDENCE");
    assert.ok(before.reasons.includes("HUMAN_DECISION"));
    const decision = agentApprove(h, merge);
    const after_ = await evaluate(h, merge, [base.verification, base.review, base.workStep, decision.evidence_id]);
    assert.equal(after_.outcome, "ALLOW", JSON.stringify(after_));
  } finally {
    h.close();
  }
});

test("AD2: the reference default delegates nothing — the same envelope satisfies no gate", async () => {
  const h = await makeHarness();
  try {
    const base = sealMergeBase(h);
    const merge = sealOp(h, "PR_MERGE");
    const decision = agentApprove(h, merge);
    const result = await evaluate(h, merge, [base.verification, base.review, base.workStep, decision.evidence_id]);
    assert.equal(result.outcome, "REQUIRE_EVIDENCE", "delegation is opt-in; an unlisted producer clears nothing");
    assert.ok(result.reasons.includes("HUMAN_DECISION"));
  } finally {
    h.close();
  }
});

test("AD3: POLICY_ACTIVATE is never delegated — constitution changes keep requiring a HUMAN_DECISION", async () => {
  const h = await makeHarness(DELEGATED);
  try {
    const activate = sealOp(h, "POLICY_ACTIVATE");
    const decision = agentApprove(h, activate);
    const result = await evaluate(h, activate, [decision.evidence_id]);
    assert.equal(result.outcome, "REQUIRE_EVIDENCE", JSON.stringify(result));
    assert.ok(result.reasons.includes("HUMAN_DECISION"));
  } finally {
    h.close();
  }
});

test("AD4: exact scope — an agent decision for X never clears Y; human approval is unaffected", async () => {
  const h = await makeHarness(DELEGATED);
  try {
    const base = sealMergeBase(h);
    const mergeX = sealOp(h, "PR_MERGE");
    const mergeY = sealOp(h, "PR_MERGE");
    const decisionX = agentApprove(h, mergeX);
    const crossed = await evaluate(h, mergeY, [base.verification, base.review, base.workStep, decisionX.evidence_id]);
    assert.equal(crossed.outcome, "REQUIRE_EVIDENCE", "X-scoped agent decision does not clear Y");

    const human = h.humanApprove(mergeY);
    const humanCleared = await evaluate(h, mergeY, [base.verification, base.review, base.workStep, human.evidence_id]);
    assert.equal(humanCleared.outcome, "ALLOW", "human_ok is unchanged by the delegation machinery");
  } finally {
    h.close();
  }
});

/** Seal a WORK_STEP so implementer_refs (product temporal-workflow) is populated in the merge input. */
function sealWorkStep(h: Harness): string {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "WORK_STEP",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000ad" },
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
}

function agentApproveAs(h: Harness, effect_id: string, principal: string, producer_ref: string): EvidenceEnvelopeV1 {
  const request = h.store.effectRequest(effect_id)!;
  return h.ingress.submitEvidence(
    {
      evidence_kind: "AGENT_DECISION",
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
      availability: "PRESENT",
      claim_schema: "cadp.human-decision.v1",
      claim: {
        principal: producer_ref,
        decision: "APPROVE",
        scope: { effect_id, target_ref: request.target_ref, material_digest: request.material_digest.value },
        presented_request_digest: request.request_digest,
        statement: "delegate approval (conformance)",
        issued_at: nowIso(h.clock.fn),
      },
      producer_ref,
      source_ref: `agent-${effect_id}-${producer_ref}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    { principal },
  );
}

test("AD5: a non-independent delegate cannot self-approve; an independent one can", async () => {
  // Two extra agent-surface delegates: one whose product collides with the WORK_STEP implementer
  // (temporal-workflow), one independent (claude-code).
  const identity_registry = [
    ...REFERENCE_IDENTITIES,
    { principal: "cadp-agent-wf", producer_ref: "agent:wf-clone", identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "agent-surface" } },
  ];
  const adapter_registry = [
    ...REFERENCE_ADAPTERS,
    { producer_ref: "agent:wf-clone", evidence_kinds: ["AGENT_DECISION"], source_relation: "INDEPENDENT_OBSERVATION" as const, produced_at_source: { kind: "NONE" as const } },
  ];
  const h = await makeHarness({
    paramOverrides: { delegated_merge_producers: ["agent:wf-clone", "agent:claude-owner"] },
    identityRegistry: identity_registry,
    adapterRegistry: adapter_registry,
  });
  try {
    const base = sealMergeBase(h);
    const ws = sealWorkStep(h); // implementer_refs = {workflow:cadp-work, product temporal-workflow}

    // Non-independent: agent:wf-clone shares the implementer's product → refused, distinct reason.
    const mergeA = sealOp(h, "PR_MERGE");
    const bad = agentApproveAs(h, mergeA, "cadp-agent-wf", "agent:wf-clone");
    const refused = await evaluate(h, mergeA, [base.verification, base.review, ws, bad.evidence_id]);
    assert.equal(refused.outcome, "REQUIRE_EVIDENCE", JSON.stringify(refused));
    assert.ok(refused.reasons.includes("agent_merge_not_independent"), JSON.stringify(refused.reasons));

    // Independent: agent:claude-owner (product claude-code) with the same implementer present → ALLOW.
    const mergeB = sealOp(h, "PR_MERGE");
    const good = agentApproveAs(h, mergeB, "cadp-agent-owner", "agent:claude-owner");
    const ok = await evaluate(h, mergeB, [base.verification, base.review, ws, good.evidence_id]);
    assert.equal(ok.outcome, "ALLOW", JSON.stringify(ok));
  } finally {
    h.close();
  }
});

/** Seal BACKEND_EXECUTION attributing the run's IMPLEMENTING MODEL (not the orchestrator). */
function sealBackendExecution(h: Harness, principal: string, producer_ref: string): string {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "BACKEND_EXECUTION",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000ad" },
        { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "WORKER" },
      ],
      availability: "PRESENT",
      claim_schema: "cadp.backend-execution.v1",
      claim: {
        requested: { provider: producer_ref.split(":")[1]!, model: "default" },
        observed: {
          provider: { availability: "PRESENT", value: producer_ref.split(":")[1]!, locator: "test" },
          model: { availability: "PRESENT", value: "test-model", locator: "test" },
          version: { availability: "UNKNOWN" }, run_id: { availability: "UNKNOWN" }, effort: { availability: "UNKNOWN" },
        },
      },
      producer_ref,
      source_ref: `be-${step += 1}`,
      source_relation: "SELF_REPORT",
    },
    { principal },
  ).evidence_id;
}

test("AD6 (12th-pilot regression): the implementer set includes the BACKEND model producer — a same-product delegate cannot self-approve a claude-implemented run", async () => {
  const h = await makeHarness(DELEGATED);
  try {
    const base = sealMergeBase(h);
    const workStep = sealWorkStep(h);
    // The run was IMPLEMENTED by the claude backend (product claude-code) — same product as the
    // delegated merge agent agent:claude-owner. Measured live (12th pilot): without the
    // BACKEND_EXECUTION clause in implementer_refs this auto-merged.
    const backend = sealBackendExecution(h, "cadp-backend-scan-claude", "backend-scan:claude");
    // Cross-product reviewer (grok), so the merge layer — not review independence — is what this
    // test isolates. (The claude reviewer over a claude-implemented run is refused too, separately:
    // the same implementer-set fix closes the §8.4 review hole; see the assertion below.)
    const grokReview = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", ...reviewBodyPair(h, "delegation grok review body") },
        producer_ref: "reviewer:grok",
        source_ref: `test-grok-${step += 1}`,
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      { principal: "cadp-reviewer-grok" },
    ).evidence_id;
    const merge = sealOp(h, "PR_MERGE");
    const decision = agentApprove(h, merge);
    const result = await evaluate(h, merge, [base.verification, grokReview, workStep, backend, decision.evidence_id]);
    assert.notEqual(result.outcome, "ALLOW", "a claude-product delegate must not clear a claude-implemented merge");
    assert.ok(result.reasons.includes("agent_merge_not_independent") || result.reasons.includes("HUMAN_DECISION"), JSON.stringify(result.reasons));

    // And the §8.4 review-layer consequence of the SAME fix: a claude review of this
    // claude-implemented run is not independent either.
    const withClaudeReview = await evaluate(h, merge, [base.verification, base.review, workStep, backend, decision.evidence_id]);
    assert.ok(withClaudeReview.reasons.includes("reviewer_product_not_independent"), JSON.stringify(withClaudeReview.reasons));
  } finally {
    h.close();
  }
});

test("AD6b: the same delegate still clears a grok-implemented run (cross-product delegation intact)", async () => {
  const h = await makeHarness(DELEGATED);
  try {
    const base = sealMergeBase(h);
    const workStep = sealWorkStep(h);
    const backend = sealBackendExecution(h, "cadp-backend-scan-grok", "backend-scan:grok");
    const merge = sealOp(h, "PR_MERGE");
    const decision = agentApprove(h, merge);
    const result = await evaluate(h, merge, [base.verification, base.review, workStep, backend, decision.evidence_id]);
    assert.equal(result.outcome, "ALLOW", JSON.stringify(result));
  } finally {
    h.close();
  }
});
