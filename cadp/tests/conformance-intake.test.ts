/**
 * cadp.improvement-intake.v1 conformance (#104 §11 controls 1–20). Real store + real OPA sidecar
 * + real kernel path; the product intake adapter validates claims, the reference Rego gates the
 * effects, and a scripted GitHub Issues transport backs FINDING_PROJECT (§13.3). Controls 1/2/9/10
 * (dev/non-dev/restart live positives) are proven in the live harness; their deterministic shape is
 * anchored here (clean implementation ALLOW, resolution validity, projection COMMITTED).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";

import { makeHarness, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { ScriptedIssues } from "./support/scriptedIssues.ts";
import { GitHubIssuesAdapter } from "../kernel/adapters/githubIssues.ts";
import { TemporalAdapter } from "../kernel/adapters/temporal.ts";
import type { TemporalTransport } from "../kernel/adapters/temporal.ts";
import { jcsDigest } from "../kernel/canonical.ts";
import { resolveActivePolicy } from "../kernel/policyState.ts";
import type { ResolvedAdmissionBundle } from "../kernel/evaluator.ts";
import type { EvidenceEnvelopeV1, SubjectBinding } from "../kernel/records.ts";
import {
  buildFindingClaim, submitFinding, submitResolution, buildProjectionMaterial,
  buildFindingAdmission, findingWorkBinding, refOf, IntakeValidationError, INTAKE_PRINCIPAL,
} from "../product/improvement/intakeAdapter.ts";
import type { FindingBuildInput, EvidenceDraftLike } from "../product/improvement/intakeAdapter.ts";
import { validateFindingClaim, validateResolutionClaim } from "../product/improvement/contracts.ts";
import type { Classification, ImprovementFindingResolutionClaimV1 } from "../product/improvement/contracts.ts";

after(() => stopSharedOpa());

function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }

const INTAKE = { principal: INTAKE_PRINCIPAL };
function submitter(h: Harness) {
  return (draft: EvidenceDraftLike) => h.ingress.submitEvidence(draft as Parameters<typeof h.ingress.submitEvidence>[0], INTAKE);
}

/** Submit a supporting (non-intake) evidence envelope to serve as a Finding basis / observation.
 * A valid WORK_STEP needs a work-run subject binding; the meaningful binding rides at index 1. */
function submitObservation(h: Harness, opts: { authority_ref?: string; namespace: string; object_id: string; revision?: string }): EvidenceEnvelopeV1 {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "WORK_STEP",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-obs-${(counter += 1)}` },
        { authority_ref: opts.authority_ref ?? "github.com", namespace: opts.namespace, object_id: opts.object_id, ...(opts.revision !== undefined ? { revision_or_version: opts.revision } : {}) },
      ],
      availability: "PRESENT",
      claim_schema: "cadp.work-step.v1",
      claim: { step_ordinal: 1, summary: `observation ${opts.object_id}` },
      producer_ref: "workflow:cadp-work",
      source_ref: "harness-observation",
      source_relation: "SELF_REPORT",
    },
    PRINCIPALS.workflow,
  );
}

const AUTHORITY_SUBJECT: SubjectBinding = {
  authority_ref: "git:github.com/astro3141/common-autonomous-development-platform",
  namespace: "repository-path",
  object_id: "Common Autonomous Development Platform — Specification v0.4.md",
  content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: "ef6814e0a423916b229a46a4d64f24377792cd1ac301b90a4ccbad2b3556ae77" },
};

const AUTHORITY_METHOD = {
  method_ref: "cadp:authority-reclassification:test-rule",
  method_digest: "sha256:test-authority-rule",
};

const AUTHORITY_TEXT_RULE = {
  evidence_kind: "VERIFICATION",
  claim_schema: "cadp.authority-text-observation.v1",
  producer_ref: "verifier:harness",
  source_relation: "INDEPENDENT_OBSERVATION",
  integrity: "AUTHENTICATED_SOURCE",
  subject_binding: AUTHORITY_SUBJECT,
  ...AUTHORITY_METHOD,
  from_classification: "CONTRACT_GAP",
  to_classification: "IMPLEMENTATION_GAP",
};

/** Seal an authority-text observation. #107 S3: the envelope must name the exact predecessor
 * Finding it clears; omit `finding` to build the (invalid) ambient form for negative controls. */
function submitAuthorityText(h: Harness, finding?: EvidenceEnvelopeV1): EvidenceEnvelopeV1 {
  const completed_at = new Date(h.clock.now).toISOString();
  return h.ingress.submitEvidence(
    {
      evidence_kind: "VERIFICATION",
      subject_bindings: [
        AUTHORITY_SUBJECT,
        ...(finding === undefined ? [] : [{
          authority_ref: "cadp-store:k04",
          namespace: "improvement-finding",
          object_id: finding.evidence_id,
          content_digest: finding.envelope_digest,
        }]),
      ],
      availability: "PRESENT",
      claim_schema: "cadp.authority-text-observation.v1",
      claim: { conclusion: "success", completed_at },
      produced_at: completed_at,
      producer_ref: "verifier:harness",
      source_ref: "clean-checkout:spec-v0.4",
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.verifier,
  );
}

/** #107 S4: the PEP's recheck #5 requires a work_run-scoped decision to name the exact work run
 * of the admitted request, so an admitting test must pass the run it will seal under. */
function submitHumanDesignDecision(h: Harness, finding: EvidenceEnvelopeV1, decision = "APPROVE", work_run_ref?: string): EvidenceEnvelopeV1 {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "HUMAN_DECISION",
      subject_bindings: [{
        authority_ref: "cadp-store:k04",
        namespace: "improvement-finding",
        object_id: finding.evidence_id,
        content_digest: finding.envelope_digest,
      }],
      availability: "PRESENT",
      claim_schema: "cadp.human-design-decision.v1",
      claim: {
        decision,
        scope: { work_run_ref: work_run_ref ?? finding.evidence_id },
        statement: "the exact contract boundary has been decided",
      },
      producer_ref: "human:astro3141",
      source_ref: "design-decision",
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.human,
  );
}

let counter = 0;
/** Build + submit an IMPROVEMENT_FINDING via the product adapter (validated). */
async function makeFinding(h: Harness, over: Partial<FindingBuildInput> & { classification: Classification }): Promise<EvidenceEnvelopeV1> {
  const basisEnv = submitObservation(h, { namespace: "commit", object_id: `sha-${(counter += 1)}`, revision: "rev-1" });
  // The finding binds its (mutable) subject by an immutable content_digest, not a mutable revision:
  // the Finding is an immutable interpretation of an exact snapshot (§2.2).
  const subject_bindings: SubjectBinding[] = over.subject_bindings as SubjectBinding[] ?? [
    { authority_ref: "github.com", namespace: "work-run", object_id: `wr-${counter}`, content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256(`wr-${counter}`) } },
    { authority_ref: "github.com", namespace: "commit", object_id: `sha-${counter}`, content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256(`sha-${counter}`) } },
  ];
  const claim = buildFindingClaim({
    classification: over.classification,
    subject: over.subject ?? { kind: "WORK_RUN", binding_index: 0 },
    subject_bindings,
    basis: over.basis ?? [{ evidence_id: basisEnv.evidence_id, envelope_digest: basisEnv.envelope_digest.value, role: "OBSERVATION" }],
    derivation: over.derivation ?? { kind: "DETERMINISTIC_DERIVATION", method_ref: "detector:x", method_digest: `md-${counter}` },
    anomaly_code: over.anomaly_code ?? `ANOM_${counter}`,
    statement: over.statement ?? { summary: `finding ${counter}` },
    ...(over.supersedes !== undefined ? { supersedes: over.supersedes } : {}),
    ...(over.correction_reason !== undefined ? { correction_reason: over.correction_reason } : {}),
    ...(over.series !== undefined ? { series: over.series } : {}),
  });
  return submitFinding(submitter(h), { claim, subject_bindings, source_ref: "intake-detector", execution_or_run_ref: over.derivation?.execution_or_run_ref });
}

/** Seal an intake WORK_START bound to a finding and evaluate it; returns the OPA outcome. */
async function evalWorkStart(h: Harness, input: {
  finding: EvidenceEnvelopeV1;
  purpose?: "IMPLEMENTATION" | "INDEX_ONLY";
  conflict_complete?: boolean;
  external_inputs?: Parameters<typeof buildFindingAdmission>[0]["external_inputs"];
  evidence: EvidenceEnvelopeV1[];
  extraWorkBindings?: SubjectBinding[];
}): Promise<{ outcome: string; reason_codes: string[] }> {
  const admission = buildFindingAdmission({
    finding_ref: refOf(input.finding),
    purpose: input.purpose ?? "IMPLEMENTATION",
    conflict_complete: input.conflict_complete ?? true,
    external_inputs: input.external_inputs,
  });
  const material = { finding_admission: admission, bounds: {} };
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: (counter += 1), purpose: "work-start",
  });
  h.ingress.sealEffectRequest(
    {
      effect_id, requester_ref: "workflow:cadp-work",
      work_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${effect_id}` },
        findingWorkBinding(refOf(input.finding)),
        ...(input.extraWorkBindings ?? []),
      ],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "cadp-v04" },
      operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", material_ref, prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const evIds = input.evidence.map((e) => e.evidence_id);
  const inp = h.ingress.assembleAdmissionInput(effect_id, evIds);
  const evaluated = await h.evaluate(inp.input_digest.value);
  if (evaluated.kind !== "DECISION") return { outcome: evaluated.kind, reason_codes: [] };
  return { outcome: evaluated.decision.outcome, reason_codes: [...evaluated.decision.reason_codes] };
}

/** Seal a non-index mutation bound to a finding and evaluate. */
async function evalNonIndexMutation(
  h: Harness,
  finding: EvidenceEnvelopeV1,
  evidence: EvidenceEnvelopeV1[],
  operation: "GIT_PUSH" | "PR_MERGE" | "POLICY_ACTIVATE" = "GIT_PUSH",
): Promise<{ outcome: string; reason_codes: string[] }> {
  const bodyKey = h.ingress.putBlob(Buffer.from("body", "utf8"));
  const material = operation === "GIT_PUSH"
    ? { repo_id: "r", ref: "refs/heads/cadp/candidate/x", new_sha: "x", expected_old_sha: "0".repeat(40), bundle_cas_key: bodyKey }
    : operation === "PR_MERGE"
      ? { repo_id: "r", pr_number: 1, expected_head_sha: "x" }
      : { proposed_policy_ref: {}, bundle_cas_ref: bodyKey, expected_active_policy_ref: {} };
  const purpose = operation === "GIT_PUSH" ? "git-push" : operation === "PR_MERGE" ? "pr-merge" : "policy-activate";
  const target_ref = operation === "POLICY_ACTIVATE"
    ? { authority_ref: "cadp-store:k04", target_type: "POLICY_STORE", target_id: "active" }
    : { authority_ref: "github.com", target_type: operation === "PR_MERGE" ? "GIT_PR" : "GIT_REPOSITORY", target_id: "r" };
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: (counter += 1), purpose,
  });
  h.ingress.sealEffectRequest(
    {
      effect_id, requester_ref: "workflow:cadp-work",
      work_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${effect_id}` },
        findingWorkBinding(refOf(finding)),
      ],
      target_ref,
      operation_kind: operation, material_schema: `cadp.${operation.toLowerCase().replaceAll("_", "-")}.v1`, material_ref, prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const inp = h.ingress.assembleAdmissionInput(effect_id, evidence.map((e) => e.evidence_id));
  const evaluated = await h.evaluate(inp.input_digest.value);
  if (evaluated.kind !== "DECISION") return { outcome: evaluated.kind, reason_codes: [] };
  return { outcome: evaluated.decision.outcome, reason_codes: [...evaluated.decision.reason_codes] };
}

// ================================================================ positives

test("intake positive: clean IMPLEMENTATION_GAP leaf → implementation WORK_START ALLOW", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "IMPLEMENTATION_GAP" });
    const r = await evalWorkStart(h, { finding: f, evidence: [f] });
    assert.equal(r.outcome, "ALLOW", JSON.stringify(r));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 3
test("C3: empty basis or mutable unversioned subject cannot be a PRESENT Finding", async () => {
  const h = await makeHarness();
  try {
    const bindings: SubjectBinding[] = [{ authority_ref: "github.com", namespace: "work-run", object_id: "wr" }]; // no revision
    // empty basis
    const empty = validateFindingClaim({
      contract_id: "cadp.improvement-intake.v1", classification: "BUG",
      subject: { kind: "WORK_RUN", binding_index: 0 }, basis: [],
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "m", method_digest: "d" },
      anomaly_code: "A", occurrence_key: "x", statement: { summary: "s" },
    } as never, bindings);
    assert.ok(!empty.ok && empty.errors.some((e) => e.includes("basis")), JSON.stringify(empty.errors));
    // Mutable WORK_RUN subject with no revision/digest → rejected (ambient "current" forbidden).
    const claim = buildFindingClaim({
      classification: "BUG", subject: { kind: "WORK_RUN", binding_index: 0 }, subject_bindings: bindings,
      basis: [{ evidence_id: "e", envelope_digest: "d", role: "OBSERVATION" }],
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "m", method_digest: "d" },
      anomaly_code: "A", statement: { summary: "s" },
    });
    const v = validateFindingClaim(claim, bindings);
    assert.ok(!v.ok && v.errors.some((e) => e.includes("mutable subject")), JSON.stringify(v.errors));
    // An EVIDENCE subject (immutable) needs no revision.
    const evBindings: SubjectBinding[] = [{ authority_ref: "cadp-store:k04", namespace: "evidence", object_id: "cadp-v04:evidence:1" }];
    const evClaim = buildFindingClaim({
      classification: "BUG", subject: { kind: "EVIDENCE", binding_index: 0 }, subject_bindings: evBindings,
      basis: [{ evidence_id: "e", envelope_digest: "d", role: "OBSERVATION" }],
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "m", method_digest: "d" },
      anomaly_code: "A", statement: { summary: "s" },
    });
    assert.ok(validateFindingClaim(evClaim, evBindings).ok);
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 4
test("C4: model-derived semantics not marked MODEL_PROPOSAL are rejected by the adapter", async () => {
  const h = await makeHarness();
  try {
    // A model run (execution_or_run_ref present) declared DETERMINISTIC → rejected.
    await assert.rejects(() => makeFinding(h, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "prompt:x", method_digest: "pd", execution_or_run_ref: "run:123" },
    }), (e: unknown) => e instanceof IntakeValidationError && e.errors.some((x) => x.includes("DETERMINISTIC_DERIVATION must not carry")));
    // MODEL_PROPOSAL without a run ref → rejected.
    await assert.rejects(() => makeFinding(h, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "MODEL_PROPOSAL", method_ref: "prompt:x", method_digest: "pd" },
    }), (e: unknown) => e instanceof IntakeValidationError);
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 5
test("C5: reclassification appends (old digest remains); concurrent tips → admission DENY", async () => {
  const h = await makeHarness();
  try {
    const f1 = await makeFinding(h, { classification: "IMPLEMENTATION_GAP", anomaly_code: "SHARED" });
    // Two independent unsuperseded leaves sharing occurrence_key: build f1b with identical inputs.
    const f1b = await makeFindingSameOccurrence(h, f1);
    // f1 still exists and is addressable (append-only): re-read succeeds.
    assert.ok(h.store.evidenceById(f1.evidence_id) !== undefined, "original finding retained");
    const r = await evalWorkStart(h, { finding: f1, evidence: [f1, f1b] });
    assert.equal(r.outcome, "DENY");
    assert.ok(r.reason_codes.includes("supersession_conflict"), JSON.stringify(r.reason_codes));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 8 / 16
test("C8/C16: unresolved CONTRACT_* → implementation WORK_START DENY; bound GIT_PUSH DENY (delta 0)", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP" });
    const ws = await evalWorkStart(h, { finding: f, evidence: [f] });
    assert.equal(ws.outcome, "DENY");
    assert.ok(ws.reason_codes.includes("contract_barrier"), JSON.stringify(ws.reason_codes));
    const push = await evalNonIndexMutation(h, f, [f]);
    assert.equal(push.outcome, "DENY");
    assert.ok(push.reason_codes.includes("contract_barrier_nonindex_denied"), JSON.stringify(push.reason_codes));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 11 / 17
test("C11/C17: MODEL_PROPOSAL reclassification of CONTRACT_* (even citing authority) keeps the barrier → DENY", async () => {
  const h = await makeHarness({ paramOverrides: { authority_text_rules: [AUTHORITY_TEXT_RULE] } });
  try {
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "CG1" });
    // F2 supersedes the CONTRACT_GAP, cites AUTHORITY_TEXT, but is MODEL_PROPOSAL → cannot clear (§3).
    const authorityEnv = submitAuthorityText(h, c);
    const f2 = await makeReclass(h, c, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "MODEL_PROPOSAL", method_ref: "prompt:reclass", method_digest: "pr", execution_or_run_ref: "run:9" },
      basis: [
        { evidence_id: c.evidence_id, envelope_digest: c.envelope_digest.value, role: "DIAGNOSTIC" },
        { evidence_id: authorityEnv.evidence_id, envelope_digest: authorityEnv.envelope_digest.value, role: "AUTHORITY_TEXT" },
      ],
    });
    const r = await evalWorkStart(h, { finding: f2, evidence: [f2, c, authorityEnv] });
    assert.equal(r.outcome, "DENY");
    assert.ok(r.reason_codes.includes("contract_barrier"), JSON.stringify(r.reason_codes));
    // Contrast: HUMAN_JUDGMENT reclassification clears the barrier → ALLOW.
    const humanEnv = submitHumanDesignDecision(h, c);
    const f3 = await makeReclass(h, c, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "HUMAN_JUDGMENT", method_ref: "design:decision", method_digest: "hd", execution_or_run_ref: "human:astro3141" },
      basis: [{ evidence_id: humanEnv.evidence_id, envelope_digest: humanEnv.envelope_digest.value, role: "AUTHORITY_TEXT" }],
    });
    const r3 = await evalWorkStart(h, { finding: f3, evidence: [f3, c, humanEnv] });
    assert.equal(r3.outcome, "ALLOW", JSON.stringify(r3));
  } finally { h.close(); }
});

test("#107 B18: resolved ordinary evidence self-labelled AUTHORITY_TEXT cannot clear CONTRACT_*", async () => {
  const h = await makeHarness();
  try {
    const contractFinding = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "B18" });
    const ordinaryObservation = submitObservation(h, {
      authority_ref: "telemetry.example",
      namespace: "span",
      object_id: "ordinary-observation",
      revision: "1",
    });
    const reclassified = await makeReclass(h, contractFinding, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "detector:self-declared", method_digest: "untrusted" },
      basis: [{
        evidence_id: ordinaryObservation.evidence_id,
        envelope_digest: ordinaryObservation.envelope_digest.value,
        role: "AUTHORITY_TEXT",
      }],
    });

    const result = await evalWorkStart(h, { finding: reclassified, evidence: [reclassified, contractFinding, ordinaryObservation] });
    assert.equal(result.outcome, "DENY", JSON.stringify(result));
    assert.ok(result.reason_codes.includes("contract_barrier"), JSON.stringify(result.reason_codes));
  } finally { h.close(); }
});

test("#107 B18: authority basis digest mismatch or absent exact envelope fails closed", async () => {
  const h = await makeHarness({ paramOverrides: { authority_text_rules: [AUTHORITY_TEXT_RULE] } });
  try {
    const contractFinding = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "B18-EXACT" });
    const authority = submitAuthorityText(h, contractFinding);

    const mismatched = await makeReclass(h, contractFinding, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: [{ evidence_id: authority.evidence_id, envelope_digest: "0".repeat(64), role: "AUTHORITY_TEXT" }],
    });
    const mismatchResult = await evalWorkStart(h, { finding: mismatched, evidence: [mismatched, contractFinding, authority] });
    assert.equal(mismatchResult.outcome, "DENY", JSON.stringify(mismatchResult));
    assert.ok(mismatchResult.reason_codes.includes("contract_barrier"));

    const absent = await makeReclass(h, contractFinding, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: [{ evidence_id: authority.evidence_id, envelope_digest: authority.envelope_digest.value, role: "AUTHORITY_TEXT" }],
    });
    const absentResult = await evalWorkStart(h, { finding: absent, evidence: [absent, contractFinding] });
    assert.equal(absentResult.outcome, "DENY", JSON.stringify(absentResult));
    assert.ok(absentResult.reason_codes.includes("contract_barrier"));
  } finally { h.close(); }
});

test("#107 B18 positive: exact policy-declared landed authority basis permits only its deterministic transition", async () => {
  const h = await makeHarness({ paramOverrides: { authority_text_rules: [AUTHORITY_TEXT_RULE] } });
  try {
    const contractFinding = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "B18-POS" });
    const authority = submitAuthorityText(h, contractFinding);
    const reclassified = await makeReclass(h, contractFinding, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: [{ evidence_id: authority.evidence_id, envelope_digest: authority.envelope_digest.value, role: "AUTHORITY_TEXT" }],
    });
    const result = await evalWorkStart(h, { finding: reclassified, evidence: [reclassified, contractFinding, authority] });
    assert.equal(result.outcome, "ALLOW", JSON.stringify(result));

    const wrongMethod = await makeReclass(h, contractFinding, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: AUTHORITY_METHOD.method_ref, method_digest: "wrong-method-digest" },
      basis: [{ evidence_id: authority.evidence_id, envelope_digest: authority.envelope_digest.value, role: "AUTHORITY_TEXT" }],
    });
    const wrongMethodResult = await evalWorkStart(h, { finding: wrongMethod, evidence: [wrongMethod, contractFinding, authority] });
    assert.equal(wrongMethodResult.outcome, "DENY", JSON.stringify(wrongMethodResult));
    assert.ok(wrongMethodResult.reason_codes.includes("contract_barrier"));
  } finally { h.close(); }
});

test("#107 B18: PR_MERGE and POLICY_ACTIVATE remain denied while an authority basis is unresolved", async () => {
  const h = await makeHarness();
  try {
    const contractFinding = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "B18-HIGH-RISK" });
    const ordinary = submitObservation(h, { authority_ref: "telemetry.example", namespace: "span", object_id: "not-authority", revision: "1" });
    const reclassified = await makeReclass(h, contractFinding, {
      classification: "IMPLEMENTATION_GAP",
      derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: "detector:self-declared", method_digest: "untrusted" },
      basis: [{ evidence_id: ordinary.evidence_id, envelope_digest: ordinary.envelope_digest.value, role: "AUTHORITY_TEXT" }],
    });
    for (const operation of ["PR_MERGE", "POLICY_ACTIVATE"] as const) {
      const result = await evalNonIndexMutation(h, reclassified, [reclassified, contractFinding, ordinary], operation);
      assert.equal(result.outcome, "DENY", `${operation}: ${JSON.stringify(result)}`);
      assert.ok(result.reason_codes.includes("contract_barrier_nonindex_denied"), `${operation}: ${JSON.stringify(result.reason_codes)}`);
    }
  } finally { h.close(); }
});

// ================================================================ #107 second round (PR #108 Review S1/S3/S4/S5)

const HUMAN_RECLASS_DERIVATION = {
  kind: "HUMAN_JUDGMENT" as const,
  method_ref: "design:decision",
  method_digest: "hd",
  execution_or_run_ref: "human:astro3141",
};

function humanBasis(env: EvidenceEnvelopeV1, role: "AUTHORITY_TEXT" | "DIAGNOSTIC" = "AUTHORITY_TEXT") {
  return [{ evidence_id: env.evidence_id, envelope_digest: env.envelope_digest.value, role }];
}

// ---------------------------------------------------------------- S1: decision semantics
test("#107 S1: only APPROVE / EXCEPTION_ACCEPT Human decisions clear CONTRACT_*; REJECT/STOP/arbitrary keep the barrier", async () => {
  const h = await makeHarness();
  try {
    for (const decision of ["REJECT", "STOP", "MAYBE", ""]) {
      const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: `S1N-${decision || "EMPTY"}` });
      const human = submitHumanDesignDecision(h, c, decision || "UNSPECIFIED");
      const f = await makeReclass(h, c, { classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION, basis: humanBasis(human) });
      const r = await evalWorkStart(h, { finding: f, evidence: [f, c, human] });
      assert.equal(r.outcome, "DENY", `decision ${decision}: ${JSON.stringify(r)}`);
      assert.ok(r.reason_codes.includes("contract_barrier"), `decision ${decision}: ${JSON.stringify(r.reason_codes)}`);
    }
    for (const decision of ["APPROVE", "EXCEPTION_ACCEPT"]) {
      const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: `S1P-${decision}` });
      const human = submitHumanDesignDecision(h, c, decision);
      const f = await makeReclass(h, c, { classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION, basis: humanBasis(human) });
      const r = await evalWorkStart(h, { finding: f, evidence: [f, c, human] });
      assert.equal(r.outcome, "ALLOW", `decision ${decision}: ${JSON.stringify(r)}`);
    }
  } finally { h.close(); }
});

test("#107 S1: a decision cited under a non-authority role, or a non-decision envelope cited as authority, cannot clear", async () => {
  const h = await makeHarness();
  try {
    // APPROVE decision exists and binds the exact predecessor, but the Finding cites it as DIAGNOSTIC.
    const c1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S1-ROLE" });
    const human = submitHumanDesignDecision(h, c1);
    const wrongRole = await makeReclass(h, c1, { classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION, basis: humanBasis(human, "DIAGNOSTIC") });
    const r1 = await evalWorkStart(h, { finding: wrongRole, evidence: [wrongRole, c1, human] });
    assert.equal(r1.outcome, "DENY", JSON.stringify(r1));
    assert.ok(r1.reason_codes.includes("contract_barrier"), JSON.stringify(r1.reason_codes));

    // HUMAN_JUDGMENT citing an ordinary WORK_STEP self-report under AUTHORITY_TEXT.
    const c2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S1-KIND" });
    const ordinary = submitObservation(h, { authority_ref: "telemetry.example", namespace: "span", object_id: "not-a-decision", revision: "1" });
    const wrongKind = await makeReclass(h, c2, { classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION, basis: humanBasis(ordinary) });
    const r2 = await evalWorkStart(h, { finding: wrongKind, evidence: [wrongKind, c2, ordinary] });
    assert.equal(r2.outcome, "DENY", JSON.stringify(r2));
    assert.ok(r2.reason_codes.includes("contract_barrier"), JSON.stringify(r2.reason_codes));

    // Kind guard bite: a NON-decision envelope that mimics every other predicate (claim.decision
    // APPROVE, exact finding binding, authenticated integrity) — only evidence_kind stops it.
    const c3 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S1-MIMIC" });
    const decisionShaped = h.ingress.submitEvidence(
      {
        evidence_kind: "WORK_STEP",
        subject_bindings: [
          { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "wr-s1-mimic" },
          { authority_ref: "cadp-store:k04", namespace: "improvement-finding", object_id: c3.evidence_id, content_digest: c3.envelope_digest },
        ],
        availability: "PRESENT",
        claim_schema: "cadp.work-step.v1",
        claim: { step_ordinal: 1, summary: "smuggled decision", decision: "APPROVE" },
        producer_ref: "workflow:cadp-work",
        source_ref: "harness-observation",
        source_relation: "SELF_REPORT",
      },
      PRINCIPALS.workflow,
    );
    const mimic = await makeReclass(h, c3, { classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION, basis: humanBasis(decisionShaped) });
    const r3 = await evalWorkStart(h, { finding: mimic, evidence: [mimic, c3, decisionShaped] });
    assert.equal(r3.outcome, "DENY", JSON.stringify(r3));
    assert.ok(r3.reason_codes.includes("contract_barrier"), JSON.stringify(r3.reason_codes));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- S5: predecessor digest binding
test("#107 S5: a supersedes ref with a mismatched predecessor digest never clears (Human and deterministic paths)", async () => {
  const h = await makeHarness({ paramOverrides: { authority_text_rules: [AUTHORITY_TEXT_RULE] } });
  try {
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S5-PRED" });
    const wrongPredecessor = [{ evidence_id: c.evidence_id, envelope_digest: "0".repeat(64) }];
    // Human path: the decision itself binds the exact predecessor, only the supersedes digest lies.
    const human = submitHumanDesignDecision(h, c);
    const humanReclass = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION,
      basis: humanBasis(human), supersedes: wrongPredecessor, correction_reason: "reclassification",
    });
    const r1 = await evalWorkStart(h, { finding: humanReclass, evidence: [humanReclass, c, human] });
    assert.equal(r1.outcome, "DENY", JSON.stringify(r1));
    assert.ok(r1.reason_codes.includes("contract_barrier"), JSON.stringify(r1.reason_codes));
    // Deterministic path: valid landed authority for c, same lying supersedes digest.
    const authority = submitAuthorityText(h, c);
    const detReclass = await makeFinding(h, {
      classification: "IMPLEMENTATION_GAP", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(authority), supersedes: wrongPredecessor, correction_reason: "reclassification",
    });
    const r2 = await evalWorkStart(h, { finding: detReclass, evidence: [detReclass, c, authority] });
    assert.equal(r2.outcome, "DENY", JSON.stringify(r2));
    assert.ok(r2.reason_codes.includes("contract_barrier"), JSON.stringify(r2.reason_codes));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- S3: exact finding-context binding
test("#107 S3: deterministic authority evidence clears only the exact Finding it names — no ambient/transplanted clearance", async () => {
  const h = await makeHarness({ paramOverrides: { authority_text_rules: [AUTHORITY_TEXT_RULE] } });
  try {
    const a = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S3-A" });
    const b = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S3-B" });
    const authorityForA = submitAuthorityText(h, a);

    // Transplant: the sealed authority for A cited to clear B → DENY.
    const reclassB = await makeReclass(h, b, {
      classification: "IMPLEMENTATION_GAP", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(authorityForA),
    });
    const rB = await evalWorkStart(h, { finding: reclassB, evidence: [reclassB, b, authorityForA] });
    assert.equal(rB.outcome, "DENY", JSON.stringify(rB));
    assert.ok(rB.reason_codes.includes("contract_barrier"), JSON.stringify(rB.reason_codes));

    // Ambient: an authority envelope naming no Finding at all → DENY.
    const ambient = submitAuthorityText(h);
    const reclassAmbient = await makeReclass(h, b, {
      classification: "IMPLEMENTATION_GAP", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(ambient),
    });
    const rAmbient = await evalWorkStart(h, { finding: reclassAmbient, evidence: [reclassAmbient, b, ambient] });
    assert.equal(rAmbient.outcome, "DENY", JSON.stringify(rAmbient));

    // Authority-digest guard bite: same producer/schema/finding binding but a DIFFERENT landed
    // authority text digest than the rule's subject_binding — only the exact-digest check stops it.
    const wrongTextAt = new Date(h.clock.now).toISOString();
    const wrongText = h.ingress.submitEvidence(
      {
        evidence_kind: "VERIFICATION",
        subject_bindings: [
          { ...AUTHORITY_SUBJECT, content_digest: { ...AUTHORITY_SUBJECT.content_digest!, value: "1".repeat(64) } },
          { authority_ref: "cadp-store:k04", namespace: "improvement-finding", object_id: b.evidence_id, content_digest: b.envelope_digest },
        ],
        availability: "PRESENT",
        claim_schema: "cadp.authority-text-observation.v1",
        claim: { conclusion: "success", completed_at: wrongTextAt },
        produced_at: wrongTextAt,
        producer_ref: "verifier:harness",
        source_ref: "clean-checkout:spec-v0.4",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.verifier,
    );
    const reclassWrongText = await makeReclass(h, b, {
      classification: "IMPLEMENTATION_GAP", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(wrongText),
    });
    const rWrongText = await evalWorkStart(h, { finding: reclassWrongText, evidence: [reclassWrongText, b, wrongText] });
    assert.equal(rWrongText.outcome, "DENY", JSON.stringify(rWrongText));

    // Transition binding: the exact authority for A cannot carry a transition the rule does not declare.
    const toBug = await makeReclass(h, a, {
      classification: "BUG", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(authorityForA),
    });
    const rBug = await evalWorkStart(h, { finding: toBug, evidence: [toBug, a, authorityForA] });
    assert.equal(rBug.outcome, "DENY", JSON.stringify(rBug));

    // From-classification binding: same rule, but the predecessor is CONTRACT_AMBIGUITY → DENY.
    const amb = await makeFinding(h, { classification: "CONTRACT_AMBIGUITY", anomaly_code: "S3-FROM" });
    const authorityForAmb = submitAuthorityText(h, amb);
    const reclassAmb = await makeReclass(h, amb, {
      classification: "IMPLEMENTATION_GAP", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(authorityForAmb),
    });
    const rFrom = await evalWorkStart(h, { finding: reclassAmb, evidence: [reclassAmb, amb, authorityForAmb] });
    assert.equal(rFrom.outcome, "DENY", JSON.stringify(rFrom));

    // The exact bound pair still clears: authority for A clearing A → ALLOW.
    const reclassA = await makeReclass(h, a, {
      classification: "IMPLEMENTATION_GAP", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(authorityForA),
    });
    const rA = await evalWorkStart(h, { finding: reclassA, evidence: [reclassA, a, authorityForA] });
    assert.equal(rA.outcome, "ALLOW", JSON.stringify(rA));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- S5/E3: admission-path independence (raw rego layer)
/** Seal a real intake WORK_START and return the pieces of a ResolvedAdmissionBundle so a test can
 * evaluate the ACTIVE policy directly with falsified evidence that ingress cannot produce. */
function sealWorkStartBundle(h: Harness, finding: EvidenceEnvelopeV1, evidence: EvidenceEnvelopeV1[]) {
  const admission = buildFindingAdmission({ finding_ref: refOf(finding), purpose: "IMPLEMENTATION", conflict_complete: true });
  const material = { finding_admission: admission, bounds: {} };
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: (counter += 1), purpose: "work-start",
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
  const admission_input = h.ingress.assembleAdmissionInput(effect_id, evidence.map((e) => e.evidence_id));
  return { admission_input, effect_request: h.store.effectRequest(effect_id)!, effect_material: material };
}

async function evaluateRaw(h: Harness, sealed: ReturnType<typeof sealWorkStartBundle>, evidence: EvidenceEnvelopeV1[]) {
  const active = resolveActivePolicy(h.store, h.cas);
  await h.evaluator.ensureLoaded(active);
  const bundle: ResolvedAdmissionBundle = {
    admission_input: sealed.admission_input,
    effect_request: sealed.effect_request,
    effect_material: sealed.effect_material,
    evidence,
    policy_ref: sealed.admission_input.policy_ref,
    now: new Date(h.clock.now).toISOString(),
  };
  return h.evaluator.evaluate(bundle);
}

test("#107 S5/E3: the admission path itself fails closed on falsified authority integrity or schema", async () => {
  const h = await makeHarness({ paramOverrides: { authority_text_rules: [AUTHORITY_TEXT_RULE] } });
  try {
    // Human path. Ingress hardcodes AUTHENTICATED_SOURCE, so an UNATTESTED decision can only be
    // presented to policy directly — admission must still deny without producer-side help.
    const c1 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S5-RAW-H" });
    const human = submitHumanDesignDecision(h, c1);
    const f1 = await makeReclass(h, c1, { classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION, basis: humanBasis(human) });
    const sealed1 = sealWorkStartBundle(h, f1, [f1, c1, human]);
    const baseline1 = await evaluateRaw(h, sealed1, [f1, c1, human]);
    assert.equal(baseline1.outcome, "ALLOW", JSON.stringify(baseline1));
    const unattested = structuredClone(human) as { provenance: { integrity: string } };
    unattested.provenance.integrity = "UNATTESTED";
    const denied1 = await evaluateRaw(h, sealed1, [f1, c1, unattested as unknown as EvidenceEnvelopeV1]);
    assert.equal(denied1.outcome, "DENY", JSON.stringify(denied1));

    // Deterministic path: the resolved authority envelope's claim_schema must match the rule.
    const c2 = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S5-RAW-D" });
    const authority = submitAuthorityText(h, c2);
    const f2 = await makeReclass(h, c2, {
      classification: "IMPLEMENTATION_GAP", derivation: { kind: "DETERMINISTIC_DERIVATION", ...AUTHORITY_METHOD },
      basis: humanBasis(authority),
    });
    const sealed2 = sealWorkStartBundle(h, f2, [f2, c2, authority]);
    const baseline2 = await evaluateRaw(h, sealed2, [f2, c2, authority]);
    assert.equal(baseline2.outcome, "ALLOW", JSON.stringify(baseline2));
    const wrongSchema = structuredClone(authority) as { claim_schema: string };
    wrongSchema.claim_schema = "cadp.work-step.v1";
    const denied2 = await evaluateRaw(h, sealed2, [f2, c2, wrongSchema as unknown as EvidenceEnvelopeV1]);
    assert.equal(denied2.outcome, "DENY", JSON.stringify(denied2));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- S4: real post-evaluation PEP path
function scriptedTemporalTransport(): TemporalTransport {
  const executions = new Map<string, { run_id: string; memo: Record<string, unknown>; status: string }>();
  return {
    async describeNamespace() {
      return { namespace_id: "ns-scripted", retention_s: 3600 };
    },
    async start(input) {
      if (executions.has(input.workflow_id)) return { kind: "already_started" };
      executions.set(input.workflow_id, { run_id: `run-${executions.size + 1}`, memo: input.memo, status: "RUNNING" });
      return { kind: "started", run_id: executions.get(input.workflow_id)!.run_id };
    },
    async describe(workflow_id) {
      const found = executions.get(workflow_id);
      return found === undefined ? { kind: "not_found" } : { kind: "found", ...found };
    },
  };
}

test("#107 S4: the sanctioned Human clearing path admits through the real PEP admitAndDispatch → COMMITTED", async () => {
  let temporal!: TemporalAdapter;
  const h = await makeHarness({
    extraAdapterFactory: (_store, cas) => {
      temporal = new TemporalAdapter(scriptedTemporalTransport(), cas, "cadp-v04", 3600);
      return [temporal];
    },
  });
  try {
    const work_run = "wr-s4-implementation-run";
    const c = await makeFinding(h, { classification: "CONTRACT_GAP", anomaly_code: "S4" });
    const human = submitHumanDesignDecision(h, c, "APPROVE", work_run);
    const f = await makeReclass(h, c, { classification: "IMPLEMENTATION_GAP", derivation: HUMAN_RECLASS_DERIVATION, basis: humanBasis(human) });

    const args = { finding: f.evidence_id };
    const args_cas_key = h.ingress.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    const admission = buildFindingAdmission({ finding_ref: refOf(f), purpose: "IMPLEMENTATION", conflict_complete: true });
    const effect_id = h.ingress.allocateEffectId({
      schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
      step_ordinal: (counter += 1), purpose: "work-start",
    });
    const material = {
      finding_admission: admission, bounds: {},
      workflow_id: `cadp-work-${effect_id}`, workflow_type: "cadpWork", task_queue: "cadp-worker",
      args_cas_key, args_digest: jcsDigest(args).value,
    };
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
    h.ingress.sealEffectRequest(
      {
        effect_id, requester_ref: "workflow:cadp-work",
        work_bindings: [
          { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: work_run },
          findingWorkBinding(refOf(f)),
        ],
        target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "ns-scripted" },
        operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", material_ref, prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    h.sealReach();
    await h.pep.refreshTargetIdentity(temporal);
    const inp = h.ingress.assembleAdmissionInput(effect_id, [f, c, human].map((e) => e.evidence_id));
    const evaluated = await h.evaluate(inp.input_digest.value);
    assert.equal(evaluated.kind, "DECISION");
    if (evaluated.kind !== "DECISION") return;
    assert.equal(evaluated.decision.outcome, "ALLOW", JSON.stringify(evaluated.decision));
    const admitted = await h.pep.admitAndDispatch(effect_id, evaluated.decision.decision_id);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(admitted.kind === "ADMITTED" ? admitted.outcome.result : "", "COMMITTED", JSON.stringify(admitted));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 12
test("C12: WORK_START citing a superseded finding_ref → DENY (independent of any commodity index)", async () => {
  const h = await makeHarness();
  try {
    const f1 = await makeFinding(h, { classification: "IMPLEMENTATION_GAP", anomaly_code: "S1" });
    const f2 = await makeReclass(h, f1, { classification: "IMPLEMENTATION_GAP", correction_reason: "refine" });
    // Bind the SUPERSEDED f1 (not the leaf) → DENY.
    const r = await evalWorkStart(h, { finding: f1, evidence: [f1, f2] });
    assert.equal(r.outcome, "DENY");
    assert.ok(r.reason_codes.includes("finding_tip_superseded"), JSON.stringify(r.reason_codes));
    // Also: conflict_complete=false (index loss) → DENY even for a clean leaf.
    const clean = await makeFinding(h, { classification: "IMPLEMENTATION_GAP" });
    const r2 = await evalWorkStart(h, { finding: clean, conflict_complete: false, evidence: [clean] });
    assert.equal(r2.outcome, "DENY");
    assert.ok(r2.reason_codes.includes("conflict_completeness_unproven"), JSON.stringify(r2.reason_codes));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 13
test("C13: tracker-derived work bytes without exact revision/observation → DENY", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "IMPLEMENTATION_GAP" });
    // Declared external input with NO revision and NO observation evidence → DENY.
    const r = await evalWorkStart(h, {
      finding: f, evidence: [f],
      external_inputs: [{ authority_ref: "github.com", object_id: "issue:1", observation_ref: "missing" }],
    });
    assert.equal(r.outcome, "DENY");
    assert.ok(r.reason_codes.includes("tracker_input_unbound"), JSON.stringify(r.reason_codes));
    // With an exact revision + matching observation evidence → ALLOW.
    const obs = submitObservation(h, { authority_ref: "github.com", namespace: "issue", object_id: "issue:1", revision: "etag-abc" });
    const r2 = await evalWorkStart(h, {
      finding: f, evidence: [f, obs],
      external_inputs: [{ authority_ref: "github.com", object_id: "issue:1", revision_or_version: "etag-abc", observation_ref: obs.evidence_id }],
    });
    assert.equal(r2.outcome, "ALLOW", JSON.stringify(r2));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 14 / 18
test("C14/C18: resolution-kind partition is symmetric (adapter rejects the wrong kind)", async () => {
  // AUTHORITY_RESOLUTION on a BUG tip → reject.
  const rBug = validateResolutionClaim(resolution("AUTHORITY_RESOLUTION", { landed_authority_ref: "spec" }), { classification: "BUG" });
  assert.ok(!rBug.ok && rBug.errors.some((e) => e.includes("AUTHORITY_RESOLUTION is invalid")), JSON.stringify(rBug.errors));
  // VERIFIED_REPAIR on a CONTRACT_GAP tip → reject.
  const rCg = validateResolutionClaim(resolution("VERIFIED_REPAIR", { resolving_work_run_refs: ["w"], verification_refs: ["v"], regression_ref: "r" }), { classification: "CONTRACT_GAP" });
  assert.ok(!rCg.ok && rCg.errors.some((e) => e.includes("VERIFIED_REPAIR is invalid")), JSON.stringify(rCg.errors));
  // Matching kinds validate.
  assert.ok(validateResolutionClaim(resolution("VERIFIED_REPAIR", { resolving_work_run_refs: ["w"], verification_refs: ["v"], regression_ref: "r" }), { classification: "BUG" }).ok);
  assert.ok(validateResolutionClaim(resolution("AUTHORITY_RESOLUTION", { landed_authority_ref: "spec" }), { classification: "CONTRACT_GAP" }).ok);
});

test("intake positive: VERIFIED_REPAIR submits for a BUG tip and reconstructs from refs", async () => {
  const h = await makeHarness();
  try {
    const f = await makeFinding(h, { classification: "BUG" });
    const env = await submitResolution(submitter(h), {
      claim: resolution("VERIFIED_REPAIR", {
        finding_tip_ref: refOf(f), resolving_work_run_refs: ["cadp-v04:effect:w"], verification_refs: ["cadp-v04:evidence:v"],
        regression_ref: "cadp-v04:evidence:reg", original_failure_ref: "cadp-v04:evidence:fail", original_scenario_replay_ref: "cadp-v04:evidence:replay",
      }),
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: f.evidence_id }],
      tip: { classification: "BUG" }, source_ref: "intake",
    });
    assert.equal(env.evidence_kind, "IMPROVEMENT_FINDING_RESOLUTION");
    // replay mandatory when a failure is named:
    const missingReplay = validateResolutionClaim(resolution("VERIFIED_REPAIR", {
      resolving_work_run_refs: ["w"], verification_refs: ["v"], regression_ref: "r", original_failure_ref: "fail",
    }), { classification: "BUG" });
    assert.ok(!missingReplay.ok && missingReplay.errors.some((e) => e.includes("replay is mandatory")));
  } finally { h.close(); }
});

function resolution(kind: "VERIFIED_REPAIR" | "AUTHORITY_RESOLUTION", over: Partial<ImprovementFindingResolutionClaimV1>): ImprovementFindingResolutionClaimV1 {
  return {
    contract_id: "cadp.improvement-intake.v1",
    finding_tip_ref: over.finding_tip_ref ?? { evidence_id: "e", envelope_digest: "d" },
    resolution_kind: kind,
    statement: "resolution",
    ...over,
  };
}

// ---------------------------------------------------------------- helpers for supersession
async function makeReclass(h: Harness, prev: EvidenceEnvelopeV1, over: Partial<FindingBuildInput> & { classification: Classification }): Promise<EvidenceEnvelopeV1> {
  return makeFinding(h, {
    ...over,
    supersedes: [{ evidence_id: prev.evidence_id, envelope_digest: prev.envelope_digest.value }],
    correction_reason: over.correction_reason ?? "reclassification",
  });
}

async function makeFindingSameOccurrence(h: Harness, first: EvidenceEnvelopeV1): Promise<EvidenceEnvelopeV1> {
  // Reconstruct identical occurrence inputs so occurrence_key collides but it is a distinct leaf.
  const claim = first.claim as { subject: { kind: string; binding_index: number }; anomaly_code: string; basis: unknown[]; derivation: { method_ref: string; method_digest: string } };
  const subject_bindings = first.subject_bindings as SubjectBinding[];
  const built = buildFindingClaim({
    classification: "IMPLEMENTATION_GAP",
    subject: claim.subject as never,
    subject_bindings,
    basis: claim.basis as never,
    derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: claim.derivation.method_ref, method_digest: claim.derivation.method_digest },
    anomaly_code: claim.anomaly_code,
    statement: { summary: "concurrent tip" },
  });
  return submitFinding(submitter(h), { claim: built, subject_bindings, source_ref: "intake-detector" });
}

// ================================================================ FINDING_PROJECT (E4/E5, Option A)

async function setupIssues(idempotencyProven = true): Promise<{ h: Harness; issues: ScriptedIssues; adapter: GitHubIssuesAdapter }> {
  const issues = new ScriptedIssues();
  let adapter!: GitHubIssuesAdapter;
  const h = await makeHarness({
    extraAdapterFactory: (_store, cas) => {
      adapter = new GitHubIssuesAdapter(issues, cas, "r", idempotencyProven);
      return [adapter];
    },
  });
  return { h, issues, adapter };
}

/** Seal + evaluate + admit a FINDING_PROJECT; returns outcome + admit result. */
async function admitProjection(h: Harness, adapter: GitHubIssuesAdapter, f: EvidenceEnvelopeV1, purpose: "CREATE_INDEX" | "APPEND_OCCURRENCE" | "APPEND_RESOLUTION", evidence: EvidenceEnvelopeV1[]): Promise<{ outcome: string; admitted: unknown }> {
  const rendered = `[CADP finding] ${purpose}\nfinding ${f.evidence_id}`;
  const rendered_cas_key = h.ingress.putBlob(Buffer.from(rendered, "utf8"));
  const material = buildProjectionMaterial({
    finding_ref: refOf(f), purpose,
    target_tracker_ref: { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: "r" },
    rendered_content_digest: sha256(rendered), rendered_cas_key,
  });
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: (counter += 1), purpose: "finding-project",
  });
  h.ingress.sealEffectRequest(
    {
      effect_id, requester_ref: "workflow:cadp-work",
      work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${effect_id}` }],
      target_ref: { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: "r" },
      operation_kind: "FINDING_PROJECT", material_schema: "cadp.finding-projection.v1", material_ref, prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  h.sealReach();
  // Recheck #14: a PEP_READ_THEN_ACT op needs a fresh TARGET_IMMUTABILITY_ATTESTATION for the
  // target. For GIT_ISSUES the attested property is projection_key uniqueness (one index item per
  // key; §13.3 idempotency/reconcile proven) — the index-projection analog of ref write-once.
  h.ingress.submitEvidence(
    {
      evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "GIT_ISSUES", object_id: "r" }],
      availability: "PRESENT",
      claim_schema: "cadp.target-immutability.v1",
      claim: { write_once_enforced: true, projection_key_unique: true, note: "projection_key ⇒ exactly one index item; §13.3 idempotency/reconcile proven" },
      producer_ref: "deployment-control-target",
      source_ref: "github issues projection-key uniqueness",
      source_relation: "TARGET_AUTHORITY_OBSERVATION",
    },
    PRINCIPALS.depctlTarget,
  );
  await h.pep.refreshTargetIdentity(adapter);
  const inp = h.ingress.assembleAdmissionInput(effect_id, evidence.map((e) => e.evidence_id));
  const evaluated = await h.evaluate(inp.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    return { outcome: evaluated.kind === "DECISION" ? evaluated.decision.outcome : evaluated.kind, admitted: undefined };
  }
  const admitted = await h.pep.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  return { outcome: "ALLOW", admitted };
}

// ---------------------------------------------------------------- control 19
test("C19: unresolved CONTRACT_* + Option-A CREATE_INDEX → passes K3–K7, only tracker index delta 1; barrier unchanged", async () => {
  const { h, issues, adapter } = await setupIssues();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP" });
    const r = await admitProjection(h, adapter, f, "CREATE_INDEX", [f]);
    assert.equal(r.outcome, "ALLOW", JSON.stringify(r));
    assert.equal((r.admitted as { outcome: { result: string } }).outcome.result, "COMMITTED", JSON.stringify(r.admitted));
    assert.equal(issues.createdIssues, 1, "exactly one tracker index item created");
    // Barrier unchanged: an implementation WORK_START bound to the same tip is still DENIED.
    const ws = await evalWorkStart(h, { finding: f, evidence: [f] });
    assert.equal(ws.outcome, "DENY");
    assert.ok(ws.reason_codes.includes("contract_barrier"));
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 20
test("C20: unresolved CONTRACT_* + APPEND_RESOLUTION → DENY; smuggled non-index material → refused; delta 0", async () => {
  const { h, issues, adapter } = await setupIssues();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP" });
    // APPEND_RESOLUTION before authority resolution → policy DENY.
    const r = await admitProjection(h, adapter, f, "APPEND_RESOLUTION", [f]);
    assert.equal(r.outcome, "DENY", JSON.stringify(r));
    assert.equal(issues.createdIssues, 0, "no tracker effect");
    assert.equal(issues.createdComments, 0);
    // Smuggled non-index semantics in the material → adapter verify_material refuses (MaterialIncomplete).
    const rendered = "x"; const rendered_cas_key = h.ingress.putBlob(Buffer.from(rendered, "utf8"));
    const smuggled = { ...buildProjectionMaterial({ finding_ref: refOf(f), purpose: "CREATE_INDEX", target_tracker_ref: { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: "r" }, rendered_content_digest: sha256(rendered), rendered_cas_key }), git_push: { ref: "refs/heads/main", new_sha: "deadbeef" } };
    await assert.rejects(() => adapter.verify_material("FINDING_PROJECT", smuggled as Record<string, unknown>), /smuggled semantics|non-index field/);
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 15
test("C15: FINDING_PROJECT without proven issue-create idempotency/reconcile → unavailable / refused; Finding unchanged", async () => {
  const { h, issues, adapter } = await setupIssues(false); // idempotency NOT proven
  try {
    assert.equal(adapter.describe().operations[0]!.available, false, "declared unavailable");
    const f = await makeFinding(h, { classification: "IMPLEMENTATION_GAP" });
    const r = await admitProjection(h, adapter, f, "CREATE_INDEX", [f]);
    // Policy may ALLOW, but the PEP availability recheck refuses an unavailable operation.
    assert.notEqual((r.admitted as { outcome?: { result?: string } } | undefined)?.outcome?.result, "COMMITTED");
    assert.equal(issues.createdIssues, 0, "no issue created");
    assert.ok(h.store.evidenceById(f.evidence_id) !== undefined, "Finding unchanged");
  } finally { h.close(); }
});

// ---------------------------------------------------------------- projection positive + §13.3 idempotency/reconcile
test("intake positive + §13.3: FINDING_PROJECT is idempotent and reconciles by enumeration (miss = UNKNOWN, not no-effect)", async () => {
  const { h, issues, adapter } = await setupIssues();
  try {
    const f = await makeFinding(h, { classification: "IMPLEMENTATION_GAP" });
    const r1 = await admitProjection(h, adapter, f, "CREATE_INDEX", [f]);
    assert.equal((r1.admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
    // Second projection of the SAME finding (same projection_key) → no second issue (idempotent).
    const r2 = await admitProjection(h, adapter, f, "CREATE_INDEX", [f]);
    assert.equal((r2.admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
    assert.equal(issues.createdIssues, 1, "idempotent create: exactly one issue");
    // Reconcile by enumeration finds it → COMMITTED.
    const rendered = "any"; const key = h.ingress.putBlob(Buffer.from(rendered, "utf8"));
    const mat = buildProjectionMaterial({ finding_ref: refOf(f), purpose: "CREATE_INDEX", target_tracker_ref: { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: "r" }, rendered_content_digest: sha256(rendered), rendered_cas_key: key });
    const recCommitted = await adapter.reconcile("e", 0, { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: "r" }, "FINDING_PROJECT", mat as unknown as Record<string, unknown>);
    assert.equal(recCommitted.kind, "COMMITTED");
    // Post-send enumeration lag → UNKNOWN, never NO_EFFECT_CONFIRMED by absence.
    issues.hideOnList = true;
    const recUnknown = await adapter.reconcile("e", 0, { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: "r" }, "FINDING_PROJECT", mat as unknown as Record<string, unknown>);
    assert.equal(recUnknown.kind, "UNKNOWN");
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 7
test("C7: a FINDING_PROJECT COMMITTED receipt is not K6 for WORK_START (tracker state confers no admission)", async () => {
  const { h, adapter } = await setupIssues();
  try {
    const f = await makeFinding(h, { classification: "CONTRACT_GAP" });
    const proj = await admitProjection(h, adapter, f, "CREATE_INDEX", [f]); // index the contract finding
    assert.equal((proj.admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
    // The projection COMMITTED does not start implementation work: WORK_START still DENIED.
    const ws = await evalWorkStart(h, { finding: f, evidence: [f] });
    assert.equal(ws.outcome, "DENY");
  } finally { h.close(); }
});

// ---------------------------------------------------------------- control 6
test("C6: series collapse groups by deterministic detector yet every raw occurrence stays addressable", async () => {
  const h = await makeHarness();
  try {
    const series = { subject_anchor: "svc:record", detector_contract_digest: "detector-v1" };
    const a = await makeFinding(h, { classification: "OPERABILITY_GAP", anomaly_code: "LAG", series });
    const b = await makeFinding(h, { classification: "OPERABILITY_GAP", anomaly_code: "LAG", series });
    const sa = (a.claim as { series_key: string }).series_key;
    const sb = (b.claim as { series_key: string }).series_key;
    assert.equal(sa, sb, "same detector + anomaly ⇒ same series_key");
    // Distinct occurrences remain individually addressable (distinct evidence + occurrence_key).
    assert.notEqual(a.evidence_id, b.evidence_id);
    assert.notEqual((a.claim as { occurrence_key: string }).occurrence_key, (b.claim as { occurrence_key: string }).occurrence_key);
    assert.ok(h.store.evidenceById(a.evidence_id) !== undefined && h.store.evidenceById(b.evidence_id) !== undefined);
  } finally { h.close(); }
});
