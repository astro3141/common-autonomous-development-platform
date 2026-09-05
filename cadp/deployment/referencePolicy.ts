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

# every predecessor id referenced by any presented finding's supersedes[], resolved or not — used
# only to materialize missing ancestry graph nodes so an unresolved/omitted predecessor can never
# vanish from ancestry() (#109 E1). This is NOT authority to treat the predecessor as superseded.
all_referenced_predecessor_ids contains pid if {
	some e in improvement_findings
	some s in object.get(e.claim, "supersedes", [])
	pid := s.evidence_id
}

# a finding id is superseded only if some provided finding presents a *resolved* reference to it
# (exact id+digest match, #109 E2). An id-only reference with a mismatched digest does not
# supersede anything: the referenced predecessor must remain a leaf so occurrence_conflict still
# sees it (review repair finding 1).
superseded_ids contains pid if {
	some e in improvement_findings
	some s in object.get(e.claim, "supersedes", [])
	supersedes_ref_resolved(s)
	pid := s.evidence_id
}

leaf(id) if not superseded_ids[id]

# supersession graph among provided findings: child -> {predecessor ids}
finding_graph[fid] := ns if {
	some e in improvement_findings
	fid := e.evidence_id
	ns := {s.evidence_id | some s in object.get(e.claim, "supersedes", [])}
}

# #109 S2: a referenced predecessor absent from input.evidence must NOT vanish from the graph
# (graph.reachable drops non-key neighbours). Materialize it as an empty node so ancestry()
# reaches it and the unresolvable-ancestor fail-closed clause below fires.
finding_graph[pid] := ns if {
	all_referenced_predecessor_ids[pid]
	not finding_by_id(pid)
	ns := set()
}

ancestry(tip_id) := graph.reachable(finding_graph, {tip_id})

# a valid AUTHORITY_RESOLUTION naming exactly this tip clears its contract class
authority_resolution_names(cid) if {
	some e in input.evidence
	e.evidence_kind == "IMPROVEMENT_FINDING_RESOLUTION"
	e.availability == "PRESENT"
	e.claim.resolution_kind == "AUTHORITY_RESOLUTION"
	e.claim.finding_tip_ref.evidence_id == cid
}

# #109 S2 (E2): a supersedes reference is resolved only by the exact presented predecessor
# envelope — id AND digest. An id-only match is unresolved.
supersedes_ref_resolved(s) if {
	some e in improvement_findings
	e.evidence_id == s.evidence_id
	e.envelope_digest.value == s.envelope_digest
}

# §3 reclassification: a non-CONTRACT_* descendant that supersedes C via HUMAN_JUDGMENT, or via
# DETERMINISTIC_DERIVATION whose basis binds AUTHORITY_TEXT. MODEL_PROPOSAL can NEVER clear.
# A clearing reference must bind the exact predecessor envelope (#109 E2).
reclassified_clear(cid) if {
	some e in improvement_findings
	some s in object.get(e.claim, "supersedes", [])
	s.evidence_id == cid
	supersedes_ref_resolved(s)
	not is_contract_class(e.claim.classification)
	e.claim.derivation.kind == "HUMAN_JUDGMENT"
}

reclassified_clear(cid) if {
	some e in improvement_findings
	some s in object.get(e.claim, "supersedes", [])
	s.evidence_id == cid
	supersedes_ref_resolved(s)
	not is_contract_class(e.claim.classification)
	e.claim.derivation.kind == "DETERMINISTIC_DERIVATION"
	some b in e.claim.basis
	b.role == "AUTHORITY_TEXT"
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

# #109 S2 (E1/E2): every supersedes reference anywhere in the ancestry must resolve to the exact
# presented predecessor envelope; an unresolvable reference is fail-closed.
contract_barrier(tip_id) if {
	some cid in ancestry(tip_id)
	e := finding_by_id(cid)
	some s in object.get(e.claim, "supersedes", [])
	not supersedes_ref_resolved(s)
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

# A binding is clear only when it resolves to a presented envelope by exact
# id+digest AND that finding is implementation-clear; non-finding bindings pass.
finding_binding_clear(wb) if wb.namespace != "improvement-finding"

finding_binding_clear(wb) if {
	wb.namespace == "improvement-finding"
	f := finding_by_id(wb.object_id)
	f.envelope_digest.value == wb.content_digest.value
	implementation_clear(wb.object_id)
}

# every bound improvement-finding must be clear — one clean co-bound Finding
# must not mask an ancestry-incomplete or barred one (fail-closed, #109 E1).
intake_binding_implementation_clear if {
	every wb in req.work_bindings {
		finding_binding_clear(wb)
	}
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
    ...input.paramOverrides,
  };
  return buildPolicyBundle({
    policy_id: input.policy_id,
    revision: input.revision,
    rego: input.rego ?? REFERENCE_REGO,
    data: { cadp, policy_params },
  });
}
