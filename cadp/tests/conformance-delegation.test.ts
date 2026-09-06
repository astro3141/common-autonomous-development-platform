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
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { nowIso } from "../kernel/canonical.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";

after(() => stopSharedOpa());

const SHA = "c".repeat(40);
let step = 500;

function sealMergeBase(h: Harness): { verification: string; review: string } {
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
      claim: { verdict: "APPROVE", body_digest: "1".repeat(64) },
      producer_ref: "reviewer:claude-code",
      source_ref: `test-${step}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.reviewer,
  ).evidence_id;
  return { verification, review };
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
      }),
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
    const before = await evaluate(h, merge, [base.verification, base.review]);
    assert.equal(before.outcome, "REQUIRE_EVIDENCE");
    assert.ok(before.reasons.includes("HUMAN_DECISION"));
    const decision = agentApprove(h, merge);
    const after_ = await evaluate(h, merge, [base.verification, base.review, decision.evidence_id]);
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
    const result = await evaluate(h, merge, [base.verification, base.review, decision.evidence_id]);
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
    const crossed = await evaluate(h, mergeY, [base.verification, base.review, decisionX.evidence_id]);
    assert.equal(crossed.outcome, "REQUIRE_EVIDENCE", "X-scoped agent decision does not clear Y");

    const human = h.humanApprove(mergeY);
    const humanCleared = await evaluate(h, mergeY, [base.verification, base.review, human.evidence_id]);
    assert.equal(humanCleared.outcome, "ALLOW", "human_ok is unchanged by the delegation machinery");
  } finally {
    h.close();
  }
});
