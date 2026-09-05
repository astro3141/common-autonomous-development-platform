/**
 * cadp.improvement-intake.v1 → v1.1 governed transition conformance (#107 S1/S3/S4/S5 against the
 * landed #117 contract). Real store + real OPA sidecar + real kernel path throughout: every
 * positive goes through `admitAndDispatch`, and every negative is a policy outcome or a
 * target-authoritative store refusal, never a stub.
 *
 * The controls are named for the #117 §12 falsification table. Guard-bite controls (FC14) mutate
 * the policy source or disable a registry-declared ingress rule and assert the exact exploit
 * reproduces, so each new predicate is individually load-bearing (#107 S5).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness, HarnessOptions } from "./support/harness.ts";
import { REFERENCE_REGO, REFERENCE_ADAPTERS, REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import type { EvidenceEnvelopeV1, SubjectBinding } from "../kernel/records.ts";
import { buildFindingAdmission, findingWorkBinding, refOf, submitResolution } from "../product/improvement/intakeAdapter.ts";
import type { ImprovementFindingResolutionClaimV1 } from "../product/improvement/contracts.ts";
import { GOVERNED_PRODUCER_REF, subjectTuple } from "../product/improvement/transition.ts";
import type { AuthorityTextRuleV1, GovernedDescendantDraftV1 } from "../product/improvement/transition.ts";
import {
  activateResolutionEntries, appliesTo, deterministicDraft, governedHumanClearing, humanDecision,
  humanDraft, makeFinding, makeRule, nextId, sealTransition, sha256, startRun, submitAuthorityObservation,
  submitAuthorityResolution, submitObservation,
} from "./support/transition.ts";

after(() => stopSharedOpa());

// ---------------------------------------------------------------- shared evaluation helpers

/** An intake implementation WORK_START bound to a tip — the barrier consumer (#98 §7/§8). */
async function evalWorkStart(h: Harness, finding: EvidenceEnvelopeV1, evidence: EvidenceEnvelopeV1[]): Promise<{ outcome: string; reason_codes: string[] }> {
  const admission = buildFindingAdmission({ finding_ref: refOf(finding), purpose: "IMPLEMENTATION", conflict_complete: true });
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify({ finding_admission: admission, bounds: {} }), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: nextId(), purpose: "work-start",
  });
  h.ingress.sealEffectRequest(
    {
      effect_id, requester_ref: "workflow:cadp-work",
      work_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${effect_id}` },
        findingWorkBinding(refOf(finding)),
      ],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "cadp-v04" },
      operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", material_ref, prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const input = h.ingress.assembleAdmissionInput(effect_id, evidence.map((e) => e.evidence_id));
  const evaluated = await h.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION") return { outcome: evaluated.kind, reason_codes: [] };
  return { outcome: evaluated.decision.outcome, reason_codes: [...evaluated.decision.reason_codes] };
}

/** A non-index mutation bound to a tip (GIT_PUSH / PR_MERGE / POLICY_ACTIVATE containment). */
async function evalBoundMutation(
  h: Harness,
  op: "GIT_PUSH" | "PR_MERGE" | "POLICY_ACTIVATE",
  findings: EvidenceEnvelopeV1[],
  evidence: EvidenceEnvelopeV1[],
  opts: { humanApprove?: boolean } = {},
): Promise<{ outcome: string; reason_codes: string[] }> {
  const spec = op === "GIT_PUSH"
    ? { purpose: "git-push", schema: "cadp.git-push.v1", material: { repo_id: "r", ref: "refs/heads/cadp/candidate/x", new_sha: "x", expected_old_sha: "0".repeat(40) }, target: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: "r" } }
    : op === "PR_MERGE"
      ? { purpose: "pr-merge", schema: "cadp.pr-merge.v1", material: { repo_id: "r", pr_number: 1, expected_head_sha: "h".repeat(40) }, target: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: "r" } }
      : { purpose: "policy-activate", schema: "cadp.policy-activate.v1", material: { note: "intake-bound candidate" }, target: { authority_ref: "cadp-store:k04", target_type: "POLICY_ACTIVATION", target_id: "k04" } };
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(spec.material), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: nextId(), purpose: spec.purpose,
  });
  h.ingress.sealEffectRequest(
    {
      effect_id, requester_ref: "workflow:cadp-work",
      work_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${effect_id}` },
        ...findings.map((f) => findingWorkBinding(refOf(f))),
      ],
      target_ref: spec.target, operation_kind: op, material_schema: spec.schema, material_ref, prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const ids = evidence.map((e) => e.evidence_id);
  if (opts.humanApprove) ids.push(h.humanApprove(effect_id).evidence_id);
  const input = h.ingress.assembleAdmissionInput(effect_id, ids);
  const evaluated = await h.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION") return { outcome: evaluated.kind, reason_codes: [] };
  return { outcome: evaluated.decision.outcome, reason_codes: [...evaluated.decision.reason_codes] };
}

/** A harness whose ACTIVE policy already carries the deterministic rule table (§11 step 0″). */
function withRules(rules: readonly unknown[], over: HarnessOptions = {}): HarnessOptions {
  return { ...over, paramOverrides: { ...over.paramOverrides, improvement_transition: { authority_text_rules: rules } } };
}

/**
 * FC14 guard-bite harness: remove or re-order exactly ONE predicate of the reference policy and
 * re-run the control it is supposed to stop. A bite whose removal changes nothing is reported as
 * defence-in-depth rather than silently counted as a control.
 */
function bite(...pairs: Array<[from: string, to: string]>): string {
  let rego = REFERENCE_REGO;
  for (const [from, to] of pairs) {
    assert.ok(rego.includes(from), `guard-bite anchor missing: ${from}`);
    rego = rego.replace(from, to);
  }
  return rego;
}

function resolutionClaim(over: Partial<ImprovementFindingResolutionClaimV1>): ImprovementFindingResolutionClaimV1 {
  return {
    contract_id: "cadp.improvement-intake.v1",
    finding_tip_ref: over.finding_tip_ref ?? { evidence_id: "e", envelope_digest: "d" },
    resolution_kind: "AUTHORITY_RESOLUTION",
    statement: "authority landed",
    ...over,
  };
}

// ================================================================ S4 — the real-PEP positive path

test("FC10 / S4: the §11 Human path clears the barrier end to end through admitAndDispatch", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S4_CG" });
    // 1. barrier up: implementation WORK_START and every bound non-index mutation DENY.
    const before = await evalWorkStart(h, f, [f]);
    assert.equal(before.outcome, "DENY");
    assert.ok(before.reason_codes.includes("contract_barrier"), JSON.stringify(before.reason_codes));

    // 2. the diagnosis run is plain-allowed while the barrier is up: the run exists first.
    const started = await startRun(h);
    assert.equal(started.outcome, "ALLOW", "WORK_START carrying no finding_admission stays plain-allowed");

    // 3. compose M and seal E; with no decision presented the admission REQUIREs the exact Human.
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const draft = humanDraft({
      predecessor: f, classification: "IMPLEMENTATION_GAP", run: started.run,
      basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    });
    const unauthorized = await sealTransition(h, { predecessor: f, draft, run: started.run, evidence: [f, diagnostic] });
    assert.equal(unauthorized.outcome, "REQUIRE_EVIDENCE", JSON.stringify(unauthorized.reason_codes));
    assert.ok(unauthorized.reason_codes.includes("transition_unauthorized"), JSON.stringify(unauthorized.reason_codes));
    assert.ok(unauthorized.reason_codes.includes("HUMAN_DECISION"), JSON.stringify(unauthorized.reason_codes));

    // 4-5. path A: the Human approves the exact effect + material digest → ALLOW → COMMITTED.
    const cleared = await governedHumanClearing(h, { predecessor: f, run: started.run });
    assert.equal(cleared.seal.outcome, "ALLOW", JSON.stringify(cleared.seal.reason_codes));
    const admitted = cleared.seal.admitted!;
    assert.equal(admitted.kind, "ADMITTED");
    assert.equal(admitted.kind === "ADMITTED" ? admitted.outcome.result : "", "COMMITTED", JSON.stringify(admitted));
    const g = cleared.sealed;
    assert.equal(g.producer_ref, GOVERNED_PRODUCER_REF);
    assert.equal(g.provenance.integrity, "AUTHENTICATED_SOURCE");
    assert.equal(g.source_ref, `cadp-v04:${cleared.seal.effect_id}`, "the artifact names its authorizing effect directly");

    // 6. the barrier is down for tips through G — and NO Human decision is presented here.
    const after = await evalWorkStart(h, g, [f, g]);
    assert.equal(after.outcome, "ALLOW", JSON.stringify(after.reason_codes));
    const push = await evalBoundMutation(h, "GIT_PUSH", [g], [f, g]);
    assert.equal(push.outcome, "ALLOW", JSON.stringify(push.reason_codes));

    // 7. the uncleared predecessor itself remains barred for every bound mutation.
    const merge = await evalBoundMutation(h, "PR_MERGE", [f], [f, g], { humanApprove: true });
    assert.equal(merge.outcome, "DENY");
    assert.ok(merge.reason_codes.includes("contract_barrier_nonindex_denied"), JSON.stringify(merge.reason_codes));
    const activate = await evalBoundMutation(h, "POLICY_ACTIVATE", [f], [f, g], { humanApprove: true });
    assert.equal(activate.outcome, "DENY");
  } finally { h.close(); }
});

// ================================================================ S1 — Human decision semantics

test("FC1 / S1: only APPROVE clears — REJECT, STOP, EXCEPTION_ACCEPT and unknown values never do", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S1_POLARITY" });
    const { run } = await startRun(h);
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const draft = humanDraft({
      predecessor: f, classification: "IMPLEMENTATION_GAP", run,
      basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    });
    // EXCEPTION_ACCEPT is deliberately excluded for transitions: a reclassification is a judgment
    // about what a Finding IS, not an accepted risk (#117 §4 rule 1).
    for (const decision of ["REJECT", "STOP", "EXCEPTION_ACCEPT", "APPROVE_ALL", ""]) {
      const seal = await sealTransition(h, {
        predecessor: f, draft, run, evidence: [f, diagnostic],
        human: (effect_id) => [humanDecision(h, effect_id, { decision })],
      });
      assert.equal(seal.outcome, "REQUIRE_EVIDENCE", `decision ${decision}: ${JSON.stringify(seal.reason_codes)}`);
      assert.equal(seal.sealed, undefined, `decision ${decision} must seal nothing`);
      assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 0);
    }
    // The barrier is untouched by any of them.
    const ws = await evalWorkStart(h, f, [f]);
    assert.equal(ws.outcome, "DENY");
    assert.ok(ws.reason_codes.includes("contract_barrier"));
  } finally { h.close(); }
});

test("FC2 / S1: a decision scoped to another effect, another material, or an unrendered request never authorizes", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S1_SCOPE" });
    const { run } = await startRun(h);
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const draft = humanDraft({
      predecessor: f, classification: "IMPLEMENTATION_GAP", run,
      basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    });

    // (a) the material digest the Human approved is not this transition's.
    const wrongMaterial = await sealTransition(h, {
      predecessor: f, draft, run, evidence: [f, diagnostic],
      human: (effect_id) => [humanDecision(h, effect_id, { material_digest: sha256("some-other-transition") })],
    });
    assert.equal(wrongMaterial.outcome, "REQUIRE_EVIDENCE", JSON.stringify(wrongMaterial.reason_codes));

    // (b) a decision issued for a DIFFERENT effect: policy-unsatisfied here, and kernel-refused
    // by the unchanged recheck #5 if it were ever re-presented.
    const other = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, diagnostic], admit: false });
    const foreign = humanDecision(h, other.effect_id);
    const crossEffect = await sealTransition(h, {
      predecessor: f, draft, run, evidence: [f, diagnostic], human: () => [foreign],
    });
    assert.equal(crossEffect.outcome, "REQUIRE_EVIDENCE", JSON.stringify(crossEffect.reason_codes));

    // (c) the landed §9.3 ingress gate: a decision whose presented_request_digest is not the
    // sealed request's is refused at submit_evidence — the surface must have rendered THIS effect.
    const pending = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, diagnostic], admit: false });
    const request = h.store.effectRequest(pending.effect_id)!;
    assert.throws(() => h.ingress.submitEvidence(
      {
        evidence_kind: "HUMAN_DECISION",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: pending.effect_id }],
        availability: "PRESENT",
        claim_schema: "cadp.human-decision.v1",
        claim: {
          principal: "sso:a.t.laplace@gmail.com", decision: "APPROVE",
          scope: { effect_id: pending.effect_id, target_ref: request.target_ref, material_digest: request.material_digest.value },
          presented_request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256("not-the-request") },
          statement: "unrendered", issued_at: new Date(h.clock.fn()).toISOString(),
        },
        producer_ref: "human:astro3141", source_ref: "sso-approval-page", source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.human,
    ), /presented_request_digest/u);
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 0);
  } finally { h.close(); }
});

// ================================================================ B18 — the landed clearing shapes

test("FC3 / FC9(d,e) / B18: no intake-sealed descendant clears — self-declared AUTHORITY_TEXT is metadata", async () => {
  const h = await makeHarness();
  try {
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "B18" });
    // The exact B18 exploit: ordinary telemetry cited under a claim-authored AUTHORITY_TEXT role
    // on a DETERMINISTIC_DERIVATION descendant. This cleared the barrier in v1.0.
    const telemetry = submitObservation(h, { namespace: "commit", object_id: `telemetry-${nextId()}`, revision: "r1" });
    const b18 = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "detector:x", method_digest: sha256("d") },
      basis: [{ evidence_id: telemetry.evidence_id, envelope_digest: telemetry.envelope_digest.value, role: "AUTHORITY_TEXT" }],
      supersedes: [refOf(c)], correction_reason: "self-declared authority",
      subject_bindings: c.subject_bindings as SubjectBinding[],
    });
    const r1 = await evalWorkStart(h, b18, [b18, c]);
    assert.equal(r1.outcome, "DENY", JSON.stringify(r1));
    assert.ok(r1.reason_codes.includes("contract_barrier"), JSON.stringify(r1.reason_codes));

    // The landed HUMAN_JUDGMENT reclassification shape is likewise no longer authority.
    const human = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "HUMAN_JUDGMENT", method_ref: "design:decision", method_digest: sha256("hd"), execution_or_run_ref: "human:astro3141" },
      basis: [{ evidence_id: telemetry.evidence_id, envelope_digest: telemetry.envelope_digest.value, role: "AUTHORITY_TEXT" }],
      supersedes: [refOf(c)], correction_reason: "bare human judgment",
      subject_bindings: c.subject_bindings as SubjectBinding[],
    });
    const r2 = await evalWorkStart(h, human, [human, c]);
    assert.equal(r2.outcome, "DENY", JSON.stringify(r2));
    assert.ok(r2.reason_codes.includes("contract_barrier"), JSON.stringify(r2.reason_codes));

    // MODEL_PROPOSAL is unsealable through the gate as well.
    const { run } = await startRun(h);
    const model = humanDraft({
      predecessor: c, classification: "IMPLEMENTATION_GAP", run,
      basis: [{ evidence_id: telemetry.evidence_id, envelope_digest: telemetry.envelope_digest.value, role: "AUTHORITY_TEXT" }],
    });
    const modelDraft: GovernedDescendantDraftV1 = {
      ...model,
      claim: { ...model.claim, derivation: { ...model.claim.derivation, kind: "MODEL_PROPOSAL" } },
    };
    const seal = await sealTransition(h, {
      predecessor: c, draft: modelDraft, run, evidence: [c, telemetry],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.equal(seal.outcome, "DENY", JSON.stringify(seal.reason_codes));
    assert.ok(seal.reason_codes.includes("transition_derivation_forbidden"), JSON.stringify(seal.reason_codes));
  } finally { h.close(); }
});

test("FC14 guard-bite: dropping the governed producer check reproduces the landed B18 clearing", async () => {
  const h = await makeHarness({
    rego: bite(['	d.producer_ref == governed_producer_ref\n	d.provenance.integrity == "AUTHENTICATED_SOURCE"\n', ""]),
  });
  try {
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "B18_BITE" });
    const telemetry = submitObservation(h, { namespace: "commit", object_id: `telemetry-${nextId()}`, revision: "r1" });
    const b18 = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "detector:x", method_digest: sha256("d") },
      basis: [{ evidence_id: telemetry.evidence_id, envelope_digest: telemetry.envelope_digest.value, role: "AUTHORITY_TEXT" }],
      supersedes: [refOf(c)], correction_reason: "self-declared authority",
      subject_bindings: c.subject_bindings as SubjectBinding[],
    });
    const r = await evalWorkStart(h, b18, [b18, c]);
    assert.equal(r.outcome, "ALLOW", "the bite must reproduce the defect this predicate closes");
  } finally { h.close(); }
});

// ================================================================ S3 — deterministic applicability

test("FC21(e) / S3 positive: the deterministic path seals exactly the derived draft and clears", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule]));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "DET_CG" });
    const { run, outcome } = await startRun(h);
    assert.equal(outcome, "ALLOW");
    const at = appliesTo({ predecessor: f, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at });
    // The run does not compose a draft: it COMPUTES derived_draft(F, A, r).
    const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
    const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
    assert.equal(seal.outcome, "ALLOW", JSON.stringify(seal.reason_codes));
    assert.equal(seal.admitted?.kind === "ADMITTED" ? seal.admitted.outcome.result : "", "COMMITTED", JSON.stringify(seal.admitted));
    const g = seal.sealed!;
    assert.equal(g.producer_ref, GOVERNED_PRODUCER_REF);
    assert.equal((g.claim as { anomaly_code: string }).anomaly_code, rule.derived_anomaly_code);
    assert.equal((g.claim as { correction_reason: string }).correction_reason, rule.derived_correction_reason);
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1);
    const ws = await evalWorkStart(h, g, [f, g]);
    assert.equal(ws.outcome, "ALLOW", JSON.stringify(ws.reason_codes));
  } finally { h.close(); }
});

test("FC20(b) / S3: the derivation closure refuses every draft that is not the derived one", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule]));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "DET_CLOSURE" });
    const { run } = await startRun(h);
    const at = appliesTo({ predecessor: f, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const unrelated = submitObservation(h, { namespace: "diagnostic", object_id: `unrelated-${nextId()}` });
    const derived = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
    const claim = derived.claim as unknown as Record<string, unknown>;
    const withClaim = (over: Record<string, unknown>): GovernedDescendantDraftV1 =>
      ({ ...derived, claim: { ...claim, ...over } } as unknown as GovernedDescendantDraftV1);

    // One control per authorization-relevant field: an extra, missing or differing value of ANY
    // kind fails the equality — there is no partial-coverage residue (round-10 R10-1).
    const variants: Array<[string, GovernedDescendantDraftV1]> = [
      ["extra basis entry", withClaim({ basis: [...(claim["basis"] as unknown[]), { evidence_id: unrelated.evidence_id, envelope_digest: unrelated.envelope_digest.value, role: "DIAGNOSTIC" }] })],
      ["second AUTHORITY_TEXT entry", withClaim({ basis: [...(claim["basis"] as unknown[]), { evidence_id: unrelated.evidence_id, envelope_digest: unrelated.envelope_digest.value, role: "AUTHORITY_TEXT" }] })],
      ["different anomaly_code", withClaim({ anomaly_code: "SOMETHING_ELSE" })],
      ["different correction_reason", withClaim({ correction_reason: "operator preference" })],
      ["different statement.summary", withClaim({ statement: { summary: "a nicer summary" } })],
      ["added statement.detail", withClaim({ statement: { summary: rule.derived_statement.summary, detail: "extra" } })],
      ["added series_key", withClaim({ series_key: sha256("series") })],
      ["added execution_or_run_ref", withClaim({ derivation: { ...(claim["derivation"] as object), execution_or_run_ref: run } })],
      ["different method_digest", withClaim({ derivation: { ...(claim["derivation"] as object), method_digest: sha256("other-method") } })],
      ["different subject.kind", withClaim({ subject: { kind: "TARGET", binding_index: 0 } })],
      ["different binding_index", withClaim({ subject: { kind: "WORK_RUN", binding_index: 1 } })],
      ["unknown claim key", withClaim({ operator_note: "smuggled" })],
      ["added secondary subject binding", { ...derived, subject_bindings: [...derived.subject_bindings, { authority_ref: "github.com", namespace: "extra", object_id: "x" }] } as GovernedDescendantDraftV1],
      ["reordered subject bindings", { ...derived, subject_bindings: [...derived.subject_bindings].reverse() } as GovernedDescendantDraftV1],
    ];
    for (const [name, draft] of variants) {
      const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a, unrelated] });
      assert.notEqual(seal.outcome, "ALLOW", `${name} must not reach ALLOW`);
      assert.equal(seal.sealed, undefined, `${name} must seal nothing`);
    }
    // A recomputed-but-consistent occurrence_key over an altered basis is still not the derived draft.
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 0);
  } finally { h.close(); }
});

test("FC14 guard-bite: dropping the derivation-closure equality lets an unauthorized draft through", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule], {
    rego: bite(["	applies_to.work_run_ref == work_run_binding_ids[0]\n	seal_draft == derived_draft\n", "	applies_to.work_run_ref == work_run_binding_ids[0]\n"]),
  }));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "CLOSURE_BITE" });
    const { run } = await startRun(h);
    const at = appliesTo({ predecessor: f, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const derived = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
    const forged = {
      ...derived,
      claim: { ...(derived.claim as unknown as Record<string, unknown>), correction_reason: "content no authority ever bound" },
    } as unknown as GovernedDescendantDraftV1;
    const seal = await sealTransition(h, { predecessor: f, draft: forged, run, evidence: [f, a], admit: false });
    assert.equal(seal.outcome, "ALLOW", "the bite must reproduce R10-1: unauthorized content reaches ALLOW");
  } finally { h.close(); }
});

test("FC9(f,g) / S3: one observation authorizes exactly one context — every cross-context reuse is unsatisfiable", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule]));
  try {
    const f1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "CTX_1" });
    const f2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "CTX_2", subject_bindings: f1.subject_bindings as SubjectBinding[] });
    const { run } = await startRun(h);
    const at1 = appliesTo({ predecessor: f1, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at1 });

    // (f-i) the same A presented for a DIFFERENT predecessor: derived_draft is computed from the
    // predecessor A names, so the material's own predecessor can never match.
    const forF2 = deterministicDraft({ predecessor: f2, observation: a, applies_to: appliesTo({ predecessor: f2, rule, run }), rule });
    const crossPredecessor = await sealTransition(h, { predecessor: f2, draft: forF2, run, evidence: [f1, f2, a] });
    assert.notEqual(crossPredecessor.outcome, "ALLOW", JSON.stringify(crossPredecessor.reason_codes));

    // (f-ii) an observation whose applies_to names the right id but a stale envelope digest.
    const staleDigest = appliesTo({ predecessor: f1, rule, run, over: { predecessor_ref: { evidence_id: f1.evidence_id, envelope_digest: sha256("stale") } } });
    const aStale = submitAuthorityObservation(h, { applies_to: staleDigest });
    const staleDraft = deterministicDraft({ predecessor: f1, observation: aStale, applies_to: staleDigest, rule });
    const stale = await sealTransition(h, { predecessor: f1, draft: staleDraft, run, evidence: [f1, aStale] });
    assert.notEqual(stale.outcome, "ALLOW", JSON.stringify(stale.reason_codes));

    // (f-iii) a differing to_subject / to_subject_kind / transition_kind / method in applies_to.
    const wrongSubject = appliesTo({ predecessor: f1, rule, run, over: { to_subject: { authority_ref: "github.com", namespace: "commit", object_id: "elsewhere", content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256("elsewhere") } } } });
    const aSubject = submitAuthorityObservation(h, { applies_to: wrongSubject });
    const subjectDraft = deterministicDraft({ predecessor: f1, observation: aSubject, applies_to: wrongSubject, rule });
    const subjectSeal = await sealTransition(h, { predecessor: f1, draft: subjectDraft, run, evidence: [f1, aSubject] });
    assert.notEqual(subjectSeal.outcome, "ALLOW", JSON.stringify(subjectSeal.reason_codes));

    const wrongMethod = appliesTo({ predecessor: f1, rule, run, over: { method: { method_ref: rule.method.method_ref, method_digest: sha256("other") } } });
    const aMethod = submitAuthorityObservation(h, { applies_to: wrongMethod });
    const methodDraft = deterministicDraft({ predecessor: f1, observation: aMethod, applies_to: wrongMethod, rule: { ...rule, method: wrongMethod.method } });
    const methodSeal = await sealTransition(h, { predecessor: f1, draft: methodDraft, run, evidence: [f1, aMethod] });
    assert.notEqual(methodSeal.outcome, "ALLOW", "a method the active rule does not declare matches no rule");

    // (g) after the edge is taken, the SAME A can never authorize a re-raised successor: C2 has a
    // different id+digest, so applies_to.predecessor_ref cannot match it.
    const valid = deterministicDraft({ predecessor: f1, observation: a, applies_to: at1, rule });
    const good = await sealTransition(h, { predecessor: f1, draft: valid, run, evidence: [f1, a] });
    assert.equal(good.outcome, "ALLOW", JSON.stringify(good.reason_codes));
    const g = good.sealed!;
    const c2 = await makeFinding(h, {
      classification: "CONTRACT_GAP", anomaly_code: "RERAISE",
      supersedes: [refOf(g)], correction_reason: "re-raise after a wrong clearing (I4)",
      subject_bindings: g.subject_bindings as SubjectBinding[],
    });
    const reraiseDraft = deterministicDraft({ predecessor: c2, observation: a, applies_to: appliesTo({ predecessor: c2, rule, run }), rule });
    const reraise = await sealTransition(h, { predecessor: c2, draft: reraiseDraft, run, evidence: [f1, g, c2, a] });
    assert.notEqual(reraise.outcome, "ALLOW", JSON.stringify(reraise.reason_codes));
    // and the re-raised tip is barred again, exactly as I4 requires.
    const ws = await evalWorkStart(h, c2, [f1, g, c2]);
    assert.equal(ws.outcome, "DENY", JSON.stringify(ws.reason_codes));
  } finally { h.close(); }
});

test("FC9(h) / S3: an observation without a complete applies_to is not authority at all", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule]));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "APPLIES_TO" });
    const { run } = await startRun(h);
    const complete = appliesTo({ predecessor: f, rule, run });
    const skeleton = submitAuthorityObservation(h, { applies_to: complete });
    const derived = deterministicDraft({ predecessor: f, observation: skeleton, applies_to: complete, rule });
    const cases: Array<[string, unknown]> = [
      ["absent applies_to", undefined],
      ["missing work_run_ref", Object.fromEntries(Object.entries(complete).filter(([k]) => k !== "work_run_ref"))],
      ["missing predecessor_ref", Object.fromEntries(Object.entries(complete).filter(([k]) => k !== "predecessor_ref"))],
      ["unknown field", { ...complete, scope_note: "everything" }],
      ["empty work_run_ref", { ...complete, work_run_ref: "" }],
    ];
    for (const [name, value] of cases) {
      const a = submitAuthorityObservation(h, value === undefined ? {} : { applies_to: value });
      const draft = { ...derived, claim: { ...(derived.claim as unknown as Record<string, unknown>), basis: [{ evidence_id: a.evidence_id, envelope_digest: a.envelope_digest.value, role: "AUTHORITY_TEXT" }] } } as unknown as GovernedDescendantDraftV1;
      const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
      assert.notEqual(seal.outcome, "ALLOW", `${name} must not authorize`);
    }
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 0);
  } finally { h.close(); }
});

test("FC9(i) / S3: work-run applicability is mandatory and not a caller-selected disjunction", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule]));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "RUN_CTX" });
    const r1 = (await startRun(h)).run;
    const r2 = (await startRun(h)).run;
    const at = appliesTo({ predecessor: f, rule, run: r1 });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });

    // (i) an observation bound to R1 presented at an effect whose single run binding is R2.
    const crossRun = await sealTransition(h, { predecessor: f, draft, run: r2, evidence: [f, a] });
    assert.notEqual(crossRun.outcome, "ALLOW", JSON.stringify(crossRun.reason_codes));

    // zero work-run bindings: the equality would be vacuous, so the effect is refused outright.
    const zeroRun = await sealTransition(h, {
      predecessor: f, draft, run: r1, evidence: [f, a],
      workBindings: (predecessor) => [{ authority_ref: "cadp-store:k04", namespace: "evidence", object_id: predecessor }],
    });
    assert.notEqual(zeroRun.outcome, "ALLOW");
    assert.ok(zeroRun.reason_codes.includes("transition_run_context_invalid"), JSON.stringify(zeroRun.reason_codes));

    // two work-run bindings, one of which is the authorized run: the disjunction attack.
    const twoRuns = await sealTransition(h, {
      predecessor: f, draft, run: r1, evidence: [f, a],
      workBindings: (predecessor, run) => [
        { authority_ref: "cadp-store:k04", namespace: "evidence", object_id: predecessor },
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: run },
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: r2 },
      ],
    });
    assert.notEqual(twoRuns.outcome, "ALLOW");
    assert.ok(twoRuns.reason_codes.includes("transition_run_context_invalid"), JSON.stringify(twoRuns.reason_codes));

    // the predecessor's evidence binding is equally mandatory: without it the §5.4 scope hold
    // could be escaped by simply not naming the predecessor the effect acts on.
    const noEvidenceBinding = await sealTransition(h, {
      predecessor: f, draft, run: r1, evidence: [f, a],
      workBindings: (_predecessor, runRef) => [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: runRef }],
    });
    assert.notEqual(noEvidenceBinding.outcome, "ALLOW");
    assert.ok(noEvidenceBinding.reason_codes.includes("transition_run_context_invalid"), JSON.stringify(noEvidenceBinding.reason_codes));

    // a bundle trying to reintroduce the deleted opt-in: run_scoped is an unknown rule key, so the
    // rule is refused at USE and cannot authorize anything.
    const h2 = await makeHarness(withRules([{ ...rule, run_scoped: false }]));
    try {
      const f2 = await makeFinding(h2, { classification: "CONTRACT_GAP", anomaly_code: "RUN_OPTIN" });
      const run2 = (await startRun(h2)).run;
      const at2 = appliesTo({ predecessor: f2, rule, run: run2 });
      const a2 = submitAuthorityObservation(h2, { applies_to: at2 });
      const d2 = deterministicDraft({ predecessor: f2, observation: a2, applies_to: at2, rule });
      const seal = await sealTransition(h2, { predecessor: f2, draft: d2, run: run2, evidence: [f2, a2] });
      assert.notEqual(seal.outcome, "ALLOW");
      assert.ok(seal.reason_codes.includes("transition_rule_malformed"), JSON.stringify(seal.reason_codes));
    } finally { h2.close(); }
  } finally { h.close(); }
});

test("FC14 guard-bite: dropping the work-run equality lets one observation cross runs (R10-2)", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule], {
    rego: bite(["	applies_to.work_run_ref == work_run_binding_ids[0]\n	seal_draft == derived_draft\n", "	seal_draft == derived_draft\n"]),
  }));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "RUN_BITE" });
    const r1 = (await startRun(h)).run;
    const r2 = (await startRun(h)).run;
    const at = appliesTo({ predecessor: f, rule, run: r1 });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
    const seal = await sealTransition(h, { predecessor: f, draft, run: r2, evidence: [f, a], admit: false });
    assert.equal(seal.outcome, "ALLOW", "the bite must reproduce R10-2: the observation applies in an unrelated run");
  } finally { h.close(); }
});

test("FC20(c) / FC21(a2): two rules on one key DENY as ambiguous — a malformed twin never loses by evaluation order", async () => {
  const rule = makeRule();
  const twin = makeRule({ derived_anomaly_code: "A_DIFFERENT_CODE" });
  const malformedTwin = { ...makeRule(), derived_correction_reason: "" };
  for (const [name, rules] of [["well-formed twin", [rule, twin]], ["malformed twin", [rule, malformedTwin]]] as const) {
    const h = await makeHarness(withRules(rules));
    try {
      const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: `AMBIG_${name}` });
      const { run } = await startRun(h);
      const at = appliesTo({ predecessor: f, rule, run });
      const a = submitAuthorityObservation(h, { applies_to: at });
      const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
      const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
      assert.notEqual(seal.outcome, "ALLOW", name);
      assert.ok(seal.reason_codes.includes("transition_rule_ambiguous"), `${name}: ${JSON.stringify(seal.reason_codes)}`);
    } finally { h.close(); }
  }
});

test("FC14 guard-bite: filtering malformed rules BEFORE selection lets the surviving twin win silently", async () => {
  const rule = makeRule();
  const malformedTwin = { ...makeRule(), derived_correction_reason: "" };
  const h = await makeHarness(withRules([rule, malformedTwin], {
    rego: bite([
      "matching_rules := [r |\n	some r in authority_text_rules\n	r.transition_kind == applies_to.transition_kind",
      "matching_rules := [r |\n	some r in authority_text_rules\n	well_formed_rule(r)\n	r.transition_kind == applies_to.transition_kind",
    ]),
  }));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "ORDER_BITE" });
    const { run } = await startRun(h);
    const at = appliesTo({ predecessor: f, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
    const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a], admit: false });
    assert.equal(seal.outcome, "ALLOW", "the bite must reproduce the ordering defect round-10 R10-1 refused");
  } finally { h.close(); }
});

test("FC21(a) / F1: a rule that could emit a draft the landed validator rejects can never be selected", async () => {
  const base = makeRule();
  const drop = (key: string): Record<string, unknown> => {
    const copy = { ...(base as unknown as Record<string, unknown>) };
    delete copy[key];
    return copy;
  };
  const variants: Array<[string, Record<string, unknown>, string]> = [
    // ROUND-12 F1, the two sites the S11-1 enumeration skipped. Reachable: applies_to.method is
    // caller-supplied claim content, so an observation carrying the SAME empty component matches
    // the rule uniquely and every other predicate passes.
    ["empty method_ref", { ...base, method: { method_ref: "", method_digest: base.method.method_digest } }, "transition_rule_malformed"],
    ["empty method_digest", { ...base, method: { method_ref: base.method.method_ref, method_digest: "" } }, "transition_rule_malformed"],
    ["empty derived_anomaly_code", { ...base, derived_anomaly_code: "" }, "transition_rule_malformed"],
    ["empty derived_statement.summary", { ...base, derived_statement: { summary: "" } }, "transition_rule_malformed"],
    ["empty derived_correction_reason", { ...base, derived_correction_reason: "" }, "transition_rule_malformed"],
    ["present derived_statement.detail", { ...base, derived_statement: { summary: "s", detail: "d" } }, "transition_rule_malformed"],
    ["empty producer_ref", { ...base, producer_ref: "" }, "transition_rule_malformed"],
    ["empty evidence_kind", { ...base, evidence_kind: "" }, "transition_rule_malformed"],
    ["empty claim_schema", { ...base, claim_schema: "" }, "transition_rule_malformed"],
    ["empty authority_content_digest", { ...base, authority_content_digest: "" }, "transition_rule_malformed"],
    ["provenance outside the landed set", { ...base, provenance: "UNATTESTED" }, "transition_rule_malformed"],
    ["unknown key", { ...base, operator_note: "extra" }, "transition_rule_malformed"],
    ["transition_kind outside the closed set", { ...base, transition_kind: "RENAME" }, "transition_rule_malformed"],
    ["from outside the closed set", { ...base, from: "NOT_A_CLASS" }, "transition_rule_malformed"],
    ["missing derived_correction_reason", drop("derived_correction_reason"), "transition_rule_malformed"],
    // A missing KEY field renders the entry unmatchable, so the zero-match DENY fires first: this
    // one is reported as defence-in-depth, not as a load-bearing bite.
    ["missing method", drop("method"), "transition_authority_absent"],
  ];
  for (const [name, rule, expected] of variants) {
    const h = await makeHarness(withRules([rule]));
    try {
      const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "WF_RULE" });
      const { run } = await startRun(h);
      const at = appliesTo({ predecessor: f, rule: rule as unknown as AuthorityTextRuleV1, run });
      const a = submitAuthorityObservation(h, { applies_to: at, claim_schema: String(rule["claim_schema"] ?? "") || undefined });
      // The draft is derived from the malformed rule wherever it supplies a value, so every
      // predicate downstream of step (2b) would pass; base fills only the keys it deletes.
      const draftRule = { ...base, ...rule } as unknown as AuthorityTextRuleV1;
      const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule: draftRule });
      const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
      assert.notEqual(seal.outcome, "ALLOW", `${name} must not reach ALLOW`);
      assert.ok(seal.reason_codes.includes(expected), `${name}: expected ${expected}, got ${JSON.stringify(seal.reason_codes)}`);
      assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 0);
    } finally { h.close(); }
  }
});

const WELL_FORMED_BITE: [string, string] = [
  "	well_formed_rule(selected_rule)\n	observation_shape_ok\n	authority_applicable\n",
  "	observation_shape_ok\n	authority_applicable\n",
];
const APPLIES_TO_METHOD_BITE: [string, string] = [
  "	nonempty_string(applies_to.method.method_ref)\n	nonempty_string(applies_to.method.method_digest)\n	nonempty_string(applies_to.work_run_ref)\n",
  "	nonempty_string(applies_to.work_run_ref)\n",
];

async function emptyMethodSeal(h: Harness, rule: AuthorityTextRuleV1) {
  const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "WF_BITE" });
  const { run } = await startRun(h);
  const at = appliesTo({ predecessor: f, rule, run });
  const a = submitAuthorityObservation(h, { applies_to: at });
  const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
  return { f, seal: await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] }) };
}

test("FC14 guard-bite / F1: the empty-method exploit is stopped by use-time well-formedness plus the observation shape", async () => {
  const rule = { ...makeRule(), method: { method_ref: "", method_digest: "" } } as unknown as AuthorityTextRuleV1;

  // MEASURED LAYERING, reported rather than assumed: removing `well_formed(r)` ALONE still DENYs,
  // because the registered `applies_to` shape independently requires a non-empty method pair. The
  // design calls that conjunct defence-in-depth; this control shows exactly which half bites when.
  const layered = await makeHarness(withRules([rule], { rego: bite(WELL_FORMED_BITE) }));
  try {
    const only = await emptyMethodSeal(layered, rule);
    assert.notEqual(only.seal.outcome, "ALLOW", "the observation-shape conjunct still refuses the empty method pair");
  } finally { layered.close(); }

  // Removing BOTH reproduces the F1 defect exactly: the admission reaches ALLOW and the effect
  // then terminates at the adapter's landed validateFindingClaim — fail-closed, but with the
  // totality claim false and no policy-level reason for the barrier staying up.
  const h = await makeHarness(withRules([rule], { rego: bite(WELL_FORMED_BITE, APPLIES_TO_METHOD_BITE) }));
  try {
    const { f, seal } = await emptyMethodSeal(h, rule);
    assert.equal(seal.outcome, "ALLOW", "the bite must reproduce the reachable-but-unsealable admission");
    assert.equal(seal.admitted?.kind, "REFUSAL");
    assert.equal(seal.admitted?.kind === "REFUSAL" ? seal.admitted.reason : "", "MATERIAL_INCOMPLETE");
    assert.match(String(seal.admitted?.kind === "REFUSAL" ? seal.admitted.detail : ""), /method_ref missing|method_digest missing/u);
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 0);
  } finally { h.close(); }
});

test("FC21(a3): an absent namespace, an absent table and an empty table are all the empty rule set", async () => {
  for (const [name, params] of [
    ["absent namespace", {}],
    ["absent table", { improvement_transition: {} }],
    ["empty table", { improvement_transition: { authority_text_rules: [] } }],
    ["non-array table", { improvement_transition: { authority_text_rules: "everything" } }],
  ] as Array<[string, Record<string, unknown>]>) {
    const h = await makeHarness({ paramOverrides: params });
    try {
      const rule = makeRule();
      const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "EMPTY_TABLE" });
      const { run } = await startRun(h);
      const at = appliesTo({ predecessor: f, rule, run });
      const a = submitAuthorityObservation(h, { applies_to: at });
      const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
      const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
      assert.notEqual(seal.outcome, "ALLOW", name);
      assert.ok(seal.reason_codes.includes("transition_authority_absent"), `${name}: ${JSON.stringify(seal.reason_codes)}`);
    } finally { h.close(); }
  }
});

test("FC21(b,c,d) / S11-1: subject-kind conformance carries the landed mutable-subject rule into the closure", async () => {
  const rule = makeRule();
  const transferRule = makeRule({ transition_kind: "SUBJECT_TRANSFER", to: "CONTRACT_GAP" });
  const h = await makeHarness(withRules([rule, transferRule]));
  try {
    // (b) RECLASSIFICATION whose observation names a kind other than the predecessor's own.
    const evidenceBindings: SubjectBinding[] = [{ authority_ref: "cadp-store:k04", namespace: "evidence", object_id: `cadp-v04:evidence:${nextId()}` }];
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "KIND_B", subject: { kind: "EVIDENCE", binding_index: 0 }, subject_bindings: evidenceBindings });
    const { run } = await startRun(h);
    for (const kind of ["TARGET", "NOT_A_KIND"] as const) {
      const at = appliesTo({ predecessor: f, rule, run, to_subject_kind: kind as never });
      const a = submitAuthorityObservation(h, { applies_to: at });
      const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
      const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
      assert.notEqual(seal.outcome, "ALLOW", `to_subject_kind ${kind}`);
      assert.ok(seal.reason_codes.includes("transition_subject_kind_invalid"), `${kind}: ${JSON.stringify(seal.reason_codes)}`);
    }

    // (c) SUBJECT_TRANSFER introducing a mutable binding that carries no exactness at all.
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "KIND_C" });
    const inexact = { authority_ref: "github.com", namespace: "module", object_id: "svc/record" };
    const atT = appliesTo({ predecessor: c, rule: transferRule, run, to_subject: inexact, to_subject_kind: "TARGET" });
    const aT = submitAuthorityObservation(h, { applies_to: atT });
    const draftT = deterministicDraft({ predecessor: c, observation: aT, applies_to: atT, rule: transferRule });
    const sealT = await sealTransition(h, { predecessor: c, draft: draftT, run, transition_kind: "SUBJECT_TRANSFER", evidence: [c, aT] });
    assert.notEqual(sealT.outcome, "ALLOW");
    assert.ok(sealT.reason_codes.includes("transition_subject_kind_invalid"), JSON.stringify(sealT.reason_codes));
  } finally { h.close(); }
});

test("FC9(c): POLICY_ACTIVATE revokes a rule prospectively — a cleared edge stays cleared", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule]));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "REVOKE_1" });
    const { run } = await startRun(h);
    const at = appliesTo({ predecessor: f, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
    const seal = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
    assert.equal(seal.outcome, "ALLOW", JSON.stringify(seal.reason_codes));
    const g = seal.sealed!;

    h.sealReach();
    await h.sealTargetIdentity();
    const activated = await h.activatePolicy({ revision: 2, paramOverrides: { improvement_transition: { authority_text_rules: [] } } });
    assert.equal((activated.admitted as { kind?: string; outcome?: { result?: string } }).outcome?.result, "COMMITTED", JSON.stringify(activated.admitted));

    // The already-cleared edge still clears: governed_transition reads kernel-stamped facts only.
    const ws = await evalWorkStart(h, g, [f, g]);
    assert.equal(ws.outcome, "ALLOW", JSON.stringify(ws.reason_codes));
    // A new deterministic seal under the same authority now has no rule at all.
    const f2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "REVOKE_2" });
    const run2 = (await startRun(h)).run;
    const at2 = appliesTo({ predecessor: f2, rule, run: run2 });
    const a2 = submitAuthorityObservation(h, { applies_to: at2 });
    const d2 = deterministicDraft({ predecessor: f2, observation: a2, applies_to: at2, rule });
    const seal2 = await sealTransition(h, { predecessor: f2, draft: d2, run: run2, evidence: [f2, a2] });
    assert.notEqual(seal2.outcome, "ALLOW", JSON.stringify(seal2.reason_codes));
    assert.ok(seal2.reason_codes.includes("transition_authority_absent"), JSON.stringify(seal2.reason_codes));
  } finally { h.close(); }
});

// ================================================================ I6 — one predecessor per resolver

test("FC17 / R7-1: one authorization discharges exactly one predecessor", async () => {
  const h = await makeHarness();
  try {
    const f1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I6_1" });
    const f2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I6_2", subject_bindings: f1.subject_bindings as SubjectBinding[] });
    const { run } = await startRun(h);
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const draft = humanDraft({
      predecessor: f1, classification: "IMPLEMENTATION_GAP", run,
      basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    });
    // (a) the governed multi-predecessor artifact is UNCONSTRUCTIBLE: the seal refuses the shape.
    const multi = {
      ...draft,
      claim: { ...(draft.claim as unknown as Record<string, unknown>), supersedes: [refOf(f1), refOf(f2)] },
    } as unknown as GovernedDescendantDraftV1;
    const seal = await sealTransition(h, {
      predecessor: f1, draft: multi, run, evidence: [f1, f2, diagnostic],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.notEqual(seal.outcome, "ALLOW");
    assert.ok(seal.reason_codes.includes("transition_shape_invalid"), JSON.stringify(seal.reason_codes));

    // (e) the singleton positive still clears exactly one predecessor and leaves the other barred.
    const cleared = await governedHumanClearing(h, { predecessor: f1, run });
    const okTip = await evalWorkStart(h, cleared.sealed, [f1, cleared.sealed]);
    assert.equal(okTip.outcome, "ALLOW", JSON.stringify(okTip.reason_codes));
    const f2Bar = await evalWorkStart(h, f2, [f2]);
    assert.equal(f2Bar.outcome, "DENY");
  } finally { h.close(); }
});

/** A governed-shaped envelope written directly through the ingress, standing in for a pre-I6
 * artifact. The store's §5.3 rule-(b) shape guard is disabled for this harness so the
 * multi-predecessor shape can even be written — which is itself the FC18(c) layering statement. */
async function syntheticGovernedDescendant(
  h: Harness,
  predecessors: EvidenceEnvelopeV1[],
  template: EvidenceEnvelopeV1,
): Promise<EvidenceEnvelopeV1> {
  const claim = template.claim as unknown as Record<string, unknown>;
  return h.ingress.submitEvidence(
    {
      evidence_kind: "IMPROVEMENT_FINDING",
      subject_bindings: template.subject_bindings,
      availability: "PRESENT",
      claim_schema: "cadp.improvement-finding.v1",
      claim: { ...claim, supersedes: predecessors.map((p) => refOf(p)) },
      producer_ref: GOVERNED_PRODUCER_REF,
      source_ref: `cadp-v04:synthetic-${nextId()}`,
      source_relation: "SELF_REPORT",
    },
    PRINCIPALS.governed,
  );
}

test("FC17(b) / R7-1: a multi-predecessor governed envelope resolves NOTHING, seal-time checks aside", async () => {
  const options: HarnessOptions = { disabledIngressRules: new Set(["governed_edge_unique"]) };
  const h = await makeHarness(options);
  try {
    const f1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I6B_1" });
    const f2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I6B_2", subject_bindings: f1.subject_bindings as SubjectBinding[] });
    const cleared = await governedHumanClearing(h, { predecessor: f1 });
    const synthetic = await syntheticGovernedDescendant(h, [f1, f2], cleared.sealed);
    // sole_predecessor reads the SEALED envelope's own list, so it fails for BOTH predecessors.
    const r1 = await evalWorkStart(h, synthetic, [f1, f2, synthetic]);
    assert.equal(r1.outcome, "DENY", JSON.stringify(r1.reason_codes));
    assert.ok(r1.reason_codes.includes("contract_barrier"), JSON.stringify(r1.reason_codes));

    // (d) merge-then-clear: an intake merge resolves nothing either, so both merged predecessors
    // keep their own obligation until each is separately transferred or cleared.
    const merged = await makeFinding(h, {
      classification: "CONTRACT_GAP", anomaly_code: "I6B_MERGE",
      supersedes: [refOf(f1), refOf(f2)], correction_reason: "duplicate merge",
      subject_bindings: f1.subject_bindings as SubjectBinding[],
    });
    const mergeCleared = await governedHumanClearing(h, { predecessor: merged });
    const r2 = await evalWorkStart(h, mergeCleared.sealed, [f1, f2, merged, mergeCleared.sealed]);
    assert.equal(r2.outcome, "DENY", "one authorization never answers two contract questions");
  } finally { h.close(); }
});

test("FC14 guard-bite: containment matching in sole_predecessor reproduces R7-1", async () => {
  const h = await makeHarness({
    disabledIngressRules: new Set(["governed_edge_unique"]),
    rego: bite([
      "sole_predecessor(cid, d) if {\n	ss := object.get(d.claim, \"supersedes\", [])\n	count(ss) == 1\n	ss[0].evidence_id == cid\n	supersedes_ref_resolved(ss[0])\n}",
      "sole_predecessor(cid, d) if {\n	some s in object.get(d.claim, \"supersedes\", [])\n	s.evidence_id == cid\n	supersedes_ref_resolved(s)\n}",
    ]),
  });
  try {
    const f1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I6_BITE_1" });
    const f2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I6_BITE_2", subject_bindings: f1.subject_bindings as SubjectBinding[] });
    const cleared = await governedHumanClearing(h, { predecessor: f1 });
    const synthetic = await syntheticGovernedDescendant(h, [f1, f2], cleared.sealed);
    const r = await evalWorkStart(h, synthetic, [f1, f2, synthetic]);
    assert.equal(r.outcome, "ALLOW", "the bite must reproduce R7-1: one seal clears an unnamed predecessor too");
  } finally { h.close(); }
});

// ================================================================ invariant U — target uniqueness

test("FC15 / R6-1: the evidence-omission attack cannot produce a second governed edge", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "OMIT" });
    const first = await governedHumanClearing(h, { predecessor: f });
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1);

    // A SECOND governed seal for the same F carrying a DIFFERENT draft, with the first descendant
    // deliberately omitted from input.evidence so the §6.4 conflict rule cannot see it.
    const run2 = (await startRun(h)).run;
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const rival = humanDraft({
      predecessor: f, classification: "BUG", run: run2, anomaly_code: "RIVAL",
      basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    });
    const second = await sealTransition(h, {
      predecessor: f, draft: rival, run: run2, evidence: [f, diagnostic],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    // Policy is blind by construction — that is the point of the control — but the STORE is not.
    assert.equal(second.outcome, "ALLOW", JSON.stringify(second.reason_codes));
    assert.equal(second.admitted?.kind, "ADMITTED");
    assert.equal(second.admitted?.kind === "ADMITTED" ? second.admitted.outcome.result : "", "NO_EFFECT_CONFIRMED", JSON.stringify(second.admitted));
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1, "at most one governed edge per predecessor, for all time");

    const incident = h.store.openIncidents().find((i) => (i.claim as { incident_kind?: string }).incident_kind === "GOVERNED_SEAL_CONFLICT");
    assert.ok(incident !== undefined, "the refusal is loud: a GOVERNED_SEAL_CONFLICT incident is sealed");
    assert.ok(incident!.subject_bindings.some((b) => b.namespace === "evidence" && b.object_id === f.evidence_id), "the incident binds the predecessor");

    // Scope-hold bite: further governed sealing against F is frozen while the incident stands...
    const run3 = (await startRun(h)).run;
    const third = await sealTransition(h, {
      predecessor: f, draft: rival, run: run3, evidence: [f, diagnostic],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.equal(third.admitted?.kind, "REFUSAL");
    assert.equal(third.admitted?.kind === "REFUSAL" ? third.admitted.reason : "", "SCOPE_HELD");
    // ...while ordinary admissions that merely PRESENT F as evidence are not held.
    const ws = await evalWorkStart(h, first.sealed, [f, first.sealed]);
    assert.equal(ws.outcome, "ALLOW", JSON.stringify(ws.reason_codes));
  } finally { h.close(); }
});

test("FC14 guard-bite: removing the governed-edge rule lets the omission attack seal a second edge", async () => {
  const h = await makeHarness({ disabledIngressRules: new Set(["governed_edge_unique"]) });
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "OMIT_BITE" });
    const first = await governedHumanClearing(h, { predecessor: f });
    const run2 = (await startRun(h)).run;
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const rival = humanDraft({
      predecessor: f, classification: "BUG", run: run2, anomaly_code: "RIVAL",
      basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    });
    const second = await sealTransition(h, {
      predecessor: f, draft: rival, run: run2, evidence: [f, diagnostic],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.equal(second.admitted?.kind === "ADMITTED" ? second.admitted.outcome.result : "", "COMMITTED");
    // Exactly R6-1: two governed descendants of one predecessor now exist, and each clears on its
    // own branch because no admission ever has to present the other.
    assert.notEqual(second.sealed!.evidence_id, first.sealed.evidence_id, "the bite must reproduce R6-1");
    const branchA = await evalWorkStart(h, first.sealed, [f, first.sealed]);
    const branchB = await evalWorkStart(h, second.sealed!, [f, second.sealed!]);
    assert.equal(branchA.outcome, "ALLOW");
    assert.equal(branchB.outcome, "ALLOW");
  } finally { h.close(); }
});

test("FC6: two presented governed descendants of one predecessor make every edge of it invalid", async () => {
  const h = await makeHarness({ disabledIngressRules: new Set(["governed_edge_unique"]) });
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "AMBIG_EDGE" });
    const first = await governedHumanClearing(h, { predecessor: f });
    // A second governed seal that PRESENTS the first is denied at the seal (defence-in-depth)…
    const run2 = (await startRun(h)).run;
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const rival = humanDraft({
      predecessor: f, classification: "BUG", run: run2, anomaly_code: "RIVAL2",
      basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    });
    const second = await sealTransition(h, {
      predecessor: f, draft: rival, run: run2, evidence: [f, diagnostic, first.sealed],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.notEqual(second.outcome, "ALLOW");
    assert.ok(second.reason_codes.includes("reclassification_ambiguous"), JSON.stringify(second.reason_codes));

    // …and downstream, a synthetic graph carrying two governed descendants clears neither.
    const synthetic = await syntheticGovernedDescendant(h, [f], first.sealed);
    const r = await evalWorkStart(h, first.sealed, [f, first.sealed, synthetic]);
    assert.equal(r.outcome, "DENY", JSON.stringify(r.reason_codes));
  } finally { h.close(); }
});

test("FC18 / R8-1: replay idempotency and edge uniqueness are two separated, individually true keys", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "KEYS" });
    const first = await governedHumanClearing(h, { predecessor: f });

    // (a) a legitimate cross-effect restatement: a SECOND effect dispatching the byte-identical
    // draft converges on the one existing envelope — one artifact, one edge, two audit trails.
    const run2 = (await startRun(h)).run;
    const restated = await sealTransition(h, {
      predecessor: f,
      draft: { evidence_kind: "IMPROVEMENT_FINDING", subject_bindings: first.sealed.subject_bindings, claim: first.sealed.claim as never },
      run: run2, evidence: [f, first.diagnostic],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.equal(restated.outcome, "ALLOW", JSON.stringify(restated.reason_codes));
    assert.equal(restated.admitted?.kind === "ADMITTED" ? restated.admitted.outcome.result : "", "COMMITTED");
    assert.equal(restated.sealed!.evidence_id, first.sealed.evidence_id, "converged to the one governed edge");
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1);

    // (b) the effect-bound replay key is not caller-chosen: the landed seal path refuses a
    // material whose idempotency_key is not this effect's, and the adapter refuses to dispatch
    // one before it can reach the target.
    const badMaterial = { ...restated.material, idempotency_key: "cadp-v04:some-other-effect" };
    const bad_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(badMaterial), "utf8"));
    const strayEffect = h.ingress.allocateEffectId({
      schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
      step_ordinal: nextId(), purpose: "finding-seal",
    });
    assert.throws(() => h.ingress.sealEffectRequest(
      {
        effect_id: strayEffect, requester_ref: "workflow:cadp-work",
        work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: run2 }],
        target_ref: { authority_ref: "cadp-store:k04", target_type: "EVIDENCE_SEAL", target_id: "k04" },
        operation_kind: "FINDING_SEAL", material_schema: "cadp.governed-transition.v1", material_ref: bad_ref, prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    ), /IDEMPOTENCY_KEY_INVALID/u);
    const refusedDispatch = await h.findingSeal.dispatch(
      strayEffect, 1, { authority_ref: "cadp-store:k04", target_type: "EVIDENCE_SEAL", target_id: "k04" },
      "FINDING_SEAL", badMaterial as unknown as Record<string, unknown>,
    );
    assert.equal(refusedDispatch.kind, "REJECTED_NO_EFFECT");

    // (c) the rule-(b) shape guard: a draft for this producer whose supersedes is not exactly one
    // exact ref cannot even be KEYED, so it is rejected at submit_evidence.
    for (const supersedes of [[], [refOf(f), refOf(f)]]) {
      assert.throws(() => h.ingress.submitEvidence(
        {
          evidence_kind: "IMPROVEMENT_FINDING",
          subject_bindings: first.sealed.subject_bindings,
          availability: "PRESENT",
          claim_schema: "cadp.improvement-finding.v1",
          claim: { ...(first.sealed.claim as object), supersedes },
          producer_ref: GOVERNED_PRODUCER_REF,
          source_ref: `cadp-v04:shape-${nextId()}`,
          source_relation: "SELF_REPORT",
        },
        PRINCIPALS.governed,
      ), /GOVERNED_DRAFT_SHAPE_INVALID/u);
    }
  } finally { h.close(); }
});

test("FC7 / §13.3: double dispatch of one admitted effect converges to exactly one envelope", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "REPLAY" });
    const first = await governedHumanClearing(h, { predecessor: f });
    const target = { authority_ref: "cadp-store:k04", target_type: "EVIDENCE_SEAL", target_id: "k04" };
    const material = first.seal.material as unknown as Record<string, unknown>;
    const again = await h.findingSeal.dispatch(first.seal.effect_id, 2, target, "FINDING_SEAL", material);
    assert.equal(again.kind, "ACCEPTED");
    assert.equal(again.kind === "ACCEPTED" ? (again.receipt_claim as { evidence_id: string }).evidence_id : "", first.sealed.evidence_id);
    assert.ok(h.findingSeal.receipt_binds("FINDING_SEAL", material, (again as { receipt_claim: Record<string, unknown> }).receipt_claim));
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1);
    // The reconcile read is the same authoritative edge predicate and returns the same receipt.
    const reconciled = await h.findingSeal.reconcile(first.seal.effect_id, 2, target, "FINDING_SEAL", material);
    assert.equal(reconciled.kind, "COMMITTED");
  } finally { h.close(); }
});

test("FC5 / FC19(c): the governed producer_ref is unreachable to other principals and reserved to one identity", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "CRED" });
    const cleared = await governedHumanClearing(h, { predecessor: f });
    // A non-governed principal declaring the governed producer is refused by the landed stamping rule.
    assert.throws(() => h.ingress.submitEvidence(
      {
        evidence_kind: "IMPROVEMENT_FINDING", subject_bindings: cleared.sealed.subject_bindings,
        availability: "PRESENT", claim_schema: "cadp.improvement-finding.v1", claim: cleared.sealed.claim,
        producer_ref: GOVERNED_PRODUCER_REF, source_ref: "forged", source_relation: "SELF_REPORT",
      },
      PRINCIPALS.workflow,
    ), /PRODUCER_REF_MISMATCH/u);

    // Invariant P: a bundle granting governed-edge power to any other producer_ref fails registry
    // conformance, so the POLICY_ACTIVATE is refused.
    h.sealReach();
    await h.sealTargetIdentity();
    const activated = await h.activatePolicy({
      revision: 2,
      configOverrides: {
        adapter_registry: [
          ...REFERENCE_ADAPTERS,
          { producer_ref: "governed:reclassification2", evidence_kinds: ["IMPROVEMENT_FINDING"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" }, governed_edge: "SUPERSEDES_SINGLETON" },
        ],
      },
    });
    const admitted = activated.admitted as { kind?: string; reason?: string; detail?: string };
    assert.equal(admitted.kind, "REFUSAL", JSON.stringify(activated.admitted));
    assert.equal(admitted.reason, "KERNEL_CONFIG_INVALID");
    assert.match(String(admitted.detail), /governed_edge is reserved/u);
  } finally { h.close(); }
});

test("FC19(a,b) / R9-1: writer-generation changes are prospective and share one edge namespace", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "GEN" });
    const cleared = await governedHumanClearing(h, { predecessor: f });

    // (a) revoke the workload credential (and, in the same bundle, retire the capability row):
    // the completed edge still clears, because governed_transition reads kernel-stamped facts.
    h.sealReach();
    await h.sealTargetIdentity();
    const revoked = await h.activatePolicy({
      revision: 2,
      configOverrides: {
        identity_registry: REFERENCE_IDENTITIES.filter((e) => e.producer_ref !== GOVERNED_PRODUCER_REF),
        adapter_registry: REFERENCE_ADAPTERS.filter((e) => e.producer_ref !== GOVERNED_PRODUCER_REF),
      },
    });
    assert.equal((revoked.admitted as { outcome?: { result?: string } }).outcome?.result, "COMMITTED", JSON.stringify(revoked.admitted));
    const stillClear = await evalWorkStart(h, cleared.sealed, [f, cleared.sealed]);
    assert.equal(stillClear.outcome, "ALLOW", "a validly cleared edge stays cleared across revocation");

    // (b) a SUCCESSOR credential bound to the same permanent producer_ref lands on the same key.
    const successor = await h.activatePolicy({
      revision: 3,
      configOverrides: {
        identity_registry: [
          ...REFERENCE_IDENTITIES.filter((e) => e.producer_ref !== GOVERNED_PRODUCER_REF),
          { principal: "cadp-governed-reclassification-2", producer_ref: GOVERNED_PRODUCER_REF, identity_class: { vendor: "cadp", product: "governed-transition", account: "cadp-v04", process_class: "evidence-adapter" } },
        ],
        adapter_registry: REFERENCE_ADAPTERS,
      },
    });
    assert.equal((successor.admitted as { outcome?: { result?: string } }).outcome?.result, "COMMITTED", JSON.stringify(successor.admitted));
    assert.throws(() => h.ingress.submitEvidence(
      {
        evidence_kind: "IMPROVEMENT_FINDING", subject_bindings: cleared.sealed.subject_bindings,
        availability: "PRESENT", claim_schema: "cadp.improvement-finding.v1",
        claim: { ...(cleared.sealed.claim as object), anomaly_code: "SUCCESSOR_GENERATION" },
        producer_ref: GOVERNED_PRODUCER_REF, source_ref: `cadp-v04:gen2-${nextId()}`, source_relation: "SELF_REPORT",
      },
      { principal: "cadp-governed-reclassification-2" },
    ), /GOVERNED_SEAL_CONFLICT/u);
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1);
  } finally { h.close(); }
});

// ================================================================ delegation and context transfer

const S2: SubjectBinding = {
  authority_ref: "github.com", namespace: "module", object_id: "svc/record",
  content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256("svc/record@1") },
};

async function transferChain(h: Harness): Promise<{ cOld: EvidenceEnvelopeV1; cNew: EvidenceEnvelopeV1; g: EvidenceEnvelopeV1 }> {
  const cOld = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "TRANSFER" });
  const transferred = await governedHumanClearing(h, {
    predecessor: cOld, classification: "CONTRACT_GAP", transition_kind: "SUBJECT_TRANSFER", to_subject: subjectTuple(S2),
  });
  const cleared = await governedHumanClearing(h, { predecessor: transferred.sealed, classification: "IMPLEMENTATION_GAP" });
  return { cOld, cNew: transferred.sealed, g: cleared.sealed };
}

test("FC8 / FC16(a): the two-step subject correction discharges the whole chain; a sibling branch does not", async () => {
  const h = await makeHarness();
  try {
    const { cOld, cNew, g } = await transferChain(h);
    const chain = await evalWorkStart(h, g, [cOld, cNew, g]);
    assert.equal(chain.outcome, "ALLOW", JSON.stringify(chain.reason_codes));

    // (b) a sibling tip whose ancestry reaches C_old NOT through C_new hits an unresolved entry.
    const sibling = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", anomaly_code: "SIBLING",
      supersedes: [refOf(cOld)], correction_reason: "unauthorized sibling reclassification",
      subject_bindings: cOld.subject_bindings as SubjectBinding[],
    });
    const sib = await evalWorkStart(h, sibling, [cOld, sibling]);
    assert.equal(sib.outcome, "DENY", JSON.stringify(sib.reason_codes));

    // (e) delegation form (a): an ordinary same-subject intake restatement still delegates, so the
    // obligation lands on the terminal CONTRACT_* node and is discharged there.
    const cA = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "RESTATE_A" });
    const cB = await makeFinding(h, {
      classification: "CONTRACT_GAP", anomaly_code: "RESTATE_B",
      supersedes: [refOf(cA)], correction_reason: "clearer statement of the same problem",
      subject_bindings: cA.subject_bindings as SubjectBinding[],
    });
    const clearedB = await governedHumanClearing(h, { predecessor: cB });
    const restated = await evalWorkStart(h, clearedB.sealed, [cA, cB, clearedB.sealed]);
    assert.equal(restated.outcome, "ALLOW", JSON.stringify(restated.reason_codes));
  } finally { h.close(); }
});

test("FC14 guard-bite: removing delegation makes the legitimate two-step correction a permanent barrier", async () => {
  const h = await makeHarness({
    rego: bite(["resolved_entry(cid, d) if clearing_edge(cid, d)\n\nresolved_entry(cid, d) if delegation_edge(cid, d)", "resolved_entry(cid, d) if clearing_edge(cid, d)"]),
  });
  try {
    const { cOld, cNew, g } = await transferChain(h);
    const chain = await evalWorkStart(h, g, [cOld, cNew, g]);
    assert.equal(chain.outcome, "DENY", "the bite must reproduce round-4 R2: the barrier becomes permanent");
  } finally { h.close(); }
});

test("FC16(b) / R6-2: authority scoped to the corrected subject never discharges the original one", async () => {
  const h = await makeHarness();
  try {
    const cOld = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "R62" });
    // The exploit: an ORDINARY intake subject-changing correction, then a fully valid governed
    // clearing of the corrected node. C_old's obligation must stand — free text is not authority.
    const cNew = await makeFinding(h, {
      classification: "CONTRACT_GAP", anomaly_code: "R62_CORRECTED",
      supersedes: [refOf(cOld)], correction_reason: "wrong module named",
      subject_bindings: [S2],
      subject: { kind: "TARGET", binding_index: 0 },
    });
    const cleared = await governedHumanClearing(h, { predecessor: cNew });
    const r = await evalWorkStart(h, cleared.sealed, [cOld, cNew, cleared.sealed]);
    assert.equal(r.outcome, "DENY", JSON.stringify(r.reason_codes));
    assert.ok(r.reason_codes.includes("contract_barrier"), JSON.stringify(r.reason_codes));
  } finally { h.close(); }
});

test("FC16(c,d) / I3: a transfer may neither cross the boundary nor misname either context", async () => {
  const h = await makeHarness();
  try {
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I3" });
    const { run } = await startRun(h);
    const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
    const basis = [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" as const }];

    // (d) transfer + clear in one step.
    const crossing = humanDraft({ predecessor: c, classification: "IMPLEMENTATION_GAP", run, basis, to_subject: subjectTuple(S2), to_subject_kind: "TARGET" });
    const both = await sealTransition(h, {
      predecessor: c, draft: crossing, run, transition_kind: "SUBJECT_TRANSFER", evidence: [c, diagnostic],
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.notEqual(both.outcome, "ALLOW");
    assert.ok(both.reason_codes.includes("transition_shape_invalid"), JSON.stringify(both.reason_codes));

    // I3 the other way: a RECLASSIFICATION that also changes the subject.
    const crossSubject = await sealTransition(h, {
      predecessor: c, draft: humanDraft({ predecessor: c, classification: "IMPLEMENTATION_GAP", run, basis, to_subject: subjectTuple(S2), to_subject_kind: "TARGET" }),
      run, evidence: [c, diagnostic], human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.notEqual(crossSubject.outcome, "ALLOW");
    assert.ok(crossSubject.reason_codes.includes("transition_subject_mismatch"), JSON.stringify(crossSubject.reason_codes));

    // (c) a transfer whose material names a to_subject the draft does not carry.
    const transfer = humanDraft({ predecessor: c, classification: "CONTRACT_GAP", run, basis, to_subject: subjectTuple(S2), to_subject_kind: "TARGET" });
    const misnamed = await sealTransition(h, {
      predecessor: c, draft: transfer, run, transition_kind: "SUBJECT_TRANSFER", evidence: [c, diagnostic],
      materialOverride: (m) => ({ ...m, to_subject: { authority_ref: "github.com", namespace: "module", object_id: "svc/other" } }),
      human: (effect_id) => [humanDecision(h, effect_id)],
    });
    assert.notEqual(misnamed.outcome, "ALLOW");
    assert.ok(misnamed.reason_codes.includes("transition_shape_invalid"), JSON.stringify(misnamed.reason_codes));
  } finally { h.close(); }
});

test("FC14 guard-bite: dropping subject preservation lets authority for one context clear another", async () => {
  const h = await makeHarness({
    rego: bite([
      "	not is_contract_class(d.claim.classification)\n	subject_tuple(primary_binding(d)) == subject_tuple(primary_binding(fc))\n	governed_transition(d)\n}",
      "	not is_contract_class(d.claim.classification)\n	governed_transition(d)\n}",
    ]),
  });
  try {
    const cOld = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "I1_BITE" });
    const cNew = await makeFinding(h, {
      classification: "CONTRACT_GAP", anomaly_code: "I1_BITE_CORRECTED",
      supersedes: [refOf(cOld)], correction_reason: "wrong module named",
      subject_bindings: [S2], subject: { kind: "TARGET", binding_index: 0 },
    });
    const cleared = await governedHumanClearing(h, { predecessor: cNew });
    // With I1 gone the S2-scoped clearing edge is accepted against C_old's own chain entry too.
    const synthetic = await syntheticGovernedDescendant(h, [cOld], cleared.sealed);
    const r = await evalWorkStart(h, synthetic, [cOld, synthetic]);
    assert.equal(r.outcome, "ALLOW", "the bite must reproduce cross-subject clearing");
  } finally { h.close(); }
});

// ================================================================ §10.4 AUTHORITY_RESOLUTION

const LANDED_AUTHORITY = sha256("landed spec section answering the contract question");

async function landResolutionEntries(h: Harness, revision: number, entries: readonly unknown[]): Promise<void> {
  const admitted = await activateResolutionEntries(h, revision, entries);
  assert.equal((admitted as { outcome?: { result?: string } }).outcome?.result, "COMMITTED", JSON.stringify(admitted));
}

test("FC12 / R5-3: an AUTHORITY_RESOLUTION clears only the ONE tip a Human-landed entry names", async () => {
  const h = await makeHarness();
  try {
    const c1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "AR_1" });
    const c2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "AR_2" });
    const x1 = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", anomaly_code: "AR_1_IMPL",
      supersedes: [refOf(c1)], correction_reason: "authority landed", subject_bindings: c1.subject_bindings as SubjectBinding[],
    });
    const x2 = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", anomaly_code: "AR_2_IMPL",
      supersedes: [refOf(c2)], correction_reason: "authority landed", subject_bindings: c2.subject_bindings as SubjectBinding[],
    });
    const r1 = await submitAuthorityResolution(h, c1, LANDED_AUTHORITY);
    const r2 = await submitAuthorityResolution(h, c2, LANDED_AUTHORITY);

    // (a) with NO landed entry the resolution clears nothing — bare-digest membership is removed.
    const noEntry = await evalWorkStart(h, x1, [c1, x1, r1]);
    assert.equal(noEntry.outcome, "DENY", JSON.stringify(noEntry.reason_codes));

    await landResolutionEntries(h, 2, [{ finding_ref: refOf(c1), authority_content_digest: LANDED_AUTHORITY }]);

    // positive: the entry + a matching resolution clears exactly this tip's edge.
    const cleared = await evalWorkStart(h, x1, [c1, x1, r1]);
    assert.equal(cleared.outcome, "ALLOW", JSON.stringify(cleared.reason_codes));
    // a second resolution of the SAME tip under the same entry is an idempotent restatement.
    const again = await submitAuthorityResolution(h, c1, LANDED_AUTHORITY);
    const idempotent = await evalWorkStart(h, x1, [c1, x1, r1, again]);
    assert.equal(idempotent.outcome, "ALLOW", JSON.stringify(idempotent.reason_codes));

    // (b) the ambient-authority control: the SAME landed digest resolving a different tip.
    const crossFinding = await evalWorkStart(h, x2, [c2, x2, r2]);
    assert.equal(crossFinding.outcome, "DENY", JSON.stringify(crossFinding.reason_codes));

    // (c) the resolution's digest is not the entry's.
    const mismatched = await submitAuthorityResolution(h, c1, sha256("some other landed text"));
    const wrongDigest = await evalWorkStart(h, x1, [c1, x1, mismatched]);
    assert.equal(wrongDigest.outcome, "DENY", JSON.stringify(wrongDigest.reason_codes));

    // (a-ii) id-match-only and digest-match-only entries are not entries.
    await landResolutionEntries(h, 3, [{ finding_ref: { evidence_id: c1.evidence_id, envelope_digest: sha256("wrong") }, authority_content_digest: LANDED_AUTHORITY }]);
    const idOnly = await evalWorkStart(h, x1, [c1, x1, r1]);
    assert.equal(idOnly.outcome, "DENY", JSON.stringify(idOnly.reason_codes));

    // malformed entries are not entries either (round-12 A1(d)).
    await landResolutionEntries(h, 4, [{ finding_ref: refOf(c1), authority_content_digest: "" }, { finding_ref: refOf(c1) }]);
    const malformed = await evalWorkStart(h, x1, [c1, x1, r1]);
    assert.equal(malformed.outcome, "DENY", JSON.stringify(malformed.reason_codes));

    // (d) removal by POLICY_ACTIVATE proves the policy-content boundary.
    await landResolutionEntries(h, 5, []);
    const revoked = await evalWorkStart(h, x1, [c1, x1, r1]);
    assert.equal(revoked.outcome, "DENY", JSON.stringify(revoked.reason_codes));
  } finally { h.close(); }
});

test("FC12(e,f): a decision-envelope ref is not landed authority, and a corrected tip needs its own entry", async () => {
  const h = await makeHarness();
  try {
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "AR_SHAPE" });
    // (e) the removed Human-decision variant: the product validator rejects an untyped ref.
    await assert.rejects(() => submitResolution(
      (draft) => h.ingress.submitEvidence(draft as Parameters<typeof h.ingress.submitEvidence>[0], PRINCIPALS.intake),
      {
        claim: resolutionClaim({ finding_tip_ref: refOf(c), landed_authority_ref: "cadp-v04:evidence:some-human-decision" as never }),
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "evidence", object_id: c.evidence_id }],
        tip: { classification: "CONTRACT_GAP" }, source_ref: "intake",
      },
    ), /landed_authority_ref/u);

    // (f) supersession detaches automatically: an entry bound to the old digest matches no
    // corrected tip, which has its own exact identity.
    await landResolutionEntries(h, 2, [{ finding_ref: refOf(c), authority_content_digest: LANDED_AUTHORITY }]);
    const corrected = await makeFinding(h, {
      classification: "CONTRACT_GAP", anomaly_code: "AR_SHAPE_CORRECTED",
      supersedes: [refOf(c)], correction_reason: "restated", subject_bindings: c.subject_bindings as SubjectBinding[],
    });
    const resolution = await submitAuthorityResolution(h, corrected, LANDED_AUTHORITY);
    const x = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", anomaly_code: "AR_SHAPE_IMPL",
      supersedes: [refOf(corrected)], correction_reason: "implementable", subject_bindings: c.subject_bindings as SubjectBinding[],
    });
    const r = await evalWorkStart(h, x, [c, corrected, x, resolution]);
    assert.equal(r.outcome, "DENY", JSON.stringify(r.reason_codes));
  } finally { h.close(); }
});

test("FC14 guard-bite: dropping the entry binding makes any landed digest ambient authority", async () => {
  const h = await makeHarness({
    rego: bite([
      "	some entry in landed_authority_resolutions\n	well_formed_resolution_entry(entry)\n	entry.finding_ref.evidence_id == cid\n	entry.finding_ref.envelope_digest == fc.envelope_digest.value\n",
      "	some entry in landed_authority_resolutions\n",
    ], [
      "	r.claim.landed_authority_ref.authority_content_digest == entry.authority_content_digest\n",
      "	r.claim.landed_authority_ref.authority_content_digest == entry.authority_content_digest\n	entry\n",
    ]),
  });
  try {
    const c1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "AR_BITE_1" });
    const c2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "AR_BITE_2" });
    const x2 = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", anomaly_code: "AR_BITE_2_IMPL",
      supersedes: [refOf(c2)], correction_reason: "authority landed", subject_bindings: c2.subject_bindings as SubjectBinding[],
    });
    const r2 = await submitAuthorityResolution(h, c2, LANDED_AUTHORITY);
    await landResolutionEntries(h, 2, [{ finding_ref: refOf(c1), authority_content_digest: LANDED_AUTHORITY }]);
    const crossFinding = await evalWorkStart(h, x2, [c2, x2, r2]);
    assert.equal(crossFinding.outcome, "ALLOW", "the bite must reproduce R5-3 ambient standing authority");
  } finally { h.close(); }
});

// ================================================================ A1 expressibility + races

test("FC21(f) / A1: both v1.1 tables ride the landed builder outside data.cadp; inside it they cannot activate", async () => {
  const rule = makeRule();
  const h = await makeHarness();
  try {
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "A1_DET" });
    const cRes = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "A1_RES" });
    const xRes = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", anomaly_code: "A1_RES_IMPL",
      supersedes: [refOf(cRes)], correction_reason: "authority landed", subject_bindings: cRes.subject_bindings as SubjectBinding[],
    });
    const resolution = await submitAuthorityResolution(h, cRes, LANDED_AUTHORITY);

    // (i) ONE ordinary bundle carrying BOTH tables at data.policy_params.improvement_transition,
    // built by the LANDED buildReferenceBundle through paramOverrides — no code, schema, bootstrap
    // or TD change — activates, and both positive paths then complete end to end.
    h.sealReach();
    await h.sealTargetIdentity();
    const activated = await h.activatePolicy({
      revision: 2,
      paramOverrides: {
        improvement_transition: {
          authority_text_rules: [rule],
          landed_authority_resolutions: [{ finding_ref: refOf(cRes), authority_content_digest: LANDED_AUTHORITY }],
        },
      },
    });
    assert.equal((activated.admitted as { outcome?: { result?: string } }).outcome?.result, "COMMITTED", JSON.stringify(activated.admitted));

    const { run } = await startRun(h);
    const at = appliesTo({ predecessor: c, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const seal = await sealTransition(h, {
      predecessor: c, draft: deterministicDraft({ predecessor: c, observation: a, applies_to: at, rule }),
      run, evidence: [c, a],
    });
    assert.equal(seal.outcome, "ALLOW", JSON.stringify(seal.reason_codes));
    assert.equal(seal.admitted?.kind === "ADMITTED" ? seal.admitted.outcome.result : "", "COMMITTED");
    const detTip = await evalWorkStart(h, seal.sealed!, [c, seal.sealed!]);
    assert.equal(detTip.outcome, "ALLOW", JSON.stringify(detTip.reason_codes));
    const resTip = await evalWorkStart(h, xRes, [cRes, xRes, resolution]);
    assert.equal(resTip.outcome, "ALLOW", JSON.stringify(resTip.reason_codes));

    // (ii) the same table INSIDE the kernel-owned closed schema is refused by the landed
    // validateKernelConfig — the A1 defect, reproduced by execution rather than by reading.
    const inside = await h.activatePolicy({ revision: 3, configOverrides: { authority_text_rules: [rule] } as never });
    const refused = inside.admitted as { kind?: string; reason?: string; detail?: string };
    assert.equal(refused.kind, "REFUSAL", JSON.stringify(inside.admitted));
    assert.equal(refused.reason, "KERNEL_CONFIG_INVALID");
    assert.match(String(refused.detail), /unknown key data\.cadp\.authority_text_rules \(closed schema\)/u);
  } finally { h.close(); }
});

test("FC20(a): competing first admissions under ONE observation carry byte-identical drafts and converge", async () => {
  const rule = makeRule();
  const h = await makeHarness(withRules([rule]));
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "RACE_A" });
    const { run } = await startRun(h);
    const at = appliesTo({ predecessor: f, rule, run });
    const a = submitAuthorityObservation(h, { applies_to: at });
    const draft = deterministicDraft({ predecessor: f, observation: a, applies_to: at, rule });
    const ea = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
    const eb = await sealTransition(h, { predecessor: f, draft, run, evidence: [f, a] });
    assert.equal(ea.outcome, "ALLOW", JSON.stringify(ea.reason_codes));
    assert.equal(eb.outcome, "ALLOW", JSON.stringify(eb.reason_codes));
    assert.equal(ea.sealed!.evidence_id, eb.sealed!.evidence_id, "the race has no observable outcome to win");
    assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1);
    assert.equal(h.store.openIncidents().filter((i) => (i.claim as { incident_kind?: string }).incident_kind === "GOVERNED_SEAL_CONFLICT").length, 0);
  } finally { h.close(); }
});

test("FC20(d,e,f): every separately-authorized rival is refused LOUDLY on the occupied edge", async () => {
  const rule = makeRule();
  for (const scenario of ["cross-generation", "cross-run re-observation", "multi-observation"] as const) {
    const h = await makeHarness(withRules([rule]));
    try {
      const f = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: `RACE_${scenario}` });
      const { run } = await startRun(h);
      const at = appliesTo({ predecessor: f, rule, run });
      const a1 = submitAuthorityObservation(h, { applies_to: at });
      const first = await sealTransition(h, {
        predecessor: f, draft: deterministicDraft({ predecessor: f, observation: a1, applies_to: at, rule }), run, evidence: [f, a1],
      });
      assert.equal(first.outcome, "ALLOW", JSON.stringify(first.reason_codes));
      assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "COMMITTED");

      let rival: Awaited<ReturnType<typeof sealTransition>>;
      if (scenario === "cross-generation") {
        const amended = makeRule({ derived_correction_reason: "amended by a later policy generation" });
        h.sealReach();
        await h.sealTargetIdentity();
        await h.activatePolicy({ revision: 2, paramOverrides: { improvement_transition: { authority_text_rules: [amended] } } });
        rival = await sealTransition(h, {
          predecessor: f, draft: deterministicDraft({ predecessor: f, observation: a1, applies_to: at, rule: amended }), run, evidence: [f, a1],
        });
      } else if (scenario === "cross-run re-observation") {
        const run2 = (await startRun(h)).run;
        const at2 = appliesTo({ predecessor: f, rule, run: run2 });
        const a2 = submitAuthorityObservation(h, { applies_to: at2 });
        rival = await sealTransition(h, {
          predecessor: f, draft: deterministicDraft({ predecessor: f, observation: a2, applies_to: at2, rule }), run: run2, evidence: [f, a2],
        });
      } else {
        // Round-11 S11-2, the DECLARED residual: two distinct observations about one F in one run.
        const a2 = submitAuthorityObservation(h, { applies_to: at });
        assert.notEqual(a2.evidence_id, a1.evidence_id);
        rival = await sealTransition(h, {
          predecessor: f, draft: deterministicDraft({ predecessor: f, observation: a2, applies_to: at, rule }), run, evidence: [f, a2],
        });
      }
      // Each rival is authorized by its OWN observation and policy generation — so the property
      // R10-1 required holds either way — but only one governed edge can ever exist.
      assert.equal(rival.outcome, "ALLOW", `${scenario}: ${JSON.stringify(rival.reason_codes)}`);
      assert.equal(rival.admitted?.kind === "ADMITTED" ? rival.admitted.outcome.result : "", "NO_EFFECT_CONFIRMED", `${scenario}: ${JSON.stringify(rival.admitted)}`);
      assert.equal(h.store.governedEdgeCount(GOVERNED_PRODUCER_REF, f.evidence_id), 1, scenario);
      const incident = h.store.openIncidents().find((i) => (i.claim as { incident_kind?: string }).incident_kind === "GOVERNED_SEAL_CONFLICT");
      assert.ok(incident !== undefined, `${scenario}: the loser is refused loudly, never silently selected`);
      // The winner's content is authorized by its own observation, which names exactly (F, run).
      const basis = (first.sealed!.claim as { basis: Array<{ evidence_id: string }> }).basis;
      assert.equal(basis.length, 1);
      const winner = h.store.evidenceById(basis[0]!.evidence_id)!;
      const winnerApplies = (winner.claim as { applies_to: { predecessor_ref: { evidence_id: string }; work_run_ref: string } }).applies_to;
      assert.equal(winnerApplies.predecessor_ref.evidence_id, f.evidence_id);
      assert.equal(winnerApplies.work_run_ref, run);
    } finally { h.close(); }
  }
});

test("FC11: no clearing predicate ever reads a free-text statement field", () => {
  assert.ok(!/[A-Za-z_\]]\.statement\b/u.test(REFERENCE_REGO), "policy must never read a claim statement");
  assert.ok(!REFERENCE_REGO.includes('statement"]'), "policy must never index a claim statement");
});
