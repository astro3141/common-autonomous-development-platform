/**
 * Proposal-only planner conformance (#61 roadmap; Spec §8.2 read-only discovery).
 *
 *   PL1  a valid proposal (with surrounding prose) parses into the exact typed items
 *   PL2  fail-closed sweep: malformed bounds, unknown keys, empty/oversized lists, non-JSON —
 *        a proposal is never repaired, defaulted or partially accepted
 *   PL3  provenance is registry-bound: only the planner producer may seal WORK_PROPOSAL
 *   PL4  a proposal confers no authority: WORK_START admission is unchanged by its presence —
 *        malformed bounds still DENY even when the request binds a sealed proposal
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import { parseWorkProposal, ProposalParseError, MAX_PROPOSAL_ITEMS, MAX_WORK_ITEM_CHARS } from "../product/planner.ts";
import type { WorkProposalV1 } from "../product/planner.ts";
import { IngressRejection } from "../kernel/ingress.ts";
import type { KernelClient } from "../clients/kernelClient.ts";
import type { EvidenceDraft } from "../kernel/ingress.ts";
import { submitPlanEvidence } from "../live/ops.ts";
import { backendScanClient, backendScanPrincipal } from "../product/backendExecution.ts";

after(() => stopSharedOpa());

const VALID: WorkProposalV1 = {
  schema: "cadp.work-proposal.v1",
  items: [
    { work_item: "add strict parsing to the stats module", max_steps: 6, max_effects: 4, rationale: "single file, testable" },
    { work_item: "document the record vertical", max_steps: 4, max_effects: 2, rationale: "docs only" },
  ],
  notes: "two independent items",
};

test("PL1: a valid proposal parses exactly, even with surrounding prose", () => {
  const parsed = parseWorkProposal(`Here is my plan:\n${JSON.stringify(VALID, null, 2)}\n`);
  assert.deepEqual(parsed, VALID);
  assert.deepEqual(parseWorkProposal(JSON.stringify({ schema: VALID.schema, items: [VALID.items[0]] })), {
    schema: VALID.schema,
    items: [VALID.items[0]],
  });
});

test("PL2: every malformed proposal shape fails closed", () => {
  const cases: Array<[string, string]> = [
    ["no JSON", "I could not produce a plan."],
    ["wrong schema", JSON.stringify({ ...VALID, schema: "v2" })],
    ["empty items", JSON.stringify({ ...VALID, items: [] })],
    ["oversized", JSON.stringify({ ...VALID, items: Array.from({ length: MAX_PROPOSAL_ITEMS + 1 }, () => VALID.items[0]) })],
    ["work_item over the char cap", JSON.stringify({ ...VALID, items: [{ ...VALID.items[0], work_item: "x".repeat(MAX_WORK_ITEM_CHARS + 1) }] })],
    ["unknown top key", JSON.stringify({ ...VALID, authority: "yes" })],
    ["unknown item key", JSON.stringify({ ...VALID, items: [{ ...VALID.items[0], admit: true }] })],
    ["zero bound", JSON.stringify({ ...VALID, items: [{ ...VALID.items[0], max_steps: 0 }] })],
    ["fractional bound", JSON.stringify({ ...VALID, items: [{ ...VALID.items[0], max_effects: 2.5 }] })],
    ["null bound (NaN over JSON)", JSON.stringify({ ...VALID, items: [{ ...VALID.items[0], max_steps: null }] })],
    ["missing work_item", JSON.stringify({ ...VALID, items: [{ max_steps: 3, max_effects: 2, rationale: "r" }] })],
    ["empty work_item", JSON.stringify({ ...VALID, items: [{ ...VALID.items[0], work_item: "  " }] })],
  ];
  for (const [label, stdout] of cases) {
    assert.throws(() => parseWorkProposal(stdout), ProposalParseError, label);
  }
});

test("PL3: only the registered planner producer may seal WORK_PROPOSAL", async () => {
  const h = await makeHarness();
  try {
    const draft = {
      evidence_kind: "WORK_PROPOSAL" as const,
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-intent", object_id: "i".repeat(64) }],
      availability: "PRESENT" as const,
      claim_schema: "cadp.work-proposal.v1",
      claim: { ...VALID, intent: "improve the stats module" },
      source_ref: "planner:test:1",
      source_relation: "SELF_REPORT" as const,
    };
    const sealed = h.ingress.submitEvidence({ ...draft, producer_ref: "planner:claude-code" }, { principal: "cadp-planner" });
    assert.equal(sealed.evidence_kind, "WORK_PROPOSAL");
    assert.equal(sealed.producer_ref, "planner:claude-code");

    // The workflow producer is not registered for WORK_PROPOSAL: provenance is registry-bound.
    assert.throws(
      () => h.ingress.submitEvidence({ ...draft, producer_ref: "workflow:cadp-work", source_ref: "planner:test:2" }, PRINCIPALS.workflow),
      IngressRejection,
    );
  } finally {
    h.close();
  }
});

test("PL4: a sealed proposal changes nothing about WORK_START admission (proposal != authority)", async () => {
  const h = await makeHarness();
  try {
    const proposal = h.ingress.submitEvidence(
      {
        evidence_kind: "WORK_PROPOSAL",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-intent", object_id: "j".repeat(64) }],
        availability: "PRESENT",
        claim_schema: "cadp.work-proposal.v1",
        claim: { ...VALID, intent: "x" },
        producer_ref: "planner:claude-code",
        source_ref: "planner:test:3",
        source_relation: "SELF_REPORT",
      },
      { principal: "cadp-planner" },
    );

    let ordinal = 100;
    const evalStart = async (bounds: unknown): Promise<string> => {
      const material = { workflow_id: "cadp-work-x", workflow_type: "cadpWork", task_queue: "cadp-worker", bounds };
      const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
      const effect_id = h.ingress.allocateEffectId({
        schema: "cadp.allocation-key.v1",
        work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
        step_ordinal: (ordinal += 1),
        purpose: "work-start",
      });
      h.ingress.sealEffectRequest(
        {
          effect_id,
          requester_ref: "workflow:cadp-work",
          work_bindings: [
            { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${effect_id}` },
            { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: proposal.evidence_id },
          ],
          target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "cadp-v04" },
          operation_kind: "WORK_START",
          material_schema: "cadp.work-start.v1",
          material_ref,
          prior_effect_refs: [],
        },
        PRINCIPALS.workflow,
      );
      // The proposal envelope rides along as ordinary evidence; it must flip nothing.
      const input = h.ingress.assembleAdmissionInput(effect_id, [proposal.evidence_id]);
      const evaluated = await h.evaluate(input.input_digest.value);
      return evaluated.kind === "DECISION" ? evaluated.decision.outcome : evaluated.kind;
    };

    assert.equal(await evalStart({ max_steps: 6, max_effects: 4 }), "ALLOW");
    assert.equal(await evalStart({ max_steps: null, max_effects: 4 }), "DENY", "a bound proposal cannot launder malformed bounds");
  } finally {
    h.close();
  }
});

test("PL5: planner sealing emits proposal and role-qualified backend siblings under distinct principals", async () => {
  for (const provider of ["claude", "grok", "codex"] as const) {
    const principal = provider === "codex" ? "cadp-backend-scan" : `cadp-backend-scan-${provider}`;
    assert.equal(backendScanPrincipal(provider), principal);
    const selected = backendScanClient(provider, { api_url: "http://kernel.invalid", tokens: { [principal]: `${provider}-scan-token` } });
    assert.equal(selected.token, `${provider}-scan-token`, "planner uses the provider's scan token, never its planner token");
    const submitted: Array<{ channel: "planner" | "scan"; draft: EvidenceDraft }> = [];
    const fakeClient = (channel: "planner" | "scan"): KernelClient => ({
      submitEvidence: async (draft: EvidenceDraft) => {
        submitted.push({ channel, draft });
        return { ...draft, evidence_id: `${channel}-id`, envelope_digest: { alg: "sha256", value: "d".repeat(64) }, sealed_at: "2026-01-01T00:00:00.000Z" };
      },
    } as unknown as KernelClient);

    const ids = await submitPlanEvidence({
      intent: "split the work",
      repo_id: "42",
      base_sha: "a".repeat(40),
      provider,
      result: { proposal: VALID, stdout_digest: "b".repeat(64) },
      planner_client: fakeClient("planner"),
      scan_client: fakeClient("scan"),
    });
    assert.deepEqual(ids, { proposal_evidence_id: "planner-id", backend_evidence_id: "scan-id" });
    assert.equal(submitted.length, 2);
    const proposal = submitted[0]!;
    const backend = submitted[1]!;
    assert.equal(proposal.channel, "planner");
    assert.equal(proposal.draft.evidence_kind, "WORK_PROPOSAL");
    assert.equal(proposal.draft.producer_ref, provider === "claude" ? "planner:claude-code" : `planner:${provider}`);
    assert.equal(backend.channel, "scan");
    assert.equal(backend.draft.evidence_kind, "BACKEND_EXECUTION");
    assert.equal(backend.draft.producer_ref, `backend-scan:${provider}`);
    assert.deepEqual(backend.draft.subject_bindings.slice(0, 2), proposal.draft.subject_bindings);
    assert.deepEqual(backend.draft.subject_bindings.at(-1), {
      authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "PLANNER",
    });
    const observed = (backend.draft.claim as { observed: { model: { availability: string } } }).observed;
    assert.equal(observed.model.availability, "UNKNOWN", "unmeasured planner model remains UNKNOWN");
  }
});
