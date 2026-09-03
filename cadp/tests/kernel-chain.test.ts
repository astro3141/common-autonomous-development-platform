/**
 * Smoke: the full constitutional chain K3 → K4 → K5(OPA) → K6 → dispatch → K7 against the
 * reference composition (real store, real OPA, scripted target).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa } from "./support/harness.ts";

after(() => stopSharedOpa());

test("positive chain: RECORD-shaped scripted effect admits once and commits", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const { evaluated, admitted } = await runChain(h, request.effect_id);
    assert.equal(evaluated.kind, "DECISION");
    if (evaluated.kind !== "DECISION") return;
    assert.equal(evaluated.decision.outcome, "ALLOW");
    assert.ok(admitted !== undefined && admitted.kind === "ADMITTED", JSON.stringify(admitted));
    assert.equal(admitted.outcome.result, "COMMITTED");
    assert.equal(admitted.admission.dispatch_ordinal, 1);
    // Store now holds exactly one of each record kind for this effect.
    assert.equal(h.store.admissionsByEffect(request.effect_id).length, 1);
    assert.equal(h.store.outcomesByEffect(request.effect_id).length, 1);
    // The COMMITTED outcome references sealed TARGET_RECONCILIATION evidence.
    const outcome = h.store.outcomesByEffect(request.effect_id)[0]!;
    assert.ok(outcome.evidence_ref !== undefined);
    assert.ok(h.store.evidenceById(outcome.evidence_ref)?.evidence_kind === "TARGET_RECONCILIATION");
  } finally {
    h.close();
  }
});

test("fail-closed: no reach attestation → refusal; no identity → refusal", async () => {
  const h = await makeHarness();
  try {
    const { request } = sealScriptedRequest(h);
    const first = await runChain(h, request.effect_id);
    assert.ok(first.admitted?.kind === "REFUSAL" && first.admitted.reason === "CREDENTIAL_REACH_UNATTESTED");
    h.sealReach();
    const second = await runChain(h, request.effect_id);
    assert.ok(second.admitted?.kind === "REFUSAL" && second.admitted.reason === "TARGET_MISMATCH", JSON.stringify(second.admitted));
    assert.equal(h.store.admissionsByEffect(request.effect_id).length, 0);
  } finally {
    h.close();
  }
});
