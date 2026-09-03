/**
 * cadp.improvement-intake.v1 producer-side product adapter (#104 E1/E6/E7). The SOLE surface that
 * emits IMPROVEMENT_FINDING / IMPROVEMENT_FINDING_RESOLUTION: it validates the reviewed claim
 * contract HERE (controls 3, 4, 14, 18) before submit_evidence and stamps the registered producer.
 * Ingress only checks producer→kind→source_relation and leaves the claim bytes untouched (TD §9.1).
 *
 * It also builds the exact WORK_START finding_admission / work-binding and the FINDING_PROJECT
 * material the reference Rego gates on — a Finding never starts work or projects by itself.
 */

import {
  CONTRACT_ID, FINDING_CLAIM_SCHEMA, RESOLUTION_CLAIM_SCHEMA, PROJECTION_MATERIAL_SCHEMA,
  deriveOccurrenceKey, deriveSeriesKey, deriveProjectionKey,
  validateFindingClaim, validateResolutionClaim, validateProjectionMaterial,
} from "./contracts.ts";
import type {
  Classification, DerivationKind, SubjectKind, BasisRole, ResolutionKind, ProjectionPurpose,
  EvidenceRef, ImprovementFindingClaimV1, ImprovementFindingResolutionClaimV1, FindingProjectionMaterialV1,
} from "./contracts.ts";
import type { EvidenceEnvelopeV1, SubjectBinding } from "../../kernel/records.ts";

export const INTAKE_PRODUCER_REF = "intake:cadp-improvement";
export const INTAKE_PRINCIPAL = "cadp-improvement-intake";

export class IntakeValidationError extends Error {
  readonly kind: string;
  readonly errors: readonly string[];
  constructor(kind: string, errors: readonly string[]) {
    super(`${kind} claim invalid: ${errors.join("; ")}`);
    this.kind = kind;
    this.errors = errors;
  }
}

/** Minimal evidence-submit seam: harness uses ingress.submitEvidence(draft, principal), live uses KernelClient.submitEvidence(draft). */
export interface EvidenceDraftLike {
  evidence_kind: string;
  subject_bindings: readonly SubjectBinding[];
  availability: "PRESENT" | "UNKNOWN";
  claim_schema: string;
  claim?: unknown;
  unknown_reason?: string;
  producer_ref: string;
  source_ref: string;
  execution_or_run_ref?: string;
  produced_at?: string;
  source_relation: "SELF_REPORT" | "INDEPENDENT_OBSERVATION" | "TARGET_AUTHORITY_OBSERVATION";
}
export type SubmitEvidence = (draft: EvidenceDraftLike) => Promise<EvidenceEnvelopeV1> | EvidenceEnvelopeV1;

export function refOf(env: EvidenceEnvelopeV1): EvidenceRef {
  return { evidence_id: env.evidence_id, envelope_digest: env.envelope_digest.value };
}

// ---------------------------------------------------------------- finding

export interface FindingBuildInput {
  classification: Classification;
  subject: { kind: SubjectKind; binding_index: number };
  subject_bindings: readonly SubjectBinding[];
  basis: ReadonlyArray<EvidenceRef & { role: BasisRole }>;
  derivation: { kind: DerivationKind; method_ref: string; method_digest: string; execution_or_run_ref?: string };
  anomaly_code: string;
  statement: { summary: string; detail?: string };
  supersedes?: ReadonlyArray<EvidenceRef>;
  correction_reason?: string;
  /** Enables the deterministic series_key (§5) — only from a declared deterministic detector. */
  series?: { subject_anchor: string; detector_contract_digest: string };
}

/** Assemble a complete finding claim with the exact derived occurrence_key / series_key (§4/§5). */
export function buildFindingClaim(input: FindingBuildInput): ImprovementFindingClaimV1 {
  const primary = input.subject_bindings[input.subject.binding_index];
  if (primary === undefined) throw new IntakeValidationError("IMPROVEMENT_FINDING", [`subject.binding_index ${input.subject.binding_index} out of range`]);
  const occurrence_key = deriveOccurrenceKey({
    primary_subject_binding: primary,
    anomaly_code: input.anomaly_code,
    basis: input.basis,
    method_ref: input.derivation.method_ref,
    method_digest: input.derivation.method_digest,
  });
  const series_key = input.series !== undefined
    ? deriveSeriesKey({ subject_anchor: input.series.subject_anchor, anomaly_code: input.anomaly_code, detector_contract_digest: input.series.detector_contract_digest })
    : undefined;
  return {
    contract_id: CONTRACT_ID,
    classification: input.classification,
    subject: input.subject,
    basis: input.basis,
    derivation: input.derivation,
    anomaly_code: input.anomaly_code,
    occurrence_key,
    ...(series_key !== undefined ? { series_key } : {}),
    statement: input.statement,
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    ...(input.correction_reason !== undefined ? { correction_reason: input.correction_reason } : {}),
  };
}

export async function submitFinding(
  submit: SubmitEvidence,
  input: { claim: ImprovementFindingClaimV1; subject_bindings: readonly SubjectBinding[]; source_ref: string; execution_or_run_ref?: string },
): Promise<EvidenceEnvelopeV1> {
  const v = validateFindingClaim(input.claim, input.subject_bindings);
  if (!v.ok) throw new IntakeValidationError("IMPROVEMENT_FINDING", v.errors);
  return submit({
    evidence_kind: "IMPROVEMENT_FINDING",
    subject_bindings: input.subject_bindings,
    availability: "PRESENT",
    claim_schema: FINDING_CLAIM_SCHEMA,
    claim: input.claim,
    producer_ref: INTAKE_PRODUCER_REF,
    source_ref: input.source_ref,
    ...(input.execution_or_run_ref !== undefined ? { execution_or_run_ref: input.execution_or_run_ref } : {}),
    source_relation: "SELF_REPORT",
  });
}

// ---------------------------------------------------------------- resolution

export async function submitResolution(
  submit: SubmitEvidence,
  input: { claim: ImprovementFindingResolutionClaimV1; subject_bindings: readonly SubjectBinding[]; tip: { classification: Classification }; source_ref: string },
): Promise<EvidenceEnvelopeV1> {
  const v = validateResolutionClaim(input.claim, input.tip);
  if (!v.ok) throw new IntakeValidationError("IMPROVEMENT_FINDING_RESOLUTION", v.errors);
  return submit({
    evidence_kind: "IMPROVEMENT_FINDING_RESOLUTION",
    subject_bindings: input.subject_bindings,
    availability: "PRESENT",
    claim_schema: RESOLUTION_CLAIM_SCHEMA,
    claim: input.claim,
    producer_ref: INTAKE_PRODUCER_REF,
    source_ref: input.source_ref,
    source_relation: "SELF_REPORT",
  });
}

// ---------------------------------------------------------------- work re-entry (§7/§8)

export interface ExternalInput {
  authority_ref: string;
  object_id: string;
  revision_or_version?: string;
  content_digest?: { value: string };
  observation_ref: string; // exact PRESENT evidence carrying that revision/digest
}

export interface FindingAdmission {
  finding_ref: EvidenceRef;
  purpose: "IMPLEMENTATION" | "INDEX_ONLY";
  conflict_complete: boolean;
  external_inputs?: readonly ExternalInput[];
}

/** The exact work_binding the Rego requires: namespace improvement-finding, object_id + envelope digest (§4.3). */
export function findingWorkBinding(finding: EvidenceRef): SubjectBinding {
  return {
    authority_ref: "cadp-store:k04",
    namespace: "improvement-finding",
    object_id: finding.evidence_id,
    content_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: finding.envelope_digest },
  };
}

export function buildFindingAdmission(input: FindingAdmission): FindingAdmission & Record<string, unknown> {
  return {
    finding_ref: input.finding_ref,
    purpose: input.purpose,
    conflict_complete: input.conflict_complete,
    ...(input.external_inputs !== undefined ? { external_inputs: input.external_inputs } : {}),
  };
}

// ---------------------------------------------------------------- projection material (§6)

export function buildProjectionMaterial(input: {
  finding_ref: EvidenceRef;
  purpose: ProjectionPurpose;
  target_tracker_ref: { authority_ref: string; target_type: string; target_id: string };
  rendered_content_digest: string;
  rendered_cas_key: string;
  series_key?: string;
  expected_external_revision?: string;
  projection_key?: string;
}): FindingProjectionMaterialV1 & { rendered_cas_key: string } {
  const projection_key = input.projection_key ?? deriveProjectionKey(input.finding_ref, input.target_tracker_ref.target_id);
  const material = {
    contract_id: CONTRACT_ID,
    finding_ref: input.finding_ref,
    target_tracker_ref: input.target_tracker_ref,
    projection_key,
    purpose: input.purpose,
    rendered_content_digest: input.rendered_content_digest,
    rendered_cas_key: input.rendered_cas_key,
    ...(input.series_key !== undefined ? { series_key: input.series_key } : {}),
    ...(input.expected_external_revision !== undefined ? { expected_external_revision: input.expected_external_revision } : {}),
  };
  const v = validateProjectionMaterial(material);
  if (!v.ok) throw new IntakeValidationError("FINDING_PROJECT", v.errors);
  return material;
}

export const SCHEMAS = { FINDING_CLAIM_SCHEMA, RESOLUTION_CLAIM_SCHEMA, PROJECTION_MATERIAL_SCHEMA };
