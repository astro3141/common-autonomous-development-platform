/**
 * AP B3 — `cadp.kernel-config.v2` validation. Conformance controls A1 (duplicate-registry-row
 * rejection, B3(1)) and A2 (unknown-entry-key rejection, B3(2)/B3(3)), plus the descriptor and
 * projection rules of B2(2)/B2(5) and the cross-field namespace invariant of B3(4)(c).
 *
 * Every case here is validation-layer only: `validateKernelConfig` is the function genesis
 * validation and `POLICY_ACTIVATE` recheck #17 both call (`genesis.ts`, `policyPublication.ts`),
 * so a refusal here is the activation refusal those controls observe. The v1 legs assert the
 * complementary claim: none of these rules is scoped to `cadp.kernel-config.v1`.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { validateKernelConfig, KernelConfigInvalid } from "../kernel/policyBundle.ts";
import { buildReferenceKernelConfig, REFERENCE_ADAPTERS, REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import { makeHarness, stopSharedOpa } from "./support/harness.ts";

after(() => stopSharedOpa());

const ROOT_PUBLIC_KEYS = [
  { key_id: "root-1", alg: "Ed25519" as const, public_key: "cm9vdA==", valid_from: "2026-01-01T00:00:00.000Z" },
];

const BOOTSTRAP_SCHEMES = [
  { algorithm: "sha256", canonicalization: "raw-bytes-1" },
  { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
  { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1" },
];

const BOUNDS = {
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
};

const IDENTITY = {
  principal: "cadp-workflow",
  producer_ref: "workflow:cadp-work",
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};

const ADAPTER = {
  producer_ref: "workflow:cadp-work",
  evidence_kinds: ["HUMAN_DECISION"],
  source_relation: "SELF_REPORT",
  produced_at_source: { kind: "NONE" },
};

/** A v2 config carrying every required key, with all five v2-only registries empty. */
function v2Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "cadp.kernel-config.v2",
    approved_digest_schemes: BOOTSTRAP_SCHEMES,
    root_public_keys: ROOT_PUBLIC_KEYS,
    attestation_keys: [],
    identity_registry: [IDENTITY],
    adapter_registry: [ADAPTER],
    allocation_purposes: ["work-start"],
    allocation_schema_descriptors: [],
    allocation_schemas: [],
    subject_complete_assembly: [],
    kernel_subject_namespaces: [],
    run_profile_enrolled_requester_refs: [],
    ...BOUNDS,
    ...overrides,
  };
}

/** The same config under v1, used to prove no new rule is scoped to v1. */
function v1Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cfg = v2Config(overrides);
  for (const key of [
    "allocation_schema_descriptors", "allocation_schemas", "subject_complete_assembly",
    "kernel_subject_namespaces", "run_profile_enrolled_requester_refs",
  ]) {
    delete cfg[key];
  }
  return { ...cfg, schema: "cadp.kernel-config.v1" };
}

/** The Workflow-Plane-owned `cadp.allocation-key.v1` descriptor (AP B1(4), B2(2)) as bundle data. */
const V1_DESCRIPTOR = {
  schema: "cadp.allocation-key.v1",
  fields: [
    { field: "work_run_ref", role: "PROJECTED", value_contract: "EFFECT_ID" },
    { field: "step_ordinal", role: "ENTROPY", value_contract: "POSITIVE_INTEGER" },
  ],
};

const V1_ALLOCATION_SCHEMA = {
  schema: "cadp.allocation-key.v1",
  binding_projection: [{ tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" }],
  purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }],
};

const EXTERNAL_DESCRIPTOR = {
  schema: "cadp.allocation-key.external.v1",
  fields: [
    { field: "repo_id", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
    { field: "candidate_base_sha", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
    { field: "candidate_sha", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
  ],
};

const EXTERNAL_ALLOCATION_SCHEMA = {
  schema: "cadp.allocation-key.external.v1",
  binding_projection: [
    { tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" },
    { tuple_field: "candidate_base_sha", authority_ref: "github.com", namespace: "base-commit" },
    { tuple_field: "candidate_sha", authority_ref: "github.com", namespace: "commit" },
  ],
  purpose_relation: [{ purpose: "pr-create", operation_kind: "PR_CREATE" }],
};

/** Deep clone so a case's mutation never leaks into the next one. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function refuse(config: Record<string, unknown>, reason: string, note: string): void {
  let thrown: unknown;
  try {
    validateKernelConfig(config);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof KernelConfigInvalid, `${note}: expected KernelConfigInvalid, got ${String(thrown)}`);
  assert.equal((thrown as KernelConfigInvalid).reason, reason, `${note}: ${(thrown as Error).message}`);
  assert.match((thrown as Error).message, new RegExp(`^${reason}: `, "u"), `${note}: code carried in the message`);
}

function refuseInvalid(config: Record<string, unknown>, messagePattern: RegExp, note: string): void {
  assert.throws(() => validateKernelConfig(config), (error: unknown) => {
    assert.ok(error instanceof KernelConfigInvalid, `${note}: ${String(error)}`);
    assert.match((error as Error).message, messagePattern, note);
    return true;
  }, note);
}

// ------------------------------------------------------------------ positive controls

test("v2 positive control: a bundle with all five new registries empty validates", () => {
  const cfg = validateKernelConfig(v2Config());
  assert.equal(cfg.schema, "cadp.kernel-config.v2");
  assert.deepEqual(cfg.allocation_schemas, []);
  assert.deepEqual(cfg.run_profile_enrolled_requester_refs, []);
});

test("A2 positive control: the reference v1 bundle still validates, byte-identically scoped", () => {
  const reference = buildReferenceKernelConfig({ policy_id: "cadp-v04:policy:root", revision: 1, root_public_keys: ROOT_PUBLIC_KEYS });
  const validated = validateKernelConfig(reference);
  assert.equal(validated.schema, "cadp.kernel-config.v1");
  // The reference registries carry no v2 key and are unaffected by the v2 rules.
  assert.equal(validated.allocation_schemas, undefined);
  assert.equal(validated.kernel_subject_namespaces, undefined);
});

test("A2 positive control: the governed-writer opt-ins on the reference adapter row activate under v2", () => {
  const cfg = validateKernelConfig(v2Config({
    identity_registry: REFERENCE_IDENTITIES,
    adapter_registry: REFERENCE_ADAPTERS,
  }));
  assert.ok(cfg.adapter_registry.some((entry) => entry.governed_edge === "SUPERSEDES_SINGLETON"));
});

test("v2 accepts a complete allocation contract for both the internal and the external schema", () => {
  const cfg = validateKernelConfig(v2Config({
    allocation_purposes: ["work-start", "pr-create"],
    allocation_schema_descriptors: [V1_DESCRIPTOR, EXTERNAL_DESCRIPTOR],
    allocation_schemas: [
      { ...V1_ALLOCATION_SCHEMA, purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }, { purpose: "pr-create", operation_kind: "PR_CREATE" }] },
      EXTERNAL_ALLOCATION_SCHEMA,
    ],
    subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: ["PR_CREATE", "PR_MERGE"] }],
    kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }],
    run_profile_enrolled_requester_refs: ["workflow:cadp-work"],
  }));
  assert.equal(cfg.allocation_schema_descriptors?.length, 2);
  assert.equal(cfg.subject_complete_assembly?.length, 1);
});

// ------------------------------------------------------------------ A1 — registry uniqueness (B3(1))

test("A1: duplicate registry rows are refused REGISTRY_DUPLICATE_KEY in all three legs", () => {
  // (i) two identity_registry rows sharing a principal, with different process_class.
  refuse(v2Config({
    identity_registry: [
      IDENTITY,
      { ...clone(IDENTITY), producer_ref: "worker:codex-cli", identity_class: { ...IDENTITY.identity_class, process_class: "worker" } },
    ],
  }), "REGISTRY_DUPLICATE_KEY", "duplicate identity principal");

  // (ii) two identity_registry rows sharing a producer_ref, with different identity_class.product.
  refuse(v2Config({
    identity_registry: [
      IDENTITY,
      { ...clone(IDENTITY), principal: "cadp-worker-codex", identity_class: { ...IDENTITY.identity_class, product: "codex-cli" } },
    ],
  }), "REGISTRY_DUPLICATE_KEY", "duplicate identity producer_ref");

  // (iii) two adapter_registry rows sharing a producer_ref, with different evidence_kinds.
  refuse(v2Config({
    adapter_registry: [ADAPTER, { ...clone(ADAPTER), evidence_kinds: ["REVIEW"] }],
  }), "REGISTRY_DUPLICATE_KEY", "duplicate adapter producer_ref");
});

test("A1 scope: the same duplicate rows are NOT refused under cadp.kernel-config.v1", () => {
  // v1 validation is unchanged: B3 narrows activation acceptance for v2 only (B3(5)).
  validateKernelConfig(v1Config({
    identity_registry: [IDENTITY, { ...clone(IDENTITY), identity_class: { ...IDENTITY.identity_class, process_class: "worker" } }],
  }));
  validateKernelConfig(v1Config({
    adapter_registry: [ADAPTER, { ...clone(ADAPTER), evidence_kinds: ["REVIEW"] }],
  }));
});

test("uniqueness extends to the v2 registries: schema, descriptor field, tuple_field, target, purpose, namespace", () => {
  refuse(v2Config({
    allocation_schema_descriptors: [V1_DESCRIPTOR, clone(V1_DESCRIPTOR)],
    allocation_schemas: [V1_ALLOCATION_SCHEMA],
  }), "REGISTRY_DUPLICATE_KEY", "two descriptors for one schema");

  refuse(v2Config({
    allocation_schema_descriptors: [{
      schema: "cadp.allocation-key.v1",
      fields: [
        { field: "work_run_ref", role: "PROJECTED", value_contract: "EFFECT_ID" },
        { field: "work_run_ref", role: "ENTROPY", value_contract: "NONEMPTY_STRING" },
      ],
    }],
    allocation_schemas: [V1_ALLOCATION_SCHEMA],
  }), "REGISTRY_DUPLICATE_KEY", "one descriptor entry naming a field twice");

  refuse(v2Config({
    allocation_schema_descriptors: [V1_DESCRIPTOR],
    allocation_schemas: [V1_ALLOCATION_SCHEMA, clone(V1_ALLOCATION_SCHEMA)],
  }), "REGISTRY_DUPLICATE_KEY", "two allocation_schemas rows for one schema");

  refuse(v2Config({
    allocation_schema_descriptors: [V1_DESCRIPTOR],
    allocation_schemas: [{
      ...clone(V1_ALLOCATION_SCHEMA),
      binding_projection: [
        { tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" },
        { tuple_field: "work_run_ref", authority_ref: "other", namespace: "work-run" },
      ],
    }],
  }), "REGISTRY_DUPLICATE_KEY", "one entry projecting one tuple_field twice");

  // The authoring-side half of B2(3.4)'s exactly-one rule: one target pair, two fields.
  refuse(v2Config({
    allocation_purposes: ["pr-create"],
    allocation_schema_descriptors: [EXTERNAL_DESCRIPTOR],
    allocation_schemas: [{
      ...clone(EXTERNAL_ALLOCATION_SCHEMA),
      binding_projection: [
        { tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" },
        { tuple_field: "candidate_base_sha", authority_ref: "github.com", namespace: "commit" },
        { tuple_field: "candidate_sha", authority_ref: "github.com", namespace: "commit" },
      ],
    }],
  }), "REGISTRY_DUPLICATE_KEY", "one entry projecting two fields onto one (authority_ref, namespace)");

  refuse(v2Config({
    allocation_schema_descriptors: [V1_DESCRIPTOR],
    allocation_schemas: [{
      ...clone(V1_ALLOCATION_SCHEMA),
      purpose_relation: [
        { purpose: "work-start", operation_kind: "WORK_START" },
        { purpose: "work-start", operation_kind: "RECORD_WRITE" },
      ],
    }],
  }), "REGISTRY_DUPLICATE_KEY", "one purpose_relation naming a purpose twice");

  refuse(v2Config({
    kernel_subject_namespaces: [
      { namespace: "work-run", authority_ref: "cadp-store:k04" },
      { namespace: "work-run", authority_ref: "other" },
    ],
  }), "REGISTRY_DUPLICATE_KEY", "two kernel_subject_namespaces rows for one namespace");
});

// ------------------------------------------------------------------ A2 — closed entry keys (B3(2)/(3))

test("A2: an unknown key INSIDE an entry is refused REGISTRY_UNKNOWN_ENTRY_KEY", () => {
  const cases: Array<{ note: string; overrides: Record<string, unknown> }> = [
    {
      note: "identity_registry producer-ref alongside a correct producer_ref",
      overrides: { identity_registry: [{ ...clone(IDENTITY), "producer-ref": "workflow:cadp-work" }] },
    },
    {
      note: "adapter_registry evidence_kind (singular) alongside a correct evidence_kinds",
      overrides: { adapter_registry: [{ ...clone(ADAPTER), evidence_kind: "REVIEW" }] },
    },
    {
      note: "root_public_keys unknown key",
      overrides: { root_public_keys: [{ ...clone(ROOT_PUBLIC_KEYS[0]!), rotated: true }] },
    },
    {
      note: "approved_digest_schemes unknown key",
      overrides: { approved_digest_schemes: [...BOOTSTRAP_SCHEMES.slice(1), { ...clone(BOOTSTRAP_SCHEMES[0]!), preferred: true }] },
    },
    {
      note: "attestation_keys unknown key",
      overrides: { attestation_keys: [{ key_id: "k", alg: "Ed25519", public_key: "x", purpose: "reach", valid_from: "2026-01-01T00:00:00.000Z", scope: "all" }] },
    },
  ];
  for (const testCase of cases) {
    refuse(v2Config(testCase.overrides), "REGISTRY_UNKNOWN_ENTRY_KEY", testCase.note);
  }
});

test("A2: nested entry key sets are closed identically — depth does not weaken the rule", () => {
  const cases: Array<{ note: string; overrides: Record<string, unknown> }> = [
    {
      note: "identity_class unknown key",
      overrides: { identity_registry: [{ ...clone(IDENTITY), identity_class: { ...IDENTITY.identity_class, tenant: "x" } }] },
    },
    {
      note: "produced_at_source unknown key",
      overrides: { adapter_registry: [{ ...clone(ADAPTER), produced_at_source: { kind: "NONE", fallback: "now" } }] },
    },
    {
      note: "descriptor fields entry unknown key",
      overrides: {
        allocation_schema_descriptors: [{
          schema: "cadp.allocation-key.v1",
          fields: [{ field: "work_run_ref", role: "PROJECTED", value_contract: "EFFECT_ID", nullable: false }, clone(V1_DESCRIPTOR.fields[1]!)],
        }],
        allocation_schemas: [V1_ALLOCATION_SCHEMA],
      },
    },
    {
      note: "binding_projection entry unknown key",
      overrides: {
        allocation_schema_descriptors: [V1_DESCRIPTOR],
        allocation_schemas: [{
          ...clone(V1_ALLOCATION_SCHEMA),
          binding_projection: [{ tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run", revision_or_version: "1" }],
        }],
      },
    },
    {
      note: "purpose_relation entry unknown key",
      overrides: {
        allocation_schema_descriptors: [V1_DESCRIPTOR],
        allocation_schemas: [{
          ...clone(V1_ALLOCATION_SCHEMA),
          purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START", optional: true }],
        }],
      },
    },
    {
      note: "allocation_schema_descriptors entry unknown key",
      overrides: {
        allocation_schema_descriptors: [{ ...clone(V1_DESCRIPTOR), version: 1 }],
        allocation_schemas: [V1_ALLOCATION_SCHEMA],
      },
    },
    {
      note: "allocation_schemas entry unknown key",
      overrides: {
        allocation_schema_descriptors: [V1_DESCRIPTOR],
        allocation_schemas: [{ ...clone(V1_ALLOCATION_SCHEMA), default_operation_kind: "WORK_START" }],
      },
    },
    {
      note: "subject_complete_assembly entry unknown key",
      overrides: { subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: [], latest_only: true }] },
    },
    {
      note: "kernel_subject_namespaces entry unknown key",
      overrides: { kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04", exact: true }] },
    },
  ];
  for (const testCase of cases) {
    refuse(v2Config(testCase.overrides), "REGISTRY_UNKNOWN_ENTRY_KEY", testCase.note);
  }
});

test("A2 scope: the same unknown entry keys are NOT refused under cadp.kernel-config.v1", () => {
  validateKernelConfig(v1Config({ identity_registry: [{ ...clone(IDENTITY), "producer-ref": "workflow:cadp-work" }] }));
  validateKernelConfig(v1Config({ adapter_registry: [{ ...clone(ADAPTER), evidence_kind: "REVIEW" }] }));
  validateKernelConfig(v1Config({ identity_registry: [{ ...clone(IDENTITY), identity_class: { ...IDENTITY.identity_class, tenant: "x" } }] }));
});

// ------------------------------------------------------------------ the v2 top-level key set

test("the five v2 keys are required top-level keys of v2 and unknown under v1", () => {
  for (const key of [
    "allocation_schema_descriptors", "allocation_schemas", "subject_complete_assembly",
    "kernel_subject_namespaces", "run_profile_enrolled_requester_refs",
  ]) {
    const missing = v2Config();
    delete missing[key];
    refuseInvalid(missing, new RegExp(`^${key} required \\(may be \\[\\]\\)$`, "u"), `${key} missing under v2`);

    // Under v1 the same key is not merely optional — it is outside the closed top-level set,
    // and the v1 refusal text is unchanged (`unknown key data.cadp.<key> (closed schema)`).
    refuseInvalid(
      { ...v1Config(), [key]: [] },
      new RegExp(`^unknown key data\\.cadp\\.${key} \\(closed schema\\)$`, "u"),
      `${key} present under v1`,
    );
  }
});

test("v1 validation is unchanged: schema string, wildcard principals, unknown top-level keys", () => {
  validateKernelConfig(v1Config());
  refuseInvalid({ ...v1Config(), extra: true }, /^unknown key data\.cadp\.extra \(closed schema\)$/u, "unknown v1 key");
  refuseInvalid(
    v1Config({ identity_registry: [{ ...clone(IDENTITY), principal: "spiffe://cadp/*" }] }),
    /^identity_registry principal must be exact \(no patterns\)$/u,
    "wildcard principal under v1",
  );
  // v2 widens acceptance and nothing else: an unknown schema string keeps v1's exact refusal text.
  refuseInvalid({ ...v1Config(), schema: "cadp.kernel-config.v3" }, /^schema must be cadp\.kernel-config\.v1$/u, "unknown schema");
  // Every v1 rule still runs under v2.
  refuseInvalid(
    v2Config({ identity_registry: [{ ...clone(IDENTITY), principal: "spiffe://cadp/*" }] }),
    /^identity_registry principal must be exact \(no patterns\)$/u,
    "wildcard principal under v2",
  );
  refuseInvalid(v2Config({ decision_ttl_s: 0 }), /^decision_ttl_s must be an integer in \[60, 86400\]$/u, "bounds under v2");
});

// ------------------------------------------------------------------ B2(2)(i) — descriptor validation

test("descriptor entries: closed role and value_contract vocabularies, all three members required", () => {
  const withFields = (fields: unknown) => v2Config({
    allocation_schema_descriptors: [{ schema: "cadp.allocation-key.v1", fields }],
    allocation_schemas: [{ ...clone(V1_ALLOCATION_SCHEMA), binding_projection: [] }],
  });

  refuseInvalid(withFields([{ field: "work_run_ref", role: "PROJECTABLE", value_contract: "EFFECT_ID" }]), /role must be one of \{PROJECTED, ENTROPY\}/u, "unknown role");
  refuseInvalid(withFields([{ field: "work_run_ref", role: "ENTROPY", value_contract: "UUID" }]), /value_contract must be one of \{POSITIVE_INTEGER, NONEMPTY_STRING, EFFECT_ID\}/u, "unknown value_contract");
  refuseInvalid(withFields([{ role: "ENTROPY", value_contract: "EFFECT_ID" }]), /fields entry\.field must be a nonempty string/u, "field missing");
  refuseInvalid(withFields([{ field: "work_run_ref", value_contract: "EFFECT_ID" }]), /fields entry\.role must be one of/u, "role missing");
  refuseInvalid(withFields([{ field: "work_run_ref", role: "ENTROPY" }]), /fields entry\.value_contract must be one of/u, "value_contract missing");
  refuseInvalid(withFields("not-an-array"), /fields required \(may be \[\]\)/u, "fields not an array");
});

test("a descriptor naming a reserved field (schema or purpose) is refused", () => {
  for (const reserved of ["schema", "purpose"]) {
    refuseInvalid(
      v2Config({
        allocation_schema_descriptors: [{ schema: "cadp.allocation-key.v1", fields: [{ field: reserved, role: "ENTROPY", value_contract: "NONEMPTY_STRING" }] }],
        allocation_schemas: [{ ...clone(V1_ALLOCATION_SCHEMA), binding_projection: [] }],
      }),
      new RegExp(`field ${reserved} is reserved kernel vocabulary`, "u"),
      `descriptor naming reserved field ${reserved}`,
    );
  }
});

test("a descriptor whose fields list is empty is expressible (B2(5): ENTROPY is a role, not a semantics)", () => {
  validateKernelConfig(v2Config({
    allocation_schema_descriptors: [{ schema: "cadp.allocation-key.empty.v1", fields: [] }],
    allocation_schemas: [{ schema: "cadp.allocation-key.empty.v1", binding_projection: [], purpose_relation: [] }],
  }));
});

// ------------------------------------------------------- B2(2)(iii)/B2(5) — projection coverage

test("every allocation_schemas entry needs a descriptor to be validated against", () => {
  refuse(v2Config({
    allocation_schema_descriptors: [],
    allocation_schemas: [V1_ALLOCATION_SCHEMA],
  }), "ALLOCATION_SCHEMA_UNREGISTERED", "mapping with no descriptor");
});

test("a descriptor with no allocation_schemas entry is unallocatable, not an invalid bundle", () => {
  // B2(5)'s "both entries" is a condition on ALLOCATABILITY — the refusal is at
  // `allocate_effect_id` — and B2(8) lists no bundle-level refusal for an unmapped descriptor.
  const cfg = validateKernelConfig(v2Config({
    allocation_schema_descriptors: [V1_DESCRIPTOR],
    allocation_schemas: [],
  }));
  assert.equal(cfg.allocation_schema_descriptors?.length, 1);
  assert.equal(cfg.allocation_schemas?.length, 0);
});

test("projection-vs-descriptor: every PROJECTED field mapped exactly once, no ENTROPY field mapped", () => {
  // A PROJECTED field with no mapping — the authorable-away weakening of control A's binding leg.
  refuse(v2Config({
    allocation_purposes: ["pr-create"],
    allocation_schema_descriptors: [EXTERNAL_DESCRIPTOR],
    allocation_schemas: [{
      ...clone(EXTERNAL_ALLOCATION_SCHEMA),
      binding_projection: EXTERNAL_ALLOCATION_SCHEMA.binding_projection.filter((p) => p.tuple_field !== "candidate_base_sha"),
    }],
  }), "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE", "PROJECTED candidate_base_sha unmapped");

  // An ENTROPY field with a mapping — v1's `step_ordinal` is projected nowhere.
  refuse(v2Config({
    allocation_schema_descriptors: [V1_DESCRIPTOR],
    allocation_schemas: [{
      ...clone(V1_ALLOCATION_SCHEMA),
      binding_projection: [
        { tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" },
        { tuple_field: "step_ordinal", authority_ref: "cadp-store:k04", namespace: "step" },
      ],
    }],
  }), "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE", "ENTROPY step_ordinal projected");

  // A mapping naming a field outside the descriptor, including a reserved one.
  for (const outside of ["candidate_sha", "schema", "purpose"]) {
    refuse(v2Config({
      allocation_schema_descriptors: [V1_DESCRIPTOR],
      allocation_schemas: [{
        ...clone(V1_ALLOCATION_SCHEMA),
        binding_projection: [
          { tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" },
          { tuple_field: outside, authority_ref: "github.com", namespace: "commit" },
        ],
      }],
    }), "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE", `mapping naming ${outside}, outside the descriptor`);
  }
});

test("B2(5): the internal schema's purpose_relation must be total over allocation_purposes", () => {
  refuse(v2Config({
    allocation_purposes: ["work-start", "pr-create"],
    allocation_schema_descriptors: [V1_DESCRIPTOR],
    allocation_schemas: [V1_ALLOCATION_SCHEMA], // registers work-start only
  }), "ALLOCATION_PURPOSE_NOT_REGISTERED", "v1 purpose_relation omits pr-create");

  // Totality is a static property of the bundle for `cadp.allocation-key.v1` alone; for any other
  // schema the allocatable purpose set is not statically known and the check is allocation-time.
  validateKernelConfig(v2Config({
    allocation_purposes: ["work-start", "pr-create"],
    allocation_schema_descriptors: [EXTERNAL_DESCRIPTOR],
    allocation_schemas: [EXTERNAL_ALLOCATION_SCHEMA], // registers pr-create only
  }));
});

// ------------------------------------------------------------------ B3(4)(c) — cross-field invariant

test("B3(4)(c): a non-empty run profile with no work-run declaration is refused KERNEL_NAMESPACE_UNDECLARED", () => {
  refuse(v2Config({
    run_profile_enrolled_requester_refs: ["workflow:cadp-work"],
    kernel_subject_namespaces: [],
  }), "KERNEL_NAMESPACE_UNDECLARED", "enrolled requester, no declaration");

  refuse(v2Config({
    run_profile_enrolled_requester_refs: ["workflow:cadp-work"],
    kernel_subject_namespaces: [{ namespace: "commit", authority_ref: "github.com" }],
  }), "KERNEL_NAMESPACE_UNDECLARED", "enrolled requester, some other namespace declared");

  // Positive control, so the refusal is attributed to the omission and not to the enrollment.
  validateKernelConfig(v2Config({
    run_profile_enrolled_requester_refs: ["workflow:cadp-work"],
    kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }],
  }));
  // And an empty run profile leaves the declaration optional, per B3(4)(a)'s "may be []".
  validateKernelConfig(v2Config({ run_profile_enrolled_requester_refs: [], kernel_subject_namespaces: [] }));
});

test("B5(3): enrolled requester refs are exact strings with no entry object", () => {
  refuseInvalid(
    v2Config({ run_profile_enrolled_requester_refs: ["workflow:*"], kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }] }),
    /^run_profile_enrolled_requester_refs\[0\] must be exact \(no patterns\)$/u,
    "wildcard requester_ref",
  );
  refuseInvalid(
    v2Config({ run_profile_enrolled_requester_refs: [{ requester_ref: "workflow:cadp-work" }], kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }] }),
    /^run_profile_enrolled_requester_refs\[0\] must be a nonempty string$/u,
    "entry object instead of an exact string",
  );
  refuseInvalid(
    v2Config({ run_profile_enrolled_requester_refs: "workflow:cadp-work" }),
    /^run_profile_enrolled_requester_refs required \(may be \[\]\)$/u,
    "not an array",
  );
});

// ------------------------------------------------------------------ B4(1) — declared assembly pairs

test("subject_complete_assembly entries carry three exact-string components", () => {
  validateKernelConfig(v2Config({ subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: [] }] }));
  refuseInvalid(
    v2Config({ subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit" }] }),
    /operation_kinds required \(may be \[\]\)/u,
    "operation_kinds missing",
  );
  refuseInvalid(
    v2Config({ subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: ["PR_*"] }] }),
    /operation_kinds\[0\] must be exact \(no patterns\)/u,
    "pattern operation_kind",
  );
  refuseInvalid(
    v2Config({ subject_complete_assembly: [{ evidence_kind: "REVIEW", operation_kinds: [] }] }),
    /subject_complete_assembly entry\.subject_namespace must be a nonempty string/u,
    "subject_namespace missing",
  );
});

test("kernel_subject_namespaces entries carry both components as exact strings", () => {
  refuseInvalid(
    v2Config({ kernel_subject_namespaces: [{ namespace: "work-run" }] }),
    /kernel_subject_namespaces entry\.authority_ref must be a nonempty string/u,
    "authority_ref missing",
  );
});

// ------------------------------------------------------------------ A1 on the activation path

/** The five v2 registries, empty — the minimum a bundle needs to carry `cadp.kernel-config.v2`. */
const V2_EMPTY_REGISTRIES = {
  schema: "cadp.kernel-config.v2",
  allocation_schema_descriptors: [],
  allocation_schemas: [],
  subject_complete_assembly: [],
  kernel_subject_namespaces: [],
  run_profile_enrolled_requester_refs: [],
} as const;

test("A1 end to end: a duplicate-principal v2 bundle is refused at recheck #17; active policy unchanged", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();

    // Positive control first, so the refusal below is attributed to the duplicate row and not to
    // the v2 schema string: the same bundle without it activates.
    const clean = await h.activatePolicy({ revision: 2, configOverrides: { ...V2_EMPTY_REGISTRIES } as never });
    assert.equal((clean.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(clean.admitted));
    assert.equal(h.store.activeActivation()!.revision, 2);

    const first = REFERENCE_IDENTITIES[0]!;
    const refused = await h.activatePolicy({
      revision: 3,
      configOverrides: {
        ...V2_EMPTY_REGISTRIES,
        identity_registry: [
          ...REFERENCE_IDENTITIES,
          { ...first, producer_ref: "workflow:cadp-work-shadow", identity_class: { ...first.identity_class, process_class: "worker" } },
        ],
      } as never,
    });
    const admitted = refused.admitted as { kind: string; reason?: string; detail?: string };
    assert.equal(admitted.kind, "REFUSAL", JSON.stringify(refused.admitted));
    assert.equal(admitted.reason, "KERNEL_CONFIG_INVALID");
    // The AP code survives into the activation refusal's detail, under the publication-level one.
    assert.match(String(admitted.detail), /REGISTRY_DUPLICATE_KEY: two identity_registry principal entries share/u);
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 3), undefined, "no policy_ref publication");
    assert.equal(h.store.activeActivation()!.revision, 2, "active policy unchanged");
  } finally {
    h.close();
  }
});
