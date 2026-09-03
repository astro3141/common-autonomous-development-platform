/**
 * K1–K7 constitutional record types (Spec v0.4 §4) and their schema validation
 * (TD §2.5 step 1 + step 5 kind-specific invariants). The versioned schemas are
 * embedded in the Kernel Service build; their digest is part of `cadp-bootstrap-1`.
 */

import { isCanonicalTimestamp, isDigestShape, jcsDigest, recordDigest, digestsEqual } from "./canonical.ts";
import type { Digest } from "./canonical.ts";

// ---------------------------------------------------------------- shared shapes

export interface SubjectBinding {
  readonly authority_ref: string;
  readonly namespace: string;
  readonly object_id: string;
  readonly revision_or_version?: string;
  readonly content_digest?: Digest;
}

export interface TargetRef {
  readonly authority_ref: string;
  readonly target_type: string;
  readonly target_id: string;
}

// ---------------------------------------------------------------- K1

export interface PolicyRefV1 {
  readonly policy_id: string;
  readonly revision: number;
  readonly content_digest: Digest;
  readonly issuer_ref: string;
}

// ---------------------------------------------------------------- K2

export type EvidenceKind =
  | "VERIFICATION"
  | "REVIEW"
  | "BACKEND_EXECUTION"
  | "HUMAN_DECISION"
  | "TARGET_RECONCILIATION"
  | "PEP_TARGET_IDENTITY"
  | "CREDENTIAL_REACH_ATTESTATION"
  | "TARGET_IMMUTABILITY_ATTESTATION"
  | "KERNEL_INCIDENT"
  | "WORK_STEP"
  | "WORK_BOUND_STOP"
  | "GENESIS"
  | "BREAK_GLASS"
  | "LEGACY_V03_ARTIFACT"
  | "RECONCILE_EXHAUSTED";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "VERIFICATION", "REVIEW", "BACKEND_EXECUTION", "HUMAN_DECISION", "TARGET_RECONCILIATION",
  "PEP_TARGET_IDENTITY", "CREDENTIAL_REACH_ATTESTATION", "TARGET_IMMUTABILITY_ATTESTATION",
  "KERNEL_INCIDENT", "WORK_STEP", "WORK_BOUND_STOP", "GENESIS", "BREAK_GLASS", "LEGACY_V03_ARTIFACT",
  "RECONCILE_EXHAUSTED",
];

export interface Provenance {
  readonly source_relation: "SELF_REPORT" | "INDEPENDENT_OBSERVATION" | "TARGET_AUTHORITY_OBSERVATION";
  readonly integrity: "UNATTESTED" | "AUTHENTICATED_SOURCE" | "SIGNED_ATTESTATION";
  readonly attestation_ref?: string;
}

export interface EvidenceEnvelopeV1 {
  readonly evidence_id: string;
  readonly evidence_kind: EvidenceKind;
  readonly subject_bindings: readonly SubjectBinding[];
  readonly availability: "PRESENT" | "UNKNOWN";
  readonly claim_schema: string;
  readonly claim?: unknown;
  readonly claim_digest?: Digest;
  readonly unknown_reason?: string;
  readonly producer_ref: string;
  readonly source_ref: string;
  readonly execution_or_run_ref?: string;
  readonly produced_at: string;
  readonly provenance: Provenance;
  readonly envelope_digest: Digest;
}

// ---------------------------------------------------------------- K3

export interface EffectRequestV1 {
  readonly effect_id: string;
  readonly requester_ref: string;
  readonly work_bindings: readonly SubjectBinding[];
  readonly target_ref: TargetRef;
  readonly operation_kind: string;
  readonly material_schema: string;
  readonly material_digest: Digest;
  readonly material_ref: string;
  readonly prior_effect_refs: readonly string[];
  readonly requested_at: string;
  readonly request_digest: Digest;
}

// ---------------------------------------------------------------- K4

export interface AdmissionInputV1 {
  readonly policy_ref: PolicyRefV1;
  readonly effect_request_ref: string;
  readonly effect_request_digest: Digest;
  readonly evidence_refs: ReadonlyArray<{ readonly evidence_id: string; readonly envelope_digest: Digest }>;
  readonly assembled_at: string;
  readonly input_digest: Digest;
}

// ---------------------------------------------------------------- K5

export interface Constraint {
  readonly kind: string;
  readonly args: readonly (string | number)[];
}

export interface PolicyDecisionV1 {
  readonly decision_id: string;
  readonly policy_ref: PolicyRefV1;
  readonly admission_input_digest: Digest;
  readonly outcome: "ALLOW" | "DENY" | "REQUIRE_EVIDENCE";
  readonly reason_codes: readonly string[];
  readonly constraints: readonly Constraint[];
  readonly evaluator: {
    readonly evaluator_ref: string;
    readonly evaluator_version: string;
    readonly integrity_ref: string;
  };
  readonly decided_at: string;
  readonly not_after?: string;
  readonly decision_digest: Digest;
}

// ---------------------------------------------------------------- K6

export interface EffectAdmissionV1 {
  readonly admission_id: string;
  readonly effect_id: string;
  readonly dispatch_ordinal: number;
  readonly prior_admission_ref?: string;
  readonly effect_request_digest: Digest;
  readonly policy_decision_ref: string;
  readonly policy_decision_digest: Digest;
  readonly admission_input_digest: Digest;
  readonly pep_ref: string;
  readonly bounded_capability: {
    readonly target_ref: TargetRef;
    readonly operation_kind: string;
    readonly material_digest: Digest;
    readonly single_dispatch: true;
    readonly expires_at?: string;
  };
  readonly admitted_at: string;
  readonly admission_digest: Digest;
}

// ---------------------------------------------------------------- K7

export type OutcomeResult = "COMMITTED" | "NO_EFFECT_CONFIRMED" | "UNKNOWN";

export interface EffectOutcomeV1 {
  readonly outcome_id: string;
  readonly effect_id: string;
  readonly admission_digest: Digest;
  readonly result: OutcomeResult;
  readonly unknown_reason?: string;
  readonly target_ref: TargetRef;
  readonly target_operation_ref?: string;
  readonly evidence_ref?: string;
  readonly observed_at: string;
  readonly observer_ref: string;
  readonly outcome_digest: Digest;
}

// ---------------------------------------------------------------- validation

export class SchemaViolation extends Error {
  readonly record_kind: string;
  constructor(record_kind: string, message: string) {
    super(`${record_kind}: ${message}`);
    this.record_kind = record_kind;
  }
}

function req(cond: unknown, kind: string, msg: string): asserts cond {
  if (!cond) throw new SchemaViolation(kind, msg);
}

function validSubjectBindings(v: unknown, kind: string): void {
  req(Array.isArray(v), kind, "subject/work bindings must be an array");
  for (const b of v as unknown[]) {
    const s = b as SubjectBinding;
    req(typeof s === "object" && s !== null, kind, "binding must be an object");
    req(typeof s.authority_ref === "string" && s.authority_ref.length > 0, kind, "binding.authority_ref");
    req(typeof s.namespace === "string", kind, "binding.namespace");
    req(typeof s.object_id === "string" && s.object_id.length > 0, kind, "binding.object_id");
    if (s.revision_or_version !== undefined) req(typeof s.revision_or_version === "string", kind, "binding.revision_or_version");
    if (s.content_digest !== undefined) req(isDigestShape(s.content_digest), kind, "binding.content_digest");
  }
}

function validTargetRef(v: unknown, kind: string): void {
  const t = v as TargetRef;
  req(typeof t === "object" && t !== null, kind, "target_ref must be an object");
  req(typeof t.authority_ref === "string" && t.authority_ref.length > 0, kind, "target_ref.authority_ref");
  req(typeof t.target_type === "string" && t.target_type.length > 0, kind, "target_ref.target_type");
  req(typeof t.target_id === "string" && t.target_id.length > 0, kind, "target_ref.target_id");
}

export function validatePolicyRef(r: PolicyRefV1): void {
  const K = "k1.policy-ref.v1";
  req(typeof r.policy_id === "string" && /^cadp-v04:policy:[a-z0-9-]+$/u.test(r.policy_id), K, "policy_id");
  req(Number.isInteger(r.revision) && r.revision >= 1, K, "revision must be integer ≥ 1");
  req(isDigestShape(r.content_digest), K, "content_digest");
  req(typeof r.issuer_ref === "string" && r.issuer_ref.length > 0, K, "issuer_ref");
}

export function validateEvidenceEnvelope(r: EvidenceEnvelopeV1): void {
  const K = "k2.evidence-envelope.v1";
  req(typeof r.evidence_id === "string" && r.evidence_id.startsWith("cadp-v04:evidence:"), K, "evidence_id");
  req(EVIDENCE_KINDS.includes(r.evidence_kind), K, `unknown evidence_kind ${String(r.evidence_kind)}`);
  validSubjectBindings(r.subject_bindings, K);
  req(r.availability === "PRESENT" || r.availability === "UNKNOWN", K, "availability");
  req(typeof r.claim_schema === "string" && r.claim_schema.length > 0, K, "claim_schema");
  if (r.availability === "PRESENT") {
    req(r.claim !== undefined, K, "PRESENT requires claim");
    req(isDigestShape(r.claim_digest), K, "PRESENT requires claim_digest");
    req(r.unknown_reason === undefined, K, "PRESENT forbids unknown_reason");
  } else {
    // Spec K2 rule: UNKNOWN forbids claim/claim_digest, requires unknown_reason (C37).
    req(r.claim === undefined && r.claim_digest === undefined, K, "UNKNOWN forbids claim/claim_digest");
    req(typeof r.unknown_reason === "string" && r.unknown_reason.length > 0, K, "UNKNOWN requires unknown_reason");
  }
  req(typeof r.producer_ref === "string" && r.producer_ref.length > 0, K, "producer_ref");
  req(typeof r.source_ref === "string" && r.source_ref.length > 0, K, "source_ref");
  req(isCanonicalTimestamp(r.produced_at), K, "produced_at must be RFC3339 UTC ms Z");
  const p = r.provenance;
  req(typeof p === "object" && p !== null, K, "provenance");
  req(["SELF_REPORT", "INDEPENDENT_OBSERVATION", "TARGET_AUTHORITY_OBSERVATION"].includes(p.source_relation), K, "provenance.source_relation");
  req(["UNATTESTED", "AUTHENTICATED_SOURCE", "SIGNED_ATTESTATION"].includes(p.integrity), K, "provenance.integrity");
  req(isDigestShape(r.envelope_digest), K, "envelope_digest");
  const recomputed = recordDigest(r as unknown as Record<string, unknown>, "envelope_digest");
  req(digestsEqual(recomputed, r.envelope_digest), K, "envelope_digest does not recompute");
  if (r.availability === "PRESENT") {
    req(digestsEqual(jcsDigest(r.claim), r.claim_digest!), K, "claim_digest does not recompute");
  }
}

export function validateEffectRequest(r: EffectRequestV1): void {
  const K = "k3.effect-request.v1";
  req(typeof r.effect_id === "string" && r.effect_id.startsWith("cadp-v04:effect:"), K, "effect_id");
  req(typeof r.requester_ref === "string" && r.requester_ref.length > 0, K, "requester_ref");
  validSubjectBindings(r.work_bindings, K);
  validTargetRef(r.target_ref, K);
  req(typeof r.operation_kind === "string" && /^[A-Z_]+$/u.test(r.operation_kind), K, "operation_kind");
  req(typeof r.material_schema === "string" && r.material_schema.length > 0, K, "material_schema");
  req(isDigestShape(r.material_digest), K, "material_digest");
  // TD §6.6: material is always a CAS object; there is no inline material in K3.
  req(typeof r.material_ref === "string" && /^cas:\/\/sha256\/[0-9a-f]{64}$/u.test(r.material_ref), K, "material_ref");
  req(Array.isArray(r.prior_effect_refs) && r.prior_effect_refs.every((x) => typeof x === "string"), K, "prior_effect_refs");
  req(isCanonicalTimestamp(r.requested_at), K, "requested_at");
  req(isDigestShape(r.request_digest), K, "request_digest");
  req(digestsEqual(recordDigest(r as unknown as Record<string, unknown>, "request_digest"), r.request_digest), K, "request_digest does not recompute");
}

export function validateAdmissionInput(r: AdmissionInputV1): void {
  const K = "k4.admission-input.v1";
  validatePolicyRef(r.policy_ref);
  req(typeof r.effect_request_ref === "string" && r.effect_request_ref.startsWith("cadp-v04:effect:"), K, "effect_request_ref");
  req(isDigestShape(r.effect_request_digest), K, "effect_request_digest");
  req(Array.isArray(r.evidence_refs), K, "evidence_refs");
  for (const e of r.evidence_refs) {
    req(typeof e.evidence_id === "string" && isDigestShape(e.envelope_digest), K, "evidence_refs entry");
  }
  req(isCanonicalTimestamp(r.assembled_at), K, "assembled_at");
  req(isDigestShape(r.input_digest), K, "input_digest");
  req(digestsEqual(recordDigest(r as unknown as Record<string, unknown>, "input_digest"), r.input_digest), K, "input_digest does not recompute");
}

export function validatePolicyDecision(r: PolicyDecisionV1): void {
  const K = "k5.policy-decision.v1";
  req(typeof r.decision_id === "string" && r.decision_id.startsWith("cadp-v04:decision:"), K, "decision_id");
  validatePolicyRef(r.policy_ref);
  req(isDigestShape(r.admission_input_digest), K, "admission_input_digest");
  req(["ALLOW", "DENY", "REQUIRE_EVIDENCE"].includes(r.outcome), K, "outcome");
  req(Array.isArray(r.reason_codes) && r.reason_codes.every((x) => typeof x === "string"), K, "reason_codes");
  req(Array.isArray(r.constraints), K, "constraints");
  for (const c of r.constraints) {
    req(typeof c.kind === "string" && Array.isArray(c.args), K, "constraint shape");
  }
  req(typeof r.evaluator?.evaluator_ref === "string", K, "evaluator.evaluator_ref");
  req(typeof r.evaluator?.evaluator_version === "string", K, "evaluator.evaluator_version");
  req(typeof r.evaluator?.integrity_ref === "string", K, "evaluator.integrity_ref");
  req(isCanonicalTimestamp(r.decided_at), K, "decided_at");
  if (r.not_after !== undefined) req(isCanonicalTimestamp(r.not_after), K, "not_after");
  req(isDigestShape(r.decision_digest), K, "decision_digest");
  req(digestsEqual(recordDigest(r as unknown as Record<string, unknown>, "decision_digest"), r.decision_digest), K, "decision_digest does not recompute");
}

export function validateEffectAdmission(r: EffectAdmissionV1): void {
  const K = "k6.effect-admission.v1";
  req(typeof r.admission_id === "string" && r.admission_id.startsWith("cadp-v04:admission:"), K, "admission_id");
  req(typeof r.effect_id === "string" && r.effect_id.startsWith("cadp-v04:effect:"), K, "effect_id");
  req(Number.isInteger(r.dispatch_ordinal) && r.dispatch_ordinal >= 1, K, "dispatch_ordinal");
  req(isDigestShape(r.effect_request_digest), K, "effect_request_digest");
  req(typeof r.policy_decision_ref === "string", K, "policy_decision_ref");
  req(isDigestShape(r.policy_decision_digest), K, "policy_decision_digest");
  req(isDigestShape(r.admission_input_digest), K, "admission_input_digest");
  req(typeof r.pep_ref === "string" && r.pep_ref.length > 0, K, "pep_ref");
  validTargetRef(r.bounded_capability?.target_ref, K);
  req(typeof r.bounded_capability.operation_kind === "string", K, "bounded_capability.operation_kind");
  req(isDigestShape(r.bounded_capability.material_digest), K, "bounded_capability.material_digest");
  req(r.bounded_capability.single_dispatch === true, K, "bounded_capability.single_dispatch must be true");
  if (r.bounded_capability.expires_at !== undefined) req(isCanonicalTimestamp(r.bounded_capability.expires_at), K, "expires_at");
  req(isCanonicalTimestamp(r.admitted_at), K, "admitted_at");
  req(isDigestShape(r.admission_digest), K, "admission_digest");
  req(digestsEqual(recordDigest(r as unknown as Record<string, unknown>, "admission_digest"), r.admission_digest), K, "admission_digest does not recompute");
}

export function validateEffectOutcome(r: EffectOutcomeV1): void {
  const K = "k7.effect-outcome.v1";
  req(typeof r.outcome_id === "string" && r.outcome_id.startsWith("cadp-v04:outcome:"), K, "outcome_id");
  req(typeof r.effect_id === "string" && r.effect_id.startsWith("cadp-v04:effect:"), K, "effect_id");
  req(isDigestShape(r.admission_digest), K, "admission_digest");
  req(["COMMITTED", "NO_EFFECT_CONFIRMED", "UNKNOWN"].includes(r.result), K, "result");
  if (r.result === "UNKNOWN") req(typeof r.unknown_reason === "string" && r.unknown_reason.length > 0, K, "UNKNOWN requires unknown_reason");
  validTargetRef(r.target_ref, K);
  req(isCanonicalTimestamp(r.observed_at), K, "observed_at");
  req(typeof r.observer_ref === "string" && r.observer_ref.length > 0, K, "observer_ref");
  req(isDigestShape(r.outcome_digest), K, "outcome_digest");
  req(digestsEqual(recordDigest(r as unknown as Record<string, unknown>, "outcome_digest"), r.outcome_digest), K, "outcome_digest does not recompute");
}

/** Digest of the embedded schema set — part of `cadp-bootstrap-1` (TD §2.1). */
export function schemaSetDigest(): Digest {
  // The validators above ARE the embedded schema build; their identity is the module source
  // digest recorded at build time. For the reference build we digest the exported kind list +
  // validation version marker, bumped on any schema change.
  return jcsDigest({ schema_build: "cadp-schemas-v1", kinds: EVIDENCE_KINDS });
}
