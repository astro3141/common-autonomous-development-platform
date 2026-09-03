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

outcome := "ALLOW" if op in {"GIT_PUSH", "RECORD_WRITE", "WORK_START"}

outcome := "ALLOW" if op in params.extra_plain_allow_operations

pr_create_ok if {
	op == "PR_CREATE"
	verification_ok(mat.head_sha)
	review_ok(mat.head_sha)
	backend_model_present
	effort_requirement_met
}

outcome := "ALLOW" if pr_create_ok

merge_base_ok if {
	op == "PR_MERGE"
	verification_ok(mat.expected_head_sha)
	review_ok(mat.expected_head_sha)
}

outcome := "ALLOW" if {
	merge_base_ok
	human_ok
}

outcome := "REQUIRE_EVIDENCE" if {
	merge_base_ok
	not human_ok
}

outcome := "ALLOW" if {
	op == "POLICY_ACTIVATE"
	human_ok
}

outcome := "REQUIRE_EVIDENCE" if {
	op == "POLICY_ACTIVATE"
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
];

export const REFERENCE_ADAPTERS: KernelConfig["adapter_registry"] = [
  { producer_ref: "workflow:cadp-work", evidence_kinds: ["WORK_STEP", "WORK_BOUND_STOP"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" } },
  { producer_ref: "backend-scan:codex", evidence_kinds: ["BACKEND_EXECUTION"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" } },
  { producer_ref: "verifier:harness", evidence_kinds: ["VERIFICATION"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "SOURCE", claim_pointer: "/completed_at" } },
  { producer_ref: "reviewer:claude-code", evidence_kinds: ["REVIEW"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" } },
  { producer_ref: "human:astro3141", evidence_kinds: ["HUMAN_DECISION"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" } },
  { producer_ref: "deployment-control-probe", evidence_kinds: ["CREDENTIAL_REACH_ATTESTATION"], source_relation: "INDEPENDENT_OBSERVATION", produced_at_source: { kind: "NONE" } },
  { producer_ref: "deployment-control-target", evidence_kinds: ["TARGET_IMMUTABILITY_ATTESTATION"], source_relation: "TARGET_AUTHORITY_OBSERVATION", produced_at_source: { kind: "NONE" } },
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
    allocation_purposes: ["work-start", "git-push", "pr-create", "pr-merge", "record-write", "policy-activate"],
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
