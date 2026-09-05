/**
 * Shared composition for the v1.1 governed transition path (#117, implementing #107) used by both
 * the intake conformance suite and the transition conformance suite. Everything here drives the
 * REAL kernel path — allocate → put_blob → seal → assemble → evaluate → admitAndDispatch — so a
 * positive is a proof about the production seam and not about a test double.
 */

import { createHash } from "node:crypto";

import { PRINCIPALS } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { findingSealTargetRef, findingSealWorkBindings } from "../../kernel/adapters/findingSeal.ts";
import type { AdmitResult } from "../../kernel/pep.ts";
import type { EvidenceEnvelopeV1, SubjectBinding } from "../../kernel/records.ts";
import { buildFindingClaim, refOf, submitFinding, submitResolution, INTAKE_PRINCIPAL } from "../../product/improvement/intakeAdapter.ts";
import type { EvidenceDraftLike, FindingBuildInput } from "../../product/improvement/intakeAdapter.ts";
import type { BasisRole, Classification, EvidenceRef, SubjectKind } from "../../product/improvement/contracts.ts";
import {
  GOVERNED_TRANSITION_MATERIAL_SCHEMA, buildGovernedTransitionMaterial, derivedDraft, subjectTuple,
} from "../../product/improvement/transition.ts";
import type {
  AuthorityApplicabilityV1, AuthorityTextRuleV1, GovernedDescendantDraftV1,
  GovernedTransitionMaterialV1, SubjectTuple, TransitionKind,
} from "../../product/improvement/transition.ts";

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let counter = 0;
export function nextId(): number {
  counter += 1;
  return counter;
}

/**
 * The reference deployment's authority-text observer. #117 §5's TD delta is exhaustive and adds
 * no evidence kind and no producer, so an observation rides an already-landed
 * producer/kind pair; WHICH pair is a deployment choice that the active rule pins exactly
 * (producer_ref + evidence_kind + claim_schema + provenance, §6.5 step 3).
 */
export const OBSERVER_PRODUCER_REF = "verifier:harness";
export const OBSERVER_EVIDENCE_KIND = "VERIFICATION";
export const OBSERVATION_CLAIM_SCHEMA = "cadp.authority-observation.v1";
export const AUTHORITY_CONTENT_DIGEST = sha256("landed-authority-text-v1");

const submitter = (h: Harness) => (draft: EvidenceDraftLike) =>
  h.ingress.submitEvidence(draft as Parameters<typeof h.ingress.submitEvidence>[0], { principal: INTAKE_PRINCIPAL });

/** A supporting non-intake envelope usable as a Finding basis / diagnostic. */
export function submitObservation(
  h: Harness,
  opts: { authority_ref?: string; namespace: string; object_id: string; revision?: string },
): EvidenceEnvelopeV1 {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "WORK_STEP",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-obs-${nextId()}` },
        {
          authority_ref: opts.authority_ref ?? "github.com", namespace: opts.namespace, object_id: opts.object_id,
          ...(opts.revision !== undefined ? { revision_or_version: opts.revision } : {}),
        },
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

export interface MakeFindingInput extends Partial<FindingBuildInput> {
  classification: Classification;
}

/** Build + submit an ordinary intake IMPROVEMENT_FINDING through the product adapter. */
export async function makeFinding(h: Harness, over: MakeFindingInput): Promise<EvidenceEnvelopeV1> {
  const n = nextId();
  const basisEnv = submitObservation(h, { namespace: "commit", object_id: `sha-${n}`, revision: "rev-1" });
  const subject_bindings: SubjectBinding[] = (over.subject_bindings as SubjectBinding[] | undefined) ?? [
    { authority_ref: "github.com", namespace: "work-run", object_id: `wr-${n}`, content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256(`wr-${n}`) } },
    { authority_ref: "github.com", namespace: "commit", object_id: `sha-${n}`, content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256(`sha-${n}`) } },
  ];
  const claim = buildFindingClaim({
    classification: over.classification,
    subject: over.subject ?? { kind: "WORK_RUN", binding_index: 0 },
    subject_bindings,
    basis: over.basis ?? [{ evidence_id: basisEnv.evidence_id, envelope_digest: basisEnv.envelope_digest.value, role: "OBSERVATION" }],
    derivation: over.derivation ?? { kind: "DETERMINISTIC_DERIVATION", method_ref: "detector:x", method_digest: `md-${n}` },
    anomaly_code: over.anomaly_code ?? `ANOM_${n}`,
    statement: over.statement ?? { summary: `finding ${n}` },
    ...(over.supersedes !== undefined ? { supersedes: over.supersedes } : {}),
    ...(over.correction_reason !== undefined ? { correction_reason: over.correction_reason } : {}),
  });
  return submitFinding(submitter(h), { claim, subject_bindings, source_ref: "intake-detector", execution_or_run_ref: over.derivation?.execution_or_run_ref });
}

/**
 * A plain WORK_START carrying no intake `finding_admission`: plain-allowed while the barrier is
 * up (referencePolicy lines 124–129), so the run exists BEFORE any authority is observed. Its
 * effect_id IS the work run ref (TD §7.3 / pep.ts work-run resolution).
 */
export async function startRun(h: Harness): Promise<{ run: string; outcome: string }> {
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify({ bounds: {} }), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: nextId(), purpose: "work-start",
  });
  h.ingress.sealEffectRequest(
    {
      effect_id, requester_ref: "workflow:cadp-work", work_bindings: [],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "cadp-v04" },
      operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", material_ref, prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  return { run: effect_id, outcome: evaluated.kind === "DECISION" ? evaluated.decision.outcome : evaluated.kind };
}

// ---------------------------------------------------------------- descendant drafts

/** Compose the HUMAN_JUDGMENT descendant draft the Human approves byte-exactly via digest(M). */
export function humanDraft(input: {
  predecessor: EvidenceEnvelopeV1;
  classification: Classification;
  basis: ReadonlyArray<EvidenceRef & { role: BasisRole }>;
  run: string;
  to_subject?: SubjectTuple;
  to_subject_kind?: SubjectKind;
  anomaly_code?: string;
  correction_reason?: string;
  summary?: string;
  method_ref?: string;
  method_digest?: string;
}): GovernedDescendantDraftV1 {
  const fClaim = input.predecessor.claim as { subject: { kind: SubjectKind; binding_index: number } };
  const index = fClaim.subject.binding_index;
  const bindings = [...input.predecessor.subject_bindings] as SubjectBinding[];
  bindings[index] = (input.to_subject ?? subjectTuple(bindings[index]!)) as unknown as SubjectBinding;
  const claim = buildFindingClaim({
    classification: input.classification,
    subject: { kind: input.to_subject_kind ?? fClaim.subject.kind, binding_index: index },
    subject_bindings: bindings,
    basis: input.basis,
    derivation: {
      kind: "HUMAN_JUDGMENT",
      method_ref: input.method_ref ?? "design:judgment-surface",
      method_digest: input.method_digest ?? sha256("judgment-surface-v1"),
      execution_or_run_ref: input.run,
    },
    anomaly_code: input.anomaly_code ?? `ANOM_${nextId()}`,
    statement: { summary: input.summary ?? "governed reclassification" },
    supersedes: [refOf(input.predecessor)],
    correction_reason: input.correction_reason ?? "authorized governed transition",
  });
  return { evidence_kind: "IMPROVEMENT_FINDING", subject_bindings: bindings, claim };
}

// ---------------------------------------------------------------- authority observation + rule

export function makeRule(over: Partial<AuthorityTextRuleV1> = {}): AuthorityTextRuleV1 {
  return {
    transition_kind: "RECLASSIFICATION",
    from: "CONTRACT_GAP",
    to: "IMPLEMENTATION_GAP",
    method: { method_ref: "authority:landed-text", method_digest: sha256("landed-text-method-v1") },
    producer_ref: OBSERVER_PRODUCER_REF,
    evidence_kind: OBSERVER_EVIDENCE_KIND,
    claim_schema: OBSERVATION_CLAIM_SCHEMA,
    provenance: "AUTHENTICATED_SOURCE",
    authority_content_digest: AUTHORITY_CONTENT_DIGEST,
    derived_anomaly_code: "AUTHORITY_DERIVED_IMPLEMENTABLE",
    derived_statement: { summary: "landed authority entails the implementation class" },
    derived_correction_reason: "deterministic derivation from landed authority text",
    ...over,
  } as AuthorityTextRuleV1;
}

/** Build the exact `applies_to` for a (predecessor, run) pair under a rule. */
export function appliesTo(input: {
  predecessor: EvidenceEnvelopeV1;
  rule: AuthorityTextRuleV1;
  run: string;
  to_subject?: SubjectTuple;
  to_subject_kind?: SubjectKind;
  over?: Partial<AuthorityApplicabilityV1>;
}): AuthorityApplicabilityV1 {
  const fClaim = input.predecessor.claim as { classification: Classification; subject: { kind: SubjectKind; binding_index: number } };
  const fPrimary = subjectTuple(input.predecessor.subject_bindings[fClaim.subject.binding_index]!);
  return {
    transition_kind: input.rule.transition_kind,
    predecessor_ref: refOf(input.predecessor),
    from_classification: input.rule.from,
    to_classification: input.rule.to,
    from_subject: fPrimary,
    to_subject: input.to_subject ?? fPrimary,
    to_subject_kind: input.to_subject_kind ?? fClaim.subject.kind,
    method: input.rule.method,
    work_run_ref: input.run,
    ...input.over,
  } as AuthorityApplicabilityV1;
}

/** Seal an authority observation A: the authority CONTENT is bound by digest on its own binding. */
export function submitAuthorityObservation(
  h: Harness,
  input: { applies_to?: unknown; content_digest?: string; claim_schema?: string; note?: string },
): EvidenceEnvelopeV1 {
  const completed_at = new Date(h.clock.fn()).toISOString();
  return h.ingress.submitEvidence(
    {
      evidence_kind: "VERIFICATION",
      subject_bindings: [
        {
          authority_ref: "authority:landed", namespace: "authority-text", object_id: `authority-${nextId()}`,
          content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: input.content_digest ?? AUTHORITY_CONTENT_DIGEST },
        },
      ],
      availability: "PRESENT",
      claim_schema: input.claim_schema ?? OBSERVATION_CLAIM_SCHEMA,
      claim: {
        completed_at,
        note: input.note ?? "authority text observed",
        ...(input.applies_to !== undefined ? { applies_to: input.applies_to } : {}),
      },
      produced_at: completed_at,
      producer_ref: OBSERVER_PRODUCER_REF,
      source_ref: "authority-observer",
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.verifier,
  );
}

/** The deterministic descendant draft: COMPUTED by the closure, never composed by the caller. */
export function deterministicDraft(input: {
  predecessor: EvidenceEnvelopeV1;
  observation: EvidenceEnvelopeV1;
  applies_to: AuthorityApplicabilityV1;
  rule: AuthorityTextRuleV1;
}): GovernedDescendantDraftV1 {
  return derivedDraft({
    predecessor: input.predecessor as never,
    observation: refOf(input.observation),
    applies_to: input.applies_to,
    rule: input.rule,
  });
}

// ---------------------------------------------------------------- the FINDING_SEAL effect

export interface SealOutcome {
  effect_id: string;
  material: GovernedTransitionMaterialV1;
  outcome: string;
  reason_codes: string[];
  admitted?: AdmitResult;
  sealed?: EvidenceEnvelopeV1;
}

/** A HUMAN_DECISION over an exact effect; every field is overridable so the polarity and scope
 * controls (FC1/FC2) exercise the landed §9.3 shape rather than a stand-in. */
export function humanDecision(
  h: Harness,
  effect_id: string,
  over: { decision?: string; material_digest?: string; scope_effect_id?: string } = {},
): EvidenceEnvelopeV1 {
  const request = h.store.effectRequest(effect_id)!;
  return h.ingress.submitEvidence(
    {
      evidence_kind: "HUMAN_DECISION",
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
      availability: "PRESENT",
      claim_schema: "cadp.human-decision.v1",
      claim: {
        principal: "sso:a.t.laplace@gmail.com",
        decision: over.decision ?? "APPROVE",
        scope: {
          effect_id: over.scope_effect_id ?? effect_id,
          target_ref: request.target_ref,
          material_digest: over.material_digest ?? request.material_digest.value,
        },
        presented_request_digest: request.request_digest,
        statement: "rendered transition approved at the SSO surface",
        issued_at: new Date(h.clock.fn()).toISOString(),
      },
      producer_ref: "human:astro3141",
      source_ref: "sso-approval-page",
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.human,
  );
}

export interface SealInput {
  predecessor: EvidenceEnvelopeV1;
  draft: GovernedDescendantDraftV1;
  run: string;
  transition_kind?: TransitionKind;
  evidence: EvidenceEnvelopeV1[];
  /** Presented HUMAN_DECISION envelopes (assembled after the request is sealed — path A). */
  human?: (effect_id: string) => EvidenceEnvelopeV1[];
  materialOverride?: (m: GovernedTransitionMaterialV1) => Record<string, unknown>;
  workBindings?: (predecessor_evidence_id: string, run: string) => SubjectBinding[];
  admit?: boolean;
}

/** Seal + evaluate (+ optionally admitAndDispatch) one governed transition effect. */
export async function sealTransition(h: Harness, input: SealInput): Promise<SealOutcome> {
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: nextId(), purpose: "finding-seal",
  });
  const base = buildGovernedTransitionMaterial({
    effect_id,
    transition_kind: input.transition_kind ?? "RECLASSIFICATION",
    predecessor: input.predecessor,
    descendant_draft: input.draft,
  });
  const material = (input.materialOverride === undefined ? base : input.materialOverride(base)) as GovernedTransitionMaterialV1;
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  h.ingress.sealEffectRequest(
    {
      effect_id, requester_ref: "workflow:cadp-work",
      work_bindings: (input.workBindings ?? findingSealWorkBindings)(input.predecessor.evidence_id, input.run),
      target_ref: findingSealTargetRef(),
      operation_kind: "FINDING_SEAL",
      material_schema: GOVERNED_TRANSITION_MATERIAL_SCHEMA,
      material_ref, prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const evidenceIds = input.evidence.map((e) => e.evidence_id);
  for (const decision of input.human?.(effect_id) ?? []) evidenceIds.push(decision.evidence_id);
  const admissionInput = h.ingress.assembleAdmissionInput(effect_id, evidenceIds);
  const evaluated = await h.evaluate(admissionInput.input_digest.value);
  if (evaluated.kind !== "DECISION") return { effect_id, material, outcome: evaluated.kind, reason_codes: [] };
  const result: SealOutcome = {
    effect_id, material,
    outcome: evaluated.decision.outcome,
    reason_codes: [...evaluated.decision.reason_codes],
  };
  if (evaluated.decision.outcome !== "ALLOW" || input.admit === false) return result;
  h.sealReach();
  await h.pep.refreshTargetIdentity(h.findingSeal);
  result.admitted = await h.pep.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  if (result.admitted.kind === "ADMITTED" && result.admitted.outcome.result === "COMMITTED") {
    const receipt = (result.admitted.outcome as unknown as { target_operation_ref?: string }).target_operation_ref ?? "";
    result.sealed = h.store.evidenceById(receipt.replace(/^evidence:/u, ""));
  }
  return result;
}

// ---------------------------------------------------------------- §10.4 landed authority resolutions

/** Human-gated POLICY_ACTIVATE landing the per-finding `landed_authority_resolutions` entries. */
export async function activateResolutionEntries(
  h: Harness,
  revision: number,
  entries: readonly unknown[],
  extraParams: Record<string, unknown> = {},
): Promise<unknown> {
  h.sealReach();
  await h.sealTargetIdentity();
  const activated = await h.activatePolicy({
    revision,
    paramOverrides: { improvement_transition: { landed_authority_resolutions: entries, ...extraParams } },
  });
  return activated.admitted;
}

export async function submitAuthorityResolution(
  h: Harness,
  tip: EvidenceEnvelopeV1,
  authority_content_digest: string,
  tipClassification: Classification = "CONTRACT_GAP",
): Promise<EvidenceEnvelopeV1> {
  return submitResolution(
    (draft) => h.ingress.submitEvidence(draft as Parameters<typeof h.ingress.submitEvidence>[0], { principal: INTAKE_PRINCIPAL }),
    {
      claim: {
        contract_id: "cadp.improvement-intake.v1",
        finding_tip_ref: refOf(tip),
        resolution_kind: "AUTHORITY_RESOLUTION",
        landed_authority_ref: { authority_content_digest },
        statement: "the landed authority answers this finding's contract question",
      },
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "evidence", object_id: tip.evidence_id }],
      tip: { classification: tipClassification },
      source_ref: "intake",
    },
  );
}

/** The whole §11 Human path in one call: F → E → REQUIRE_EVIDENCE → H → ALLOW → COMMITTED → G. */
export async function governedHumanClearing(h: Harness, input: {
  predecessor: EvidenceEnvelopeV1;
  classification?: Classification;
  transition_kind?: TransitionKind;
  to_subject?: SubjectTuple;
  to_subject_kind?: SubjectKind;
  run?: string;
  extraEvidence?: EvidenceEnvelopeV1[];
}): Promise<{ sealed: EvidenceEnvelopeV1; run: string; seal: SealOutcome; diagnostic: EvidenceEnvelopeV1 }> {
  const run = input.run ?? (await startRun(h)).run;
  const diagnostic = submitObservation(h, { namespace: "diagnostic", object_id: `diag-${nextId()}` });
  const draft = humanDraft({
    predecessor: input.predecessor,
    classification: input.classification ?? "IMPLEMENTATION_GAP",
    basis: [{ evidence_id: diagnostic.evidence_id, envelope_digest: diagnostic.envelope_digest.value, role: "DIAGNOSTIC" }],
    run,
    ...(input.to_subject !== undefined ? { to_subject: input.to_subject } : {}),
    ...(input.to_subject_kind !== undefined ? { to_subject_kind: input.to_subject_kind } : {}),
  });
  const seal = await sealTransition(h, {
    predecessor: input.predecessor,
    draft,
    run,
    ...(input.transition_kind !== undefined ? { transition_kind: input.transition_kind } : {}),
    evidence: [input.predecessor, diagnostic, ...(input.extraEvidence ?? [])],
    human: (effect_id) => [humanDecision(h, effect_id)],
  });
  if (seal.sealed === undefined) {
    throw new Error(`governed clearing did not seal: ${seal.outcome} ${JSON.stringify(seal.reason_codes)} ${JSON.stringify(seal.admitted)}`);
  }
  return { sealed: seal.sealed, run, seal, diagnostic };
}
