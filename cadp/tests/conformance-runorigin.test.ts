/**
 * AP B1(5)/B2(2)(ii)/B5 part 1 — the run-capability mechanism's ALLOCATION, CONFIG, STORAGE and
 * MINTING half, plus WP §3.6's `cadp.allocation-key.run-origin.v1`.
 *
 * What this file asserts, and nothing more (seal-time capability presentation, the
 * `x-cadp-run-capability` header, recheck #19 and the enrollment refusals are a later lane):
 *  - the run-origin schema validates as ordinary descriptor/mapping data — the Kernel names the
 *    schema STRING and never the field `origin_key` (B2(2)(ii) honest scope);
 *  - its allocation contract is IMMUTABLE for the store's lifetime: a changed OR DELETED descriptor
 *    entry or `allocation_schemas` entry is refused `SCHEMA_DESCRIPTOR_CHANGED` at activation, and
 *    a DELETION is refused as that and never as `ALLOCATION_SCHEMA_UNREGISTERED` (the precedence
 *    leg), with the caller-visible consequence — one `origin_key` → one `effect_id` across an
 *    intervening unrelated `POLICY_ACTIVATE` (B1(5), WP control 13);
 *  - `is_run_origin` (B5(9)): a self-bound `WORK_START` seals and writes the durable
 *    `run_membership(E, E)` witness; a `WORK_START` binding ANOTHER run is refused
 *    `RUN_CAPABILITY_INVALID` even when that run's capability row exists and is valid;
 *  - minting (B5(1), B6(4)): WITNESSED, requester-verified, once, at the initial dispatch only —
 *    and the secret is stored nowhere, logged nowhere, and never in an error message.
 * The last test is the complementary claim: under `cadp.kernel-config.v1` none of it runs.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { sha256Hex } from "../kernel/canonical.ts";
import { validateKernelConfig, KernelConfigInvalid } from "../kernel/policyBundle.ts";
import type { AllocationTuple, Principal } from "../kernel/ingress.ts";
import type { SubjectBinding, TargetRef } from "../kernel/records.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "../kernel/adapters/types.ts";
import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import {
  DEFAULT_WORK_RUN_REF, PRINCIPALS, V2_ALLOCATION_SCHEMAS, V2_ALLOCATION_SCHEMA_DESCRIPTORS, makeHarness,
  stopSharedOpa, v2ConfigOverrides,
} from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

after(() => stopSharedOpa());

const RUN_ORIGIN_SCHEMA = "cadp.allocation-key.run-origin.v1";
const REQUESTER_A = "workflow:cadp-work";
const REQUESTER_B = "workflow:cadp-work-b";

/** A second `workflow`-class principal: the non-owner of every dispatch-verification leg below. */
const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: REQUESTER_B,
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};

/**
 * WP §3.6's wire shape as BUNDLE DATA: `origin_key` is the schema's single non-reserved field,
 * `{ENTROPY, NONEMPTY_STRING}`, and `binding_projection` is `[]` because nothing is `PROJECTED` —
 * the origin's self-binding is not an allocation projection at all, it is B5(9)'s seal-time rule.
 */
const RUN_ORIGIN_DESCRIPTOR = {
  schema: RUN_ORIGIN_SCHEMA,
  fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "NONEMPTY_STRING" }],
};

const RUN_ORIGIN_MAPPING = {
  schema: RUN_ORIGIN_SCHEMA,
  binding_projection: [],
  purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }],
};

const WORK_RUN_AUTHORITY = "cadp-store:k04";
const WORK_START_TARGET: TargetRef = { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "cadp-v04" };

/** A `WORK_START`-capable target: the reference policy plain-allows a well-bounded WORK_START. */
class WorkStartTarget implements TargetAdapterV1 {
  readonly operations: AdapterOperation[] = [
    {
      operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", available: true,
      idempotency: "NONE", dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: true,
    },
  ];

  /** Per-ordinal script: undefined ⇒ ACCEPTED. */
  onDispatch: ((effect_id: string, ordinal: number) => DispatchResult | undefined) | undefined;

  describe() {
    return { target_type: WORK_START_TARGET.target_type, authority_ref: WORK_START_TARGET.authority_ref, operations: this.operations };
  }

  serialization_domain(): string {
    return "work-start-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: WORK_START_TARGET, claim: { namespace: WORK_START_TARGET.target_id } };
  }

  async current_revision(subject: SubjectBinding): Promise<RevisionRead> {
    return { revision_or_version: subject.revision_or_version, availability: "PRESENT" };
  }

  async verify_material(): Promise<void> {}

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(effect_id: string, ordinal: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<DispatchResult> {
    return this.onDispatch?.(effect_id, ordinal) ?? {
      kind: "ACCEPTED",
      target_operation_ref: `workflow-${effect_id}-${ordinal}`,
      receipt_claim: { bounds: material["bounds"] },
    };
  }

  async reconcile(): Promise<ReconcileResult> {
    return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { authoritative_absence: true, read_authority: "primary" } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return JSON.stringify(receipt["bounds"]) === JSON.stringify(material["bounds"]);
  }
}

/** The five v2 registries with the run-origin contract added to the two allocation ones. */
function runOriginConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return v2ConfigOverrides({
    allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, RUN_ORIGIN_DESCRIPTOR],
    allocation_schemas: [...V2_ALLOCATION_SCHEMAS, RUN_ORIGIN_MAPPING],
    ...overrides,
  });
}

interface OriginHarness {
  h: Harness;
  workflowTarget: WorkStartTarget;
}

async function originHarness(v2 = true): Promise<OriginHarness> {
  const workflowTarget = new WorkStartTarget();
  const h = await makeHarness({
    identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B],
    extraAdapters: [workflowTarget],
    ...(v2 ? { configOverrides: runOriginConfig() as never } : {}),
  });
  h.sealReach();
  await h.sealTargetIdentity();
  await h.pep.refreshTargetIdentity(workflowTarget);
  return { h, workflowTarget };
}

function originTuple(origin_key: string): AllocationTuple {
  return { schema: RUN_ORIGIN_SCHEMA, origin_key, purpose: "work-start" };
}

function workStartMaterial(h: Harness): string {
  return h.ingress.putBlob(Buffer.from(JSON.stringify({ bounds: { max_steps: 4, max_effects: 3 } }), "utf8"));
}

/** Allocate under run-origin.v1 and seal the `WORK_START` — self-bound unless `workRun` says otherwise. */
function sealOrigin(
  h: Harness,
  options: { origin_key: string; principal?: Principal; requester_ref?: string; workRun?: string; bindings?: SubjectBinding[] },
): { effect_id: string; tuple: AllocationTuple } {
  const principal = options.principal ?? PRINCIPALS.workflow;
  const tuple = originTuple(options.origin_key);
  const effect_id = h.ingress.allocateEffectId(tuple, principal);
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: options.bindings ?? [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: options.workRun ?? effect_id }],
      target_ref: WORK_START_TARGET,
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: workStartMaterial(h),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    principal,
  );
  return { effect_id, tuple };
}

async function dispatch(h: Harness, effect_id: string, principal?: Principal) {
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION", JSON.stringify(evaluated));
  const decision = (evaluated as { decision: { outcome: string; decision_id: string } }).decision;
  assert.equal(decision.outcome, "ALLOW", JSON.stringify(decision));
  return h.pep.admitAndDispatch(effect_id, decision.decision_id, principal === undefined ? {} : { principal });
}

function capabilityOf(result: unknown): string | undefined {
  return (result as { run_capability?: string }).run_capability;
}

/** Every text-bearing row of the store, for the "the secret exists nowhere durable" control. */
function storeText(h: Harness): string {
  const tables = [
    "run_capability", "run_membership", "effect_request", "effect_allocation", "evidence_envelope",
    "effect_admission", "effect_outcome", "admission_input", "policy_decision", "cas_blob",
  ];
  const parts: string[] = [];
  for (const table of tables) {
    for (const row of h.store.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const value of Object.values(row)) {
        parts.push(value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value));
      }
    }
  }
  return parts.join(" ");
}

function refusalDetail(result: unknown): string {
  return `${(result as { reason?: string }).reason ?? ""}: ${(result as { detail?: string }).detail ?? ""}`;
}

// ================================================================ B2(2) — the schema as bundle data

test("WP §3.6/B2(5): the run-origin schema validates as ordinary descriptor + mapping data", () => {
  const cfg = validateKernelConfig(runOriginConfigForValidation());
  const descriptor = cfg.allocation_schema_descriptors?.find((d) => d.schema === RUN_ORIGIN_SCHEMA);
  assert.deepEqual(descriptor?.fields, [{ field: "origin_key", role: "ENTROPY", value_contract: "NONEMPTY_STRING" }]);
  const mapping = cfg.allocation_schemas?.find((s) => s.schema === RUN_ORIGIN_SCHEMA);
  assert.deepEqual(mapping?.binding_projection, [], "no field is PROJECTED, so the tuple projects nothing");
  assert.deepEqual(mapping?.purpose_relation, [{ purpose: "work-start", operation_kind: "WORK_START" }]);

  // B2(2)(iii)'s coverage rule is satisfied by the EMPTY projection precisely because the only
  // field is ENTROPY — and projecting it would be refused, generically, with no schema named.
  assert.throws(
    () => validateKernelConfig(runOriginConfigForValidation({
      allocation_schemas: [{ ...RUN_ORIGIN_MAPPING, binding_projection: [{ tuple_field: "origin_key", authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run" }] }],
    })),
    (error: unknown) =>
      error instanceof KernelConfigInvalid && error.reason === "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
  );
});

/** A minimal, self-contained v2 `data.cadp` for the validation-layer cases above. */
function runOriginConfigForValidation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "cadp.kernel-config.v2",
    approved_digest_schemes: [
      { algorithm: "sha256", canonicalization: "raw-bytes-1" },
      { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
      { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1" },
    ],
    root_public_keys: [{ key_id: "root-1", alg: "Ed25519", public_key: "cm9vdA==", valid_from: "2026-01-01T00:00:00.000Z" }],
    attestation_keys: [],
    identity_registry: [REFERENCE_IDENTITIES[0]],
    adapter_registry: [],
    allocation_purposes: ["work-start"],
    allocation_schema_descriptors: [RUN_ORIGIN_DESCRIPTOR],
    allocation_schemas: [RUN_ORIGIN_MAPPING],
    subject_complete_assembly: [],
    kernel_subject_namespaces: [],
    run_profile_enrolled_requester_refs: [],
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
    ...overrides,
  };
}

// ================================================================ B2(2)(ii) — lifetime immutability

test("B2(2)(ii): once activated, the run-origin descriptor AND mapping are immutable — change or deletion is SCHEMA_DESCRIPTOR_CHANGED", async () => {
  const { h } = await originHarness();
  try {
    // Positive control: an unrelated activation carrying the byte-identical contract activates, so
    // every refusal below is attributed to the run-origin entry and not to activation itself.
    const clean = await h.activatePolicy({
      revision: 2,
      configOverrides: {
        identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B, {
          principal: "cadp-workflow-c", producer_ref: "workflow:cadp-work-c", identity_class: { ...IDENTITY_B.identity_class },
        }],
      } as never,
    });
    assert.equal((clean.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(clean.admitted));
    assert.equal(h.store.activeActivation()!.revision, 2);

    const cases: Array<{ note: string; overrides: Record<string, unknown> }> = [
      {
        note: "mapping entry changed (a second purpose_relation pair)",
        overrides: {
          allocation_schemas: [...V2_ALLOCATION_SCHEMAS, {
            ...RUN_ORIGIN_MAPPING,
            purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }, { purpose: "record-write", operation_kind: "SCRIPTED_WRITE" }],
          }],
        },
      },
      {
        note: "descriptor entry changed (the field renamed)",
        overrides: {
          allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, {
            schema: RUN_ORIGIN_SCHEMA,
            fields: [{ field: "origin_discriminator", role: "ENTROPY", value_contract: "NONEMPTY_STRING" }],
          }],
        },
      },
      {
        note: "mapping entry REMOVED (descriptor retained)",
        overrides: { allocation_schemas: [...V2_ALLOCATION_SCHEMAS] },
      },
    ];

    let revision = 3;
    for (const { note, overrides } of cases) {
      const refused = await h.activatePolicy({ revision, configOverrides: overrides as never });
      const admitted = refused.admitted as { kind: string; reason?: string; detail?: string };
      assert.equal(admitted.kind, "REFUSAL", `${note}: ${JSON.stringify(refused.admitted)}`);
      assert.equal(admitted.reason, "KERNEL_CONFIG_INVALID", note);
      assert.match(String(admitted.detail), /SCHEMA_DESCRIPTOR_CHANGED: /u, note);
      assert.equal(h.store.policyRef("cadp-v04:policy:root", revision), undefined, `${note}: no publication`);
      assert.equal(h.store.activeActivation()!.revision, 2, `${note}: active policy unchanged`);
      revision += 1;
    }

    // PRECEDENCE (B2(2)(ii), B2(8)): deleting the DESCRIPTOR while the mapping stays is exactly the
    // shape `assertProjectionCoverage` would call ALLOCATION_SCHEMA_UNREGISTERED. The immutability
    // comparison runs first, so it is refused as the prohibited MUTATION of an activated contract
    // — a deletion misreported as "a schema that was never registered" would be the wrong fact.
    const deleted = await h.activatePolicy({
      revision,
      configOverrides: { allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS] } as never,
    });
    const admitted = deleted.admitted as { kind: string; reason?: string; detail?: string };
    assert.equal(admitted.kind, "REFUSAL", JSON.stringify(deleted.admitted));
    assert.match(String(admitted.detail), /SCHEMA_DESCRIPTOR_CHANGED: /u, "the deletion is the prohibited mutation");
    assert.doesNotMatch(String(admitted.detail), /ALLOCATION_SCHEMA_UNREGISTERED/u, "never reported as an absence");
    assert.equal(h.store.activeActivation()!.revision, 2, "active policy unchanged");
  } finally {
    h.close();
  }
});

test("B1(5)/WP control 13: one origin_key → one effect_id, across an intervening unrelated POLICY_ACTIVATE", async () => {
  const { h } = await originHarness();
  try {
    const tuple = originTuple("origin-key-stable-1");
    const first = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);

    const activated = await h.activatePolicy({
      revision: 2,
      configOverrides: {
        identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B, {
          principal: "cadp-workflow-c", producer_ref: "workflow:cadp-work-c", identity_class: { ...IDENTITY_B.identity_class },
        }],
      } as never,
    });
    assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));

    // The contract cannot have drifted — it is immutable — so the contract-scoped key of B1(2)
    // takes the same value and the same origin converges on the SAME effect_id, one row.
    assert.equal(h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow), first, "the same origin, the same identity");
    const rows = h.store.db
      .prepare("SELECT COUNT(*) AS n FROM effect_allocation WHERE allocation_schema = ?")
      .get(RUN_ORIGIN_SCHEMA) as { n: number };
    assert.equal(rows.n, 1, "exactly one allocation for that origin, for the store's lifetime");

    // Distinctness is by origin_key, never by content: a second logical origin is a second identity.
    assert.notEqual(h.ingress.allocateEffectId(originTuple("origin-key-stable-2"), PRINCIPALS.workflow), first);
    // And it is requester-scoped like every other schema's key (B1(2)).
    assert.notEqual(h.ingress.allocateEffectId(tuple, PRINCIPAL_B), first);
  } finally {
    h.close();
  }
});

// ================================================================ B5(9) — is_run_origin

test("B5(9): a self-bound WORK_START is adjudicated an origin — it seals and writes run_membership(E, E)", async () => {
  const { h } = await originHarness();
  try {
    const { effect_id } = sealOrigin(h, { origin_key: "origin-a" });
    assert.equal(h.store.effectRequest(effect_id)?.effect_id, effect_id, "the origin seals");
    const witness = h.store.runMembership(effect_id);
    assert.equal(witness?.effect_id, effect_id, "the durable witness is written in the sealing transaction");
    assert.equal(witness?.work_run_ref, effect_id, "and it is SELF-referential — B5(1)(b)'s minting witness");
    // Identity only: originating a scope mints nothing at seal (B5(9), B5(1)).
    assert.equal(h.store.runCapability(effect_id), undefined, "no capability exists before the initial dispatch");

    // B2(5): the entry's `purpose_relation` is TOTAL over the purposes this schema may allocate —
    // exactly the one `work-start` ↔ `WORK_START` pair — so any other purpose is refused at
    // allocation, before any row exists, by the generic rule that names no schema.
    assert.throws(
      () => h.ingress.allocateEffectId({ ...originTuple("origin-a"), purpose: "record-write" }, PRINCIPALS.workflow),
      (error: unknown) => (error as { reason?: string }).reason === "ALLOCATION_PURPOSE_NOT_REGISTERED",
    );
    // And `origin_key` is checked against its descriptor's NONEMPTY_STRING contract, never parsed.
    assert.throws(
      () => h.ingress.allocateEffectId(originTuple(""), PRINCIPALS.workflow),
      (error: unknown) => (error as { reason?: string }).reason === "ALLOCATION_TUPLE_INVALID",
    );
  } finally {
    h.close();
  }
});

test("B5(9): a WORK_START binding ANOTHER run is refused RUN_CAPABILITY_INVALID — even with that run's valid capability row present", async () => {
  const { h } = await originHarness();
  try {
    // A genuine, dispatched origin: `run_capability(R1)` exists, holder matches, K7 is COMMITTED.
    const { effect_id: r1 } = sealOrigin(h, { origin_key: "origin-r1" });
    const admitted = await dispatch(h, r1, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", refusalDetail(admitted));
    assert.ok(h.store.runCapability(r1) !== undefined, "R1 holds a valid capability row");

    // A second WORK_START, allocated under run-origin.v1 by the same requester, binding R1's run.
    const tuple = originTuple("origin-r2");
    const r2 = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    assert.throws(
      () => h.ingress.sealEffectRequest(
        {
          effect_id: r2, requester_ref: REQUESTER_A,
          work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: r1 }],
          target_ref: WORK_START_TARGET, operation_kind: "WORK_START", material_schema: "cadp.work-start.v1",
          material_ref: workStartMaterial(h), prior_effect_refs: [], allocation_tuple: tuple,
        },
        PRINCIPALS.workflow,
      ),
      (error: unknown) => {
        assert.equal((error as { reason?: string }).reason, "RUN_CAPABILITY_INVALID", String((error as Error).message));
        return true;
      },
      "ORIGIN-OR-REFUSED: possession of a valid capability never carries a WORK_START down the member path",
    );
    assert.equal(h.store.effectRequest(r2), undefined, "no effect_request row");
    assert.equal(h.store.runMembership(r2), undefined, "no membership proof");
    assert.equal(h.store.runCapability(r2), undefined, "no capability row");
    assert.equal(h.store.openIncidents().length, 0, "a caller error against another's run raises no incident and holds no scope");

    // R1's own run is untouched by the attempt.
    assert.equal(h.store.runMembership(r1)?.work_run_ref, r1);
    assert.equal(h.store.runCapability(r1)!.holder_ref, REQUESTER_A);
  } finally {
    h.close();
  }
});

test("B5(1)(α): an ordinary WORK_START carries no witness — its verified initial dispatch mints nothing", async () => {
  const { h } = await originHarness();
  try {
    // Not run-bound at all: (9) never adjudicates it, so no `run_membership(E, E)` exists. This is
    // exactly the request B5(1)(α) names, and the witnessed predicate is what keeps it non-minting.
    const tuple = originTuple("origin-unbound");
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    h.ingress.sealEffectRequest(
      {
        effect_id, requester_ref: REQUESTER_A, work_bindings: [],
        target_ref: WORK_START_TARGET, operation_kind: "WORK_START", material_schema: "cadp.work-start.v1",
        material_ref: workStartMaterial(h), prior_effect_refs: [], allocation_tuple: tuple,
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.runMembership(effect_id), undefined, "no witness");

    const admitted = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", refusalDetail(admitted));
    assert.equal(capabilityOf(admitted), undefined, "shape alone is not minting");
    assert.equal(h.store.runCapability(effect_id), undefined, "no run_capability row is ever written for it");
  } finally {
    h.close();
  }
});

// ================================================================ B5(1)/B6(4) — minting and delivery

test("B5(1): admit_and_dispatch by anyone but the sealed requester is WORK_START_DISPATCH_REQUESTER_MISMATCH — nothing minted", async () => {
  const { h, workflowTarget } = await originHarness();
  try {
    const { effect_id } = sealOrigin(h, { origin_key: "origin-mismatch" });
    const refused = await dispatch(h, effect_id, PRINCIPAL_B);
    assert.equal(refused.kind, "REFUSAL", JSON.stringify(refused));
    assert.equal((refused as { reason: string }).reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH");
    assert.equal(capabilityOf(refused), undefined);
    assert.equal(h.store.runCapability(effect_id), undefined, "nothing minted");
    assert.equal(h.store.admissionsByEffect(effect_id).length, 0, "no admission");
    assert.equal(h.store.outcomesByEffect(effect_id).length, 0, "and no outcome");
    assert.equal(workflowTarget.onDispatch, undefined);
    assert.equal(
      (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_admission WHERE effect_id = ?").get(effect_id) as { n: number }).n,
      0,
      "the refusal precedes the admission transaction and the target entirely",
    );

    // An UNAUTHENTICATED in-process call is refused on the same leg: the secret is deliverable
    // only to a caller the Platform has verified as the sealed requester.
    const unattributed = await dispatch(h, effect_id);
    assert.equal((unattributed as { reason?: string }).reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH");

    // The owner still gets it: the refusal above is scoped to the caller, not to the effect.
    const admitted = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", refusalDetail(admitted));
    assert.equal(typeof capabilityOf(admitted), "string");
  } finally {
    h.close();
  }
});

test("B5(1)/B6(4): the capability is minted ONCE, at the verified initial dispatch, and stored as SHA-256 of the RAW bytes", async () => {
  const { h } = await originHarness();
  try {
    const { effect_id } = sealOrigin(h, { origin_key: "origin-mint" });
    const admitted = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", refusalDetail(admitted));
    const secret = capabilityOf(admitted)!;
    assert.equal(typeof secret, "string");

    // B6(3): base64url, UNPADDED, of the raw 256-bit secret.
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/u, "unpadded base64url of 32 bytes");
    const raw = Buffer.from(secret, "base64url");
    assert.equal(raw.length, 32, "256 bits from a CSPRNG");

    // B5(1): the digest preimage is PINNED to the raw bytes, never to the transport text.
    const row = h.store.runCapability(effect_id)!;
    assert.equal(row.capability_digest, sha256Hex(raw), "capability_digest = SHA-256(raw 32 bytes)");
    assert.notEqual(row.capability_digest, sha256Hex(secret), "and never SHA-256 of the base64url text");
    assert.equal(row.holder_ref, REQUESTER_A, "holder_ref is the SEALED requester_ref");
    assert.equal(row.work_run_ref, effect_id, "keyed by the WORK_START's own effect_id");

    // B5(4): no revocation state exists in this generation — the column is deliberately absent.
    const columns = (h.store.db.prepare("SELECT name FROM pragma_table_info('run_capability')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.deepEqual(columns, ["work_run_ref", "holder_ref", "capability_digest", "minted_at"]);

    // B6(4): ABSENT in every other case. The repeat call is refused (recheck #12) and, either way,
    // is not the INITIAL dispatch — nothing mints and nothing is re-delivered.
    const repeat = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(capabilityOf(repeat), undefined, "returned exactly once");
    assert.equal(h.store.runCapability(effect_id)!.capability_digest, row.capability_digest, "the row is untouched");
    assert.equal(
      (h.store.db.prepare("SELECT COUNT(*) AS n FROM run_capability").get() as { n: number }).n,
      1,
      "one capability, for one run, for the store's lifetime",
    );
  } finally {
    h.close();
  }
});

test("B5(2)/B6(4): a LATER ordinal after NO_EFFECT_CONFIRMED delivers nothing — 'initial dispatch', not 'call outcome'", async () => {
  const { h, workflowTarget } = await originHarness();
  try {
    const { effect_id } = sealOrigin(h, { origin_key: "origin-retry" });
    workflowTarget.onDispatch = (_id, ordinal) =>
      ordinal === 1 ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } } : undefined;

    const first = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(first.kind, "ADMITTED", refusalDetail(first));
    assert.equal((first as { outcome: { result: string } }).outcome.result, "NO_EFFECT_CONFIRMED");
    const secret = capabilityOf(first)!;
    assert.equal(typeof secret, "string", "the INITIAL dispatch mints, whatever the target answered");

    const second = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(second.kind, "ADMITTED", refusalDetail(second));
    assert.equal((second as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal(capabilityOf(second), undefined, "a second ordinal is not the initial dispatch");
    assert.equal(h.store.runCapability(effect_id)!.capability_digest, sha256Hex(Buffer.from(secret, "base64url")));
  } finally {
    h.close();
  }
});

test("B6(3)/B5(7): the secret exists nowhere durable and appears in no error message", async () => {
  const { h } = await originHarness();
  try {
    const { effect_id } = sealOrigin(h, { origin_key: "origin-secrecy" });
    const admitted = await dispatch(h, effect_id, PRINCIPALS.workflow);
    const secret = capabilityOf(admitted)!;
    assert.equal(typeof secret, "string");

    // Nowhere durable: not in the capability row, not in any K1–K7 record, not in CAS.
    assert.ok(!storeText(h).includes(secret), "the raw secret is in no stored row — only its digest is");

    // In no thrown error text, on a refusal path that names the very effect the secret belongs to.
    let thrown: unknown;
    try {
      h.ingress.sealEffectRequest(
        {
          effect_id, requester_ref: REQUESTER_B,
          work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }],
          target_ref: WORK_START_TARGET, operation_kind: "WORK_START", material_schema: "cadp.work-start.v1",
          material_ref: workStartMaterial(h), prior_effect_refs: [], allocation_tuple: originTuple("origin-secrecy"),
        },
        PRINCIPAL_B,
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal((thrown as { reason?: string }).reason, "ALLOCATION_PRINCIPAL_MISMATCH");
    assert.ok(!String((thrown as Error).message).includes(secret), "no refusal message carries the secret or a prefix of it");

    // And in no refusal result the Platform hands back.
    const repeat = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.ok(!JSON.stringify(repeat).includes(secret), "a repeat dispatch result never re-delivers it");
    for (const incident of h.store.openIncidents()) {
      assert.ok(!JSON.stringify(incident).includes(secret), "no KERNEL_INCIDENT claim carries it");
    }
  } finally {
    h.close();
  }
});

// ================================================================ v1-config regression

test("v1 config: no origin adjudication, no witness, no minting — the v0.4 seal and dispatch behaviour exactly", async () => {
  const { h } = await originHarness(false);
  try {
    const tuple: AllocationTuple = { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 41, purpose: "work-start" };
    const selfBound = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    h.ingress.sealEffectRequest(
      {
        effect_id: selfBound, requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: selfBound }],
        target_ref: WORK_START_TARGET, operation_kind: "WORK_START", material_schema: "cadp.work-start.v1",
        material_ref: workStartMaterial(h), prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.runMembership(selfBound), undefined, "a v1 deployment adjudicates no origin");

    // A WORK_START binding ANOTHER run seals exactly as it did in v0.4 — the ORIGIN-OR-REFUSED
    // rule is v0.5 contract and stays inside the v2 gate.
    const other = h.ingress.allocateEffectId({ ...tuple, step_ordinal: 42 }, PRINCIPALS.workflow);
    h.ingress.sealEffectRequest(
      {
        effect_id: other, requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: selfBound }],
        target_ref: WORK_START_TARGET, operation_kind: "WORK_START", material_schema: "cadp.work-start.v1",
        material_ref: workStartMaterial(h), prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.effectRequest(other)?.effect_id, other, "v1 seals it, unrefused");

    // And dispatch mints nothing, with or without a principal.
    const admitted = await dispatch(h, selfBound, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", refusalDetail(admitted));
    assert.equal(capabilityOf(admitted), undefined);
    const unattributed = await dispatch(h, other);
    assert.equal(unattributed.kind, "ADMITTED", refusalDetail(unattributed));
    assert.equal(capabilityOf(unattributed), undefined, "no principal is required where nothing can mint");
    assert.equal(
      (h.store.db.prepare("SELECT COUNT(*) AS n FROM run_capability").get() as { n: number }).n,
      0,
      "a v1 deployment writes no run_capability row on any path",
    );
  } finally {
    h.close();
  }
});
