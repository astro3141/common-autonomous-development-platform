/**
 * AP B1(5)/B2(2)(ii)-as-extended/B5(1)/B5(5)/B5(9), WP §3.6 — the ALLOCATION/CONFIG/STORAGE/
 * MINTING half of the run-capability mechanism.
 *
 * The legs here:
 *   - `cadp.allocation-key.run-origin.v1` validates and allocates through the generic descriptor
 *     machinery, with no shape of it in kernel code (B1(5), B2(2)(i));
 *   - its allocation contract is IMMUTABLE for the store's lifetime — a changed or DELETED
 *     descriptor or `allocation_schemas` entry under an already-activated id is refused
 *     `SCHEMA_DESCRIPTOR_CHANGED`, and that refusal takes PRECEDENCE over
 *     `ALLOCATION_SCHEMA_UNREGISTERED` and `ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE` (B2(2)(ii));
 *   - the caller-visible consequence: one `(requester_ref, origin_key)` → one `effect_id`, stable
 *     across an intervening unrelated `POLICY_ACTIVATE` (B1(5), WP control 13);
 *   - `is_run_origin` at seal — ORIGIN-OR-REFUSED: a self-bound `WORK_START` seals and writes the
 *     durable witness `run_membership(E, E)`; a `WORK_START` bound to any other run is REFUSED
 *     `RUN_CAPABILITY_INVALID` even with a valid capability row for that run present (B5(9));
 *   - the WITNESSED minting predicate at dispatch, the stamped-vs-sealed `requester_ref` equality
 *     that guards it, and one-shot delivery of the secret (B5(1), B6(4));
 *   - the secret is never storable, recoverable or loggable (B5(1), B6(3)).
 *
 * NOT here, and deliberately: seal-time capability PRESENTATION (`RUN_CAPABILITY_REQUIRED`,
 * `RUN_CAPABILITY_HOLDER_MISMATCH`, `RUN_SCOPE_*`), the `x-cadp-run-capability` header, recheck
 * #19, `RUN_BINDING_REQUIRED`/`NOT_RUN_ENROLLED` and the `origin_key` derivation in
 * `cadp/live/ops.ts` — all of them a later lane.
 *
 * SOURCE-BYTES NOTE: every binary value below is produced or decoded PROGRAMMATICALLY (a
 * base64url string decoded at runtime, a `createHash` digest); no raw byte is written as a string
 * literal in this file.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";

import { startKernelApi } from "../kernel/api.ts";
import { jcs, sha256Hex } from "../kernel/canonical.ts";
import { IngressRejection } from "../kernel/ingress.ts";
import type { AllocationTuple, Principal } from "../kernel/ingress.ts";
import type { AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim } from "../kernel/adapters/types.ts";
import type { SubjectBinding, TargetRef } from "../kernel/records.ts";
import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import {
  PRINCIPALS, V2_ALLOCATION_SCHEMAS, V2_ALLOCATION_SCHEMA_DESCRIPTORS, makeHarness, stopSharedOpa, v2ConfigOverrides,
} from "./support/harness.ts";
import type { Harness, HarnessOptions } from "./support/harness.ts";

after(() => stopSharedOpa());

// ---------------------------------------------------------------- composition data

const RUN_ORIGIN_SCHEMA = "cadp.allocation-key.run-origin.v1";
const WORK_RUN_AUTHORITY = "cadp-store:k04";

/**
 * WP §3.6's canonical definitions, carried — not authored — by the bundle: `origin_key` is the
 * schema's single non-reserved field, `{ENTROPY, NONEMPTY_STRING}`, and because no field is
 * `PROJECTED` the mapping's `binding_projection` is `[]` and its one `purpose_relation` pair is
 * `work-start` ↔ `WORK_START`.
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

/** A second `workflow`-class principal: the non-holder of every cross-principal leg below. */
const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: "workflow:cadp-work-b",
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};
const REQUESTER_A = "workflow:cadp-work";
const REQUESTER_B = "workflow:cadp-work-b";

function runOriginConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return v2ConfigOverrides({
    allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, RUN_ORIGIN_DESCRIPTOR],
    allocation_schemas: [...V2_ALLOCATION_SCHEMAS, RUN_ORIGIN_MAPPING],
    ...overrides,
  });
}

/**
 * A scripted `WORK_START` target. The harness's own scripted adapter serves record-vertical
 * operations only, and a run origin must actually DISPATCH for anything to be minted.
 */
class WorkStartTarget implements TargetAdapterV1 {
  target_type = "WORK_RUN";
  authority_ref = "scripted:work-run";
  operations: AdapterOperation[] = [
    {
      operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", available: true,
      idempotency: "NONE", dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: true,
    },
  ];

  onDispatch: ((effect_id: string, ordinal: number) => DispatchResult) | undefined;

  describe() {
    return { target_type: this.target_type, authority_ref: this.authority_ref, operations: this.operations };
  }

  serialization_domain(): string {
    return "work-run-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: this.targetRef(), claim: { tenant: "work-run-1" } };
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
      target_operation_ref: `work-run-${effect_id}-${ordinal}`,
      receipt_claim: { workflow_id: material["workflow_id"], applied: true },
    };
  }

  async reconcile(): Promise<ReconcileResult> {
    return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { authoritative_absence: true, read_authority: "primary" } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["workflow_id"] === material["workflow_id"];
  }

  targetRef(): TargetRef {
    return { authority_ref: this.authority_ref, target_type: this.target_type, target_id: "work-run-1" };
  }
}

interface OriginHarness {
  h: Harness;
  work: WorkStartTarget;
}

/** A `cadp.kernel-config.v2` harness carrying the run-origin allocation contract. */
async function originHarness(options: HarnessOptions = {}): Promise<OriginHarness> {
  const work = new WorkStartTarget();
  const h = await makeHarness({
    ...options,
    identityRegistry: options.identityRegistry ?? [...REFERENCE_IDENTITIES, IDENTITY_B],
    extraAdapters: [work, ...(options.extraAdapters ?? [])],
    configOverrides: runOriginConfig(options.configOverrides ?? {}) as never,
  });
  return { h, work };
}

// ---------------------------------------------------------------- helpers

function originTuple(origin_key: string, overrides: Record<string, unknown> = {}): AllocationTuple {
  return { schema: RUN_ORIGIN_SCHEMA, origin_key, purpose: "work-start", ...overrides } as AllocationTuple;
}

function workStartMaterial(h: Harness, workflow_id: string): string {
  return h.ingress.putBlob(Buffer.from(JSON.stringify({
    workflow_id, workflow_type: "cadpWork", task_queue: "cadp-worker",
    bounds: { max_steps: 8, max_effects: 6 },
  }), "utf8"));
}

/**
 * Allocate under `run-origin.v1` and seal the `WORK_START` — by default self-bound, which is the
 * origin case; `bind_to` names another run, which is B5(9)'s refusal case.
 */
function sealOrigin(
  o: OriginHarness,
  options: { origin_key: string; principal?: Principal; requester_ref?: string; bind_to?: string },
): { effect_id: string; tuple: AllocationTuple } {
  const principal = options.principal ?? PRINCIPALS.workflow;
  const tuple = originTuple(options.origin_key);
  const effect_id = o.h.ingress.allocateEffectId(tuple, principal);
  o.h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: options.bind_to ?? effect_id }],
      target_ref: o.work.targetRef(),
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: workStartMaterial(o.h, `cadp-work-${options.origin_key}`),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    principal,
  );
  return { effect_id, tuple };
}

/** Everything recheck #8/#9 need before a `WORK_START` can be admitted at all. */
async function readyForDispatch(o: OriginHarness): Promise<void> {
  o.h.sealReach();
  await o.h.pep.refreshTargetIdentity(o.work);
  await o.h.sealTargetIdentity();
}

async function dispatchOrigin(o: OriginHarness, effect_id: string, caller?: Principal) {
  const input = o.h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await o.h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION", JSON.stringify(evaluated));
  const decision = (evaluated as { decision: { decision_id: string; outcome: string } }).decision;
  assert.equal(decision.outcome, "ALLOW", JSON.stringify(decision));
  return await o.h.pep.admitAndDispatch(effect_id, decision.decision_id, caller);
}

function rows(h: Harness, table: string): number {
  return (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function incidents(h: Harness): number {
  return (h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'KERNEL_INCIDENT'").get() as { n: number }).n;
}

function refusal(fn: () => unknown, reason: string, note: string): IngressRejection {
  let caught: IngressRejection | undefined;
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof IngressRejection, `${note}: ${String(error)}`);
    assert.equal(error.reason, reason, `${note}: ${error.message}`);
    caught = error;
    return true;
  }, note);
  return caught!;
}

/**
 * Every text byte this store holds, across every table — the sweep the "never storable, never
 * recoverable" claim is asserted against. BLOB columns are rendered in three encodings so a raw
 * secret could not hide in one of them.
 */
function everyStoredByte(h: Harness): string {
  const tables = h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const parts: string[] = [];
  for (const table of tables) {
    for (const row of h.store.db.prepare(`SELECT * FROM "${table.name}"`).all() as Array<Record<string, unknown>>) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) {
          const bytes = Buffer.from(value);
          parts.push(bytes.toString("utf8"), bytes.toString("base64url"), bytes.toString("hex"));
        } else if (value !== null && value !== undefined) {
          parts.push(String(value));
        }
      }
    }
  }
  return parts.join(" ");
}

/** The activation refusal detail the publication path surfaces for a kernel-config refusal. */
function activationRefusal(admitted: unknown): { kind: string; reason?: string; detail?: string } {
  return admitted as { kind: string; reason?: string; detail?: string };
}

// ================================================================ B1(5)/B2 — the schema

test("B1(5)/WP §3.6: run-origin.v1 validates and allocates through the generic descriptor machinery", async () => {
  const { h } = await originHarness();
  try {
    const tuple = originTuple("origin-alpha");
    const a = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    // WP control 13: a retry of ONE logical origin — same `origin_key` — converges.
    assert.equal(h.ingress.allocateEffectId({ ...tuple }, PRINCIPALS.workflow), a, "retry converges on one effect_id");
    // Identity, never content: a DISTINCT origin over byte-identical work is a distinct identity.
    assert.notEqual(h.ingress.allocateEffectId(originTuple("origin-beta"), PRINCIPALS.workflow), a, "distinct origin_key");
    // B1(2): `origin_key` confers no effect-identity authority — the key is requester-scoped too.
    assert.notEqual(h.ingress.allocateEffectId(tuple, PRINCIPAL_B), a, "another principal, another identity");
    assert.equal(rows(h, "effect_allocation"), 3);

    const row = h.store.allocationByEffectId(a)!;
    assert.equal(row.binding?.allocation_schema, RUN_ORIGIN_SCHEMA);
    assert.equal(row.binding?.requester_ref, REQUESTER_A, "the STAMPED requester, never a tuple field");
    assert.equal(row.binding?.purpose, "work-start");
    assert.equal(row.binding?.allocation_binding_digest, sha256Hex(jcs(tuple)));
    // B2(1): `allocation_contract_payload.v1` over this schema's two registry entries verbatim.
    assert.equal(
      row.binding?.allocation_contract_digest,
      sha256Hex(jcs({ descriptor: RUN_ORIGIN_DESCRIPTOR, allocation_schema: RUN_ORIGIN_MAPPING })),
    );

    // B2(5)/WP control 15 (record-vertical generality): a key outside the descriptor's set —
    // here a development-only field — is refused, and so is a value violating NONEMPTY_STRING.
    refusal(
      () => h.ingress.allocateEffectId(originTuple("origin-gamma", { repo_id: "github.com/x/y" }), PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "a vertical's own field is not in the descriptor's key set",
    );
    refusal(
      () => h.ingress.allocateEffectId(originTuple(""), PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "empty origin_key violates NONEMPTY_STRING",
    );
    refusal(
      () => h.ingress.allocateEffectId({ schema: RUN_ORIGIN_SCHEMA, purpose: "work-start" } as AllocationTuple, PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "missing origin_key",
    );
    // The tuple carries no `work_run_ref` and this schema's single pair is work-start ↔ WORK_START.
    refusal(
      () => h.ingress.allocateEffectId(originTuple("origin-delta", { purpose: "record-write" }), PRINCIPALS.workflow),
      "ALLOCATION_PURPOSE_NOT_REGISTERED",
      "a purpose this schema pairs with no operation_kind",
    );
    assert.equal(rows(h, "effect_allocation"), 3, "no refused tuple left a row");
    assert.equal(incidents(h), 0);
  } finally {
    h.close();
  }
});

test("B2(2)(ii): the run-origin contract is immutable for the store's lifetime — change OR deletion is SCHEMA_DESCRIPTOR_CHANGED", async () => {
  const { h } = await originHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const pinned = h.ingress.allocateEffectId(originTuple("origin-pinned"), PRINCIPALS.workflow);

    const changedDescriptor = {
      schema: RUN_ORIGIN_SCHEMA,
      fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "EFFECT_ID" }],
    };
    const projectedDescriptor = {
      schema: RUN_ORIGIN_SCHEMA,
      fields: [{ field: "origin_key", role: "PROJECTED", value_contract: "NONEMPTY_STRING" }],
    };
    const changedMapping = {
      schema: RUN_ORIGIN_SCHEMA,
      binding_projection: [],
      purpose_relation: [{ purpose: "work-start", operation_kind: "GIT_PUSH" }],
    };

    const cases: Array<{ name: string; overrides: Record<string, unknown>; notReason?: string }> = [
      {
        name: "descriptor field's value_contract changed",
        overrides: { allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, changedDescriptor] },
      },
      {
        name: "mapping's purpose_relation re-paired",
        overrides: { allocation_schemas: [...V2_ALLOCATION_SCHEMAS, changedMapping] },
      },
      {
        // Without the immutability rule this is `ALLOCATION_SCHEMA_UNREGISTERED` (a mapping with
        // no descriptor); the mandated precedence makes it the prohibited MUTATION it is.
        name: "descriptor DELETED, mapping kept",
        overrides: { allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS] },
        notReason: "ALLOCATION_SCHEMA_UNREGISTERED",
      },
      {
        // Without the rule this activates silently: a carried-but-unmapped descriptor is inert.
        name: "mapping DELETED, descriptor kept",
        overrides: { allocation_schemas: [...V2_ALLOCATION_SCHEMAS] },
      },
      {
        name: "both entries DELETED",
        overrides: {
          allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS],
          allocation_schemas: [...V2_ALLOCATION_SCHEMAS],
        },
        notReason: "ALLOCATION_SCHEMA_UNREGISTERED",
      },
      {
        // Precedence over the OTHER coverage refusal: a PROJECTED field with an empty
        // `binding_projection` is `ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE` on its own merits.
        name: "descriptor role flipped to PROJECTED",
        overrides: { allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, projectedDescriptor] },
        notReason: "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
      },
    ];

    let revision = 1;
    for (const testCase of cases) {
      revision += 1;
      const result = await h.activatePolicy({ revision, configOverrides: testCase.overrides as never });
      const admitted = activationRefusal(result.admitted);
      assert.equal(admitted.kind, "REFUSAL", `${testCase.name}: ${JSON.stringify(admitted)}`);
      assert.equal(admitted.reason, "KERNEL_CONFIG_INVALID", testCase.name);
      assert.ok(
        (admitted.detail ?? "").includes("SCHEMA_DESCRIPTOR_CHANGED"),
        `${testCase.name}: expected SCHEMA_DESCRIPTOR_CHANGED, got ${admitted.detail}`,
      );
      if (testCase.notReason !== undefined) {
        assert.ok(
          !(admitted.detail ?? "").includes(testCase.notReason),
          `${testCase.name}: must not be reported as ${testCase.notReason} — ${admitted.detail}`,
        );
      }
      assert.equal(h.store.activeActivation()!.seq, 1, `${testCase.name}: no activation`);
      assert.equal(h.store.policyRef("cadp-v04:policy:root", revision), undefined, `${testCase.name}: nothing published`);
    }

    // Positive control: an unrelated change with both entries byte-identical activates. Member
    // ORDER is canonicalization's to fix (B2(2)(ii) compares `cadp-jcs-1` forms), so an entry
    // whose members are written in another order is the SAME entry and is not a change.
    const reordered = { fields: RUN_ORIGIN_DESCRIPTOR.fields, schema: RUN_ORIGIN_SCHEMA };
    const ok = await h.activatePolicy({
      revision: 20,
      configOverrides: {
        decision_ttl_s: 1799,
        allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, reordered],
      } as never,
    });
    assert.equal(activationRefusal(ok.admitted).kind, "ADMITTED", JSON.stringify(ok.admitted));
    assert.equal(h.store.activeActivation()!.seq, 2, "the unrelated change activated");
    // B1(5): and the pinned identity is exactly what it was, under the new activation.
    assert.equal(h.ingress.allocateEffectId(originTuple("origin-pinned"), PRINCIPALS.workflow), pinned);

    // The ASYMMETRY, claimed for no other schema: `cadp.allocation-key.external.v1`'s mapping
    // carries repointable projection targets a composition may legitimately re-aim, and stays
    // MUTABLE and contract-scoped exactly as it is — in the very same store where the run-origin
    // contract is pinned.
    const repointed = [
      V2_ALLOCATION_SCHEMAS[0],
      {
        ...V2_ALLOCATION_SCHEMAS[1],
        binding_projection: [
          { tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" },
          { tuple_field: "candidate_base_sha", authority_ref: "github.com", namespace: "commit" },
          { tuple_field: "candidate_sha", authority_ref: "github.com", namespace: "base-commit" },
        ],
      },
      RUN_ORIGIN_MAPPING,
    ];
    const external = await h.activatePolicy({ revision: 21, configOverrides: { allocation_schemas: repointed } as never });
    assert.equal(activationRefusal(external.admitted).kind, "ADMITTED", JSON.stringify(external.admitted));
    assert.equal(h.store.activeActivation()!.seq, 3, "another schema's mapping is not pinned by this rule");
  } finally {
    h.close();
  }
});

test("B1(5)/WP control 13: one (requester, origin_key) → one effect_id across an unrelated POLICY_ACTIVATE", async () => {
  const { h } = await originHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const before = h.ingress.allocateEffectId(originTuple("origin-stable"), PRINCIPALS.workflow);
    const activated = await h.activatePolicy({ revision: 2, paramOverrides: { verification_max_age_s: 3599 } });
    assert.equal(activationRefusal(activated.admitted).kind, "ADMITTED", JSON.stringify(activated.admitted));
    assert.equal(h.store.activeActivation()!.seq, 2);

    const after = h.ingress.allocateEffectId(originTuple("origin-stable"), PRINCIPALS.workflow);
    assert.equal(after, before, "the allocation contract cannot drift, so neither can the identity");
    const originRows = (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_allocation WHERE allocation_schema = ?").get(RUN_ORIGIN_SCHEMA) as { n: number }).n;
    assert.equal(originRows, 1, "one logical origin, exactly one allocation row for the store's lifetime");
  } finally {
    h.close();
  }
});

// ================================================================ B5(9) — origin adjudication

test("B5(9): a self-bound WORK_START is adjudicated an ORIGIN and writes the durable run_membership(E, E) witness", async () => {
  const o = await originHarness();
  try {
    const { effect_id } = sealOrigin(o, { origin_key: "origin-self" });
    assert.equal(o.h.store.runMembership(effect_id), effect_id, "the self-referential witness row");
    assert.equal(rows(o.h, "run_membership"), 1);
    // Originating an identity mints nothing: the capability for that run comes at its own
    // `admit_and_dispatch` (B5(9)'s closing note).
    assert.equal(rows(o.h, "run_capability"), 0);
    assert.equal(incidents(o.h), 0);

    // An idempotent re-seal returns the stored row and writes no second witness.
    const tuple = originTuple("origin-self");
    const reSealed = o.h.ingress.sealEffectRequest(
      {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }],
        target_ref: o.work.targetRef(),
        operation_kind: "WORK_START",
        material_schema: "cadp.work-start.v1",
        material_ref: workStartMaterial(o.h, "cadp-work-origin-self"),
        prior_effect_refs: [],
        allocation_tuple: tuple,
      },
      PRINCIPALS.workflow,
    );
    assert.equal(reSealed.effect_id, effect_id);
    assert.equal(rows(o.h, "run_membership"), 1, "one witness, not two");
    assert.equal(rows(o.h, "effect_request"), 1);
    assert.equal(incidents(o.h), 0, "an idempotent re-seal is no REQUEST_DIGEST_CONFLICT");
  } finally {
    o.h.close();
  }
});

test("B5(9): a WORK_START bound to ANOTHER run is REFUSED RUN_CAPABILITY_INVALID — even with that run's valid capability row present", async () => {
  const o = await originHarness();
  try {
    await readyForDispatch(o);
    // Run A: a real origin, dispatched, so a genuine holder-matching `run_capability` row exists
    // and its `WORK_START` is COMMITTED — the counterexample B5(9) names explicitly.
    const runA = sealOrigin(o, { origin_key: "origin-a" });
    const dispatched = await dispatchOrigin(o, runA.effect_id, PRINCIPALS.workflow);
    assert.equal((dispatched as { kind: string }).kind, "ADMITTED", JSON.stringify(dispatched));
    const capabilityRow = o.h.store.runCapability(runA.effect_id)!;
    assert.equal(capabilityRow.holder_ref, REQUESTER_A);

    const requestsBefore = rows(o.h, "effect_request");
    const membershipBefore = rows(o.h, "run_membership");
    // Run B: allocated under the same run-origin contract by the same holder, but its work-run
    // binding names run A. Leg 3 fails ⇒ refused, and NEVER the ordinary member path.
    const error = refusal(
      () => sealOrigin(o, { origin_key: "origin-b", bind_to: runA.effect_id }),
      "RUN_CAPABILITY_INVALID",
      "a WORK_START may not originate a second run's identity inside another run's scope",
    );
    assert.ok(!error.message.includes(capabilityRow.capability_digest), "no stored digest is echoed in the refusal");
    assert.equal(rows(o.h, "effect_request"), requestsBefore, "no K3 row for the refused request");
    assert.equal(rows(o.h, "run_membership"), membershipBefore, "and no membership proof");
    assert.equal(rows(o.h, "run_capability"), 1, "nothing minted for the refused request");
    assert.equal(incidents(o.h), 0, "a refusal, not an incident");
  } finally {
    o.h.close();
  }
});

// ================================================================ B5(1)/B6(4) — the mint

test("B5(1): the mint is gated on the stamped-vs-sealed requester_ref — a wrong or absent caller mints nothing", async () => {
  const o = await originHarness();
  try {
    await readyForDispatch(o);
    const { effect_id } = sealOrigin(o, { origin_key: "origin-holder" });

    for (const [note, caller] of [["another principal", PRINCIPAL_B], ["no principal at all", undefined]] as const) {
      const refused = await dispatchOrigin(o, effect_id, caller);
      const result = refused as { kind: string; reason?: string; run_capability?: string };
      assert.equal(result.kind, "REFUSAL", `${note}: ${JSON.stringify(refused)}`);
      assert.equal(result.reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH", note);
      assert.equal(result.run_capability, undefined, `${note}: no field on a refusal`);
      assert.equal(rows(o.h, "run_capability"), 0, `${note}: nothing minted`);
      assert.equal(rows(o.h, "effect_admission"), 0, `${note}: no admission`);
      assert.equal(rows(o.h, "effect_outcome"), 0, `${note}: and no outcome`);
    }

    // Positive control: the sealed requester's own dispatch mints.
    const admitted = await dispatchOrigin(o, effect_id, PRINCIPALS.workflow);
    assert.equal((admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(admitted));
    assert.ok(typeof (admitted as { run_capability?: string }).run_capability === "string");
    assert.equal(rows(o.h, "run_capability"), 1);
  } finally {
    o.h.close();
  }
});

test("B5(1)/B6(4): the capability is returned EXACTLY on the initial verified dispatch; the row holds SHA-256 of the RAW secret", async () => {
  const o = await originHarness();
  try {
    await readyForDispatch(o);
    // The first dispatch resolves NO_EFFECT_CONFIRMED, which is the one state recheck #12 admits
    // a further ordinal after — so the repeat below is a real second dispatch, not a refusal.
    o.work.onDispatch = (_effect_id, ordinal) =>
      ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true, read_authority: "primary" } }
        : { kind: "ACCEPTED", target_operation_ref: "work-run-second", receipt_claim: { workflow_id: "cadp-work-origin-once", applied: true } };

    const { effect_id } = sealOrigin(o, { origin_key: "origin-once" });
    const first = await dispatchOrigin(o, effect_id, PRINCIPALS.workflow);
    const firstResult = first as { kind: string; run_capability?: string; admission: { dispatch_ordinal: number }; outcome: { result: string } };
    assert.equal(firstResult.kind, "ADMITTED", JSON.stringify(first));
    assert.equal(firstResult.admission.dispatch_ordinal, 1);
    assert.equal(firstResult.outcome.result, "NO_EFFECT_CONFIRMED");
    const secret = firstResult.run_capability!;
    assert.equal(typeof secret, "string", "the initial verified dispatch delivers the capability");

    // B6(3): base64url, unpadded, of the raw 256-bit secret — decoded here, never literal.
    assert.ok(/^[A-Za-z0-9_-]+$/u.test(secret), "unpadded base64url alphabet only");
    const raw = Buffer.from(secret, "base64url");
    assert.equal(raw.length, 32, "256 bits");
    // B5(1): `capability_digest` is SHA-256 over the RAW bytes, never over the transport text.
    const row = o.h.store.runCapability(effect_id)!;
    assert.equal(row.capability_digest, createHash("sha256").update(raw).digest("hex"));
    assert.notEqual(row.capability_digest, createHash("sha256").update(Buffer.from(secret, "utf8")).digest("hex"), "not the text's digest");
    assert.equal(row.holder_ref, REQUESTER_A);
    assert.equal(row.work_run_ref, effect_id, "the PK is the WORK_START's own effect_id");
    assert.equal((row as unknown as Record<string, unknown>)["revoked_at"], undefined, "no revocation state in this generation");

    // The repeat: a real second admission that finds the row, mints nothing and returns nothing.
    const second = await dispatchOrigin(o, effect_id, PRINCIPALS.workflow);
    const secondResult = second as { kind: string; run_capability?: string; admission: { dispatch_ordinal: number } };
    assert.equal(secondResult.kind, "ADMITTED", JSON.stringify(second));
    assert.equal(secondResult.admission.dispatch_ordinal, 2, "a genuine later dispatch, not a refusal");
    assert.equal(secondResult.run_capability, undefined, "returned exactly once — never re-delivered");
    assert.equal(rows(o.h, "run_capability"), 1);
    assert.equal(o.h.store.runCapability(effect_id)!.capability_digest, row.capability_digest, "the row is untouched");
  } finally {
    o.h.close();
  }
});

test("B5(1)(α): an ordinary WORK_START carrying no seal-time witness is NEVER minting", async () => {
  const o = await originHarness();
  try {
    await readyForDispatch(o);
    // A `WORK_START` that binds no kernel work-run subject at all: never adjudicated, so no
    // witness row — and therefore no mint at its initial dispatch or at any later one.
    const tuple = originTuple("origin-unbound");
    const effect_id = o.h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    o.h.ingress.sealEffectRequest(
      {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: [],
        target_ref: o.work.targetRef(),
        operation_kind: "WORK_START",
        material_schema: "cadp.work-start.v1",
        material_ref: workStartMaterial(o.h, "cadp-work-unbound"),
        prior_effect_refs: [],
        allocation_tuple: tuple,
      },
      PRINCIPALS.workflow,
    );
    assert.equal(o.h.store.runMembership(effect_id), undefined, "no witness");

    const admitted = await dispatchOrigin(o, effect_id, PRINCIPALS.workflow);
    assert.equal((admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined, "shape alone never mints");
    assert.equal(rows(o.h, "run_capability"), 0);
  } finally {
    o.h.close();
  }
});

test("B5(1)/B6(3): the minted secret is never stored, never recoverable and never in an error or a log", async () => {
  const o = await originHarness();
  try {
    await readyForDispatch(o);
    const { effect_id } = sealOrigin(o, { origin_key: "origin-secret" });
    const admitted = await dispatchOrigin(o, effect_id, PRINCIPALS.workflow);
    const secret = (admitted as { run_capability?: string }).run_capability!;
    assert.equal(typeof secret, "string");
    const raw = Buffer.from(secret, "base64url");

    // Every byte this store holds, in every encoding a raw secret could hide in.
    const stored = everyStoredByte(o.h);
    const digest = o.h.store.runCapability(effect_id)!.capability_digest;
    assert.ok(stored.includes(digest), "positive control: the sweep does see the row's digest");
    assert.ok(!stored.includes(secret), "the base64url secret is nowhere in the store");
    assert.ok(!stored.includes(raw.toString("hex")), "nor its hex");
    assert.ok(!stored.includes(raw.toString("utf8")), "nor its raw bytes");
    // Nothing on the row inverts to the secret: only the digest is kept.
    for (const value of Object.values(o.h.store.runCapability(effect_id)!)) {
      assert.notEqual(value, secret);
    }

    // Refusal paths: neither a seal refusal's message nor a dispatch refusal's JSON carries it.
    const sealError = refusal(
      () => sealOrigin(o, { origin_key: "origin-secret-2", bind_to: effect_id }),
      "RUN_CAPABILITY_INVALID",
      "non-self WORK_START",
    );
    assert.ok(!sealError.message.includes(secret), "the seal refusal names a reason code, never a secret");
    const refused = await dispatchOrigin(o, effect_id, PRINCIPAL_B);
    assert.ok(!JSON.stringify(refused).includes(secret), "the dispatch refusal carries no secret");
    // And a repeat dispatch by the holder returns no secret either.
    const repeat = await dispatchOrigin(o, effect_id, PRINCIPALS.workflow);
    assert.ok(!JSON.stringify(repeat).includes(secret), "no re-delivery on any later result");
    assert.equal(incidents(o.h), 0, "and no KERNEL_INCIDENT was written at all, let alone one carrying it");
  } finally {
    o.h.close();
  }
});

test("B6(4) over the wire: admit_and_dispatch delivers run_capability to the verified caller only", async () => {
  const o = await originHarness();
  try {
    await readyForDispatch(o);
    const { effect_id } = sealOrigin(o, { origin_key: "origin-wire" });
    const input = o.h.ingress.assembleAdmissionInput(effect_id, []);
    const evaluated = await o.h.evaluate(input.input_digest.value);
    assert.equal(evaluated.kind, "DECISION");
    const decision_id = (evaluated as { decision: { decision_id: string } }).decision.decision_id;

    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"], ["tok-b", "cadp-workflow-b"]]);
    const api = await startKernelApi(
      { store: o.h.store, cas: o.h.cas, ingress: o.h.ingress, pep: o.h.pep, reconciler: o.h.reconciler, evaluator: o.h.evaluator, tokens },
      0,
    );
    try {
      const call = async (token: string) => {
        const res = await fetch(`http://127.0.0.1:${api.port}/admit_and_dispatch`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ effect_id, decision_id }),
        });
        return (await res.json()) as { kind?: string; reason?: string; run_capability?: string };
      };
      // The other `workflow`-class principal has the reach but not the identity.
      const wrong = await call("tok-b");
      assert.equal(wrong.kind, "REFUSAL", JSON.stringify(wrong));
      assert.equal(wrong.reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH");
      assert.equal(wrong.run_capability, undefined);
      assert.equal(rows(o.h, "run_capability"), 0);

      const holder = await call("tok-a");
      assert.equal(holder.kind, "ADMITTED", JSON.stringify(holder));
      assert.equal(Buffer.from(holder.run_capability!, "base64url").length, 32);
      assert.equal(
        o.h.store.runCapability(effect_id)!.capability_digest,
        createHash("sha256").update(Buffer.from(holder.run_capability!, "base64url")).digest("hex"),
      );
    } finally {
      api.close();
    }
  } finally {
    o.h.close();
  }
});

// ================================================================ v1 regression

test("v1 regression: under cadp.kernel-config.v1 nothing above exists — no adjudication, no witness, no mint", async () => {
  const work = new WorkStartTarget();
  const h = await makeHarness({ extraAdapters: [work] });
  try {
    h.sealReach();
    await h.pep.refreshTargetIdentity(work);
    await h.sealTargetIdentity();

    // The v0.4 allocation path accepts exactly one schema, as it does today.
    refusal(
      () => h.ingress.allocateEffectId(originTuple("origin-v1"), PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "run-origin.v1 is not a v0.4 tuple schema",
    );

    const effect_id = h.ingress.allocateEffectId(
      { schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000", step_ordinal: 7, purpose: "work-start" },
      PRINCIPALS.workflow,
    );
    // A SELF-bound `WORK_START` — the exact shape v2 adjudicates — seals unchanged under v1: no
    // origin rule runs, no witness row appears, and no refusal is invented.
    h.ingress.sealEffectRequest(
      {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }],
        target_ref: work.targetRef(),
        operation_kind: "WORK_START",
        material_schema: "cadp.work-start.v1",
        material_ref: workStartMaterial(h, "cadp-work-v1"),
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.runMembership(effect_id), undefined, "no witness under a v1 config");

    const input = h.ingress.assembleAdmissionInput(effect_id, []);
    const evaluated = await h.evaluate(input.input_digest.value);
    assert.equal(evaluated.kind, "DECISION", JSON.stringify(evaluated));
    const decision = (evaluated as { decision: { decision_id: string; outcome: string } }).decision;
    assert.equal(decision.outcome, "ALLOW");
    // Dispatched with NO principal, exactly as every v0.4 caller does: unchanged, and nothing minted.
    const admitted = await h.pep.admitAndDispatch(effect_id, decision.decision_id);
    assert.equal((admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined);
    assert.equal(rows(h, "run_capability"), 0);
    assert.equal(rows(h, "run_membership"), 0);
    assert.equal(incidents(h), 0);
  } finally {
    h.close();
  }
});
