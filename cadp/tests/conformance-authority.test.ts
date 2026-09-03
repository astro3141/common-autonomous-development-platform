/**
 * TD §13.1 — C6 (alternate credential path), C7 (admissionless commit), C12/C28
 * (independence + identity-class derivation), C13 (observed-without-locator), C14 (required
 * fact UNKNOWN), C17 (target mismatch), C18/C24 (human decision binding), C19/C29 (root kinds
 * + API reach), C27 (source-time freshness).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import { startKernelApi } from "../kernel/api.ts";
import { REFERENCE_ADAPTERS, REFERENCE_IDENTITIES, REFERENCE_REGO } from "../deployment/referencePolicy.ts";
import { nowIso } from "../kernel/canonical.ts";

after(() => stopSharedOpa());

test("C6: alternate_path_found=true fails every admission closed; guard-bite admits", async () => {
  for (const biteMode of [false, true]) {
    const h = await makeHarness(biteMode ? { disabledChecks: new Set(["recheck8_reach"]) } : {});
    try {
      h.sealReach(false);
      await h.sealTargetIdentity();
      const ok = sealScriptedRequest(h);
      const first = await runChain(h, ok.request.effect_id);
      assert.equal(first.admitted?.kind, "ADMITTED", "clean attestation admits");

      // A token leaks into the worker: the periodic probe now reports an alternate path.
      h.sealReach(true);
      const leaked = sealScriptedRequest(h, { body: "after-leak" });
      const second = await runChain(h, leaked.request.effect_id);
      if (biteMode) {
        assert.equal(second.admitted?.kind, "ADMITTED", "guard-bite: leak ignored when #8 removed");
      } else {
        assert.ok(
          second.admitted?.kind === "REFUSAL" && second.admitted.reason === "ALTERNATE_CREDENTIAL_PATH_FOUND",
          JSON.stringify(second.admitted),
        );
      }
    } finally {
      h.close();
    }
  }
});

test("C7: a directly-observed target commit without any admission row is an ADMISSIONLESS_COMMIT_OBSERVED incident", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // A rogue path performs the effect at the target without any K6 (test-only direct call).
    h.target.commitSilently("cadp-v04:effect:00000000-0000-7000-8000-00000000rogue", { body_digest: "rogue" });
    // The deployment-control audit compares target observations against kernel rows.
    const observed = h.target.effects;
    for (const effectId of observed) {
      if (h.store.admissionsByEffect(effectId).length === 0) {
        h.ingress.sealIncident("ADMISSIONLESS_COMMIT_OBSERVED", `target shows effect ${effectId} with no admission row`, [
          { authority_ref: "scripted:target", namespace: "SCRIPTED", object_id: "scripted-1" },
        ]);
      }
    }
    assert.ok(h.store.openIncidents().some((i) => (i.claim as { incident_kind?: string })?.incident_kind === "ADMISSIONLESS_COMMIT_OBSERVED"));
    // Scope hold now blocks new effects on that target.
    const blocked = sealScriptedRequest(h);
    const { admitted } = await runChain(h, blocked.request.effect_id);
    assert.ok(admitted?.kind === "REFUSAL" && admitted.reason === "SCOPE_HELD");
  } finally {
    h.close();
  }
});

// Registry variant used by C12/C14/C27/C28: extra producers for the failure shapes.
const VARIANT_IDENTITIES = [
  ...REFERENCE_IDENTITIES,
  { principal: "cadp-selfreview", producer_ref: "surface:selfdev", identity_class: { vendor: "openai", product: "codex-cli", account: "cadp-v04", process_class: "worker" } },
  { principal: "cadp-verifier-none", producer_ref: "verifier:none", identity_class: { vendor: "cadp", product: "importer", account: "cadp-v04", process_class: "evidence-adapter" } },
  { principal: "cadp-samereviewer", producer_ref: "reviewer:codex-2", identity_class: { vendor: "openai", product: "codex-cli", account: "cadp-v04", process_class: "worker" } },
];
const VARIANT_ADAPTERS = [
  ...REFERENCE_ADAPTERS,
  { producer_ref: "surface:selfdev", evidence_kinds: ["WORK_STEP", "REVIEW"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" as const } },
  { producer_ref: "verifier:none", evidence_kinds: ["VERIFICATION"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" as const } },
  { producer_ref: "reviewer:codex-2", evidence_kinds: ["REVIEW"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" as const } },
];

function verificationClaim(sha: string, completedAt: string) {
  return {
    head_sha: sha, clone_head: sha, porcelain_empty: true, conclusion: "success",
    runner: "node --test", started_at: completedAt, completed_at: completedAt, output_digest: "0".repeat(64),
  };
}

test("C12/C28: self-review and same-product review are denied on DERIVED classes; class self-assertion is rejected", async () => {
  const h = await makeHarness({
    configOverrides: { identity_registry: VARIANT_IDENTITIES, adapter_registry: VARIANT_ADAPTERS },
  });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // (C28 i) top-level class assertion rejected at the Ingress.
    assert.throws(
      () =>
        h.ingress.submitEvidence(
          {
            evidence_kind: "REVIEW",
            subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-x" }],
            availability: "PRESENT",
            claim_schema: "cadp.review.v1",
            claim: { verdict: "APPROVE", body_digest: "0".repeat(64) },
            producer_ref: "surface:selfdev",
            source_ref: "test",
            source_relation: "SELF_REPORT",
            identity_class: { product: "not-codex" },
          } as never,
          { principal: "cadp-selfreview" },
        ),
      (error: unknown) => (error as { reason?: string }).reason === "DRAFT_FIELD_FORBIDDEN",
    );

    // The same surface implements (WORK_STEP) and reviews (REVIEW) sha-x; in-claim class noise is ignored.
    const workStep = h.ingress.submitEvidence(
      {
        evidence_kind: "WORK_STEP",
        subject_bindings: [
          { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c012" },
          { authority_ref: "cadp-store:k04", namespace: "step-input", object_id: "i" },
          { authority_ref: "cadp-store:k04", namespace: "step-output", object_id: "sha-x" },
        ],
        availability: "PRESENT",
        claim_schema: "cadp.work-step.v1",
        claim: { step_ordinal: 1, summary: "implemented sha-x" },
        producer_ref: "surface:selfdev",
        source_ref: "test",
        source_relation: "SELF_REPORT",
      },
      { principal: "cadp-selfreview" },
    );
    const selfReview = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-x" }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "0".repeat(64), identity_class: { product: "definitely-not-codex" } },
        producer_ref: "surface:selfdev",
        source_ref: "test",
        source_relation: "SELF_REPORT",
      },
      { principal: "cadp-selfreview" },
    );
    const completedAt = nowIso(h.clock.fn);
    const verification = h.ingress.submitEvidence(
      {
        evidence_kind: "VERIFICATION",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-x" }],
        availability: "PRESENT",
        claim_schema: "cadp.verification.harness.v1",
        claim: verificationClaim("sha-x", completedAt),
        produced_at: completedAt,
        producer_ref: "verifier:harness",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.verifier,
    );
    const backend = h.ingress.submitEvidence(
      {
        evidence_kind: "BACKEND_EXECUTION",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c012" }],
        availability: "PRESENT",
        claim_schema: "cadp.backend.v1",
        claim: { requested: {}, observed: { model: { availability: "PRESENT", value: "gpt-5.3-codex", locator: "log#1" } } },
        producer_ref: "backend-scan:codex",
        source_ref: "scan",
        source_relation: "SELF_REPORT",
      },
      PRINCIPALS.backendScan,
    );

    // PR_CREATE-shaped request evaluated (decision only; no dispatch needed for C12).
    const material = { repo_id: "1", base_ref: "refs/heads/main", head_ref: "refs/heads/cadp/candidate/sha-x", head_sha: "sha-x", title_cas_key: h.cas.put(Buffer.from("t")), body_cas_key: h.cas.put(Buffer.from("b")) };
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
    const request = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000c012", step_ordinal: 99, purpose: "pr-create" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: "1" },
        operation_kind: "PR_CREATE",
        material_schema: "cadp.pr-create.v1",
        material_ref,
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    const input = h.ingress.assembleAdmissionInput(request.effect_id, [workStep.evidence_id, selfReview.evidence_id, verification.evidence_id, backend.evidence_id]);
    const evaluated = await h.evaluate(input.input_digest.value);
    assert.equal(evaluated.kind, "DECISION");
    if (evaluated.kind !== "DECISION") return;
    assert.equal(evaluated.decision.outcome, "DENY");
    assert.ok(evaluated.decision.reason_codes.includes("reviewer_is_the_implementer"), evaluated.decision.reason_codes.join(","));

    // Same-product (codex) reviewer who did NOT implement: still denied — DERIVED product class
    // equals the implementer's (independence predicate over identity_class.product).
    const sameProductReview = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-x" }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "1".repeat(64) },
        producer_ref: "reviewer:codex-2",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      { principal: "cadp-samereviewer" },
    );
    const input2 = h.ingress.assembleAdmissionInput(request.effect_id, [workStep.evidence_id, sameProductReview.evidence_id, verification.evidence_id, backend.evidence_id]);
    const evaluated2 = await h.evaluate(input2.input_digest.value);
    assert.equal(evaluated2.kind, "DECISION");
    if (evaluated2.kind !== "DECISION") return;
    assert.equal(evaluated2.decision.outcome, "DENY");
    assert.ok(evaluated2.decision.reason_codes.includes("reviewer_product_not_independent"), evaluated2.decision.reason_codes.join(","));
  } finally {
    h.close();
  }
});

test("C13: a PRESENT observed backend fact without a locator is rejected at the Ingress", async () => {
  const h = await makeHarness();
  try {
    assert.throws(
      () =>
        h.ingress.submitEvidence(
          {
            evidence_kind: "BACKEND_EXECUTION",
            subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c013" }],
            availability: "PRESENT",
            claim_schema: "cadp.backend.v1",
            claim: { requested: { model: "gpt-5.3-codex" }, observed: { model: { availability: "PRESENT", value: "gpt-5.3-codex" } } },
            producer_ref: "backend-scan:codex",
            source_ref: "scan",
            source_relation: "SELF_REPORT",
          },
          PRINCIPALS.backendScan,
        ),
      (error: unknown) => (error as { reason?: string }).reason === "OBSERVED_WITHOUT_LOCATOR",
    );
  } finally {
    h.close();
  }
});

test("C14: a policy-required observed fact that is UNKNOWN denies with required_fact_unknown", async () => {
  const h = await makeHarness({ paramOverrides: { require_backend_effort: true } });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const completedAt = nowIso(h.clock.fn);
    const verification = h.ingress.submitEvidence(
      {
        evidence_kind: "VERIFICATION",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-c14" }],
        availability: "PRESENT",
        claim_schema: "cadp.verification.harness.v1",
        claim: verificationClaim("sha-c14", completedAt),
        produced_at: completedAt,
        producer_ref: "verifier:harness",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.verifier,
    );
    const review = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-c14" }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "0".repeat(64) },
        producer_ref: "reviewer:claude-code",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.reviewer,
    );
    // Backend evidence: model PRESENT, effort UNKNOWN (honest observation).
    const backend = h.ingress.submitEvidence(
      {
        evidence_kind: "BACKEND_EXECUTION",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c014" }],
        availability: "PRESENT",
        claim_schema: "cadp.backend.v1",
        claim: { requested: {}, observed: { model: { availability: "PRESENT", value: "m", locator: "log#1" }, effort: { availability: "UNKNOWN" } } },
        producer_ref: "backend-scan:codex",
        source_ref: "scan",
        source_relation: "SELF_REPORT",
      },
      PRINCIPALS.backendScan,
    );
    const material = { repo_id: "1", base_ref: "refs/heads/main", head_ref: "refs/heads/cadp/candidate/sha-c14", head_sha: "sha-c14", title_cas_key: h.cas.put(Buffer.from("t")), body_cas_key: h.cas.put(Buffer.from("b")) };
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
    const request = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000c014", step_ordinal: 1, purpose: "pr-create" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: "1" },
        operation_kind: "PR_CREATE",
        material_schema: "cadp.pr-create.v1",
        material_ref,
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    const input = h.ingress.assembleAdmissionInput(request.effect_id, [verification.evidence_id, review.evidence_id, backend.evidence_id]);
    const evaluated = await h.evaluate(input.input_digest.value);
    assert.equal(evaluated.kind, "DECISION");
    if (evaluated.kind !== "DECISION") return;
    assert.equal(evaluated.decision.outcome, "DENY");
    assert.ok(evaluated.decision.reason_codes.includes("required_fact_unknown"));
  } finally {
    h.close();
  }
});

test("C17: a target the credential does not prove is refused as TARGET_MISMATCH", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity(); // proves scripted-1 only
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify({ body_digest: "x" }), "utf8"));
    const request = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000c017", step_ordinal: 1, purpose: "record-write" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: { authority_ref: "scripted:target", target_type: "SCRIPTED", target_id: "scripted-2" }, // same name shape, different id
        operation_kind: "SCRIPTED_WRITE",
        material_schema: "test.scripted-write.v1",
        material_ref,
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    const { admitted } = await runChain(h, request.effect_id);
    assert.ok(admitted?.kind === "REFUSAL" && admitted.reason === "TARGET_MISMATCH", JSON.stringify(admitted));
  } finally {
    h.close();
  }
});

test("C18/C24: a Human decision binds exactly one pre-sealed effect", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const x = sealScriptedRequest(h, { body: "x" });
    const y = sealScriptedRequest(h, { body: "y" });
    const approval = h.humanApprove(x.request.effect_id);

    // Present the X-scoped approval in Y's input → PEP #5 refuses.
    const inputY = h.ingress.assembleAdmissionInput(y.request.effect_id, [approval.evidence_id]);
    const evaluatedY = await h.evaluate(inputY.input_digest.value);
    if (evaluatedY.kind !== "DECISION") throw new Error("expected decision");
    const refused = await h.pep.admitAndDispatch(y.request.effect_id, evaluatedY.decision.decision_id);
    assert.ok(refused.kind === "REFUSAL" && refused.reason === "HUMAN_DECISION_SCOPE_MISMATCH", JSON.stringify(refused));

    // (C24 i) a POST whose presented_request_digest is stale/wrong is rejected at the Ingress.
    assert.throws(
      () =>
        h.ingress.submitEvidence(
          {
            evidence_kind: "HUMAN_DECISION",
            subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: x.request.effect_id }],
            availability: "PRESENT",
            claim_schema: "cadp.human-decision.v1",
            claim: {
              principal: "sso:a.t.laplace@gmail.com",
              decision: "APPROVE",
              scope: { effect_id: x.request.effect_id },
              presented_request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: "0".repeat(64) },
              issued_at: nowIso(h.clock.fn),
            },
            producer_ref: "human:astro3141",
            source_ref: "sso",
            source_relation: "INDEPENDENT_OBSERVATION",
          },
          PRINCIPALS.human,
        ),
      (error: unknown) => (error as { reason?: string }).reason === "HUMAN_DECISION_INVALID",
    );

    // (C24 ii) a REVIEW-producing principal cannot smuggle a HUMAN_DECISION.
    assert.throws(
      () =>
        h.ingress.submitEvidence(
          {
            evidence_kind: "HUMAN_DECISION",
            subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: x.request.effect_id }],
            availability: "PRESENT",
            claim_schema: "cadp.human-decision.v1",
            claim: { decision: "APPROVE", scope: { effect_id: x.request.effect_id } },
            producer_ref: "reviewer:claude-code",
            source_ref: "github-review",
            source_relation: "INDEPENDENT_OBSERVATION",
          },
          PRINCIPALS.reviewer,
        ),
      (error: unknown) => (error as { reason?: string }).reason === "EVIDENCE_KIND_FORBIDDEN",
    );

    // (C24 iii) a decision naming a non-existent effect (post-filled scope) is rejected.
    assert.throws(
      () =>
        h.ingress.submitEvidence(
          {
            evidence_kind: "HUMAN_DECISION",
            subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000none" }],
            availability: "PRESENT",
            claim_schema: "cadp.human-decision.v1",
            claim: { decision: "APPROVE", scope: { effect_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000none" } },
            producer_ref: "human:astro3141",
            source_ref: "sso",
            source_relation: "INDEPENDENT_OBSERVATION",
          },
          PRINCIPALS.human,
        ),
      (error: unknown) => (error as { reason?: string }).reason === "HUMAN_DECISION_INVALID",
    );
  } finally {
    h.close();
  }
});

test("C19/C29: root document kinds are rejected everywhere but the root listener; API reach matrix holds", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // C19/C29: GENESIS/BREAK_GLASS via ordinary submit_evidence rejected regardless of caller.
    for (const kind of ["GENESIS", "BREAK_GLASS"] as const) {
      assert.throws(
        () =>
          h.ingress.submitEvidence(
            {
              evidence_kind: kind,
              subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "root-operation", object_id: "x" }],
              availability: "PRESENT",
              claim_schema: "cadp.break-glass.v1",
              claim: {},
              producer_ref: "workflow:cadp-work",
              source_ref: "x",
              source_relation: "INDEPENDENT_OBSERVATION",
            },
            PRINCIPALS.workflow,
          ),
        (error: unknown) => (error as { reason?: string }).reason === "FORBIDDEN_FOR_PRINCIPAL",
      );
    }

    // API reach: worker token cannot seal requests or admit; foreign requester_ref rejected.
    const tokens = new Map<string, string>([
      ["tok-workflow", "cadp-workflow"],
      ["tok-worker", "cadp-worker-codex"],
    ]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    const call = async (token: string, method: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as { error?: string } };
    };
    const requestsBefore = (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_request").get() as { n: number }).n;

    const sealAsWorker = await call("tok-worker", "seal_effect_request", { effect_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c029" });
    assert.equal(sealAsWorker.status, 403);
    assert.equal(sealAsWorker.json.error, "FORBIDDEN_FOR_PRINCIPAL");
    const admitAsWorker = await call("tok-worker", "admit_and_dispatch", { effect_id: "x", decision_id: "y" });
    assert.equal(admitAsWorker.status, 403);
    const unauthenticated = await fetch(`http://127.0.0.1:${api.port}/get_effect_state`, { method: "POST", body: "{}" });
    assert.equal(unauthenticated.status, 401);

    // Foreign requester_ref via the workflow token: stamped identity wins.
    const seal = await call("tok-workflow", "seal_effect_request", {
      effect_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c029",
      requester_ref: "worker:codex-cli",
      work_bindings: [],
      target_ref: { authority_ref: "scripted:target", target_type: "SCRIPTED", target_id: "scripted-1" },
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref: h.ingress.putBlob(Buffer.from("{}")),
      prior_effect_refs: [],
    });
    assert.equal(seal.status, 422);
    assert.equal(seal.json.error, "REQUESTER_REF_MISMATCH");

    const requestsAfter = (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_request").get() as { n: number }).n;
    assert.equal(requestsAfter, requestsBefore, "store row counts unchanged");
    api.close();
  } finally {
    h.close();
  }
});

test("C27: freshness counts only under source-time authority; guard-bite admits stale evidence", async () => {
  const rego = REFERENCE_REGO.replace(
    "# ---------------------------------------------------------------- constraints",
    `# ---------------------------------------------------------------- constraints

constraints contains {"kind": "EVIDENCE_MAX_AGE", "args": ["VERIFICATION", params.verification_max_age_s]} if op == "SCRIPTED_WRITE"
`,
  );
  for (const biteMode of [false, true]) {
    const h = await makeHarness({
      rego,
      configOverrides: { identity_registry: VARIANT_IDENTITIES, adapter_registry: VARIANT_ADAPTERS },
      disabledChecks: biteMode ? new Set(["recheck4_freshness"]) : undefined,
    });
    try {
      h.sealReach();
      await h.sealTargetIdentity();
      const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      const claim = verificationClaim("sha-c27", tenDaysAgo);

      // (c) produced_at forged to now under a SOURCE contract → Ingress rejects.
      assert.throws(
        () =>
          h.ingress.submitEvidence(
            {
              evidence_kind: "VERIFICATION",
              subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-c27" }],
              availability: "PRESENT",
              claim_schema: "cadp.verification.harness.v1",
              claim,
              produced_at: nowIso(h.clock.fn),
              producer_ref: "verifier:harness",
              source_ref: "test",
              source_relation: "INDEPENDENT_OBSERVATION",
            },
            PRINCIPALS.verifier,
          ),
        (error: unknown) => (error as { reason?: string }).reason === "PRODUCED_AT_SOURCE_MISMATCH",
      );

      // (b) SOURCE producer, honest old produced_at → sealed; PEP freshness refuses (10 d > 3600 s).
      const sourceStale = h.ingress.submitEvidence(
        {
          evidence_kind: "VERIFICATION",
          subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-c27" }],
          availability: "PRESENT",
          claim_schema: "cadp.verification.harness.v1",
          claim,
          produced_at: tenDaysAgo,
          producer_ref: "verifier:harness",
          source_ref: "test",
          source_relation: "INDEPENDENT_OBSERVATION",
        },
        PRINCIPALS.verifier,
      );
      // (a) NONE producer, same claim bytes → sealed with a fresh receipt-time produced_at,
      // which derives to NONE and can NEVER satisfy EVIDENCE_MAX_AGE.
      const noneDerived = h.ingress.submitEvidence(
        {
          evidence_kind: "VERIFICATION",
          subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "sha-c27" }],
          availability: "PRESENT",
          claim_schema: "cadp.verification.harness.v1",
          claim,
          producer_ref: "verifier:none",
          source_ref: "importer",
          source_relation: "INDEPENDENT_OBSERVATION",
        },
        { principal: "cadp-verifier-none" },
      );
      assert.equal(sourceStale.claim_digest!.value, noneDerived.claim_digest!.value, "claim bytes identical in (a)/(b)");

      const requestB = sealScriptedRequest(h, { body: "with-stale-source" });
      const b = await runChain(h, requestB.request.effect_id, [sourceStale.evidence_id]);
      const requestA = sealScriptedRequest(h, { body: "with-none-derived" });
      const a = await runChain(h, requestA.request.effect_id, [noneDerived.evidence_id]);
      if (biteMode) {
        assert.equal(b.admitted?.kind, "ADMITTED", "guard-bite: stale admitted when #4/#16 removed");
        assert.equal(a.admitted?.kind, "ADMITTED");
      } else {
        assert.ok(b.admitted?.kind === "REFUSAL" && b.admitted.reason === "EVIDENCE_STALE", JSON.stringify(b.admitted));
        assert.ok(a.admitted?.kind === "REFUSAL" && a.admitted.reason === "EVIDENCE_FRESHNESS_UNKNOWN", JSON.stringify(a.admitted));
      }
    } finally {
      h.close();
    }
  }
});
