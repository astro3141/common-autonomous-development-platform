/**
 * TD §13.1 — C22/C22b (activation reorder + recovery), C26 (manifest/payload identity),
 * C30 (material completeness), C31 (kernel-config fail-closed), C35 (publication authority).
 * Guard-bites here also CLASSIFY: where the store-level CAS or the adapter remains the final
 * guard, removal of the kernel recheck changes nothing — defence-in-depth per TD §13.1.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import { buildTar, parseTar } from "../../cadp/kernel/policyBundle.ts";
import { evaluateAndSeal } from "../../cadp/kernel/evaluator.ts";
import type { EvaluatorPort, ResolvedAdmissionBundle } from "../../cadp/kernel/evaluator.ts";

after(() => stopSharedOpa());

test("C22 + C22b: activation CAS — the loser can never land; a fresh base inserts without gaps", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // B (rev 3) lands first under base seq 1 → seq 2.
    const b = await h.activatePolicy({ revision: 3, paramOverrides: { verification_max_age_s: 3599 } });
    assert.equal((b.admitted as { kind: string }).kind, "ADMITTED");
    assert.equal(h.store.activeActivation()!.seq, 2);
    assert.equal(h.store.activeActivation()!.revision, 3);

    // A (rev 2) still claims base seq 1 → refused pre-K6 (#13 ACTIVATION_BASE_STALE).
    const a = await h.activatePolicy({ revision: 2, expectedSeqOverride: 1 });
    const aResult = a.admitted as { kind: string; reason?: string };
    assert.equal(aResult.kind, "REFUSAL");
    assert.equal(aResult.reason, "ACTIVATION_BASE_STALE");
    assert.equal(h.store.activeActivation()!.seq, 2, "max(seq) stays 2; active remains rev 3");

    // C22b: a FRESH activation against the new base inserts cleanly as seq 3 — no gap
    // (with a sequence-generated seq this fails: the r2 bigserial defect).
    const fresh = await h.activatePolicy({ revision: 2 });
    assert.equal((fresh.admitted as { kind: string }).kind, "ADMITTED");
    const active = h.store.activeActivation()!;
    assert.equal(active.seq, 3);
    assert.equal(active.expected_prev_seq, 2);
    assert.equal(active.revision, 2);
  } finally {
    h.close();
  }
});

test("C22 guard-bite: removing #13 changes nothing — the store CAS is the load-bearing guard (defence-in-depth)", async () => {
  const h = await makeHarness({ disabledChecks: new Set(["recheck13_activation_base"]) });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const b = await h.activatePolicy({ revision: 3, paramOverrides: { verification_max_age_s: 3599 } });
    assert.equal((b.admitted as { kind: string }).kind, "ADMITTED");
    // Stale A is now ADMITTED (kernel check removed) but the dispatch hits the target-native
    // activation CAS: REJECTED_NO_EFFECT, zero wrong activation.
    const a = await h.activatePolicy({ revision: 2, expectedSeqOverride: 1 });
    const result = a.admitted as { kind: string; outcome?: { result: string } };
    assert.equal(result.kind, "ADMITTED");
    assert.equal(result.outcome?.result, "NO_EFFECT_CONFIRMED", JSON.stringify(result.outcome));
    assert.equal(h.store.activeActivation()!.seq, 2, "the superseded constitution was NOT reinstated");
    assert.equal(h.store.activeActivation()!.revision, 3);
  } finally {
    h.close();
  }
});

test("C26: a bundle whose manifest.revision does not match its payload digest is refused pre-K6; evaluator integrity failures seal no decision", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // Tamper: rebuild the rev-2 bundle with a manifest revision claiming a wrong payload hex.
    const { buildReferenceBundle } = await import("../../cadp/deployment/referencePolicy.ts");
    const clean = buildReferenceBundle({ ...h.policyInput, revision: 2 });
    const entries = parseTar(gunzipSync(clean));
    const tampered = gzipSync(
      buildTar(
        entries.map((e) =>
          e.path.replace(/^\/+/u, "") === ".manifest"
            ? { path: e.path, bytes: Buffer.from(JSON.stringify({ revision: `cadp-v04:policy:root@2#${"0".repeat(64)}`, roots: [""] }), "utf8") }
            : e,
        ),
      ),
    );
    const bundle_cas_ref = h.ingress.putBlob(tampered);
    const active = h.store.activeActivation()!;
    const { rawDigest } = await import("../../cadp/kernel/canonical.ts");
    const material = {
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(tampered), issuer_ref: "workflow:cadp-work" },
      bundle_cas_ref,
      expected_active_policy_ref: {
        policy_id: active.policy_id, revision: active.revision,
        content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: active.content_digest }, seq: active.seq,
      },
    };
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
    const request = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000c026", step_ordinal: 1, purpose: "policy-activate" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: { authority_ref: "cadp-store:k04", target_type: "POLICY_ACTIVATION", target_id: "k04" },
        operation_kind: "POLICY_ACTIVATE",
        material_schema: "cadp.policy-activate.v1",
        material_ref,
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    const human = h.humanApprove(request.effect_id);
    const input = h.ingress.assembleAdmissionInput(request.effect_id, [human.evidence_id]);
    const evaluated = await h.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION") throw new Error("expected decision");
    const refused = await h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id);
    assert.ok(refused.kind === "REFUSAL" && refused.reason === "MANIFEST_REVISION_MISMATCH", JSON.stringify(refused));
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined, "no policy_ref row written");

    // Evaluator integrity failure (revision echo mismatch at the port) seals NO decision.
    const decisionsBefore = (h.store.db.prepare("SELECT COUNT(*) AS n FROM policy_decision").get() as { n: number }).n;
    const lying: EvaluatorPort = {
      ensureLoaded: (active2) => h.evaluator.ensureLoaded(active2),
      identity: () => ({ ...h.evaluator.identity(), loaded_policy_content_digest: "not-the-active-content" }),
      integrityRef: () => h.evaluator.integrityRef(),
      evaluate: (bundle: ResolvedAdmissionBundle) => h.evaluator.evaluate(bundle),
    };
    const probe = sealScriptedRequest(h);
    const probeInput = h.ingress.assembleAdmissionInput(probe.request.effect_id, []);
    const outcome = await evaluateAndSeal(h.store, h.cas, h.ingress, lying, probeInput.input_digest.value, h.clock.fn);
    assert.equal(outcome.kind, "EVALUATION_UNAVAILABLE");
    const decisionsAfter = (h.store.db.prepare("SELECT COUNT(*) AS n FROM policy_decision").get() as { n: number }).n;
    assert.equal(decisionsAfter, decisionsBefore, "no PolicyDecisionV1 sealed");
    assert.ok(h.store.openIncidents().some((i) => (i.claim as { incident_kind?: string })?.incident_kind === "EVALUATOR_INTEGRITY_FAILURE"));
  } finally {
    h.close();
  }
});

test("C30: missing/corrupt CAS material refuses before K6 — no admission, no publication; guard-bite mints the effect", async () => {
  for (const biteMode of [false, true]) {
    const h = await makeHarness(biteMode ? { disabledChecks: new Set(["material_complete"]) } : {});
    try {
      h.sealReach();
      await h.sealTargetIdentity();
      // Scripted-target leg: the body CAS object vanishes after sealing.
      const { request, material } = sealScriptedRequest(h, { body: "to-be-deleted" });
      h.store.db.prepare("DELETE FROM cas_blob WHERE digest_key = ?").run(material["body_cas_key"]);
      const result = await runChain(h, request.effect_id);
      if (biteMode) {
        assert.equal(result.admitted?.kind, "ADMITTED", "guard-bite: incomplete material dispatched when #15 removed");
        assert.equal(h.target.effects.length, 1, "prohibited effect delta 1");
      } else {
        assert.ok(result.admitted?.kind === "REFUSAL" && result.admitted.reason === "MATERIAL_INCOMPLETE", JSON.stringify(result.admitted));
        assert.equal(h.store.admissionsByEffect(request.effect_id).length, 0, "refusal is pre-K6");
      }

      if (!biteMode) {
        // POLICY_ACTIVATE leg: nested bundle_cas_ref deleted → refusal, no policy_ref row.
        const { buildReferenceBundle } = await import("../../cadp/deployment/referencePolicy.ts");
        const { rawDigest } = await import("../../cadp/kernel/canonical.ts");
        const bundle = buildReferenceBundle({ ...h.policyInput, revision: 2 });
        const bundle_cas_ref = h.ingress.putBlob(bundle);
        h.store.db.prepare("DELETE FROM cas_blob WHERE digest_key = ?").run(bundle_cas_ref);
        const active = h.store.activeActivation()!;
        const activateMaterial = {
          proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(bundle), issuer_ref: "workflow:cadp-work" },
          bundle_cas_ref,
          expected_active_policy_ref: {
            policy_id: active.policy_id, revision: active.revision,
            content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: active.content_digest }, seq: active.seq,
          },
        };
        const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(activateMaterial), "utf8"));
        const activateRequest = h.ingress.sealEffectRequest(
          {
            effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000c030", step_ordinal: 1, purpose: "policy-activate" }),
            requester_ref: "workflow:cadp-work",
            work_bindings: [],
            target_ref: { authority_ref: "cadp-store:k04", target_type: "POLICY_ACTIVATION", target_id: "k04" },
            operation_kind: "POLICY_ACTIVATE",
            material_schema: "cadp.policy-activate.v1",
            material_ref,
            prior_effect_refs: [],
          },
          PRINCIPALS.workflow,
        );
        const human = h.humanApprove(activateRequest.effect_id);
        const input = h.ingress.assembleAdmissionInput(activateRequest.effect_id, [human.evidence_id]);
        const evaluated = await h.evaluate(input.input_digest.value);
        if (evaluated.kind !== "DECISION") throw new Error("expected decision");
        const refused = await h.pep.admitAndDispatch(activateRequest.effect_id, evaluated.decision.decision_id);
        assert.equal(refused.kind, "REFUSAL", JSON.stringify(refused));
        assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined, "no policy_ref publication");
        assert.equal(h.store.activeActivation()!.seq, active.seq, "no policy_activation append");
      }
    } finally {
      h.close();
    }
  }
});

test("C31: kernel-config violations are refused at #17 in all four shapes; active policy unchanged", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const cases: Array<{ name: string; configOverrides: Record<string, unknown> }> = [
      { name: "missing reach_attestation_max_age_s", configOverrides: { reach_attestation_max_age_s: undefined } },
      { name: "decision_ttl_s = 0", configOverrides: { decision_ttl_s: 0 } },
      { name: "unknown key data.cadp.extra", configOverrides: { extra: true } },
      {
        name: "wildcard principal",
        configOverrides: {
          identity_registry: [{ principal: "spiffe://cadp/*", producer_ref: "x", identity_class: { vendor: "v", product: "p", account: "a", process_class: "worker" } }],
        },
      },
    ];
    for (const testCase of cases) {
      const result = await h.activatePolicy({ revision: 2, configOverrides: testCase.configOverrides as never });
      const admitted = result.admitted as { kind: string; reason?: string };
      assert.equal(admitted.kind, "REFUSAL", `${testCase.name}: ${JSON.stringify(admitted)}`);
      assert.equal(admitted.reason, "KERNEL_CONFIG_INVALID", testCase.name);
      assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined, testCase.name);
      assert.equal(h.store.activeActivation()!.seq, 1, "active policy unchanged");
    }
  } finally {
    h.close();
  }
});

test("C35: publication happens only inside POLICY_ACTIVATE dispatch; conflicts refuse; guard-bite shows the adapter backstop", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // (i) there is no publication API: nothing else ever inserted policy_ref rev 2.
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined);

    // (ii) bundle bytes that do not re-digest to the proposed content_digest → refused pre-K6.
    const { buildReferenceBundle } = await import("../../cadp/deployment/referencePolicy.ts");
    const bundle = buildReferenceBundle({ ...h.policyInput, revision: 2 });
    const otherBundle = buildReferenceBundle({ ...h.policyInput, revision: 2, paramOverrides: { verification_max_age_s: 100 } });
    const bundle_cas_ref = h.ingress.putBlob(bundle);
    const { rawDigest } = await import("../../cadp/kernel/canonical.ts");
    const active = h.store.activeActivation()!;
    const badMaterial = {
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(otherBundle), issuer_ref: "workflow:cadp-work" },
      bundle_cas_ref, // bytes of `bundle`, digest of `otherBundle`
      expected_active_policy_ref: {
        policy_id: active.policy_id, revision: active.revision,
        content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: active.content_digest }, seq: active.seq,
      },
    };
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(badMaterial), "utf8"));
    const request = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000c035", step_ordinal: 1, purpose: "policy-activate" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: { authority_ref: "cadp-store:k04", target_type: "POLICY_ACTIVATION", target_id: "k04" },
        operation_kind: "POLICY_ACTIVATE",
        material_schema: "cadp.policy-activate.v1",
        material_ref,
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    const human = h.humanApprove(request.effect_id);
    const input = h.ingress.assembleAdmissionInput(request.effect_id, [human.evidence_id]);
    const evaluated = await h.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION") throw new Error("expected decision");
    const refused = await h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id);
    assert.ok(refused.kind === "REFUSAL" && refused.reason === "BUNDLE_DIGEST_MISMATCH", JSON.stringify(refused));
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined);

    // (iii) first (id, revision) publication lands; a different-bytes proposal for the same
    // (id, revision) is refused POLICY_REF_CONFLICT — never an inactive/replaced row.
    const good = await h.activatePolicy({ revision: 2 });
    assert.equal((good.admitted as { kind: string }).kind, "ADMITTED");
    const conflicting = await h.activatePolicy({ revision: 2, paramOverrides: { verification_max_age_s: 55 } });
    const conflictResult = conflicting.admitted as { kind: string; reason?: string };
    assert.equal(conflictResult.kind, "REFUSAL");
    assert.equal(conflictResult.reason, "POLICY_REF_CONFLICT");
    const stored = h.store.policyRef("cadp-v04:policy:root", 2)!;
    assert.ok(stored.content_digest.length === 64, "exactly one immutable published row");
  } finally {
    h.close();
  }
});
