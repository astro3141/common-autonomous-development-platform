/**
 * Reference policy content (TD §5, §8.3, §13): the OPA bundle IS the policy. This module
 * builds the reference rego + `data.cadp` kernel config + rego-private `data.policy_params`.
 * Everything here is deployment composition, not kernel authority.
 */

import { buildPolicyBundle } from "../kernel/policyBundle.ts";
import type { KernelConfig } from "../kernel/policyBundle.ts";

export const REFERENCE_REGO = `package cadp.admission

revision_echo := data.system.bundles["cadp"].manifest.revision

params := data.policy_params

op := input.effect_request.operation_kind
mat := input.effect_material
req := input.effect_request

# ---------------------------------------------------------------- helpers

ptr_value(obj, pointer) := object.get(obj, [s | some s in split(pointer, "/"); s != ""], null)

registry_entry(producer) := entry if {
	some entry in data.cadp.identity_registry
	entry.producer_ref == producer
}

adapter_entry(producer) := entry if {
	some entry in data.cadp.adapter_registry
	entry.producer_ref == producer
}

# S1 derivation: pure function of the K2 envelope + the active adapter registry (TD 9.1).
source_authoritative(e) if {
	a := adapter_entry(e.producer_ref)
	a.produced_at_source.kind == "SOURCE"
	e.availability == "PRESENT"
	ptr_value(e.claim, a.produced_at_source.claim_pointer) == e.produced_at
}

implementer_refs contains p if {
	some e in input.evidence
	e.evidence_kind == "WORK_STEP"
	p := e.producer_ref
}

verification_ok(sha) if {
	some e in input.evidence
	e.evidence_kind == "VERIFICATION"
	e.availability == "PRESENT"
	some b in e.subject_bindings
	b.namespace == "commit"
	b.object_id == sha
	e.claim.conclusion == "success"
	source_authoritative(e)
}

# C41 leg 1: the REVIEW subject must equal the exact candidate the sealed material names.
review_ok(sha) if {
	some e in input.evidence
	e.evidence_kind == "REVIEW"
	e.availability == "PRESENT"
	some b in e.subject_bindings
	b.namespace == "commit"
	b.object_id == sha
	e.claim.verdict == "APPROVE"
	entry := registry_entry(e.producer_ref)
	not implementer_refs[e.producer_ref]
	independent_product(entry)
}

# S2 derivation + independence predicate (TD 8.4): product class must differ from every implementer.
independent_product(entry) if {
	every p in implementer_refs {
		registry_entry(p).identity_class.product != entry.identity_class.product
	}
}

backend_model_present if {
	some e in input.evidence
	e.evidence_kind == "BACKEND_EXECUTION"
	e.availability == "PRESENT"
	e.claim.observed.model.availability == "PRESENT"
}

backend_effort_present if {
	some e in input.evidence
	e.evidence_kind == "BACKEND_EXECUTION"
	e.availability == "PRESENT"
	e.claim.observed.effort.availability == "PRESENT"
}

effort_requirement_met if not params.require_backend_effort

effort_requirement_met if backend_effort_present

# 9.3: exact pre-sealed scope; the PEP re-verifies at 4.4 #5.
human_ok if {
	some e in input.evidence
	e.evidence_kind == "HUMAN_DECISION"
	e.availability == "PRESENT"
	e.claim.decision == "APPROVE"
	e.claim.scope.effect_id == req.effect_id
	e.claim.scope.material_digest == req.material_digest.value
}

has_work_run if {
	some wb in req.work_bindings
	wb.namespace == "work-run"
}

# ---------------------------------------------------------------- outcomes

default outcome := "DENY"

# Plain GIT_PUSH / RECORD_WRITE are allowed only when they are NOT an intake effect bound to a
# Finding whose tip is not implementation-clear (cadp.improvement-intake.v1 §8, controls 8/16).
outcome := "ALLOW" if {
	op in {"GIT_PUSH", "RECORD_WRITE"}
	not intake_nonindex_denied
}

# A WORK_START not carrying intake finding_admission keeps the plain allow; an intake
# implementation WORK_START is gated by the finding predicates below.
outcome := "ALLOW" if {
	op == "WORK_START"
	not is_intake_workstart
}

outcome := "ALLOW" if {
	op == "WORK_START"
	is_intake_workstart
	intake_workstart_ok
}

outcome := "ALLOW" if op in params.extra_plain_allow_operations

pr_create_ok if {
	op == "PR_CREATE"
	verification_ok(mat.head_sha)
	review_ok(mat.head_sha)
	backend_model_present
	effort_requirement_met
}

outcome := "ALLOW" if {
	pr_create_ok
	not intake_nonindex_denied
}

merge_base_ok if {
	op == "PR_MERGE"
	verification_ok(mat.expected_head_sha)
	review_ok(mat.expected_head_sha)
}

outcome := "ALLOW" if {
	merge_base_ok
	human_ok
	not intake_nonindex_denied
}

outcome := "REQUIRE_EVIDENCE" if {
	merge_base_ok
	not human_ok
	not intake_nonindex_denied
}

outcome := "ALLOW" if {
	op == "POLICY_ACTIVATE"
	human_ok
	not intake_nonindex_denied
}

outcome := "REQUIRE_EVIDENCE" if {
	op == "POLICY_ACTIVATE"
	not human_ok
	not intake_nonindex_denied
}

# cadp.improvement-intake.v1 index-only projection (Option A, §6): the SOLE exception to the
# unresolved-CONTRACT_* mutation prohibition.
outcome := "ALLOW" if finding_project_ok

# ---------------------------------------------------------------- reasons

reason_codes contains "verification_missing_or_unbound" if {
	op == "PR_CREATE"
	not verification_ok(mat.head_sha)
}

reason_codes contains "verification_missing_or_unbound" if {
	op == "PR_MERGE"
	not verification_ok(mat.expected_head_sha)
}

reason_codes contains "review_missing_or_wrong_subject" if {
	op == "PR_CREATE"
	not review_ok(mat.head_sha)
}

reason_codes contains "review_missing_or_wrong_subject" if {
	op == "PR_MERGE"
	not review_ok(mat.expected_head_sha)
}

reason_codes contains "reviewer_is_the_implementer" if {
	some e in input.evidence
	e.evidence_kind == "REVIEW"
	implementer_refs[e.producer_ref]
}

reason_codes contains "reviewer_product_not_independent" if {
	some e in input.evidence
	e.evidence_kind == "REVIEW"
	entry := registry_entry(e.producer_ref)
	not independent_product(entry)
}

reason_codes contains "required_fact_unknown" if {
	op == "PR_CREATE"
	not backend_model_present
}

reason_codes contains "required_fact_unknown" if {
	op == "PR_CREATE"
	not effort_requirement_met
}

reason_codes contains "HUMAN_DECISION" if {
	merge_base_ok
	not human_ok
}

reason_codes contains "HUMAN_DECISION" if {
	op == "POLICY_ACTIVATE"
	not human_ok
}

# ---------------------------------------------------------------- constraints

constraints contains {"kind": "EVIDENCE_MAX_AGE", "args": ["VERIFICATION", params.verification_max_age_s]} if {
	op in {"PR_CREATE", "PR_MERGE"}
}

constraints contains {"kind": "MAX_EFFECTS_IN_WORK_RUN", "args": [params.max_effects_cap]} if has_work_run

constraints contains {"kind": "NOT_AFTER", "args": [mat.bounds.deadline]} if {
	op == "WORK_START"
	mat.bounds.deadline
}

# ================================================================ cadp.improvement-intake.v1 (#104)
# Mandatory intake predicates over the immutable IMPROVEMENT_FINDING / _RESOLUTION K2 envelopes
# resolved into input.evidence. The generic allow-list above is NOT this contract; these gate the
# effects. A Finding, tracker state, model output, or workflow label is never authority by itself.

contract_classes := {"CONTRACT_GAP", "CONTRACT_AMBIGUITY", "CONTRACT_CONTRADICTION"}

is_contract_class(c) if c in contract_classes

# every PRESENT IMPROVEMENT_FINDING in this admission input
improvement_findings contains e if {
	some e in input.evidence
	e.evidence_kind == "IMPROVEMENT_FINDING"
	e.availability == "PRESENT"
}

finding_by_id(id) := e if {
	some e in improvement_findings
	e.evidence_id == id
}

# Resolve a claim-internal evidence ref only through the exact K4-bound K2 envelope. A role string,
# id alone, display locator, or mismatching digest is never a resolved basis (#107 / Review B18).
evidence_by_exact_ref(ref) := e if {
	some e in input.evidence
	e.evidence_id == ref.evidence_id
	e.envelope_digest.value == ref.envelope_digest
}

# a finding id is superseded if some provided finding names it in supersedes[]
superseded_ids contains pid if {
	some e in improvement_findings
	some s in object.get(e.claim, "supersedes", [])
	pid := s.evidence_id
}

leaf(id) if not superseded_ids[id]

# supersession graph among provided findings: child -> {predecessor ids}
finding_graph[fid] := ns if {
	some e in improvement_findings
	fid := e.evidence_id
	ns := {s.evidence_id | some s in object.get(e.claim, "supersedes", [])}
}

ancestry(tip_id) := graph.reachable(finding_graph, {tip_id})

# a valid AUTHORITY_RESOLUTION naming exactly this tip clears its contract class
authority_resolution_names(cid) if {
	fc := finding_by_id(cid)
	some e in input.evidence
	e.evidence_kind == "IMPROVEMENT_FINDING_RESOLUTION"
	e.availability == "PRESENT"
	e.claim.resolution_kind == "AUTHORITY_RESOLUTION"
	e.claim.finding_tip_ref.evidence_id == cid
	e.claim.finding_tip_ref.envelope_digest == fc.envelope_digest.value
}

# A Human reclassification basis must resolve to a PRESENT, authenticated HUMAN_DECISION bound to
# the exact predecessor Finding. This preserves the valid Human path without trusting a derivation
# label or an absent/mismatched basis envelope.
human_reclassification_basis(e, fc) if {
	some b in e.claim.basis
	authority := evidence_by_exact_ref(b)
	authority.evidence_kind == "HUMAN_DECISION"
	authority.availability == "PRESENT"
	authority.provenance.integrity in {"AUTHENTICATED_SOURCE", "SIGNED_ATTESTATION"}
	some subject in authority.subject_bindings
	subject.authority_ref == "cadp-store:k04"
	subject.namespace == "improvement-finding"
	subject.object_id == fc.evidence_id
	subject.content_digest.value == fc.envelope_digest.value
}

# A deterministic authority-text transition is an exact active-policy rule, not a claim-authored
# role. The cited pair must resolve in this admission, and the resolved K2 envelope must match every
# authority identity/provenance/method/transition field in one policy rule.
deterministic_authority_basis(e, fc) if {
	e.claim.derivation.kind == "DETERMINISTIC_DERIVATION"
	some b in e.claim.basis
	b.role == "AUTHORITY_TEXT"
	authority := evidence_by_exact_ref(b)
	authority.availability == "PRESENT"
	some rule in object.get(params, "authority_text_rules", [])
	authority.evidence_kind == rule.evidence_kind
	authority.claim_schema == rule.claim_schema
	authority.producer_ref == rule.producer_ref
	authority.provenance.source_relation == rule.source_relation
	authority.provenance.integrity == rule.integrity
	some subject in authority.subject_bindings
	subject == rule.subject_binding
	e.claim.derivation.method_ref == rule.method_ref
	e.claim.derivation.method_digest == rule.method_digest
	fc.claim.classification == rule.from_classification
	e.claim.classification == rule.to_classification
}

# §3 reclassification: a non-CONTRACT_* descendant that supersedes the exact C digest via a bound
# HUMAN_JUDGMENT, or via a policy-declared deterministic authority rule. MODEL_PROPOSAL never clears.
reclassified_clear(cid) if {
	fc := finding_by_id(cid)
	some e in improvement_findings
	some s in object.get(e.claim, "supersedes", [])
	s.evidence_id == cid
	s.envelope_digest == fc.envelope_digest.value
	not is_contract_class(e.claim.classification)
	e.claim.derivation.kind == "HUMAN_JUDGMENT"
	human_reclassification_basis(e, fc)
}

reclassified_clear(cid) if {
	fc := finding_by_id(cid)
	some e in improvement_findings
	some s in object.get(e.claim, "supersedes", [])
	s.evidence_id == cid
	s.envelope_digest == fc.envelope_digest.value
	not is_contract_class(e.claim.classification)
	deterministic_authority_basis(e, fc)
}

cleared(cid) if authority_resolution_names(cid)
cleared(cid) if reclassified_clear(cid)

# contract_barrier(F): an uncleared CONTRACT_* ancestor, OR an ancestor we cannot even resolve
# (inability to prove the complete ancestry is fail-closed).
contract_barrier(tip_id) if {
	some cid in ancestry(tip_id)
	fc := finding_by_id(cid)
	is_contract_class(fc.claim.classification)
	not cleared(cid)
}

contract_barrier(tip_id) if {
	some cid in ancestry(tip_id)
	not finding_by_id(cid)
}

# another current leaf shares this finding's occurrence_key => SUPERSESSION_CONFLICT (§4)
occurrence_conflict(id) if {
	f := finding_by_id(id)
	some e in improvement_findings
	e.evidence_id != id
	leaf(e.evidence_id)
	e.claim.occurrence_key == f.claim.occurrence_key
}

implementation_clear(id) if {
	fc := finding_by_id(id)
	not is_contract_class(fc.claim.classification)
	not contract_barrier(id)
}

# ---- intake implementation WORK_START (§4, §7, §8) ----

fa := mat.finding_admission

is_intake_workstart if {
	op == "WORK_START"
	mat.finding_admission
}

# every declared tracker-derived external input carries exact revision/digest + observation (§7, control 13)
external_input_valid(inp) if {
	has_rev(inp)
	some e in input.evidence
	e.availability == "PRESENT"
	e.evidence_id == inp.observation_ref
	some b in e.subject_bindings
	b.authority_ref == inp.authority_ref
	b.object_id == inp.object_id
}

has_rev(inp) if inp.revision_or_version
has_rev(inp) if inp.content_digest

external_inputs_ok if {
	every inp in object.get(fa, "external_inputs", []) {
		external_input_valid(inp)
	}
}

# work_bindings contain exactly the tip finding_ref (evidence_id + envelope_digest) (§4.3)
work_binding_exact(id, dig) if {
	some wb in req.work_bindings
	wb.namespace == "improvement-finding"
	wb.object_id == id
	wb.content_digest.value == dig
}

intake_workstart_ok if {
	fa.purpose == "IMPLEMENTATION"
	tip := finding_by_id(fa.finding_ref.evidence_id)
	tip.envelope_digest.value == fa.finding_ref.envelope_digest
	not is_contract_class(tip.claim.classification)
	not contract_barrier(fa.finding_ref.evidence_id)
	leaf(fa.finding_ref.evidence_id)
	not occurrence_conflict(fa.finding_ref.evidence_id)
	fa.conflict_complete == true
	work_binding_exact(fa.finding_ref.evidence_id, fa.finding_ref.envelope_digest)
	external_inputs_ok
}

# ---- non-index mutation containment (§8, controls 8/16) ----

nonindex_mutations := {"GIT_PUSH", "RECORD_WRITE", "PR_CREATE", "PR_MERGE", "POLICY_ACTIVATE"}

intake_binding_present if {
	some wb in req.work_bindings
	wb.namespace == "improvement-finding"
}

intake_binding_implementation_clear if {
	some wb in req.work_bindings
	wb.namespace == "improvement-finding"
	f := finding_by_id(wb.object_id)
	f.envelope_digest.value == wb.content_digest.value
	implementation_clear(wb.object_id)
}

intake_nonindex_denied if {
	op in nonindex_mutations
	intake_binding_present
	not intake_binding_implementation_clear
}

# ---- FINDING_PROJECT (Option A, §6) ----

unresolved_contract(id) if {
	fc := finding_by_id(id)
	is_contract_class(fc.claim.classification)
	not authority_resolution_names(id)
}

projection_purpose_ok if mat.purpose in {"CREATE_INDEX", "APPEND_OCCURRENCE"}

projection_purpose_ok if {
	mat.purpose == "APPEND_RESOLUTION"
	not unresolved_contract(mat.finding_ref.evidence_id)
}

finding_project_ok if {
	op == "FINDING_PROJECT"
	tip := finding_by_id(mat.finding_ref.evidence_id)
	tip.envelope_digest.value == mat.finding_ref.envelope_digest
	leaf(mat.finding_ref.evidence_id)
	not occurrence_conflict(mat.finding_ref.evidence_id)
	projection_purpose_ok
}

# ---- reason codes ----

reason_codes contains "contract_barrier" if {
	is_intake_workstart
	contract_barrier(fa.finding_ref.evidence_id)
}

reason_codes contains "finding_tip_is_contract_class" if {
	is_intake_workstart
	tip := finding_by_id(fa.finding_ref.evidence_id)
	is_contract_class(tip.claim.classification)
}

reason_codes contains "supersession_conflict" if {
	is_intake_workstart
	occurrence_conflict(fa.finding_ref.evidence_id)
}

reason_codes contains "finding_tip_superseded" if {
	is_intake_workstart
	not leaf(fa.finding_ref.evidence_id)
}

reason_codes contains "conflict_completeness_unproven" if {
	is_intake_workstart
	not fa.conflict_complete == true
}

reason_codes contains "tracker_input_unbound" if {
	is_intake_workstart
	not external_inputs_ok
}

reason_codes contains "finding_ref_binding_mismatch" if {
	is_intake_workstart
	not work_binding_exact(fa.finding_ref.evidence_id, fa.finding_ref.envelope_digest)
}

reason_codes contains "contract_barrier_nonindex_denied" if intake_nonindex_denied

reason_codes contains "append_resolution_before_authority" if {
	op == "FINDING_PROJECT"
	mat.purpose == "APPEND_RESOLUTION"
	unresolved_contract(mat.finding_ref.evidence_id)
}
`;

export interface ReferenceIdentity {
  readonly principal: string;
  readonly producer_ref: string;
  readonly identity_class: { vendor: string; product: string; account: string; process_class: string };
}

export interface ReferencePolicyInput {
  readonly policy_id: string;
  readonly revision: number;
  readonly root_public_keys: KernelConfig["root_public_keys"];
  readonly identity_registry?: KernelConfig["identity_registry"];
  readonly adapter_registry?: KernelConfig["adapter_registry"];
  readonly configOverrides?: Partial<KernelConfig>;
  readonly paramOverrides?: Record<string, unknown>;
  readonly rego?: string;
}

export const REFERENCE_IDENTITIES: KernelConfig["identity_registry"] = [
  { principal: "cadp-workflow", producer_ref: "workflow:cadp-work", identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" } },
  { principal: "cadp-worker-codex", producer_ref: "worker:codex-cli", identity_class: { vendor: "openai", product: "codex-cli", account: "cadp-v04", process_class: "worker" } },
  { principal: "cadp-backend-scan", producer_ref: "backend-scan:codex", identity_class: { vendor: "openai", product: "codex-cli", account: "cadp-v04", process_class: "evidence-adapter" } },
  { principal: "cadp-reviewer-claude", producer_ref: "reviewer:claude-code", identity_class: { vendor: "anthropic", product: "claude-code", account: "cadp-v04", process_class: "worker" } },
  { principal: "cadp-verifier", producer_ref: "verifier:harness", identity_class: { vendor: "cadp", product: "node-test-harness", account: "cadp-v04", process_class: "evidence-adapter" } },
  { principal: "sso:a.t.laplace@gmail.com", producer_ref: "human:astro3141", identity_class: { vendor: "github", product: "human", account: "astro3141", process_class: "human-surface" } },
  { principal: "cadp-depctl-probe", producer_ref: "deployment-control-probe", identity_class: { vendor: "cadp", product: "deployment-control", account: "cadp-v04", process_class: "deployment-control" } },
  { principal: "cadp-depctl-target", producer_ref: "deployment-control-target", identity_class: { vendor: "cadp", product: "deployment-control", account: "cadp-v04", process_class: "deployment-control" } },
  // cadp.improvement-intake.v1 (#104): the sole registered producer of IMPROVEMENT_FINDING /
  // IMPROVEMENT_FINDING_RESOLUTION. The product adapter validates the claim contract before submit.
  { principal: "cadp-improvement-intake", producer_ref: "intake:cadp-improvement", identity_class: { vendor: "cadp", product: "improvement-intake", account: "cadp-v04", process_class: "evidence-adapter" } },
];

export const REFERENCE_ADAPTERS: KernelConfig["adapter_registry"] = [
  { producer_ref: "workflow:cadp-work", evidence_kinds: ["WORK_STEP", "WORK_BOUND_STOP"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" } },
  { producer_ref: "backend-scan:codex", evidence_kinds: ["BACKEND_EXECUTION"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" } },
  { producer_ref: "verifier:harness", evidence_kinds: ["VERIFICATION"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "SOURCE", claim_pointer: "/completed_at" } },
  { producer_ref: "reviewer:claude-code", evidence_kinds: ["REVIEW"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" } },
  { producer_ref: "human:astro3141", evidence_kinds: ["HUMAN_DECISION"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" } },
  { producer_ref: "deployment-control-probe", evidence_kinds: ["CREDENTIAL_REACH_ATTESTATION"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" } },
  { producer_ref: "deployment-control-target", evidence_kinds: ["TARGET_IMMUTABILITY_ATTESTATION"], source_relation: "TARGET_AUTHORITY_OBSERVATION", produced_at_source: { kind: "NONE" } },
  { producer_ref: "intake:cadp-improvement", evidence_kinds: ["IMPROVEMENT_FINDING", "IMPROVEMENT_FINDING_RESOLUTION"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" } },
];

export function buildReferenceKernelConfig(input: ReferencePolicyInput): KernelConfig {
  return {
    schema: "cadp.kernel-config.v1",
    approved_digest_schemes: [
      { algorithm: "sha256", canonicalization: "raw-bytes-1" },
      { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
      { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1" },
    ],
    root_public_keys: input.root_public_keys,
    attestation_keys: [],
    identity_registry: input.identity_registry ?? REFERENCE_IDENTITIES,
    adapter_registry: input.adapter_registry ?? REFERENCE_ADAPTERS,
    allocation_purposes: ["work-start", "git-push", "pr-create", "pr-merge", "record-write", "policy-activate", "finding-project"],
    decision_ttl_s: 1800,
    dispatch_window_s: 120,
    identity_probe_max_age_s: 600,
    reach_attestation_max_age_s: 3600,
    target_immutability_attestation_max_age_s: 3600,
    reconcile_max_attempts: 20,
    reconcile_backoff_s: 30,
    pr_settle_window_s: 30,
    temporal_idempotency_horizon_s: 86400,
    cas_upload_max_bytes: 268435456,
    break_glass_max_lifetime_s: 3600,
    ...input.configOverrides,
  } as KernelConfig;
}

export function buildReferenceBundle(input: ReferencePolicyInput): Uint8Array {
  const cadp = buildReferenceKernelConfig(input);
  const policy_params = {
    verification_max_age_s: 3600,
    max_effects_cap: 1000,
    require_backend_effort: false,
    extra_plain_allow_operations: [],
    // Empty by default: a deployment must bind every deterministic CONTRACT_* reclassification
    // to one exact K2 authority observation + method + class transition. No ambient/latest text.
    authority_text_rules: [],
    ...input.paramOverrides,
  };
  return buildPolicyBundle({
    policy_id: input.policy_id,
    revision: input.revision,
    rego: input.rego ?? REFERENCE_REGO,
    data: { cadp, policy_params },
  });
}
