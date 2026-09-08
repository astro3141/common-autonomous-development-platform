/**
 * AP B3 — `cadp.kernel-config.v2` validation, unit-tested against `validateKernelConfig` directly.
 *
 * Mirrors the Authority Plane TD's conformance controls A1 (duplicate-registry-row rejection,
 * B3(1)) and A2 (unknown-entry-key rejection, B3(2)/(3)), and covers the descriptor registry
 * (B2(2)(i)), projection-vs-descriptor coverage (B2(2)(iii), B2(5)) and the work-run declaration
 * invariant (B3(4)(c)). Every control is paired with a positive control, so each refusal is
 * attributed to the mutation and not to the bundle.
 *
 * Scope of this lane is the VALIDATION layer only: B2(2)(ii)'s cross-activation descriptor
 * immutability needs the sealed store, and B2(5)'s allocation-time refusals are ingress rules.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateKernelConfig, KernelConfigInvalid } from "../kernel/policyBundle.ts";
import { buildReferenceKernelConfig, REFERENCE_ADAPTERS, REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";

// ------------------------------------------------------------------ fixtures

const BOOTSTRAP_SCHEMES = [
  { algorithm: "sha256", canonicalization: "raw-bytes-1" },
  { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
  { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1" },
];

const ROOT_KEYS = [{ key_id: "root-1", alg: "Ed25519" as const, public_key: "AAAA", valid_from: "2026-01-01T00:00:00.000Z" }];

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

function identityRow(principal: string, producer_ref: string, product = "temporal-workflow"): Record<string, unknown> {
  return { principal, producer_ref, identity_class: { vendor: "cadp", product, account: "cadp-v05", process_class: "workflow" } };
}

function adapterRow(producer_ref: string, evidence_kinds: readonly string[]): Record<string, unknown> {
  return { producer_ref, evidence_kinds: [...evidence_kinds], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" } };
}

/** The v1 rule set's required content, shared by both schemas. */
function v1Core(): Record<string, unknown> {
  return {
    approved_digest_schemes: BOOTSTRAP_SCHEMES.map((s) => ({ ...s })),
    root_public_keys: ROOT_KEYS.map((k) => ({ ...k })),
    attestation_keys: [],
    identity_registry: [identityRow("cadp-workflow", "workflow:cadp-work")],
    adapter_registry: [adapterRow("workflow:cadp-work", ["WORK_STEP"])],
    allocation_purposes: ["work-start"],
    ...BOUNDS,
  };
}

/** A v2 bundle whose five new registries are all empty — B3's "required, may be []". */
function v2Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "cadp.kernel-config.v2",
    ...v1Core(),
    allocation_schema_descriptors: [],
    allocation_schemas: [],
    subject_complete_assembly: [],
    kernel_subject_namespaces: [],
    run_profile_enrolled_requester_refs: [],
    ...overrides,
  };
}

function v1Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "cadp.kernel-config.v1", ...v1Core(), ...overrides };
}

/**
 * The WP-owned `cadp.allocation-key.v1` descriptor (AP B1(4)) with a conforming projection entry:
 * `work_run_ref` {PROJECTED, EFFECT_ID}, `step_ordinal` {ENTROPY, POSITIVE_INTEGER}.
 */
function descriptorV1(): Record<string, unknown> {
  return {
    schema: "cadp.allocation-key.v1",
    fields: [
      { field: "work_run_ref", role: "PROJECTED", value_contract: "EFFECT_ID" },
      { field: "step_ordinal", role: "ENTROPY", value_contract: "POSITIVE_INTEGER" },
    ],
  };
}

function allocationSchemaV1(): Record<string, unknown> {
  return {
    schema: "cadp.allocation-key.v1",
    binding_projection: [{ tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" }],
    purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }],
  };
}

/** A v2 bundle carrying the descriptor/projection pair above, for the B2 controls. */
function v2WithAllocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return v2Config({
    allocation_schema_descriptors: [descriptorV1()],
    allocation_schemas: [allocationSchemaV1()],
    ...overrides,
  });
}

function refusal(cfg: unknown): KernelConfigInvalid {
  try {
    validateKernelConfig(cfg);
  } catch (error) {
    if (error instanceof KernelConfigInvalid) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: "expected KernelConfigInvalid, but the config validated" });
}

function assertRefused(cfg: unknown, reason: string, detail: RegExp, label: string): void {
  const error = refusal(cfg);
  assert.equal(error.reason, reason, `${label}: ${error.message}`);
  assert.match(error.message, detail, label);
}

// ------------------------------------------------------------------ positive controls

test("v2 positive control: a bundle whose five new registries are all empty validates", () => {
  const cfg = validateKernelConfig(v2Config());
  assert.equal(cfg.schema, "cadp.kernel-config.v2");
  assert.deepEqual(cfg.allocation_schema_descriptors, []);
  assert.deepEqual(cfg.allocation_schemas, []);
  assert.deepEqual(cfg.subject_complete_assembly, []);
  assert.deepEqual(cfg.kernel_subject_namespaces, []);
  assert.deepEqual(cfg.run_profile_enrolled_requester_refs, []);
});

test("v2 positive control: a fully-populated bundle — descriptor, projection, assembly, namespaces, enrollment — validates", () => {
  const cfg = validateKernelConfig(
    v2WithAllocation({
      subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: ["PR_CREATE", "PR_MERGE"] }],
      kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }],
      run_profile_enrolled_requester_refs: ["workflow:cadp-work"],
    }),
  );
  assert.equal(cfg.allocation_schemas?.[0]?.schema, "cadp.allocation-key.v1");
});

test("A2 positive control (v1): the unmodified reference kernel-config — replay_idempotency and governed_edge included — validates unchanged", () => {
  const reference = buildReferenceKernelConfig({ policy_id: "cadp-v04:policy:root", revision: 1, root_public_keys: ROOT_KEYS });
  const cfg = validateKernelConfig(reference);
  assert.equal(cfg.schema, "cadp.kernel-config.v1");
  assert.equal(cfg.identity_registry.length, REFERENCE_IDENTITIES.length);
  assert.equal(cfg.adapter_registry.length, REFERENCE_ADAPTERS.length);
  // The governed-writer opt-ins survive: their keys are in B3(3)'s closed adapter set, and the
  // reference bundle stays v1 in this lane, so it reaches none of the v2 rules at all.
  assert.equal(cfg.adapter_registry.at(-1)?.governed_edge, "SUPERSEDES_SINGLETON");
});

// ------------------------------------------------------------------ v1 is untouched (B3(5): the rules are v2's)

test("v1 is byte-identical in behaviour: the v2 rules are not applied to it, and the v2 keys are not in its closed set", () => {
  // Duplicate rows — every leg of A1 — still validate under v1, because B3(1) defines v2.
  validateKernelConfig(v1Config({ identity_registry: [identityRow("p", "a"), identityRow("p", "b")] }));
  validateKernelConfig(v1Config({ identity_registry: [identityRow("p1", "same"), identityRow("p2", "same")] }));
  validateKernelConfig(v1Config({ adapter_registry: [adapterRow("same", ["REVIEW"]), adapterRow("same", ["VERIFICATION"])] }));
  // An unknown key inside an entry still validates under v1, because B3(2) defines v2.
  validateKernelConfig(v1Config({ identity_registry: [{ ...identityRow("p", "a"), "producer-ref": "typo" }] }));
  // And the five v2 keys are refused as unknown TOP-LEVEL keys under v1, by the unchanged rule.
  for (const key of [
    "allocation_schema_descriptors", "allocation_schemas", "subject_complete_assembly",
    "kernel_subject_namespaces", "run_profile_enrolled_requester_refs",
  ]) {
    assertRefused(v1Config({ [key]: [] }), "KERNEL_CONFIG_INVALID", new RegExp(`unknown key data\\.cadp\\.${key} \\(closed schema\\)`, "u"), key);
  }
});

test("the schema string is exact: neither an unknown schema nor a missing one reaches either rule set", () => {
  assertRefused(v1Config({ schema: "cadp.kernel-config.v3" }), "KERNEL_CONFIG_INVALID", /schema must be cadp\.kernel-config\.v1 or cadp\.kernel-config\.v2/u, "v3");
  assertRefused(v1Config({ schema: undefined }), "KERNEL_CONFIG_INVALID", /schema must be/u, "missing");
});

// ------------------------------------------------------------------ A1: registry uniqueness (B3(1))

test("A1: two identity_registry rows sharing a principal are refused REGISTRY_DUPLICATE_KEY", () => {
  assertRefused(
    v2Config({ identity_registry: [identityRow("cadp-workflow", "workflow:a"), identityRow("cadp-workflow", "workflow:b")] }),
    "REGISTRY_DUPLICATE_KEY",
    /two identity_registry entries share principal cadp-workflow/u,
    "A1(i)",
  );
  // Positive control: the same two rows under distinct principals activate.
  validateKernelConfig(v2Config({ identity_registry: [identityRow("cadp-workflow", "workflow:a"), identityRow("cadp-other", "workflow:b")] }));
});

test("A1: two identity_registry rows sharing a producer_ref are refused REGISTRY_DUPLICATE_KEY", () => {
  assertRefused(
    v2Config({
      identity_registry: [identityRow("p1", "workflow:cadp-work", "temporal-workflow"), identityRow("p2", "workflow:cadp-work", "other-product")],
    }),
    "REGISTRY_DUPLICATE_KEY",
    /two identity_registry entries share producer_ref workflow:cadp-work/u,
    "A1(ii)",
  );
});

test("A1: two adapter_registry rows sharing a producer_ref are refused REGISTRY_DUPLICATE_KEY", () => {
  assertRefused(
    v2Config({ adapter_registry: [adapterRow("backend-scan:codex", ["REVIEW"]), adapterRow("backend-scan:codex", ["VERIFICATION"])] }),
    "REGISTRY_DUPLICATE_KEY",
    /two adapter_registry entries share producer_ref backend-scan:codex/u,
    "A1(iii)",
  );
  // Positive control: two distinct producers, same evidence kinds, validate.
  validateKernelConfig(v2Config({ adapter_registry: [adapterRow("backend-scan:codex", ["REVIEW"]), adapterRow("backend-scan:grok", ["REVIEW"])] }));
});

// ------------------------------------------------------------------ A2: closed entry keys (B3(2)/(3))

test("A2: an unknown key INSIDE any registry entry is refused REGISTRY_UNKNOWN_ENTRY_KEY", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["identity_registry producer-ref typo", { identity_registry: [{ ...identityRow("p", "a"), "producer-ref": "a" }] }, /unknown key producer-ref in identity_registry entry/u],
    ["adapter_registry evidence_kind singular", { adapter_registry: [{ ...adapterRow("a", ["REVIEW"]), evidence_kind: "REVIEW" }] }, /unknown key evidence_kind in adapter_registry entry/u],
    ["root_public_keys extra", { root_public_keys: [{ ...ROOT_KEYS[0], rotated: true }] }, /unknown key rotated in root_public_keys entry/u],
    ["approved_digest_schemes extra", { approved_digest_schemes: [...BOOTSTRAP_SCHEMES, { algorithm: "sha512", canonicalization: "raw-bytes-1", preferred: true }] }, /unknown key preferred in approved_digest_schemes entry/u],
    ["attestation_keys extra", { attestation_keys: [{ key_id: "k", alg: "Ed25519", public_key: "AAAA", purpose: "identity-probe", valid_from: "2026-01-01T00:00:00.000Z", scope: "all" }] }, /unknown key scope in attestation_keys entry/u],
    ["nested identity_class", { identity_registry: [{ principal: "p", producer_ref: "a", identity_class: { vendor: "v", product: "p", account: "a", process_class: "workflow", tier: "gold" } }] }, /unknown key tier in identity_registry\.identity_class entry/u],
    ["nested produced_at_source", { adapter_registry: [{ producer_ref: "a", evidence_kinds: ["REVIEW"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE", fallback: "now" } }] }, /unknown key fallback in adapter_registry\.produced_at_source entry/u],
    ["subject_complete_assembly extra", { subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: [], optional: true }] }, /unknown key optional in subject_complete_assembly entry/u],
    ["kernel_subject_namespaces extra", { kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04", exact: true }] }, /unknown key exact in kernel_subject_namespaces entry/u],
  ];
  for (const [label, override, detail] of cases) {
    assertRefused(v2Config(override), "REGISTRY_UNKNOWN_ENTRY_KEY", detail, label);
  }
});

test("A2: nested entry key sets are closed identically — descriptor fields, binding_projection, purpose_relation", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "descriptor entry",
      { allocation_schema_descriptors: [{ ...descriptorV1(), version: 1 }], allocation_schemas: [allocationSchemaV1()] },
      /unknown key version in allocation_schema_descriptors entry/u,
    ],
    [
      "descriptor field entry",
      {
        allocation_schema_descriptors: [{ schema: "cadp.allocation-key.v1", fields: [{ field: "work_run_ref", role: "PROJECTED", value_contract: "EFFECT_ID", nullable: false }] }],
        allocation_schemas: [allocationSchemaV1()],
      },
      /unknown key nullable in allocation_schema_descriptors\.fields entry/u,
    ],
    [
      "allocation_schemas entry",
      { allocation_schema_descriptors: [descriptorV1()], allocation_schemas: [{ ...allocationSchemaV1(), note: "x" }] },
      /unknown key note in allocation_schemas entry/u,
    ],
    [
      "binding_projection entry",
      {
        allocation_schema_descriptors: [descriptorV1()],
        allocation_schemas: [{ ...allocationSchemaV1(), binding_projection: [{ tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run", revision_or_version: "1" }] }],
      },
      /unknown key revision_or_version in allocation_schemas\.binding_projection entry/u,
    ],
    [
      "purpose_relation entry",
      {
        allocation_schema_descriptors: [descriptorV1()],
        allocation_schemas: [{ ...allocationSchemaV1(), purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START", target_type: "WORK" }] }],
      },
      /unknown key target_type in allocation_schemas\.purpose_relation entry/u,
    ],
  ];
  for (const [label, override, detail] of cases) {
    assertRefused(v2Config(override), "REGISTRY_UNKNOWN_ENTRY_KEY", detail, label);
  }
});

// ------------------------------------------------------------------ the five new v2 keys (B3(3) inventory)

test("each of the five v2 keys is REQUIRED, and each may be []", () => {
  for (const key of [
    "allocation_schema_descriptors", "allocation_schemas", "subject_complete_assembly",
    "kernel_subject_namespaces", "run_profile_enrolled_requester_refs",
  ]) {
    const cfg = v2Config();
    delete cfg[key];
    assertRefused(cfg, "KERNEL_CONFIG_INVALID", new RegExp(`${key} required \\(may be \\[\\]\\)`, "u"), key);
    // Non-array is refused by the same rule.
    assertRefused(v2Config({ [key]: {} }), "KERNEL_CONFIG_INVALID", new RegExp(`${key} required \\(may be \\[\\]\\)`, "u"), `${key} non-array`);
  }
});

test("run_profile_enrolled_requester_refs members are exact strings with no entry object and no patterns (B5(3), B3(3))", () => {
  assertRefused(
    v2Config({ run_profile_enrolled_requester_refs: ["workflow:*"], kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }] }),
    "KERNEL_CONFIG_INVALID",
    /run_profile_enrolled_requester_refs members must be exact requester_refs \(no patterns\)/u,
    "wildcard",
  );
  assertRefused(
    v2Config({ run_profile_enrolled_requester_refs: [{ requester_ref: "workflow:cadp-work" }], kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }] }),
    "KERNEL_CONFIG_INVALID",
    /run_profile_enrolled_requester_refs members must be exact requester_refs/u,
    "entry object",
  );
  // Positive control: an exact requester_ref, with the work-run declaration B3(4)(c) requires.
  validateKernelConfig(
    v2Config({ run_profile_enrolled_requester_refs: ["workflow:cadp-work"], kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }] }),
  );
});

// ------------------------------------------------------------------ descriptor validation (B2(2)(i))

test("descriptor field entries have exactly three members, all required", () => {
  for (const [label, fieldEntry] of [
    ["no role", { field: "work_run_ref", value_contract: "EFFECT_ID" }],
    ["no value_contract", { field: "work_run_ref", role: "PROJECTED" }],
    ["no field", { role: "PROJECTED", value_contract: "EFFECT_ID" }],
  ] as Array<[string, Record<string, unknown>]>) {
    assertRefused(
      v2Config({
        allocation_schema_descriptors: [{ schema: "s", fields: [fieldEntry] }],
        allocation_schemas: [{ schema: "s", binding_projection: [], purpose_relation: [] }],
      }),
      "KERNEL_CONFIG_INVALID",
      /allocation_schema_descriptors\.fields \w+ must be a string/u,
      label,
    );
  }
});

test("role is the closed two-value vocabulary and value_contract the closed three-value one", () => {
  assertRefused(
    v2Config({
      allocation_schema_descriptors: [{ schema: "s", fields: [{ field: "f", role: "DERIVED", value_contract: "EFFECT_ID" }] }],
      allocation_schemas: [{ schema: "s", binding_projection: [], purpose_relation: [] }],
    }),
    "KERNEL_CONFIG_INVALID",
    /field f role must be one of PROJECTED, ENTROPY/u,
    "role",
  );
  assertRefused(
    v2Config({
      allocation_schema_descriptors: [{ schema: "s", fields: [{ field: "f", role: "ENTROPY", value_contract: "NONNEGATIVE_INTEGER" }] }],
      allocation_schemas: [{ schema: "s", binding_projection: [], purpose_relation: [] }],
    }),
    "KERNEL_CONFIG_INVALID",
    /field f value_contract must be one of POSITIVE_INTEGER, NONEMPTY_STRING, EFFECT_ID/u,
    "value_contract",
  );
  // Positive control: all three contracts, both roles, validate.
  validateKernelConfig(
    v2Config({
      allocation_schema_descriptors: [{
        schema: "s",
        fields: [
          { field: "a", role: "ENTROPY", value_contract: "POSITIVE_INTEGER" },
          { field: "b", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
          { field: "c", role: "PROJECTED", value_contract: "EFFECT_ID" },
        ],
      }],
      allocation_schemas: [{
        schema: "s",
        binding_projection: [
          { tuple_field: "b", authority_ref: "github.com", namespace: "commit" },
          { tuple_field: "c", authority_ref: "cadp-store:k04", namespace: "work-run" },
        ],
        purpose_relation: [],
      }],
    }),
  );
});

test("a descriptor naming a reserved field (schema, purpose) is refused", () => {
  for (const reserved of ["schema", "purpose"]) {
    assertRefused(
      v2Config({
        allocation_schema_descriptors: [{ schema: "s", fields: [{ field: reserved, role: "ENTROPY", value_contract: "NONEMPTY_STRING" }] }],
        allocation_schemas: [{ schema: "s", binding_projection: [], purpose_relation: [] }],
      }),
      "KERNEL_CONFIG_INVALID",
      new RegExp(`names reserved kernel field ${reserved}`, "u"),
      reserved,
    );
  }
});

test("duplicate schema across descriptor entries, and duplicate field within one entry, are REGISTRY_DUPLICATE_KEY", () => {
  assertRefused(
    v2Config({
      allocation_schema_descriptors: [descriptorV1(), descriptorV1()],
      allocation_schemas: [allocationSchemaV1()],
    }),
    "REGISTRY_DUPLICATE_KEY",
    /two allocation_schema_descriptors entries share schema cadp\.allocation-key\.v1/u,
    "duplicate schema",
  );
  assertRefused(
    v2Config({
      allocation_schema_descriptors: [{
        schema: "s",
        fields: [
          { field: "dup", role: "ENTROPY", value_contract: "NONEMPTY_STRING" },
          { field: "dup", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
        ],
      }],
      allocation_schemas: [{ schema: "s", binding_projection: [], purpose_relation: [] }],
    }),
    "REGISTRY_DUPLICATE_KEY",
    /two allocation_schema_descriptors s fields entries share field dup/u,
    "duplicate field",
  );
});

// ------------------------------------------------------------------ projection coverage (B2(2)(iii), B2(5))

test("B2(5): a schema missing EITHER entry is refused ALLOCATION_SCHEMA_UNREGISTERED", () => {
  assertRefused(
    v2Config({ allocation_schema_descriptors: [], allocation_schemas: [allocationSchemaV1()] }),
    "ALLOCATION_SCHEMA_UNREGISTERED",
    /allocation_schemas cadp\.allocation-key\.v1 has no allocation_schema_descriptors entry/u,
    "no descriptor",
  );
  assertRefused(
    v2Config({ allocation_schema_descriptors: [descriptorV1()], allocation_schemas: [] }),
    "ALLOCATION_SCHEMA_UNREGISTERED",
    /allocation_schema_descriptors cadp\.allocation-key\.v1 has no allocation_schemas entry/u,
    "no allocation_schemas entry",
  );
  // Positive control: the pair together validates.
  validateKernelConfig(v2WithAllocation());
});

test("B2(2)(iii): every PROJECTED field has exactly one mapping, no ENTROPY field has any, none names a non-descriptor field", () => {
  // A PROJECTED field with no mapping — the peer-contract leg of the AP's binding control.
  assertRefused(
    v2WithAllocation({ allocation_schemas: [{ ...allocationSchemaV1(), binding_projection: [] }] }),
    "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
    /field work_run_ref is PROJECTED and has 0 binding_projection entries \(expected 1\)/u,
    "PROJECTED unmapped",
  );
  // An ENTROPY field with a mapping — v1's `step_ordinal`, which is projected nowhere.
  assertRefused(
    v2WithAllocation({
      allocation_schemas: [{
        ...allocationSchemaV1(),
        binding_projection: [
          { tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" },
          { tuple_field: "step_ordinal", authority_ref: "cadp-store:k04", namespace: "step" },
        ],
      }],
    }),
    "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
    /field step_ordinal is ENTROPY and has 1 binding_projection entries \(expected 0\)/u,
    "ENTROPY mapped",
  );
  // A mapping naming a field outside the descriptor — which disposes of the reserved names too.
  for (const outside of ["candidate_sha", "purpose", "schema"]) {
    assertRefused(
      v2WithAllocation({
        allocation_schemas: [{
          ...allocationSchemaV1(),
          binding_projection: [
            { tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" },
            { tuple_field: outside, authority_ref: "github.com", namespace: "commit" },
          ],
        }],
      }),
      "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
      new RegExp(`binding_projection names ${outside}, which is not a descriptor field`, "u"),
      `outside: ${outside}`,
    );
  }
});

test("within one allocation_schemas entry: duplicate tuple_field, duplicate target pair and duplicate purpose are REGISTRY_DUPLICATE_KEY", () => {
  assertRefused(
    v2WithAllocation({
      allocation_schemas: [{
        ...allocationSchemaV1(),
        binding_projection: [
          { tuple_field: "work_run_ref", authority_ref: "cadp-store:k04", namespace: "work-run" },
          { tuple_field: "work_run_ref", authority_ref: "other", namespace: "work-run" },
        ],
      }],
    }),
    "REGISTRY_DUPLICATE_KEY",
    /binding_projection entries share tuple_field work_run_ref/u,
    "duplicate tuple_field",
  );
  // Two DIFFERENT tuple_fields onto one (authority_ref, namespace) target — the authoring-side
  // half of B2(3.4)'s exactly-one rule, refused before it can become a permanent seal failure.
  assertRefused(
    v2Config({
      allocation_schema_descriptors: [{
        schema: "s",
        fields: [
          { field: "a", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
          { field: "b", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
        ],
      }],
      allocation_schemas: [{
        schema: "s",
        binding_projection: [
          { tuple_field: "a", authority_ref: "github.com", namespace: "commit" },
          { tuple_field: "b", authority_ref: "github.com", namespace: "commit" },
        ],
        purpose_relation: [],
      }],
    }),
    "REGISTRY_DUPLICATE_KEY",
    /binding_projection entries share \(authority_ref, namespace\) target/u,
    "duplicate target pair",
  );
  // The same two fields on DISTINCT targets validate — the refusal is the target pair's, not the count's.
  validateKernelConfig(
    v2Config({
      allocation_schema_descriptors: [{
        schema: "s",
        fields: [
          { field: "a", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
          { field: "b", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
        ],
      }],
      allocation_schemas: [{
        schema: "s",
        binding_projection: [
          { tuple_field: "a", authority_ref: "github.com", namespace: "commit" },
          { tuple_field: "b", authority_ref: "github.com", namespace: "base-commit" },
        ],
        purpose_relation: [],
      }],
    }),
  );
  assertRefused(
    v2WithAllocation({
      allocation_schemas: [{
        ...allocationSchemaV1(),
        purpose_relation: [
          { purpose: "work-start", operation_kind: "WORK_START" },
          { purpose: "work-start", operation_kind: "PR_CREATE" },
        ],
      }],
    }),
    "REGISTRY_DUPLICATE_KEY",
    /purpose_relation entries share purpose work-start/u,
    "duplicate purpose",
  );
});

test("two allocation_schemas rows sharing a schema are refused REGISTRY_DUPLICATE_KEY", () => {
  assertRefused(
    v2Config({ allocation_schema_descriptors: [descriptorV1()], allocation_schemas: [allocationSchemaV1(), allocationSchemaV1()] }),
    "REGISTRY_DUPLICATE_KEY",
    /two allocation_schemas entries share schema cadp\.allocation-key\.v1/u,
    "duplicate allocation_schemas schema",
  );
});

// ------------------------------------------------------------------ B3(4): kernel namespaces and the cross-field invariant

test("kernel_subject_namespaces is unique per namespace (B3(4)(a) under B3(1))", () => {
  assertRefused(
    v2Config({
      kernel_subject_namespaces: [
        { namespace: "work-run", authority_ref: "cadp-store:k04" },
        { namespace: "work-run", authority_ref: "other" },
      ],
    }),
    "REGISTRY_DUPLICATE_KEY",
    /two kernel_subject_namespaces entries share namespace work-run/u,
    "duplicate namespace",
  );
});

test("B3(4)(c): a non-empty run profile with no work-run declaration is refused KERNEL_NAMESPACE_UNDECLARED", () => {
  assertRefused(
    v2Config({ run_profile_enrolled_requester_refs: ["workflow:cadp-work"], kernel_subject_namespaces: [] }),
    "KERNEL_NAMESPACE_UNDECLARED",
    /run_profile_enrolled_requester_refs is non-empty but no kernel_subject_namespaces entry declares work-run/u,
    "no declaration at all",
  );
  // A declaration of some OTHER namespace does not arm the work-run lock either.
  assertRefused(
    v2Config({
      run_profile_enrolled_requester_refs: ["workflow:cadp-work"],
      kernel_subject_namespaces: [{ namespace: "commit", authority_ref: "github.com" }],
    }),
    "KERNEL_NAMESPACE_UNDECLARED",
    /no kernel_subject_namespaces entry declares work-run/u,
    "wrong namespace declared",
  );
  // Positive control, so the refusal is attributed to the omission and not to the enrollment:
  // the same bundle with the declaration added validates.
  validateKernelConfig(
    v2Config({
      run_profile_enrolled_requester_refs: ["workflow:cadp-work"],
      kernel_subject_namespaces: [{ namespace: "work-run", authority_ref: "cadp-store:k04" }],
    }),
  );
  // And an EMPTY run profile needs no declaration — the invariant binds only an enabled profile.
  validateKernelConfig(v2Config({ run_profile_enrolled_requester_refs: [], kernel_subject_namespaces: [] }));
});

// ------------------------------------------------------------------ shape rules on the new registries

test("the new registries' entries are objects with string members", () => {
  assertRefused(v2Config({ kernel_subject_namespaces: ["work-run"] }), "KERNEL_CONFIG_INVALID", /kernel_subject_namespaces\[0\] must be an object/u, "namespace string");
  assertRefused(
    v2Config({ subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: "PR_CREATE" }] }),
    "KERNEL_CONFIG_INVALID",
    /subject_complete_assembly operation_kinds must be an array of strings/u,
    "operation_kinds string",
  );
  assertRefused(
    v2Config({ subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: [{ operation_kind: "PR_CREATE" }] }] }),
    "KERNEL_CONFIG_INVALID",
    /subject_complete_assembly operation_kinds must be an array of strings/u,
    "operation_kinds entry object",
  );
  assertRefused(
    v2Config({ kernel_subject_namespaces: [{ namespace: "work-run" }] }),
    "KERNEL_CONFIG_INVALID",
    /kernel_subject_namespaces authority_ref must be a string/u,
    "missing authority_ref",
  );
});
