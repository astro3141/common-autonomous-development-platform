/**
 * TD §13.1 — C1 (stale policy), C2 (wrong work revision), C3/C5 (wrong effect/decision
 * binding), C32 (AdmissionInput exactness), C38 (K4 complete-input binding), each with the
 * guard-bite check where the TD requires one.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";

after(() => stopSharedOpa());

test("C1: decision under revision r is refused after r+1 activates; guard-bite admits", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const input = h.ingress.assembleAdmissionInput(request.effect_id, []);
    const evaluated = await h.evaluate(input.input_digest.value);
    assert.equal(evaluated.kind, "DECISION");
    if (evaluated.kind !== "DECISION") return;

    // Activate revision 2 (full governed POLICY_ACTIVATE chain with Human approval).
    const activation = await h.activatePolicy({ revision: 2 });
    assert.equal((activation.admitted as { kind: string }).kind, "ADMITTED");
    assert.equal(h.store.activeActivation()!.seq, 2);

    const refused = await h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id);
    assert.ok(refused.kind === "REFUSAL" && refused.reason === "POLICY_NOT_ACTIVE", JSON.stringify(refused));
    assert.equal(h.store.admissionsByEffect(request.effect_id).length, 0, "no admission row");
    assert.equal(h.target.committed.size, 0, "target delta 0");
  } finally {
    h.close();
  }
});

test("C1 guard-bite: with recheck #1 removed the stale-policy admission DOES occur", async () => {
  const h = await makeHarness({ disabledChecks: new Set(["recheck1_policy_active"]) });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const input = h.ingress.assembleAdmissionInput(request.effect_id, []);
    const evaluated = await h.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION") throw new Error("expected decision");
    const activation = await h.activatePolicy({ revision: 2 });
    assert.equal((activation.admitted as { kind: string }).kind, "ADMITTED");
    const admitted = await h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id);
    assert.equal(admitted.kind, "ADMITTED", "check removed → prohibited effect occurs (load-bearing)");
    assert.equal(h.target.committed.size, 1, "target delta 1");
  } finally {
    h.close();
  }
});

test("C2: evidence bound to sha_a while the subject moved to sha_b is refused at #3; guard-bite admits", async () => {
  for (const biteMode of [false, true]) {
    const h = await makeHarness(biteMode ? { disabledChecks: new Set(["subject_revision_fresh"]) } : {});
    try {
      h.sealReach();
      await h.sealTargetIdentity();
      const { request } = sealScriptedRequest(h);
      // REVIEW evidence bound to subject at revision sha-a on the scripted authority.
      const review = h.ingress.submitEvidence(
        {
          evidence_kind: "REVIEW",
          subject_bindings: [
            { authority_ref: "scripted:target", namespace: "commit", object_id: "sha-a", revision_or_version: "sha-a" },
          ],
          availability: "PRESENT",
          claim_schema: "cadp.review.v1",
          claim: { verdict: "APPROVE", body_digest: "d".repeat(64) },
          producer_ref: "reviewer:claude-code",
          source_ref: "test",
          source_relation: "INDEPENDENT_OBSERVATION",
        },
        PRINCIPALS.reviewer,
      );
      // The target now reports the subject at sha-b (moved).
      h.target.onRevision = () => ({ revision_or_version: "sha-b", availability: "PRESENT" });
      const { evaluated, admitted } = await runChain(h, request.effect_id, [review.evidence_id]);
      assert.equal(evaluated.kind, "DECISION");
      if (biteMode) {
        assert.ok(admitted?.kind === "ADMITTED", "guard-bite: drift admitted when check removed");
        assert.equal(h.target.committed.size, 1);
      } else {
        assert.ok(admitted?.kind === "REFUSAL" && admitted.reason === "SUBJECT_REVISION_DRIFT", JSON.stringify(admitted));
        assert.equal(h.target.committed.size, 0, "PR/target delta 0");
      }
    } finally {
      h.close();
    }
  }
});

test("C3/C5: a decision for effect X presented with effect Y is refused; reuse across requests refused; guard-bite admits", async () => {
  for (const biteMode of [false, true]) {
    const h = await makeHarness(biteMode ? { disabledChecks: new Set(["recheck2_exact_binding"]) } : {});
    try {
      h.sealReach();
      await h.sealTargetIdentity();
      const x = sealScriptedRequest(h, { body: "payload-x" });
      const y = sealScriptedRequest(h, { body: "payload-y" });
      const inputX = h.ingress.assembleAdmissionInput(x.request.effect_id, []);
      const evaluated = await h.evaluate(inputX.input_digest.value);
      if (evaluated.kind !== "DECISION") throw new Error("expected decision");
      const result = await h.pep.admitAndDispatch(y.request.effect_id, evaluated.decision.decision_id);
      if (biteMode) {
        assert.equal(result.kind, "ADMITTED", "guard-bite: cross-effect decision admitted when binding check removed");
      } else {
        assert.ok(result.kind === "REFUSAL" && result.reason === "DECISION_INPUT_MISMATCH", JSON.stringify(result));
        assert.equal(h.store.admissionsByEffect(y.request.effect_id).length, 0);
      }
    } finally {
      h.close();
    }
  }
});

test("C32: two assemblies are two exact records; admission binds only the matching pair", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const input1 = h.ingress.assembleAdmissionInput(request.effect_id, []);
    const input2 = h.ingress.assembleAdmissionInput(request.effect_id, []);
    assert.notEqual(input1.input_digest.value, input2.input_digest.value, "assembled_at is inside the digest — no collapse");
    assert.equal(h.store.admissionInputsByEffect(request.effect_id).length, 2, "two admission_input rows");
    const evaluated = await h.evaluate(input1.input_digest.value);
    if (evaluated.kind !== "DECISION") throw new Error("expected decision");
    assert.equal(evaluated.decision.admission_input_digest.value, input1.input_digest.value);
    const admitted = await h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id);
    assert.equal(admitted.kind, "ADMITTED", "matching pair admits");
  } finally {
    h.close();
  }
});

test("C38: decisions are a function of input_digest + policy content + now only; non-K4 columns change nothing", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const review = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "commit", object_id: "sha-1" }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "e".repeat(64) },
        producer_ref: "reviewer:claude-code",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.reviewer,
    );
    const input = h.ingress.assembleAdmissionInput(request.effect_id, [review.evidence_id]);
    const first = await h.evaluate(input.input_digest.value);
    if (first.kind !== "DECISION") throw new Error("expected decision");

    // (i)/(ii): corrupt the operational received_at column (test-only raw write on an impl
    // column, which is exactly what C38 licenses) and re-evaluate the same input digest.
    h.store.db.prepare("UPDATE evidence_envelope SET received_at = '1999-01-01T00:00:00.000Z' WHERE evidence_id = ?").run(review.evidence_id);
    const second = await h.evaluate(input.input_digest.value);
    if (second.kind !== "DECISION") throw new Error("expected decision");
    assert.equal(second.decision.outcome, first.decision.outcome);
    assert.deepEqual(second.decision.reason_codes, first.decision.reason_codes);
    assert.deepEqual(second.decision.constraints, first.decision.constraints);

    // (iii): a re-sealed envelope (new produced_at) is a NEW record with a NEW digest; the old
    // input still names the old digest and its decision is unchanged.
    const resealed = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "commit", object_id: "sha-1" }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "e".repeat(64) },
        producer_ref: "reviewer:claude-code",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.reviewer,
    );
    assert.notEqual(resealed.envelope_digest.value, review.envelope_digest.value);
    const inputWithNew = h.ingress.assembleAdmissionInput(request.effect_id, [resealed.evidence_id]);
    assert.notEqual(inputWithNew.input_digest.value, input.input_digest.value, "using new evidence requires a NEW AdmissionInputV1");
  } finally {
    h.close();
  }
});

test("C38 guard-bite: with verify-on-read removed, a corrupted K4-bound claim is admitted", async () => {
  for (const biteMode of [false, true]) {
    const h = await makeHarness(biteMode ? { disabledChecks: new Set(["verify_on_read"]) } : {});
    try {
      h.sealReach();
      await h.sealTargetIdentity();
      const { request } = sealScriptedRequest(h);
      const review = h.ingress.submitEvidence(
        {
          evidence_kind: "REVIEW",
          subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "commit", object_id: "sha-2" }],
          availability: "PRESENT",
          claim_schema: "cadp.review.v1",
          claim: { verdict: "APPROVE", body_digest: "f".repeat(64) },
          producer_ref: "reviewer:claude-code",
          source_ref: "test",
          source_relation: "INDEPENDENT_OBSERVATION",
        },
        PRINCIPALS.reviewer,
      );
      const input = h.ingress.assembleAdmissionInput(request.effect_id, [review.evidence_id]);
      const evaluated = await h.evaluate(input.input_digest.value);
      if (evaluated.kind !== "DECISION") throw new Error("expected decision");
      // Flip a byte in the stored claim (C4-style corruption) AFTER evaluation.
      const stored = h.store.db.prepare("SELECT envelope_json FROM evidence_envelope WHERE evidence_id = ?").get(review.evidence_id) as { envelope_json: string };
      const tampered = stored.envelope_json.replace('"verdict":"APPROVE"', '"verdict":"TAMPERED"');
      h.store.db.prepare("UPDATE evidence_envelope SET envelope_json = ? WHERE evidence_id = ?").run(tampered, review.evidence_id);
      const result = await h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id);
      if (biteMode) {
        assert.equal(result.kind, "ADMITTED", "guard-bite: corruption admitted when verify-on-read removed");
      } else {
        assert.ok(result.kind === "REFUSAL", JSON.stringify(result));
        // DIGEST_CORRUPTION incident + scope hold (C4 semantics).
        const incidents = h.store.openIncidents();
        assert.ok(incidents.some((i) => (i.claim as { incident_kind?: string })?.incident_kind === "DIGEST_CORRUPTION"));
      }
    } finally {
      h.close();
    }
  }
});
