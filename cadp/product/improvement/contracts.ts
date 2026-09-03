/**
 * cadp.improvement-intake.v1 product claim contracts (#104, Design authority #98
 * issuecomment-5526957311 §2–§5, §9). Pure product-layer types + validators + identity
 * derivation. The Kernel never parses these claims (TD §9.1); the registered improvement-intake
 * adapter validates the cross-field contract HERE before submit_evidence, and the reference Rego
 * enforces admission predicates over the resulting immutable K2 envelopes.
 *
 * A Finding / Resolution is evidence-derived product interpretation. It is not policy, admission,
 * mutable status, execution authority, or permission to mutate.
 */

import { jcs, sha256Hex } from "../../kernel/canonical.ts";
import type { Digest } from "../../kernel/canonical.ts";
import type { SubjectBinding } from "../../kernel/records.ts";

export const CONTRACT_ID = "cadp.improvement-intake.v1" as const;
export const FINDING_CLAIM_SCHEMA = "cadp.improvement-finding.v1" as const;
export const RESOLUTION_CLAIM_SCHEMA = "cadp.improvement-finding-resolution.v1" as const;
export const PROJECTION_MATERIAL_SCHEMA = "cadp.finding-projection.v1" as const;

export const CLASSIFICATIONS = [
  "BUG", "IMPLEMENTATION_GAP", "BACKEND_GAP", "OPERABILITY_GAP",
  "CONTRACT_GAP", "CONTRACT_AMBIGUITY", "CONTRACT_CONTRADICTION", "NON_BLOCKING_NIT",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** The three CONTRACT_* classes that raise the contract barrier (§3, §8). */
export const CONTRACT_CLASSES: readonly Classification[] = ["CONTRACT_GAP", "CONTRACT_AMBIGUITY", "CONTRACT_CONTRADICTION"];
export function isContractClass(c: Classification): boolean {
  return CONTRACT_CLASSES.includes(c);
}

export const SUBJECT_KINDS = ["WORK_RUN", "EFFECT", "EVIDENCE", "BACKEND", "TARGET", "PRODUCT_CONFORMANCE_PROOF"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
/** Immutable subject kinds need no revision/digest; every other kind does (§2.2). */
const IMMUTABLE_SUBJECT_KINDS: readonly SubjectKind[] = ["EVIDENCE"];

export const BASIS_ROLES = ["OBSERVATION", "REPRODUCTION", "DIAGNOSTIC", "CONFORMANCE_PROOF", "AUTHORITY_TEXT"] as const;
export type BasisRole = (typeof BASIS_ROLES)[number];

export const DERIVATION_KINDS = ["DETERMINISTIC_DERIVATION", "MODEL_PROPOSAL", "HUMAN_JUDGMENT"] as const;
export type DerivationKind = (typeof DERIVATION_KINDS)[number];

export const RESOLUTION_KINDS = ["VERIFIED_REPAIR", "AUTHORITY_RESOLUTION"] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

export const PROJECTION_PURPOSES = ["CREATE_INDEX", "APPEND_OCCURRENCE", "APPEND_RESOLUTION"] as const;
export type ProjectionPurpose = (typeof PROJECTION_PURPOSES)[number];
/** Option-A index-only purposes: the sole exception to unresolved-CONTRACT_* mutation DENY (§6). */
export const INDEX_ONLY_PURPOSES: readonly ProjectionPurpose[] = ["CREATE_INDEX", "APPEND_OCCURRENCE"];

export interface EvidenceRef {
  readonly evidence_id: string;
  readonly envelope_digest: string;
}

export interface ImprovementFindingClaimV1 {
  readonly contract_id: typeof CONTRACT_ID;
  readonly classification: Classification;
  readonly subject: { readonly kind: SubjectKind; readonly binding_index: number };
  readonly basis: ReadonlyArray<EvidenceRef & { readonly role: BasisRole }>;
  readonly derivation: {
    readonly kind: DerivationKind;
    readonly method_ref: string;
    readonly method_digest: string;
    readonly execution_or_run_ref?: string;
  };
  readonly anomaly_code: string;
  readonly occurrence_key: string;
  readonly series_key?: string;
  readonly statement: { readonly summary: string; readonly detail?: string };
  readonly supersedes?: ReadonlyArray<EvidenceRef>;
  readonly correction_reason?: string;
}

export interface ImprovementFindingResolutionClaimV1 {
  readonly contract_id: typeof CONTRACT_ID;
  readonly finding_tip_ref: EvidenceRef;
  readonly resolution_kind: ResolutionKind;
  readonly resolving_work_run_refs?: readonly string[];
  readonly committed_effect_outcome_refs?: readonly string[];
  readonly verification_refs?: readonly string[];
  readonly review_refs?: readonly string[];
  readonly original_failure_ref?: string;
  readonly original_scenario_replay_ref?: string;
  readonly regression_ref?: string;
  readonly landed_authority_ref?: string;
  readonly statement: string;
}

export interface FindingProjectionMaterialV1 {
  readonly contract_id: typeof CONTRACT_ID;
  readonly finding_ref: EvidenceRef;
  readonly series_key?: string;
  readonly target_tracker_ref: { readonly authority_ref: string; readonly target_type: string; readonly target_id: string };
  readonly projection_key: string;
  readonly purpose: ProjectionPurpose;
  readonly rendered_content_digest: string;
  /** CAS pointer to the exact rendered index-item bytes bound by rendered_content_digest (§6). */
  readonly rendered_cas_key?: string;
  readonly expected_external_revision?: string;
}

// ---------------------------------------------------------------- identity derivation

/**
 * occurrence_key (§4): stable identity of one occurrence of one anomaly on one exact subject
 * under one detector. The primary subject binding is the EXACT enclosing K2 subject binding, not
 * a copied display string.
 */
export function deriveOccurrenceKey(input: {
  primary_subject_binding: SubjectBinding;
  anomaly_code: string;
  basis: ReadonlyArray<EvidenceRef & { role: BasisRole }>;
  method_ref: string;
  method_digest: string;
}): string {
  const sorted = [...input.basis]
    .map((b) => ({ evidence_id: b.evidence_id, envelope_digest: b.envelope_digest, role: b.role }))
    .sort((a, b) => (a.evidence_id + a.envelope_digest).localeCompare(b.evidence_id + b.envelope_digest));
  return sha256Hex(jcs({
    contract_id: CONTRACT_ID,
    exact_primary_subject_binding: normalizeBinding(input.primary_subject_binding),
    anomaly_code: input.anomaly_code,
    sorted_exact_basis_refs: sorted,
    method_ref: input.method_ref,
    method_digest: input.method_digest,
  }));
}

/**
 * series_key (§5): presentation-only grouping of repeated occurrences. Automatic grouping is
 * admissible ONLY from a declared deterministic detector contract (anomaly_code +
 * detector_contract_digest); model/fuzzy grouping is advisory UI metadata, never this key.
 */
export function deriveSeriesKey(input: { subject_anchor: string; anomaly_code: string; detector_contract_digest: string }): string {
  return sha256Hex(jcs({
    subject_anchor: input.subject_anchor,
    anomaly_code: input.anomaly_code,
    detector_contract_digest: input.detector_contract_digest,
  }));
}

function normalizeBinding(b: SubjectBinding): Record<string, unknown> {
  const out: Record<string, unknown> = { authority_ref: b.authority_ref, namespace: b.namespace, object_id: b.object_id };
  if (b.revision_or_version !== undefined) out["revision_or_version"] = b.revision_or_version;
  if (b.content_digest !== undefined) out["content_digest"] = b.content_digest;
  return out;
}

// ---------------------------------------------------------------- validation

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function fail(errors: string[]): ValidationResult { return { ok: errors.length === 0, errors }; }

/**
 * Validate an IMPROVEMENT_FINDING claim against §2/§3 before submission (control 3, 4). The
 * enclosing subject_bindings are supplied so the primary-subject binding can be resolved and the
 * occurrence_key recomputed exactly. This is per-claim structural + cross-field validity; cross-
 * finding barrier/leaf/conflict facts are enforced by the reference Rego at admission.
 */
export function validateFindingClaim(claim: ImprovementFindingClaimV1, subjectBindings: readonly SubjectBinding[]): ValidationResult {
  const errors: string[] = [];
  if (claim.contract_id !== CONTRACT_ID) errors.push(`contract_id must be ${CONTRACT_ID}`);
  if (!CLASSIFICATIONS.includes(claim.classification)) errors.push(`unknown classification ${String(claim.classification)}`);

  // subject.binding_index resolves to the exact enclosing K2 subject binding (§2.1).
  const idx = claim.subject?.binding_index;
  const primary = Number.isInteger(idx) && idx >= 0 && idx < subjectBindings.length ? subjectBindings[idx] : undefined;
  if (primary === undefined) {
    errors.push(`subject.binding_index ${String(idx)} does not resolve to an enclosing subject binding`);
  } else if (!SUBJECT_KINDS.includes(claim.subject.kind)) {
    errors.push(`unknown subject.kind ${String(claim.subject.kind)}`);
  } else if (!IMMUTABLE_SUBJECT_KINDS.includes(claim.subject.kind) && primary.revision_or_version === undefined && primary.content_digest === undefined) {
    // Mutable subject with no exact revision/version or content digest cannot be a PRESENT Finding
    // (§2.2, control 3): the ambient "current" is forbidden; bind the UNKNOWN/diagnostic instead.
    errors.push(`mutable subject kind ${claim.subject.kind} requires an exact revision_or_version or content_digest`);
  }

  // basis is non-empty and every pair is a well-formed exact K2 ref (§2.3). A Finding cannot cite
  // itself: at submission the Finding has no id yet, so self-citation is structurally impossible.
  if (!Array.isArray(claim.basis) || claim.basis.length === 0) {
    errors.push("basis must be a non-empty array of exact K2 refs");
  } else {
    for (const [i, b] of claim.basis.entries()) {
      if (typeof b.evidence_id !== "string" || b.evidence_id.length === 0) errors.push(`basis[${i}].evidence_id missing`);
      if (typeof b.envelope_digest !== "string" || b.envelope_digest.length === 0) errors.push(`basis[${i}].envelope_digest missing`);
      if (!BASIS_ROLES.includes(b.role)) errors.push(`basis[${i}].role invalid ${String(b.role)}`);
    }
  }

  // derivation provenance (§2.5/§2.6): method binds the exact detector or prompt+schema surface;
  // a run ref is mandatory for MODEL_PROPOSAL/HUMAN_JUDGMENT and forbidden for a deterministic
  // rule (a model/human judgment inherently has a run; a pure detector does not) — control 4.
  const d = claim.derivation;
  if (!d || !DERIVATION_KINDS.includes(d.kind)) {
    errors.push(`derivation.kind invalid ${String(d?.kind)}`);
  } else {
    if (typeof d.method_ref !== "string" || d.method_ref.length === 0) errors.push("derivation.method_ref missing");
    if (typeof d.method_digest !== "string" || d.method_digest.length === 0) errors.push("derivation.method_digest missing");
    const hasRun = typeof d.execution_or_run_ref === "string" && d.execution_or_run_ref.length > 0;
    if ((d.kind === "MODEL_PROPOSAL" || d.kind === "HUMAN_JUDGMENT") && !hasRun) {
      errors.push(`derivation.execution_or_run_ref is mandatory for ${d.kind}`);
    }
    if (d.kind === "DETERMINISTIC_DERIVATION" && hasRun) {
      errors.push("DETERMINISTIC_DERIVATION must not carry execution_or_run_ref (a run implies non-deterministic derivation)");
    }
  }

  if (typeof claim.anomaly_code !== "string" || claim.anomaly_code.length === 0) errors.push("anomaly_code missing");
  if (!claim.statement || typeof claim.statement.summary !== "string" || claim.statement.summary.length === 0) errors.push("statement.summary missing");

  // A correction/reclassification is a new complete Finding: supersedes lists exact predecessors
  // and correction_reason is mandatory (§4).
  if (claim.supersedes !== undefined) {
    if (!Array.isArray(claim.supersedes) || claim.supersedes.length === 0) errors.push("supersedes, when present, must be a non-empty array");
    else for (const [i, s] of claim.supersedes.entries()) {
      if (typeof s.evidence_id !== "string" || typeof s.envelope_digest !== "string") errors.push(`supersedes[${i}] must be an exact ref`);
    }
    if (typeof claim.correction_reason !== "string" || claim.correction_reason.length === 0) errors.push("correction_reason is mandatory when superseding");
  }

  // occurrence_key must be the exact derivation (§4): a forged/mismatched key is rejected.
  if (primary !== undefined && Array.isArray(claim.basis) && claim.basis.length > 0 && d && DERIVATION_KINDS.includes(d.kind)) {
    const expected = deriveOccurrenceKey({
      primary_subject_binding: primary,
      anomaly_code: claim.anomaly_code,
      basis: claim.basis,
      method_ref: d.method_ref,
      method_digest: d.method_digest,
    });
    if (claim.occurrence_key !== expected) errors.push(`occurrence_key mismatch: expected ${expected}`);
  }

  return fail(errors);
}

/**
 * Validate an IMPROVEMENT_FINDING_RESOLUTION claim (§9). The exact resolution-kind partition is
 * symmetric and requires the tip's classification (controls 14, 18). VERIFIED_REPAIR rejects every
 * CONTRACT_* tip; AUTHORITY_RESOLUTION rejects every non-CONTRACT_* tip.
 */
export function validateResolutionClaim(
  claim: ImprovementFindingResolutionClaimV1,
  tip: { classification: Classification },
): ValidationResult {
  const errors: string[] = [];
  if (claim.contract_id !== CONTRACT_ID) errors.push(`contract_id must be ${CONTRACT_ID}`);
  if (!claim.finding_tip_ref || typeof claim.finding_tip_ref.evidence_id !== "string" || typeof claim.finding_tip_ref.envelope_digest !== "string") {
    errors.push("finding_tip_ref must be an exact ref");
  }
  if (!RESOLUTION_KINDS.includes(claim.resolution_kind)) {
    errors.push(`unknown resolution_kind ${String(claim.resolution_kind)}`);
  } else {
    const tipIsContract = isContractClass(tip.classification);
    if (claim.resolution_kind === "VERIFIED_REPAIR" && tipIsContract) {
      errors.push(`VERIFIED_REPAIR is invalid for CONTRACT_* tip (${tip.classification})`);
    }
    if (claim.resolution_kind === "AUTHORITY_RESOLUTION" && !tipIsContract) {
      errors.push(`AUTHORITY_RESOLUTION is invalid for non-CONTRACT_* tip (${tip.classification})`);
    }
    if (claim.resolution_kind === "VERIFIED_REPAIR") {
      // Exact resolving work + committed outcomes + policy-required verification/review + regression (§9.6).
      if (!claim.resolving_work_run_refs || claim.resolving_work_run_refs.length === 0) errors.push("VERIFIED_REPAIR requires resolving_work_run_refs");
      if (!claim.verification_refs || claim.verification_refs.length === 0) errors.push("VERIFIED_REPAIR requires verification_refs");
      if (!claim.regression_ref) errors.push("VERIFIED_REPAIR requires regression_ref");
      // Where a failing scenario is reproducible, replay is mandatory; where impossible, exact
      // independent evidence must say why (§9.7/§9.8). A bare omission is insufficient.
      if (claim.original_failure_ref !== undefined && claim.original_scenario_replay_ref === undefined) {
        errors.push("original_failure_ref present but original_scenario_replay_ref missing (replay is mandatory when reproducible)");
      }
    }
    if (claim.resolution_kind === "AUTHORITY_RESOLUTION" && (claim.landed_authority_ref === undefined || claim.landed_authority_ref.length === 0)) {
      errors.push("AUTHORITY_RESOLUTION requires the exact landed authority (Spec/TD/product-authority) or Human Design decision ref");
    }
  }
  if (typeof claim.statement !== "string" || claim.statement.length === 0) errors.push("statement missing");
  return fail(errors);
}

/** Validate a FINDING_PROJECT material (§6): closed shape, no smuggled non-index semantics (control 20). */
export function validateProjectionMaterial(material: FindingProjectionMaterialV1): ValidationResult {
  const errors: string[] = [];
  const allowedKeys = new Set([
    "contract_id", "finding_ref", "series_key", "target_tracker_ref", "projection_key",
    "purpose", "rendered_content_digest", "rendered_cas_key", "expected_external_revision",
  ]);
  for (const k of Object.keys(material)) {
    if (!allowedKeys.has(k)) errors.push(`finding-projection material has non-index field "${k}" (smuggled semantics forbidden)`);
  }
  if (material.contract_id !== CONTRACT_ID) errors.push(`contract_id must be ${CONTRACT_ID}`);
  if (!material.finding_ref || typeof material.finding_ref.evidence_id !== "string" || typeof material.finding_ref.envelope_digest !== "string") {
    errors.push("finding_ref must be an exact ref");
  }
  if (!PROJECTION_PURPOSES.includes(material.purpose)) errors.push(`unknown projection purpose ${String(material.purpose)}`);
  if (typeof material.projection_key !== "string" || material.projection_key.length === 0) errors.push("projection_key missing");
  if (typeof material.rendered_content_digest !== "string" || material.rendered_content_digest.length === 0) errors.push("rendered_content_digest missing");
  const t = material.target_tracker_ref;
  if (!t || typeof t.authority_ref !== "string" || typeof t.target_type !== "string" || typeof t.target_id !== "string") {
    errors.push("target_tracker_ref must name the declared tracker index target");
  }
  return fail(errors);
}

/** Deterministic projection_key: one stable tracker index item per (finding tip, tracker). */
export function deriveProjectionKey(finding_ref: EvidenceRef, target_id: string): string {
  return sha256Hex(jcs({ contract_id: CONTRACT_ID, finding_evidence_id: finding_ref.evidence_id, target_id }));
}

export type { Digest };
