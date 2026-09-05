/**
 * cadp.improvement-intake.v1 → v1.1 governed transition contract (#117, implementing #107).
 *
 * The landed v1.0 clearing rule let a CONTRACT_* barrier drop on a claim-authored
 * `AUTHORITY_TEXT` basis role (Review B18) and on a bare intake `HUMAN_JUDGMENT` descendant.
 * v1.1 replaces that: the only descendants with clearing or delegation power are the ones
 * sealed through the governed `FINDING_SEAL` effect by the permanent producer identity
 * `governed:reclassification` (invariant P), authorized either by an ordinary effect-scoped
 * `HUMAN_DECISION` over `digest(M)` or by an ACTIVE-policy `authority_text_rules` entry plus a
 * context-bound authority observation whose applicability names the exact predecessor, both
 * subjects, the method and the work run.
 *
 * Everything here is product layer: pure types, validators and the derivation closure. The
 * Kernel never parses these claims (TD §9.1); the reference Rego enforces the same predicates
 * at admission and the `FINDING_SEAL` adapter re-validates them before dispatch.
 */

import { jcs, jcsDigest, sha256Hex } from "../../kernel/canonical.ts";
import type { Digest } from "../../kernel/canonical.ts";
import type { EvidenceEnvelopeV1, SubjectBinding } from "../../kernel/records.ts";
import {
  CLASSIFICATIONS, CONTRACT_ID, FINDING_CLAIM_SCHEMA, IMMUTABLE_SUBJECT_KINDS, SUBJECT_KINDS,
  deriveOccurrenceKey, isContractClass,
} from "./contracts.ts";
import type {
  Classification, EvidenceRef, ImprovementFindingClaimV1, SubjectKind, ValidationResult,
} from "./contracts.ts";

/**
 * Invariant P (§5.2): a permanent constant of product contract v1.1, never registry content.
 * Only the workload CREDENTIAL bound to it rotates; every uniqueness key and every clearing
 * predicate uses this exact string, so a revoked or rotated credential can neither un-clear a
 * completed edge nor open a second edge for a served predecessor.
 */
export const GOVERNED_PRODUCER_REF = "governed:reclassification" as const;
export const GOVERNED_PRINCIPAL = "cadp-governed-reclassification" as const;
export const GOVERNED_TRANSITION_MATERIAL_SCHEMA = "cadp.governed-transition.v1" as const;
export const FINDING_SEAL_OPERATION = "FINDING_SEAL" as const;
export const FINDING_SEAL_TARGET_TYPE = "EVIDENCE_SEAL" as const;
export const FINDING_SEAL_AUTHORITY_REF = "cadp-store:k04" as const;
export const FINDING_SEAL_SERIALIZATION_DOMAIN = "evidence-seal" as const;

/** The two exhaustive governed transition families (§4, §4.1). One edge never changes both. */
export const TRANSITION_KINDS = ["RECLASSIFICATION", "SUBJECT_TRANSFER"] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** `Provenance.integrity` minus UNATTESTED — the vocabulary a rule may demand of an observation. */
export const RULE_PROVENANCES = ["AUTHENTICATED_SOURCE", "SIGNED_ATTESTATION"] as const;
export type RuleProvenance = (typeof RULE_PROVENANCES)[number];

// ---------------------------------------------------------------- normalized subject tuple

export interface SubjectTuple {
  readonly authority_ref: string;
  readonly namespace: string;
  readonly object_id: string;
  readonly revision_or_version?: string;
  readonly content_digest?: Digest;
}

const SUBJECT_TUPLE_KEYS = ["authority_ref", "namespace", "object_id", "revision_or_version", "content_digest"] as const;

/**
 * The normalized primary subject tuple both families bind (§4). Exactly the five landed
 * `SubjectBinding` fields, absent ones omitted — the same projection the reference Rego makes,
 * so material/observation/envelope comparisons are byte-exact on both sides.
 */
export function subjectTuple(b: SubjectBinding): SubjectTuple {
  const out: Record<string, unknown> = {};
  for (const k of SUBJECT_TUPLE_KEYS) {
    const v = (b as unknown as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as SubjectTuple;
}

export function primaryBinding(
  finding: { subject_bindings: readonly SubjectBinding[]; claim: ImprovementFindingClaimV1 },
): SubjectBinding | undefined {
  return finding.subject_bindings[finding.claim.subject.binding_index];
}

// ---------------------------------------------------------------- authority observation

/**
 * The typed applicability claim every deterministic authority observation must carry (§6.5).
 * A claim without it is not authority at all — there is no free-floating authority text — and
 * every field is mandatory: none of them is rule-suppressible (round-10 R10-2).
 */
export interface AuthorityApplicabilityV1 {
  readonly transition_kind: TransitionKind;
  readonly predecessor_ref: EvidenceRef;
  readonly from_classification: Classification;
  readonly to_classification: Classification;
  readonly from_subject: SubjectTuple;
  readonly to_subject: SubjectTuple;
  readonly to_subject_kind: SubjectKind;
  readonly method: { readonly method_ref: string; readonly method_digest: string };
  readonly work_run_ref: string;
}

export const APPLIES_TO_KEYS = [
  "transition_kind", "predecessor_ref", "from_classification", "to_classification",
  "from_subject", "to_subject", "to_subject_kind", "method", "work_run_ref",
] as const;

// ---------------------------------------------------------------- active-policy rule table

/**
 * One entry of `data.policy_params.improvement_transition.authority_text_rules` — Human-gated,
 * revocable, evaluator-private policy content OUTSIDE the kernel-owned `data.cadp` (§5, round-12
 * A1). The kernel therefore never validates it: `wellFormedRule` is a fail-closed predicate at
 * USE, evaluated on the uniquely selected rule (§6.5 step 2b).
 */
export interface AuthorityTextRuleV1 {
  readonly transition_kind: TransitionKind;
  readonly from: Classification;
  readonly to: Classification;
  readonly method: { readonly method_ref: string; readonly method_digest: string };
  readonly producer_ref: string;
  readonly evidence_kind: string;
  readonly claim_schema: string;
  readonly provenance: RuleProvenance;
  readonly authority_content_digest: string;
  readonly derived_anomaly_code: string;
  readonly derived_statement: { readonly summary: string };
  readonly derived_correction_reason: string;
}

export const RULE_KEYS = [
  "transition_kind", "from", "to", "method", "producer_ref", "evidence_kind", "claim_schema",
  "provenance", "authority_content_digest", "derived_anomaly_code", "derived_statement",
  "derived_correction_reason",
] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function keysEqual(o: unknown, keys: readonly string[]): o is Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return false;
  const actual = Object.keys(o as Record<string, unknown>);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

/**
 * `well_formed(r)` (§6.5). Typed over the WHOLE rule, not the derived_* strings only: round-12
 * F1 measured that an empty `method_ref`/`method_digest` was reachable (an observation carrying
 * the same empty pair matches uniquely) and produced a draft the landed `validateFindingClaim`
 * rejects — an ALLOW that can never seal. No missing key, no unknown key, no empty string, no
 * non-member of a landed closed set.
 */
export function wellFormedRule(r: unknown): r is AuthorityTextRuleV1 {
  if (!keysEqual(r, RULE_KEYS as unknown as readonly string[])) return false;
  const o = r as unknown as Record<string, unknown>;
  if (!TRANSITION_KINDS.includes(o["transition_kind"] as TransitionKind)) return false;
  if (!CLASSIFICATIONS.includes(o["from"] as Classification)) return false;
  if (!CLASSIFICATIONS.includes(o["to"] as Classification)) return false;
  if (!keysEqual(o["method"], ["method_ref", "method_digest"])) return false;
  const m = o["method"] as Record<string, unknown>;
  if (!isNonEmptyString(m["method_ref"]) || !isNonEmptyString(m["method_digest"])) return false;
  for (const k of ["producer_ref", "evidence_kind", "claim_schema", "authority_content_digest", "derived_anomaly_code", "derived_correction_reason"]) {
    if (!isNonEmptyString(o[k])) return false;
  }
  if (!RULE_PROVENANCES.includes(o["provenance"] as RuleProvenance)) return false;
  if (!keysEqual(o["derived_statement"], ["summary"])) return false;
  if (!isNonEmptyString((o["derived_statement"] as Record<string, unknown>)["summary"])) return false;
  return true;
}

/**
 * One entry of `data.policy_params.improvement_transition.landed_authority_resolutions` (§10.4):
 * a Human-landed binding of ONE landed authority content to ONE exact CONTRACT_* tip. Absent
 * namespace, absent table, non-array or malformed entry ⇒ no valid resolution (fail closed).
 */
export interface LandedAuthorityResolutionEntryV1 {
  readonly finding_ref: EvidenceRef;
  readonly authority_content_digest: string;
}

export function wellFormedResolutionEntry(e: unknown): e is LandedAuthorityResolutionEntryV1 {
  if (!keysEqual(e, ["finding_ref", "authority_content_digest"])) return false;
  const o = e as Record<string, unknown>;
  if (!keysEqual(o["finding_ref"], ["evidence_id", "envelope_digest"])) return false;
  const f = o["finding_ref"] as Record<string, unknown>;
  return isNonEmptyString(f["evidence_id"]) && isNonEmptyString(f["envelope_digest"]) &&
    isNonEmptyString(o["authority_content_digest"]);
}

// ---------------------------------------------------------------- the K3 material

/** The complete K2 draft of G, embedded byte-exactly in the material (§4, A3). */
export interface GovernedDescendantDraftV1 {
  readonly evidence_kind: "IMPROVEMENT_FINDING";
  readonly subject_bindings: readonly SubjectBinding[];
  readonly claim: ImprovementFindingClaimV1;
}

export interface GovernedTransitionMaterialV1 {
  readonly contract_id: typeof CONTRACT_ID;
  readonly idempotency_key: string;
  readonly transition_kind: TransitionKind;
  readonly predecessor_ref: EvidenceRef;
  readonly from_classification: Classification;
  readonly to_classification: Classification;
  readonly from_subject: SubjectTuple;
  readonly to_subject: SubjectTuple;
  readonly descendant_draft: GovernedDescendantDraftV1;
}

export const MATERIAL_KEYS = [
  "contract_id", "idempotency_key", "transition_kind", "predecessor_ref", "from_classification",
  "to_classification", "from_subject", "to_subject", "descendant_draft",
] as const;

function fail(errors: string[]): ValidationResult { return { ok: errors.length === 0, errors }; }

/**
 * Structural + cross-field validity of a `cadp.governed-transition.v1` material (§6.4 shape and
 * per-kind rules), independent of any authority. The reference Rego enforces the same predicates
 * at admission over the resolved material; this is the adapter-side conformance gate (§4 rule 3).
 */
export function validateGovernedTransitionMaterial(
  material: unknown,
  predecessor?: { subject_bindings: readonly SubjectBinding[]; claim: ImprovementFindingClaimV1; envelope_digest: Digest; evidence_id: string },
): ValidationResult {
  const errors: string[] = [];
  if (!keysEqual(material, MATERIAL_KEYS as unknown as readonly string[])) {
    return fail([`governed-transition material must carry exactly ${MATERIAL_KEYS.join(", ")}`]);
  }
  const m = material as unknown as GovernedTransitionMaterialV1;
  if (m.contract_id !== CONTRACT_ID) errors.push(`contract_id must be ${CONTRACT_ID}`);
  if (!isNonEmptyString(m.idempotency_key)) errors.push("idempotency_key missing");
  if (!TRANSITION_KINDS.includes(m.transition_kind)) errors.push(`transition_kind invalid ${String(m.transition_kind)}`);
  if (!keysEqual(m.predecessor_ref, ["evidence_id", "envelope_digest"]) ||
      !isNonEmptyString(m.predecessor_ref.evidence_id) || !isNonEmptyString(m.predecessor_ref.envelope_digest)) {
    errors.push("predecessor_ref must be an exact { evidence_id, envelope_digest }");
  }
  if (!CLASSIFICATIONS.includes(m.from_classification)) errors.push("from_classification invalid");
  if (!isContractClass(m.from_classification)) errors.push("from_classification must be a CONTRACT_* member");
  if (!CLASSIFICATIONS.includes(m.to_classification)) errors.push("to_classification invalid");

  const draft = m.descendant_draft;
  if (!keysEqual(draft, ["evidence_kind", "subject_bindings", "claim"])) {
    errors.push("descendant_draft must carry exactly evidence_kind, subject_bindings, claim");
    return fail(errors);
  }
  if (draft.evidence_kind !== "IMPROVEMENT_FINDING") errors.push("descendant_draft.evidence_kind must be IMPROVEMENT_FINDING");
  if (!Array.isArray(draft.subject_bindings) || draft.subject_bindings.length === 0) {
    errors.push("descendant_draft.subject_bindings must be a non-empty array");
    return fail(errors);
  }
  const claim = draft.claim;
  // I6 (§7): the governed material may carry EXACTLY the one predecessor its authority named.
  const supersedes = claim?.supersedes;
  if (!Array.isArray(supersedes) || supersedes.length !== 1) {
    errors.push("descendant_draft.claim.supersedes must be exactly one exact ref (invariant I6)");
  } else if (supersedes[0]!.evidence_id !== m.predecessor_ref.evidence_id || supersedes[0]!.envelope_digest !== m.predecessor_ref.envelope_digest) {
    errors.push("descendant_draft.claim.supersedes[0] must equal predecessor_ref exactly");
  }
  if (!isNonEmptyString(claim?.correction_reason)) errors.push("descendant_draft.claim.correction_reason is mandatory");
  if (claim?.classification !== m.to_classification) errors.push("to_classification must equal the draft classification");

  const draftPrimary = draft.subject_bindings[claim?.subject?.binding_index ?? -1];
  if (draftPrimary === undefined) {
    errors.push("descendant_draft.claim.subject.binding_index does not resolve");
  } else if (jcs(subjectTuple(draftPrimary)) !== jcs(m.to_subject)) {
    errors.push("to_subject must equal the descendant draft's normalized primary subject binding");
  }

  // Per-kind rules (§6.4): a reclassification crosses the boundary and preserves the subject; a
  // transfer moves the subject and preserves the class. One edge never does both (I3).
  if (m.transition_kind === "RECLASSIFICATION") {
    if (isContractClass(m.to_classification)) errors.push("RECLASSIFICATION must leave the CONTRACT_* classes");
    if (jcs(m.to_subject) !== jcs(m.from_subject)) errors.push("RECLASSIFICATION must preserve the exact primary subject (I1)");
  } else if (m.transition_kind === "SUBJECT_TRANSFER") {
    if (m.to_classification !== m.from_classification) errors.push("SUBJECT_TRANSFER must preserve the classification");
    if (jcs(m.to_subject) === jcs(m.from_subject)) errors.push("SUBJECT_TRANSFER must actually change the subject");
  }

  if (predecessor !== undefined) {
    if (predecessor.evidence_id !== m.predecessor_ref.evidence_id || predecessor.envelope_digest.value !== m.predecessor_ref.envelope_digest) {
      errors.push("predecessor_ref does not name the supplied predecessor envelope exactly");
    }
    if (predecessor.claim.classification !== m.from_classification) errors.push("from_classification must equal the predecessor's classification");
    const fp = primaryBinding(predecessor);
    if (fp === undefined || jcs(subjectTuple(fp)) !== jcs(m.from_subject)) {
      errors.push("from_subject must equal the predecessor's normalized primary subject binding");
    }
  }
  return fail(errors);
}

// ---------------------------------------------------------------- the derivation closure

/**
 * `derived_draft(F, A, r)` (§6.5) — a TOTAL function of the resolved predecessor envelope, the
 * resolved observation and the uniquely matched, well-formed active rule. For the deterministic
 * family the descendant draft is not composed by a caller at all; `authority_applicable`
 * requires the material's draft to equal this object exactly, so exactly one draft is admissible
 * per (F, A, active policy) and the winner's content is always the authorized content.
 *
 * Totality is against the landed VALIDATOR, not merely the landed shape: every free string comes
 * from `r`, and `wellFormedRule` forbids every value `validateFindingClaim` rejects.
 */
export function derivedDraft(input: {
  predecessor: { subject_bindings: readonly SubjectBinding[]; claim: ImprovementFindingClaimV1 };
  observation: EvidenceRef;
  applies_to: AuthorityApplicabilityV1;
  rule: AuthorityTextRuleV1;
}): GovernedDescendantDraftV1 {
  const { predecessor, observation, applies_to, rule } = input;
  const index = predecessor.claim.subject.binding_index;
  const subject_bindings = predecessor.subject_bindings.map((b, i) =>
    (i === index ? (applies_to.to_subject as unknown as SubjectBinding) : b));
  const basis = [{ evidence_id: observation.evidence_id, envelope_digest: observation.envelope_digest, role: "AUTHORITY_TEXT" as const }];
  const primary = subject_bindings[index]!;
  const claim: ImprovementFindingClaimV1 = {
    contract_id: CONTRACT_ID,
    classification: applies_to.to_classification,
    subject: { kind: applies_to.to_subject_kind, binding_index: index },
    basis,
    derivation: { kind: "DETERMINISTIC_DERIVATION", method_ref: rule.method.method_ref, method_digest: rule.method.method_digest },
    anomaly_code: rule.derived_anomaly_code,
    occurrence_key: deriveOccurrenceKey({
      primary_subject_binding: primary,
      anomaly_code: rule.derived_anomaly_code,
      basis,
      method_ref: rule.method.method_ref,
      method_digest: rule.method.method_digest,
    }),
    statement: { summary: rule.derived_statement.summary },
    supersedes: [applies_to.predecessor_ref],
    correction_reason: rule.derived_correction_reason,
  };
  return { evidence_kind: "IMPROVEMENT_FINDING", subject_bindings, claim };
}

/**
 * `subject_kind_conformance` (§6.5, round-11 S11-1): the landed mutable-subject rule
 * (`contracts.ts` — a non-`EVIDENCE` kind needs an exact revision or content digest) carried
 * into the closure. A RECLASSIFICATION reuses F's own (kind, binding) pair, which F was already
 * validated against; a SUBJECT_TRANSFER introduces a binding F never carried, so the rule is
 * checked directly.
 */
export function subjectKindConformant(input: {
  transition_kind: TransitionKind;
  to_subject_kind: SubjectKind;
  to_subject: SubjectTuple;
  predecessor_subject_kind: SubjectKind;
}): boolean {
  if (!SUBJECT_KINDS.includes(input.to_subject_kind)) return false;
  if (input.transition_kind === "RECLASSIFICATION") return input.to_subject_kind === input.predecessor_subject_kind;
  if (IMMUTABLE_SUBJECT_KINDS.includes(input.to_subject_kind)) return true;
  return input.to_subject.revision_or_version !== undefined || input.to_subject.content_digest !== undefined;
}

// ---------------------------------------------------------------- composition helpers

/** Compose the K3 material for a governed transition; `idempotency_key` is effect-bound (§4). */
export function buildGovernedTransitionMaterial(input: {
  effect_id: string;
  transition_kind: TransitionKind;
  predecessor: EvidenceEnvelopeV1;
  descendant_draft: GovernedDescendantDraftV1;
}): GovernedTransitionMaterialV1 {
  const fClaim = input.predecessor.claim as ImprovementFindingClaimV1;
  const fPrimary = input.predecessor.subject_bindings[fClaim.subject.binding_index]!;
  const dPrimary = input.descendant_draft.subject_bindings[input.descendant_draft.claim.subject.binding_index]!;
  return {
    contract_id: CONTRACT_ID,
    idempotency_key: `cadp-v04:${input.effect_id}`,
    transition_kind: input.transition_kind,
    predecessor_ref: { evidence_id: input.predecessor.evidence_id, envelope_digest: input.predecessor.envelope_digest.value },
    from_classification: fClaim.classification,
    to_classification: input.descendant_draft.claim.classification,
    from_subject: subjectTuple(fPrimary),
    to_subject: subjectTuple(dPrimary),
    descendant_draft: input.descendant_draft,
  };
}

/** The target-native receipt field the §5.1 receipt-binding rule uses: a function of the material. */
export function draftDigest(draft: GovernedDescendantDraftV1): string {
  return jcsDigest({ evidence_kind: draft.evidence_kind, subject_bindings: draft.subject_bindings, claim: draft.claim }).value;
}

/** The governed-edge key T(F) (§6.6), derived by the store from the draft's OWN supersedes singleton. */
export function governedEdgeKey(claim: unknown): { evidence_id: string; envelope_digest: string } | undefined {
  const supersedes = (claim as { supersedes?: unknown } | undefined)?.supersedes;
  if (!Array.isArray(supersedes) || supersedes.length !== 1) return undefined;
  const only = supersedes[0] as { evidence_id?: unknown; envelope_digest?: unknown };
  if (!isNonEmptyString(only?.evidence_id) || !isNonEmptyString(only?.envelope_digest)) return undefined;
  return { evidence_id: only.evidence_id, envelope_digest: only.envelope_digest };
}

export { FINDING_CLAIM_SCHEMA, sha256Hex };
