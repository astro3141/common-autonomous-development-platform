/**
 * Reference policy content (TD §5, §8.3, §13): the OPA bundle IS the policy. This module
 * builds the reference rego + `data.cadp` kernel config + rego-private `data.policy_params`.
 * Everything here is deployment composition, not kernel authority.
 */

import { buildPolicyBundle } from "../kernel/policyBundle.ts";
import type { KernelConfig } from "../kernel/policyBundle.ts";

/**
 * RFC 8785 (cadp-jcs-1) string serialization as a Rego rule. OPA's own `json.marshal` is NOT
 * JCS: it HTML-escapes `<`, `>` and `&` and emits `\\u0008`/`\\u000c` where RFC 8785 uses `\\b`
 * and `\\f`. The v1.1 derivation closure recomputes the landed `occurrence_key`, so the evaluator
 * needs the exact serializer — an ALLOW on the deterministic path must entail a sealable Finding
 * (#117 §10 item 2a site 20). The escape chain is generated so it cannot drift from
 * `JSON.stringify`, which implements exactly the RFC 8785 escape set.
 *
 * Order is load-bearing: the backslash is escaped first, so the backslashes introduced by every
 * later replacement are never re-escaped, and no later target can occur in text already emitted.
 */
const JCS_ESCAPES: ReadonlyArray<readonly [string, string]> = (() => {
  const pairs: Array<[string, string]> = [["\\", "\\\\"], ['"', '\\"']];
  for (let code = 0; code < 0x20; code += 1) {
    const ch = String.fromCharCode(code);
    pairs.push([ch, JSON.stringify(ch).slice(1, -1)]);
  }
  return pairs;
})();

const JCS_STRING_RULE: string = (() => {
  const quote = JSON.stringify('"');
  const lines = JCS_ESCAPES.map(
    ([raw, escaped], i) => `\te${i + 1} := replace(e${i}, ${JSON.stringify(raw)}, ${JSON.stringify(escaped)})`,
  );
  return [
    `jcs_string(s) := concat("", [${quote}, e${JCS_ESCAPES.length}, ${quote}]) if {`,
    "\te0 := s",
    ...lines,
    "}",
  ].join("\n");
})();

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

# FINDING_SEAL is the governed transition gate and is NEVER plain-allowed, whatever a deployment
# puts in extra_plain_allow_operations (#117 §6.4 containment).
outcome := "ALLOW" if {
	op in params.extra_plain_allow_operations
	op != "FINDING_SEAL"
}

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

# cadp.improvement-intake.v1 index-only projection (Option A, §6): the FIRST of the two exceptions
# to the unresolved-CONTRACT_* mutation prohibition.
outcome := "ALLOW" if finding_project_ok

# v1.1 governed transition sealing (#117 §6.4): the second and last exception. The two families
# are disjoint by the draft's single derivation kind, so ALLOW and REQUIRE_EVIDENCE never collide.
outcome := "ALLOW" if finding_seal_ok

outcome := "REQUIRE_EVIDENCE" if {
	finding_seal_base_ok
	seal_derivation_kind == "HUMAN_JUDGMENT"
	not human_ok
}

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

# Landed closed sets, read as-is and never extended (cadp/product/improvement/contracts.ts).
classifications := {
	"BUG", "IMPLEMENTATION_GAP", "BACKEND_GAP", "OPERABILITY_GAP",
	"CONTRACT_GAP", "CONTRACT_AMBIGUITY", "CONTRACT_CONTRADICTION", "NON_BLOCKING_NIT",
}

subject_kinds := {"WORK_RUN", "EFFECT", "EVIDENCE", "BACKEND", "TARGET", "PRODUCT_CONFORMANCE_PROOF"}

immutable_subject_kinds := {"EVIDENCE"}

transition_kinds := {"RECLASSIFICATION", "SUBJECT_TRANSFER"}

# Invariant P (#117 §5.2): a permanent constant of product contract v1.1, NOT registry content.
# Only the workload credential bound to it rotates, so every clearing predicate and uniqueness key
# is generation-independent and revocation is prospective only.
governed_producer_ref := "governed:reclassification"

intake_producer_ref := "intake:cadp-improvement"

nonempty_string(x) if {
	is_string(x)
	x != ""
}

# The normalized primary subject tuple both governed families bind (§4): exactly the five landed
# SubjectBinding fields, absent ones omitted.
subject_tuple(b) := object.filter(b, ["authority_ref", "namespace", "object_id", "revision_or_version", "content_digest"])

primary_binding(e) := b if {
	b := e.subject_bindings[e.claim.subject.binding_index]
}

# ---- evaluator-private v1.1 policy content (#117 §5, round-12 A1) ----
# Both tables are read ONLY by this evaluator, never by the Kernel Service, so they live outside
# the kernel-owned closed data.cadp schema, in the landed rego-private namespace. Absent
# namespace, absent table or non-array ⇒ the EMPTY set, which is also the default: fail closed.

default improvement_transition := {}

improvement_transition := t if {
	t := params.improvement_transition
	is_object(t)
}

default authority_text_rules := []

authority_text_rules := r if {
	r := improvement_transition.authority_text_rules
	is_array(r)
}

default landed_authority_resolutions := []

landed_authority_resolutions := r if {
	r := improvement_transition.landed_authority_resolutions
	is_array(r)
}

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

# #109 S2 (E2): a supersedes reference is resolved only by the exact presented predecessor
# envelope — id AND digest. An id-only match is unresolved.
supersedes_ref_resolved(s) if {
	some e in improvement_findings
	e.evidence_id == s.evidence_id
	e.envelope_digest.value == s.envelope_digest
}

# ---------------------------------------------------------------- v1.1 §10.4 AUTHORITY_RESOLUTION
# Bare-digest membership and the Human-decision variant are REMOVED (round-4 R4, round-5 R5-3):
# an untyped digest set let any intake-produced resolution clear ANY CONTRACT_* tip. The ACTIVE
# policy instead carries applicability-bearing entries, each Human-landed by POLICY_ACTIVATE and
# authorizing resolution of exactly ONE finding tip by exactly ONE landed content.

well_formed_resolution_entry(e) if {
	object.keys(e) == {"finding_ref", "authority_content_digest"}
	object.keys(e.finding_ref) == {"evidence_id", "envelope_digest"}
	nonempty_string(e.finding_ref.evidence_id)
	nonempty_string(e.finding_ref.envelope_digest)
	nonempty_string(e.authority_content_digest)
}

valid_authority_resolution(cid) if {
	fc := finding_by_id(cid)
	some entry in landed_authority_resolutions
	well_formed_resolution_entry(entry)
	entry.finding_ref.evidence_id == cid
	entry.finding_ref.envelope_digest == fc.envelope_digest.value
	some r in input.evidence
	r.evidence_kind == "IMPROVEMENT_FINDING_RESOLUTION"
	r.availability == "PRESENT"
	r.producer_ref == intake_producer_ref
	r.claim.resolution_kind == "AUTHORITY_RESOLUTION"
	r.claim.finding_tip_ref.evidence_id == cid
	r.claim.finding_tip_ref.envelope_digest == fc.envelope_digest.value
	r.claim.landed_authority_ref.authority_content_digest == entry.authority_content_digest
}

# ---------------------------------------------------------------- v1.1 §6.2 the durable clearing artifact
# What later admissions consume is an ordinary immutable IMPROVEMENT_FINDING envelope distinguished
# by KERNEL-STAMPED facts only — never by a lookup in the currently-active registry (round-9 R9-1),
# so revocation or rotation of the writer credential can never un-clear a completed edge. The
# landed v1.0 shape (a claim-authored AUTHORITY_TEXT basis role, or a bare intake HUMAN_JUDGMENT
# descendant) clears NOTHING in v1.1: that was Review B18.
governed_transition(d) if {
	d.evidence_kind == "IMPROVEMENT_FINDING"
	d.availability == "PRESENT"
	d.producer_ref == governed_producer_ref
	d.provenance.integrity == "AUTHENTICATED_SOURCE"
	d.claim.derivation.kind in {"HUMAN_JUDGMENT", "DETERMINISTIC_DERIVATION"}
}

# ---------------------------------------------------------------- v1.1 §6.3 edge/path-scoped barrier
# I6 (round-7 R7-1): a descendant resolves an entry only when its supersedes list is EXACTLY the
# single entry naming that predecessor. Containment matching let ONE authorized seal resolve every
# other CONTRACT_* finding the draft happened to list. This predicate reads the SEALED envelope's
# own list, so it holds at every later admission regardless of any seal-time check.
sole_predecessor(cid, d) if {
	ss := object.get(d.claim, "supersedes", [])
	count(ss) == 1
	ss[0].evidence_id == cid
	supersedes_ref_resolved(ss[0])
}

clearing_edge(cid, d) if {
	fc := finding_by_id(cid)
	sole_predecessor(cid, d)
	is_contract_class(fc.claim.classification)
	not is_contract_class(d.claim.classification)
	subject_tuple(primary_binding(d)) == subject_tuple(primary_binding(fc))
	governed_transition(d)
}

# Delegation form (a) CONTEXT_PRESERVING: ordinary intake, NO authority required — no context
# crosses, and whatever later clears the successor is bound to the same exact subject.
delegation_edge(cid, d) if {
	fc := finding_by_id(cid)
	sole_predecessor(cid, d)
	is_contract_class(fc.claim.classification)
	is_contract_class(d.claim.classification)
	subject_tuple(primary_binding(d)) == subject_tuple(primary_binding(fc))
}

# Delegation form (b) CONTEXT TRANSFER: a governed SUBJECT_TRANSFER whose authority named BOTH
# contexts. An UNAUTHORISED subject-changing supersession stays legal at intake and simply
# delegates nothing — the predecessor's obligation stands (round-6 R6-2).
delegation_edge(cid, d) if context_transfer_edge(cid, d)

context_transfer_edge(cid, d) if {
	fc := finding_by_id(cid)
	sole_predecessor(cid, d)
	is_contract_class(fc.claim.classification)
	is_contract_class(d.claim.classification)
	subject_tuple(primary_binding(d)) != subject_tuple(primary_binding(fc))
	governed_transition(d)
}

resolved_entry(cid, d) if clearing_edge(cid, d)

resolved_entry(cid, d) if delegation_edge(cid, d)

governed_resolver(cid, d) if clearing_edge(cid, d)

governed_resolver(cid, d) if context_transfer_edge(cid, d)

# Ambiguity (fail closed, defence-in-depth): §6.6's target-authoritative uniqueness makes this
# state unreachable for governed edges; it is retained as a graph-level backstop, NOT as the
# exclusivity mechanism (round-6 R6-1).
reclassification_ambiguous(cid) if {
	some d1 in improvement_findings
	some d2 in improvement_findings
	d1.evidence_id < d2.evidence_id
	governed_resolver(cid, d1)
	governed_resolver(cid, d2)
}

entry_resolved(cid, d) if {
	resolved_entry(cid, d)
	not reclassification_ambiguous(cid)
}

# contract_barrier(tip): (i) an unresolved supersession entry into a CONTRACT_* predecessor
# anywhere in the chain; (ii) the tip itself CONTRACT_*; (iii) ancestry that cannot even be
# resolved (fail closed, #109 E1/E2 retained verbatim).
contract_barrier(tip_id) if {
	some did in ancestry(tip_id)
	d := finding_by_id(did)
	some s in object.get(d.claim, "supersedes", [])
	fc := finding_by_id(s.evidence_id)
	is_contract_class(fc.claim.classification)
	not entry_resolved(s.evidence_id, d)
	not valid_authority_resolution(s.evidence_id)
}

contract_barrier(tip_id) if {
	tip := finding_by_id(tip_id)
	is_contract_class(tip.claim.classification)
	not valid_authority_resolution(tip_id)
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
	not valid_authority_resolution(id)
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

# ================================================================ v1.1 FINDING_SEAL (#117 §6.4–§6.6)
# The ONE governed transition gate. Sealing the boundary-crossing (or context-transferring)
# descendant is itself an admitted effect: its K3 material is the exact typed transition payload,
# the Human authorization is an ordinary landed effect-scoped HUMAN_DECISION over digest(M), and
# the deterministic authorization is an ACTIVE-policy rule plus a context-bound observation whose
# applicability names the exact predecessor, both subjects, the method and the work run.
#
# FINDING_SEAL is admissible while the barrier is up — it IS the resolution path — and is NEVER in
# any plain-allow set (the second and last exception to the unresolved-CONTRACT_* mutation DENY;
# the first is the Option-A index-only projection, unchanged).

is_finding_seal if op == "FINDING_SEAL"

seal_draft := mat.descendant_draft

seal_draft_primary := b if {
	b := seal_draft.subject_bindings[seal_draft.claim.subject.binding_index]
}

seal_supersedes := object.get(seal_draft.claim, "supersedes", [])

# E1: F resolves from input.evidence by EXACT id + envelope digest; absent or mismatched → DENY.
seal_predecessor := f if {
	is_finding_seal
	some f in improvement_findings
	f.evidence_id == mat.predecessor_ref.evidence_id
	f.envelope_digest.value == mat.predecessor_ref.envelope_digest
}

seal_predecessor_present if seal_predecessor.evidence_id

transition_kind_ok if mat.transition_kind in transition_kinds

work_run_binding_ids := [wb.object_id |
	some wb in req.work_bindings
	wb.namespace == "work-run"
]

# Round-10 R10-2: zero work-run bindings would make the deterministic run equality vacuous and two
# would turn it into a caller-selected disjunction. Checked for BOTH families.
#
# The predecessor's evidence binding is equally mandatory (§5.1): it is what makes the §5.4
# GOVERNED_SEAL_CONFLICT scope hold freeze further governed sealing against F. Enforcing it here —
# not only in the composing adapter — is what stops a caller from escaping that hold by omitting it.
transition_run_context_ok if {
	count(work_run_binding_ids) == 1
	some wb in req.work_bindings
	wb.namespace == "evidence"
	wb.object_id == mat.predecessor_ref.evidence_id
}

transition_shape_ok if {
	mat.contract_id == "cadp.improvement-intake.v1"
	seal_draft.evidence_kind == "IMPROVEMENT_FINDING"
	count(seal_supersedes) == 1
	seal_supersedes[0].evidence_id == mat.predecessor_ref.evidence_id
	seal_supersedes[0].envelope_digest == mat.predecessor_ref.envelope_digest
	mat.from_classification == seal_predecessor.claim.classification
	is_contract_class(mat.from_classification)
	mat.to_classification == seal_draft.claim.classification
	mat.from_subject == subject_tuple(primary_binding(seal_predecessor))
	mat.to_subject == subject_tuple(seal_draft_primary)
	nonempty_string(object.get(seal_draft.claim, "correction_reason", ""))
	transition_per_kind_ok
}

transition_per_kind_ok if {
	mat.transition_kind == "RECLASSIFICATION"
	not is_contract_class(mat.to_classification)
	mat.to_subject == mat.from_subject
}

transition_per_kind_ok if {
	mat.transition_kind == "SUBJECT_TRANSFER"
	mat.to_classification == mat.from_classification
	mat.to_subject != mat.from_subject
}

# Defence-in-depth ONLY: this reads the caller-selected evidence list and is therefore NOT the
# exclusivity mechanism — the store's invariant U on T(F) is (round-6 R6-1).
transition_conflict if {
	some d in improvement_findings
	governed_resolver(mat.predecessor_ref.evidence_id, d)
}

finding_seal_base_ok if {
	is_finding_seal
	seal_predecessor_present
	transition_kind_ok
	transition_shape_ok
	transition_run_context_ok
	not transition_conflict
}

seal_derivation_kind := seal_draft.claim.derivation.kind

finding_seal_ok if {
	finding_seal_base_ok
	seal_derivation_kind == "HUMAN_JUDGMENT"
	human_ok
}

finding_seal_ok if {
	finding_seal_base_ok
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	deterministic_authority_ok
}

# ---- §6.5 deterministic family: context-bound observation + the derivation closure ----

# (1) Resolve the observation UNIQUELY, never by disjunction: a multi-entry basis would make
# "some AUTHORITY_TEXT entry" a caller-selected choice of validator.
observation := a if {
	count(seal_basis) == 1
	seal_basis[0].role == "AUTHORITY_TEXT"
	some a in input.evidence
	a.evidence_id == seal_basis[0].evidence_id
	a.envelope_digest.value == seal_basis[0].envelope_digest
	a.availability == "PRESENT"
}

seal_basis := seal_draft.claim.basis

observation_resolved if observation.evidence_id

applies_to := observation.claim.applies_to

# (2) Select the rule keyed off the OBSERVATION, never off the presented draft: the draft is the
# object under validation and may not choose its own validator. Two matches DENY.
matching_rules := [r |
	some r in authority_text_rules
	r.transition_kind == applies_to.transition_kind
	r.from == applies_to.from_classification
	r.to == applies_to.to_classification
	r.method == applies_to.method
]

selected_rule := r if {
	count(matching_rules) == 1
	r := matching_rules[0]
}

# (2b) Well-formedness of the SELECTED rule, checked AFTER selection and never as a pre-filter
# (round-12 A1(c)): filtering malformed entries out first would silently skip a malformed twin and
# let the survivor win by evaluation order. Typed over the WHOLE rule (round-12 F1): an empty
# method component is reachable and produces a draft the landed validator rejects.
well_formed_rule(r) if {
	object.keys(r) == {
		"transition_kind", "from", "to", "method", "producer_ref", "evidence_kind",
		"claim_schema", "provenance", "authority_content_digest", "derived_anomaly_code",
		"derived_statement", "derived_correction_reason",
	}
	r.transition_kind in transition_kinds
	r.from in classifications
	r.to in classifications
	object.keys(r.method) == {"method_ref", "method_digest"}
	nonempty_string(r.method.method_ref)
	nonempty_string(r.method.method_digest)
	nonempty_string(r.producer_ref)
	nonempty_string(r.evidence_kind)
	nonempty_string(r.claim_schema)
	nonempty_string(r.authority_content_digest)
	r.provenance in {"AUTHENTICATED_SOURCE", "SIGNED_ATTESTATION"}
	nonempty_string(r.derived_anomaly_code)
	object.keys(r.derived_statement) == {"summary"}
	nonempty_string(r.derived_statement.summary)
	nonempty_string(r.derived_correction_reason)
}

# (3) The observation's shape against the selected rule. The authority CONTENT is bound by digest
# on A's own subject binding — ambient/latest authority text, display URLs and labels confer nothing.
observation_shape_ok if {
	observation.producer_ref == selected_rule.producer_ref
	observation.evidence_kind == selected_rule.evidence_kind
	observation.claim_schema == selected_rule.claim_schema
	observation.provenance.integrity == selected_rule.provenance
	some b in observation.subject_bindings
	b.content_digest.value == selected_rule.authority_content_digest
}

applies_to_well_formed if {
	object.keys(applies_to) == {
		"transition_kind", "predecessor_ref", "from_classification", "to_classification",
		"from_subject", "to_subject", "to_subject_kind", "method", "work_run_ref",
	}
	object.keys(applies_to.predecessor_ref) == {"evidence_id", "envelope_digest"}
	nonempty_string(applies_to.predecessor_ref.evidence_id)
	nonempty_string(applies_to.predecessor_ref.envelope_digest)
	object.keys(applies_to.method) == {"method_ref", "method_digest"}
	nonempty_string(applies_to.method.method_ref)
	nonempty_string(applies_to.method.method_digest)
	nonempty_string(applies_to.work_run_ref)
}

# Round-11 S11-1: the landed mutable-subject rule carried into the closure. A RECLASSIFICATION
# reuses F's own (kind, binding) pair — F was validated against exactly that pair — while a
# SUBJECT_TRANSFER introduces a binding F never carried, so the rule is checked directly.
subject_kind_conformance if {
	applies_to.to_subject_kind in subject_kinds
	mat.transition_kind == "RECLASSIFICATION"
	applies_to.to_subject_kind == seal_predecessor.claim.subject.kind
}

subject_kind_conformance if {
	applies_to.to_subject_kind in subject_kinds
	mat.transition_kind == "SUBJECT_TRANSFER"
	immutable_subject_kinds[applies_to.to_subject_kind]
}

subject_kind_conformance if {
	applies_to.to_subject_kind in subject_kinds
	mat.transition_kind == "SUBJECT_TRANSFER"
	not immutable_subject_kinds[applies_to.to_subject_kind]
	subject_exactness(applies_to.to_subject)
}

subject_exactness(s) if nonempty_string(s.revision_or_version)

subject_exactness(s) if s.content_digest

digest_object_exact(d) if {
	object.keys(d) == {"algorithm", "canonicalization", "value"}
	nonempty_string(d.algorithm)
	nonempty_string(d.canonicalization)
	nonempty_string(d.value)
}

to_subject_digest_ok if not applies_to.to_subject.content_digest

to_subject_digest_ok if digest_object_exact(applies_to.to_subject.content_digest)

# (4) authority_applicable — every element exact, none of it optional or rule-suppressible. One
# observation therefore authorizes at most ONE transition, with exactly one admissible content.
authority_applicable if {
	applies_to_well_formed
	to_subject_digest_ok
	applies_to.transition_kind == mat.transition_kind
	applies_to.predecessor_ref.evidence_id == seal_predecessor.evidence_id
	applies_to.predecessor_ref.envelope_digest == seal_predecessor.envelope_digest.value
	applies_to.from_classification == mat.from_classification
	applies_to.to_classification == mat.to_classification
	applies_to.from_subject == mat.from_subject
	applies_to.to_subject == mat.to_subject
	applies_to.to_subject_kind == seal_draft.claim.subject.kind
	subject_kind_conformance
	applies_to.method == selected_rule.method
	applies_to.method.method_ref == seal_draft.claim.derivation.method_ref
	applies_to.method.method_digest == seal_draft.claim.derivation.method_digest
	applies_to.work_run_ref == work_run_binding_ids[0]
	seal_draft == derived_draft
}

deterministic_authority_ok if {
	observation_resolved
	well_formed_rule(selected_rule)
	observation_shape_ok
	authority_applicable
}

# ---- the derivation closure (round-10 R10-1): the draft is COMPUTED, never composed ----
# derived_draft(F, A, r) is a total function of the resolved predecessor envelope, the resolved
# observation and the uniquely matched well-formed active rule. Every field is derived, fixed by
# the operation, or required ABSENT; an extra, missing, differing or reordered field fails the
# equality, so there is no partial-coverage residue.

derived_draft := {
	"evidence_kind": "IMPROVEMENT_FINDING",
	"subject_bindings": derived_subject_bindings,
	"claim": derived_claim,
}

# Exactly one element changes; secondary bindings are carried through unchanged — they cannot be
# added, dropped or reordered.
derived_subject_bindings := json.patch(
	seal_predecessor.subject_bindings,
	[{
		"op": "replace",
		"path": [format_int(seal_predecessor.claim.subject.binding_index, 10)],
		"value": applies_to.to_subject,
	}],
)

derived_claim := {
	"contract_id": "cadp.improvement-intake.v1",
	"classification": applies_to.to_classification,
	"subject": {"kind": applies_to.to_subject_kind, "binding_index": seal_predecessor.claim.subject.binding_index},
	"basis": [{
		"evidence_id": observation.evidence_id,
		"envelope_digest": observation.envelope_digest.value,
		"role": "AUTHORITY_TEXT",
	}],
	"derivation": {
		"kind": "DETERMINISTIC_DERIVATION",
		"method_ref": selected_rule.method.method_ref,
		"method_digest": selected_rule.method.method_digest,
	},
	"anomaly_code": selected_rule.derived_anomaly_code,
	"occurrence_key": derived_occurrence_key,
	"statement": {"summary": selected_rule.derived_statement.summary},
	"supersedes": [applies_to.predecessor_ref],
	"correction_reason": selected_rule.derived_correction_reason,
}

# The landed §4 occurrence_key derivation (cadp-jcs-1 over the exact primary binding, anomaly
# code, sorted basis refs and method), recomputed here so the closure is total against the landed
# VALIDATOR and an ALLOWed deterministic transition is always sealable. The basis is the I6-style
# singleton, so the landed sort is the identity.
derived_occurrence_key := crypto.sha256(occurrence_payload)

occurrence_payload := concat("", [
	"{\\"anomaly_code\\":", jcs_string(selected_rule.derived_anomaly_code),
	",\\"contract_id\\":\\"cadp.improvement-intake.v1\\"",
	",\\"exact_primary_subject_binding\\":", jcs_binding(applies_to.to_subject),
	",\\"method_digest\\":", jcs_string(selected_rule.method.method_digest),
	",\\"method_ref\\":", jcs_string(selected_rule.method.method_ref),
	",\\"sorted_exact_basis_refs\\":[{\\"envelope_digest\\":", jcs_string(observation.envelope_digest.value),
	",\\"evidence_id\\":", jcs_string(observation.evidence_id),
	",\\"role\\":\\"AUTHORITY_TEXT\\"}]}",
])

jcs_binding(b) := concat("", ["{", concat(",", binding_members(b)), "}"])

binding_members(b) := m if {
	m0 := [concat("", ["\\"authority_ref\\":", jcs_string(b.authority_ref)])]
	m1 := array.concat(m0, binding_digest_member(b))
	m2 := array.concat(m1, [concat("", ["\\"namespace\\":", jcs_string(b.namespace)])])
	m3 := array.concat(m2, [concat("", ["\\"object_id\\":", jcs_string(b.object_id)])])
	m := array.concat(m3, binding_revision_member(b))
}

binding_digest_member(b) := [concat("", ["\\"content_digest\\":", jcs_digest_object(b.content_digest)])] if b.content_digest

binding_digest_member(b) := [] if not b.content_digest

binding_revision_member(b) := [concat("", ["\\"revision_or_version\\":", jcs_string(b.revision_or_version)])] if b.revision_or_version

binding_revision_member(b) := [] if not b.revision_or_version

jcs_digest_object(d) := concat("", [
	"{\\"algorithm\\":", jcs_string(d.algorithm),
	",\\"canonicalization\\":", jcs_string(d.canonicalization),
	",\\"value\\":", jcs_string(d.value), "}",
])

${JCS_STRING_RULE}

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

# ---- v1.1 FINDING_SEAL reason codes (#117 §10 item 6) ----

reason_codes contains "finding_unresolvable" if {
	is_finding_seal
	not seal_predecessor_present
}

reason_codes contains "transition_kind_invalid" if {
	is_finding_seal
	not transition_kind_ok
}

reason_codes contains "transition_shape_invalid" if {
	is_finding_seal
	seal_predecessor_present
	transition_kind_ok
	not transition_shape_ok
}

reason_codes contains "transition_subject_mismatch" if {
	is_finding_seal
	seal_predecessor_present
	mat.transition_kind == "RECLASSIFICATION"
	mat.to_subject != mat.from_subject
}

reason_codes contains "transition_run_context_invalid" if {
	is_finding_seal
	not transition_run_context_ok
}

reason_codes contains "reclassification_ambiguous" if {
	is_finding_seal
	transition_conflict
}

reason_codes contains "transition_derivation_forbidden" if {
	is_finding_seal
	seal_derivation_kind == "MODEL_PROPOSAL"
}

# REQUIRE_EVIDENCE(HUMAN_DECISION, transition_unauthorized{predecessor_ref, digest(M)}): the exact
# refs are the sealed K3 request's own predecessor_ref and material_digest.
reason_codes contains "transition_unauthorized" if {
	finding_seal_base_ok
	seal_derivation_kind == "HUMAN_JUDGMENT"
	not human_ok
}

reason_codes contains "HUMAN_DECISION" if {
	finding_seal_base_ok
	seal_derivation_kind == "HUMAN_JUDGMENT"
	not human_ok
}

reason_codes contains "transition_draft_underived" if {
	is_finding_seal
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	not observation_resolved
}

reason_codes contains "transition_rule_ambiguous" if {
	is_finding_seal
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	observation_resolved
	count(matching_rules) > 1
}

reason_codes contains "transition_authority_absent" if {
	is_finding_seal
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	observation_resolved
	count(matching_rules) == 0
}

reason_codes contains "transition_rule_malformed" if {
	is_finding_seal
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	observation_resolved
	count(matching_rules) == 1
	not well_formed_rule(matching_rules[0])
}

reason_codes contains "transition_subject_kind_invalid" if {
	is_finding_seal
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	observation_resolved
	well_formed_rule(selected_rule)
	applies_to_well_formed
	not subject_kind_conformance
}

reason_codes contains "transition_draft_underived" if {
	is_finding_seal
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	observation_resolved
	well_formed_rule(selected_rule)
	observation_shape_ok
	applies_to_well_formed
	subject_kind_conformance
	seal_draft != derived_draft
}

reason_codes contains "transition_unauthorized" if {
	is_finding_seal
	seal_derivation_kind == "DETERMINISTIC_DERIVATION"
	observation_resolved
	well_formed_rule(selected_rule)
	not authority_applicable
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
  // v1.1 governed transition writer (#117 §5.2). `producer_ref` is the permanent invariant-P
  // contract constant; THIS row is the rotatable/revocable part — the workload credential bound
  // to it. Only the PEP-held FINDING_SEAL adapter authenticates as this principal (FC5).
  { principal: "cadp-governed-reclassification", producer_ref: "governed:reclassification", identity_class: { vendor: "cadp", product: "governed-transition", account: "cadp-v04", process_class: "evidence-adapter" } },
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
  // v1.1 (#117 §5.2/§5.3): the two separated mechanisms declared explicitly — replay idempotency
  // on the effect-bound source_ref (what makes the adapter's NATIVE_KEY true at the target) and
  // governed-edge uniqueness on the sealed draft's own supersedes singleton (invariant U).
  {
    producer_ref: "governed:reclassification", evidence_kinds: ["IMPROVEMENT_FINDING"],
    source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" },
    replay_idempotency: "SOURCE_REF_UNIQUE", governed_edge: "SUPERSEDES_SINGLETON",
  },
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
    allocation_purposes: ["work-start", "git-push", "pr-create", "pr-merge", "record-write", "policy-activate", "finding-project", "finding-seal"],
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
