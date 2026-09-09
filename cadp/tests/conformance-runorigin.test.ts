/**
 * AP B1(5)/B2(2)(ii)/B5 — the run-capability mechanism.
 *
 * PART 1, the ALLOCATION, CONFIG, STORAGE and MINTING half: the
 * `cadp.allocation-key.run-origin.v1` contract and its lifetime immutability, the seal-time
 * `is_run_origin` adjudication (ORIGIN-OR-REFUSED) and its durable `run_membership(E, E)` witness,
 * and the WITNESSED mint delivered exactly once at the verified initial `admit_and_dispatch`.
 *
 * PART 2, B5(3)-(4)/B6(3), the last section of this file: the request-metadata PLUMBING of the
 * `x-cadp-run-capability` header from `api.ts` to the seal, and the STRICT PARSER every
 * presentation is read through before its digest is compared. The reason code governed there is
 * `RUN_CAPABILITY_INVALID` alone. B5(4)'s other presentation codes —
 * `RUN_CAPABILITY_HOLDER_MISMATCH`, `RUN_SCOPE_UNRESOLVED`, `RUN_SCOPE_REFUSED`,
 * `RUN_CAPABILITY_REQUIRED` — with B5(3)'s `RUN_BINDING_REQUIRED` and recheck #19's
 * `RUN_MEMBERSHIP_UNPROVEN`, are later lanes and are asserted nowhere here; each of them NARROWS
 * what seals, so nothing asserted below starts sealing when they land.
 *
 * These are the Authority-side legs of §C controls A4 (witnessed minting, delivery, the origin
 * legs o1/o2, the dispatch-requester equality and the presentation encoding) and A5 (one
 * `origin_key` → one `effect_id` for the store's lifetime, and the o-iv/o-vi immutability legs).
 *
 * Every rule below is gated on the active config's schema string and, for the seal adjudication
 * and the presentation legs, on `run_profile_enrolled_requester_refs` membership plus the declared
 * `kernel_subject_namespaces` work-run pair. The complementary claims are asserted throughout: a
 * NON-ENROLLED requester's ordinary `WORK_START` (B5(1)(α), control A4 leg w1) and a whole
 * `cadp.kernel-config.v1` deployment are untouched — they seal, dispatch, acquire no witness, mint
 * nothing, and treat the header as the inert transport it is under v0.4.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";

import { startKernelApi } from "../kernel/api.ts";
import { IngressRejection, RUN_CAPABILITY_HEADER } from "../kernel/ingress.ts";
import type { Principal } from "../kernel/ingress.ts";
import { recordDigest } from "../kernel/canonical.ts";
import type { EffectRequestV1 } from "../kernel/records.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA, KernelConfigInvalid, validateKernelConfig } from "../kernel/policyBundle.ts";
import type { ActivatedAllocationContracts } from "../kernel/policyBundle.ts";
import type { AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim } from "../kernel/adapters/types.ts";
import type { SubjectBinding, TargetRef } from "../kernel/records.ts";
import { REFERENCE_IDENTITIES, buildReferenceKernelConfig } from "../deployment/referencePolicy.ts";
import {
  DEFAULT_WORK_RUN_REF, PRINCIPALS, V2_ALLOCATION_SCHEMAS, V2_ALLOCATION_SCHEMA_DESCRIPTORS,
  makeHarness, stopSharedOpa, v2ConfigOverrides,
} from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

after(() => stopSharedOpa());

const REQUESTER_A = "workflow:cadp-work";
const REQUESTER_B = "workflow:cadp-work-b";
const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: REQUESTER_B,
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};

/**
 * WP §3.6's wire shape as bundle data: exactly `{schema, origin_key, purpose}`, `origin_key` the
 * single non-reserved field with role ENTROPY and value contract NONEMPTY_STRING. The Kernel holds
 * no canonical copy of this — it is the schema owner's, carried by the bundle (AP B2(2)(i)).
 */
const RUN_ORIGIN_DESCRIPTOR = {
  schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
  fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "NONEMPTY_STRING" }],
};

/** `binding_projection: []` (nothing is PROJECTED) and the one fixed `work-start`↔`WORK_START` pair. */
const RUN_ORIGIN_MAPPING = {
  schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
  binding_projection: [] as ReadonlyArray<{ tuple_field: string; authority_ref: string; namespace: string }>,
  purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }],
};

const WORK_RUN_AUTHORITY = "cadp-store:k04";

/**
 * B6(3)'s base64url alphabet, in index order — the one place this file spells it out, so the
 * non-canonical variant below is derived from the encoding's own definition rather than hand-typed.
 */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A DETERMINISTIC 32-byte capability, as `Buffer.from(hex)` — no raw control-byte literals and no
 * dependence on what a CSPRNG happened to produce. Chosen so its canonical text carries BOTH `-`
 * and `_`, which is what makes the standard-alphabet variant a real variant: a secret whose
 * base64url text used neither would encode identically under both alphabets and would prove
 * nothing. The minted-secret path is exercised on its own alongside it.
 */
const CAPABILITY_FIXTURE_HEX = "1ecb6d0bbfa9dce864bd8fd43a63c22c26a75b47b360d854e83f8ad1d20c87d4";

/**
 * The four NON-CANONICAL presentations of one secret that B6(3) must refuse, each built from the
 * canonical text so the claim "same secret, different string" is structural. `decodes` records what
 * a PERMISSIVE `Buffer.from(value, "base64url")` yields, and every one of them recovers the
 * original 32 bytes — which is the whole point: the parser must refuse them anyway, because
 * `capability_digest` has ONE preimage (B5(1)) and therefore its presentation must have ONE string.
 */
function nonCanonicalPresentations(canonical: string): ReadonlyArray<{ note: string; value: string; decodes: "EXACT" | "PREFIX" }> {
  const last = BASE64URL_ALPHABET.indexOf(canonical[42]!);
  return [
    // `=` padding: what a padded base64url encoder emits for 32 bytes. 44 characters.
    { note: "padded", value: `${canonical}=`, decodes: "EXACT" },
    // The STANDARD alphabet: the same 6-bit values spelled `+`/`/` instead of `-`/`_`.
    { note: "standard-alphabet", value: canonical.replace(/-/gu, "+").replace(/_/gu, "/"), decodes: "EXACT" },
    // 44 characters over the exact alphabet: 33 bytes, whose first 32 are the secret.
    { note: "44-character", value: `${canonical}A`, decodes: "PREFIX" },
    // NON-CANONICAL TRAILING BITS: 43 × 6 = 258 bits carry 256 of secret, so the final character
    // has 2 unused low bits. The canonical encoder zeroes them; the next three alphabet indices
    // decode to the identical 32 bytes. This is the leg a length-and-alphabet test cannot catch.
    { note: "non-canonical-trailing-bits", value: `${canonical.slice(0, 42)}${BASE64URL_ALPHABET[last + 1]!}`, decodes: "EXACT" },
  ];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A `WORK_START`-capable target, so an origin can be admitted and dispatched through the real PEP. */
class WorkStartTarget implements TargetAdapterV1 {
  readonly target_type = "WORKFLOW";

  readonly authority_ref = "temporal:cadp-v04";

  onDispatch: ((effect_id: string, ordinal: number) => DispatchResult) | undefined;

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: this.target_type,
      authority_ref: this.authority_ref,
      operations: [
        {
          operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", available: true,
          idempotency: "NONE", dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE",
          no_effect_proof_supported: true,
        },
      ],
    };
  }

  serialization_domain(): string {
    return "work-start-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: this.targetRef(), claim: { namespace: "cadp-v04" } };
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
      target_operation_ref: `wf-${effect_id}-${ordinal}`,
      receipt_claim: { workflow_id: material["workflow_id"], started: true },
    };
  }

  async reconcile(effect_id: string, _o: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<ReconcileResult> {
    return { kind: "COMMITTED", target_operation_ref: `wf-${effect_id}`, receipt_claim: { workflow_id: material["workflow_id"], started: true } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["workflow_id"] === material["workflow_id"];
  }

  targetRef(): TargetRef {
    return { authority_ref: this.authority_ref, target_type: this.target_type, target_id: "cadp-v04" };
  }
}

/** The v2 config this lane needs: the run-origin contract registered, requester A enrolled. */
function runProfileConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return v2ConfigOverrides({
    allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, RUN_ORIGIN_DESCRIPTOR],
    allocation_schemas: [...V2_ALLOCATION_SCHEMAS, RUN_ORIGIN_MAPPING],
    run_profile_enrolled_requester_refs: [REQUESTER_A],
    ...overrides,
  });
}

interface RunProfileHarness {
  h: Harness;
  target: WorkStartTarget;
}

async function runProfileHarness(
  configOverrides: Record<string, unknown> = runProfileConfig(),
  disabledChecks?: ReadonlySet<string>,
): Promise<RunProfileHarness> {
  const target = new WorkStartTarget();
  const h = await makeHarness({
    identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B],
    extraAdapters: [target],
    configOverrides: configOverrides as never,
    ...(disabledChecks === undefined ? {} : { disabledChecks }),
  });
  h.sealReach();
  await h.sealTargetIdentity();
  await h.pep.refreshTargetIdentity(target);
  return { h, target };
}

let originCounter = 0;

/** Allocate under `run-origin.v1` and seal the `WORK_START` it names, self-bound unless told otherwise. */
function sealWorkStart(
  rp: RunProfileHarness,
  options: {
    origin_key?: string;
    principal?: Principal;
    requester_ref?: string;
    /** The `work-run` binding's `object_id`; defaults to the request's OWN effect_id (leg 3). */
    work_run_ref?: string;
    authority_ref?: string;
  } = {},
): { effect_id: string; tuple: Record<string, unknown> } {
  const { h, target } = rp;
  const principal = options.principal ?? PRINCIPALS.workflow;
  const tuple = {
    schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
    origin_key: options.origin_key ?? `origin-${(originCounter += 1)}`,
    purpose: "work-start",
  };
  const effect_id = h.ingress.allocateEffectId(tuple, principal);
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    bounds: { max_steps: 8, max_effects: 6 },
  };
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: [{
        authority_ref: options.authority_ref ?? WORK_RUN_AUTHORITY,
        namespace: "work-run",
        object_id: options.work_run_ref ?? effect_id,
      }],
      target_ref: target.targetRef(),
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    principal,
  );
  return { effect_id, tuple };
}

let memberCounter = 0;

/**
 * An ordinary run-bound MEMBER request: a non-`WORK_START` operation bound to an existing run, so
 * it is exactly B5(4)'s scope ("every run-bound request EXCEPT a run origin") rather than B5(9)'s.
 * `capability` is presented as REQUEST METADATA, the third parameter — never inside the body.
 */
function sealMember(
  rp: RunProfileHarness,
  options: { work_run_ref: string; capability?: string },
): { effect_id: string; request: EffectRequestV1 } {
  const { h } = rp;
  const tuple = {
    schema: "cadp.allocation-key.v1",
    work_run_ref: options.work_run_ref,
    step_ordinal: (memberCounter += 1),
    purpose: "record-write",
  };
  const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
  // Deliberately free of any effect-specific member, so two members of the same run seal over
  // BYTE-IDENTICAL material and therefore over one CAS key and one `material_digest`.
  const material = { tenant: "scripted-1", resource_id: "r-1" };
  const request = h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: REQUESTER_A,
      work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: options.work_run_ref }],
      target_ref: h.target.targetRef(),
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    PRINCIPALS.workflow,
    options.capability === undefined ? {} : { run_capability: options.capability },
  );
  return { effect_id, request };
}

/** assemble → evaluate → admit, with the caller the dispatch equality of B5(1) is checked against. */
async function dispatch(h: Harness, effect_id: string, caller?: Principal) {
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION", `expected a decision for ${effect_id}`);
  const decision = (evaluated as { decision: { decision_id: string; outcome: string } }).decision;
  assert.equal(decision.outcome, "ALLOW", `expected ALLOW for ${effect_id}`);
  return h.pep.admitAndDispatch(effect_id, decision.decision_id, caller);
}

function count(h: Harness, table: string): number {
  return (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function refuseConfig(
  cfg: Record<string, unknown>,
  prior: ActivatedAllocationContracts,
  reason: string,
  note: string,
): KernelConfigInvalid {
  let thrown: unknown;
  try {
    validateKernelConfig(cfg, prior);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof KernelConfigInvalid, `${note}: expected KernelConfigInvalid, got ${String(thrown)}`);
  assert.equal((thrown as KernelConfigInvalid).reason, reason, `${note}: ${(thrown as Error).message}`);
  return thrown as KernelConfigInvalid;
}

/** A validatable `data.cadp` carrying the run-profile contract, for the validation-layer legs. */
function configOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return buildReferenceKernelConfig({
    policy_id: "cadp-v04:policy:root",
    revision: 1,
    root_public_keys: [{ key_id: "root-1", alg: "Ed25519", public_key: "cm9vdA==", valid_from: "2026-01-01T00:00:00.000Z" }],
    configOverrides: runProfileConfig(overrides) as never,
  }) as unknown as Record<string, unknown>;
}

/** The sealed-store contract a run-origin id has already been activated under (B2(2)(ii)). */
function activatedContracts(): ActivatedAllocationContracts {
  return {
    descriptors: new Map<string, unknown>([
      [RUN_ORIGIN_ALLOCATION_SCHEMA, clone(RUN_ORIGIN_DESCRIPTOR)],
      ["cadp.allocation-key.external.v1", clone(V2_ALLOCATION_SCHEMA_DESCRIPTORS[1])],
    ]),
    allocation_schemas: new Map<string, unknown>([
      [RUN_ORIGIN_ALLOCATION_SCHEMA, clone(RUN_ORIGIN_MAPPING)],
      ["cadp.allocation-key.external.v1", clone(V2_ALLOCATION_SCHEMAS[1])],
    ]),
  };
}

// ================================================ B1(5) — the run-origin schema is accepted as data

test("B1(5): the run-origin allocation contract validates, and genesis activates a bundle carrying it", async () => {
  // The generic machinery of B2 accepts it with no new path: `origin_key` is ENTROPY, so B2(2)(iii)'s
  // coverage rule is satisfied by an EMPTY `binding_projection`, and the one fixed purpose pair is
  // ordinary composition data. No Kernel rule names the field or checks the descriptor's shape.
  const cfg = validateKernelConfig(configOf());
  const descriptor = cfg.allocation_schema_descriptors?.find((e) => e.schema === RUN_ORIGIN_ALLOCATION_SCHEMA);
  const mapping = cfg.allocation_schemas?.find((e) => e.schema === RUN_ORIGIN_ALLOCATION_SCHEMA);
  assert.deepEqual(descriptor?.fields, [{ field: "origin_key", role: "ENTROPY", value_contract: "NONEMPTY_STRING" }]);
  assert.deepEqual(mapping?.binding_projection, []);
  assert.deepEqual(mapping?.purpose_relation, [{ purpose: "work-start", operation_kind: "WORK_START" }]);

  // The same bundle through genesis validation, and an allocation under it: exactly the three keys
  // of WP §3.6, with no development-only field required or accepted (control A5 leg o-iii).
  const { h } = await runProfileHarness();
  try {
    const effect_id = h.ingress.allocateEffectId(
      { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: "origin-record-vertical", purpose: "work-start" },
      PRINCIPALS.workflow,
    );
    assert.match(effect_id, /^cadp-v04:effect:/u);
    assert.throws(
      () => h.ingress.allocateEffectId(
        { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: "origin-x", purpose: "work-start", repo_id: "github.com/x/y" },
        PRINCIPALS.workflow,
      ),
      (error: unknown) => (error as IngressRejection).reason === "ALLOCATION_TUPLE_INVALID",
      "a key outside the descriptor's set is refused",
    );
  } finally {
    h.close();
  }
});

// ================================================ B2(2)(ii) — lifetime immutability and its precedence

test("A5 o-iv: a change to EITHER run-origin entry, or removal of either, is refused SCHEMA_DESCRIPTOR_CHANGED", () => {
  const prior = activatedContracts();

  // (1) the MAPPING re-paired — the leg the descriptor-only rule would miss entirely.
  refuseConfig(
    configOf({
      allocation_schemas: [...V2_ALLOCATION_SCHEMAS, { ...clone(RUN_ORIGIN_MAPPING), purpose_relation: [{ purpose: "work-start", operation_kind: "SCRIPTED_WRITE" }] }],
    }),
    prior,
    "SCHEMA_DESCRIPTOR_CHANGED",
    "run-origin mapping re-paired",
  );

  // (2) the MAPPING removed, descriptor kept.
  const removedMapping = refuseConfig(
    configOf({ allocation_schemas: [...V2_ALLOCATION_SCHEMAS] }),
    prior,
    "SCHEMA_DESCRIPTOR_CHANGED",
    "run-origin mapping removed",
  );
  assert.match(removedMapping.message, /is removed/u);

  // (3) the DESCRIPTOR removed, mapping kept — the PRECEDENCE leg (B2(8)). Without the ordering
  // this bundle is exactly `assertProjectionCoverage`'s ALLOCATION_SCHEMA_UNREGISTERED case (a
  // mapping with no descriptor), which would misreport a prohibited mutation as an absence.
  const removedDescriptor = refuseConfig(
    configOf({ allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS] }),
    prior,
    "SCHEMA_DESCRIPTOR_CHANGED",
    "run-origin descriptor removed",
  );
  assert.doesNotMatch(removedDescriptor.message, /ALLOCATION_SCHEMA_UNREGISTERED/u, "the deletion is not reported as an absence");

  // (4) the DESCRIPTOR changed (B2(2)(ii)'s general rule, which the run-origin id inherits).
  refuseConfig(
    configOf({
      allocation_schema_descriptors: [
        ...V2_ALLOCATION_SCHEMA_DESCRIPTORS,
        { ...clone(RUN_ORIGIN_DESCRIPTOR), fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "EFFECT_ID" }] },
      ],
    }),
    prior,
    "SCHEMA_DESCRIPTOR_CHANGED",
    "run-origin descriptor changed",
  );

  // Positive control, so the four refusals are attributed to the run-origin entries and not to the
  // bundle: byte-identical run-origin entries alongside an unrelated registry change VALIDATE.
  const positive = validateKernelConfig(
    configOf({
      identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B],
      subject_complete_assembly: [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: ["PR_CREATE"] }],
    }),
    prior,
  );
  assert.equal(positive.subject_complete_assembly?.length, 1);

  // A5 o-vi, the asymmetry asserted rather than assumed: the EXTERNAL schema's MAPPING stays
  // mutable (its drift is recoverable by re-allocation, B2(3.3)/B2(9)/B1(2)) while its DESCRIPTOR,
  // like every other id's, may not change.
  const externalRetargeted = clone(V2_ALLOCATION_SCHEMAS[1]) as { binding_projection: Array<{ tuple_field: string; authority_ref: string; namespace: string }> };
  externalRetargeted.binding_projection = [
    { tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" },
    { tuple_field: "candidate_base_sha", authority_ref: "github.com", namespace: "commit" },
    { tuple_field: "candidate_sha", authority_ref: "github.com", namespace: "base-commit" },
  ];
  validateKernelConfig(
    configOf({ allocation_schemas: [V2_ALLOCATION_SCHEMAS[0], externalRetargeted, RUN_ORIGIN_MAPPING] }),
    prior,
  );
  refuseConfig(
    configOf({
      allocation_schema_descriptors: [
        V2_ALLOCATION_SCHEMA_DESCRIPTORS[0],
        { ...clone(V2_ALLOCATION_SCHEMA_DESCRIPTORS[1]), fields: [{ field: "repo_id", role: "PROJECTED", value_contract: "NONEMPTY_STRING" }] },
        RUN_ORIGIN_DESCRIPTOR,
      ],
      allocation_schemas: [
        V2_ALLOCATION_SCHEMAS[0],
        { ...clone(V2_ALLOCATION_SCHEMAS[1]), binding_projection: [{ tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" }] },
        RUN_ORIGIN_MAPPING,
      ],
    }),
    prior,
    "SCHEMA_DESCRIPTOR_CHANGED",
    "external descriptor re-shaped under the same id",
  );
});

test("A5 o-iv end to end: the immutability refusal happens at recheck #17; active policy unchanged", async () => {
  const { h } = await runProfileHarness();
  try {
    const before = h.store.activeActivation()!.seq;
    const refused = await h.activatePolicy({
      revision: 2,
      configOverrides: runProfileConfig({
        allocation_schemas: [...V2_ALLOCATION_SCHEMAS, { ...clone(RUN_ORIGIN_MAPPING), purpose_relation: [{ purpose: "work-start", operation_kind: "SCRIPTED_WRITE" }] }],
      }) as never,
    });
    const result = refused.admitted as { kind: string; reason?: string; detail?: string };
    assert.equal(result.kind, "REFUSAL", JSON.stringify(result));
    assert.equal(result.reason, "KERNEL_CONFIG_INVALID");
    assert.match(String(result.detail), /SCHEMA_DESCRIPTOR_CHANGED: /u);
    assert.equal(h.store.activeActivation()!.seq, before, "no activation row");

    // Positive control on the same store: the same bundle with the run-origin entries untouched,
    // carrying an unrelated registry change, ACTIVATES.
    const activated = await h.activatePolicy({
      revision: 3,
      configOverrides: runProfileConfig({ identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B, {
        principal: "cadp-workflow-c",
        producer_ref: "workflow:cadp-work-c",
        identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
      }] }) as never,
    });
    assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));
    assert.equal(h.store.activeActivation()!.seq, before + 1);
  } finally {
    h.close();
  }
});

test("A5 o-ii: one origin_key derives ONE effect_id across an unrelated POLICY_ACTIVATE", async () => {
  const { h } = await runProfileHarness();
  try {
    const tuple = { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: "origin-stable", purpose: "work-start" };
    const first = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    assert.equal(h.ingress.allocateEffectId({ ...tuple }, PRINCIPALS.workflow), first, "a retry converges");

    const activated = await h.activatePolicy({
      revision: 2,
      configOverrides: runProfileConfig({ identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B, {
        principal: "cadp-workflow-c",
        producer_ref: "workflow:cadp-work-c",
        identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
      }] }) as never,
    });
    assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));

    // Asserted with NO allocation-contract qualifier: this schema's contract CANNOT have changed,
    // so the key derived under the new bundle is the same key (B1(5), WP control 13).
    assert.equal(h.ingress.allocateEffectId({ ...tuple }, PRINCIPALS.workflow), first, "the same origin, across an activation");
    const rows = (h.store.db.prepare(
      "SELECT COUNT(*) AS n FROM effect_allocation WHERE allocation_schema = ?",
    ).get(RUN_ORIGIN_ALLOCATION_SCHEMA) as { n: number }).n;
    assert.equal(rows, 1, "one logical origin, one allocation row");

    // The distinctness leg: a DIFFERENT origin_key is a different logical origin, hence a different
    // identity, even though every other input is byte-identical (control A5 leg o-i).
    const other = h.ingress.allocateEffectId({ ...tuple, origin_key: "origin-stable-2" }, PRINCIPALS.workflow);
    assert.notEqual(other, first);
    // And the key stays requester-scoped: the same origin_key under another principal is another
    // identity, so an `origin_key` confers no effect-identity authority (B1(2), WP §3.6).
    assert.notEqual(h.ingress.allocateEffectId({ ...tuple }, PRINCIPAL_B), first);
  } finally {
    h.close();
  }
});

// ================================================ B5(9) — ORIGIN-OR-REFUSED at seal

test("A4 o1: a self-bound WORK_START seals with no capability presented and writes run_membership(E,E)", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id } = sealWorkStart(rp);
    assert.equal(rp.h.store.effectRequest(effect_id)?.effect_id, effect_id, "the origin SEALS");
    // The witness: written on this path and no other, in the same transaction as the request row.
    const witness = rp.h.store.runMembership(effect_id);
    assert.equal(witness?.effect_id, effect_id);
    assert.equal(witness?.work_run_ref, effect_id, "both columns are the origin's own effect_id");
    assert.equal(count(rp.h, "run_membership"), 1, "exactly one membership row");
    // Originating an identity mints nothing: the capability is minted at the origin's OWN dispatch.
    assert.equal(rp.h.store.runCapability(effect_id), undefined);
    assert.equal(count(rp.h, "run_capability"), 0);
  } finally {
    rp.h.close();
  }
});

test("A4 o2: a WORK_START binding ANOTHER run is REFUSED RUN_CAPABILITY_INVALID, capability row or not", async () => {
  const rp = await runProfileHarness();
  try {
    // A genuine origin, dispatched, so a valid holder-matching capability row for R1 EXISTS and its
    // WORK_START is COMMITTED — the counterexample this rule is written for.
    const { effect_id: r1 } = sealWorkStart(rp, { origin_key: "origin-r1" });
    const admitted = await dispatch(rp.h, r1, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(rp.h.store.runCapability(r1)?.holder_ref, REQUESTER_A);

    const membershipBefore = count(rp.h, "run_membership");
    const requestsBefore = count(rp.h, "effect_request");
    assert.throws(
      () => sealWorkStart(rp, { origin_key: "origin-second", work_run_ref: r1 }),
      (error: unknown) => {
        assert.ok(error instanceof IngressRejection, String(error));
        assert.equal(error.reason, "RUN_CAPABILITY_INVALID");
        return true;
      },
      "a WORK_START-shaped request naming another run never falls through to the member path",
    );
    assert.equal(count(rp.h, "effect_request"), requestsBefore, "zero effect_request rows for the refusal");
    assert.equal(count(rp.h, "run_membership"), membershipBefore, "zero run_membership rows: no membership proof");

    // o3: the same code and the same zeros for a fabricated run ref.
    assert.throws(
      () => sealWorkStart(rp, { origin_key: "origin-third", work_run_ref: DEFAULT_WORK_RUN_REF }),
      (error: unknown) => (error as IngressRejection).reason === "RUN_CAPABILITY_INVALID",
    );
    // And an OFF-AUTHORITY self-binding is not a kernel work-run subject at all (B3(4)(a)): leg 2
    // matches the DECLARED exact pair, so this fails adjudication rather than satisfying it.
    assert.throws(
      () => sealWorkStart(rp, { origin_key: "origin-fourth", authority_ref: "other" }),
      (error: unknown) => (error as IngressRejection).reason === "RUN_CAPABILITY_INVALID",
    );
    assert.equal(count(rp.h, "effect_request"), requestsBefore);
    assert.equal(count(rp.h, "run_membership"), membershipBefore);
    assert.equal(count(rp.h, "run_capability"), 1, "R1's capability is the only one, and R1 is unmoved");
  } finally {
    rp.h.close();
  }
});

// ================================================ B5(1)/B6(4) — witnessed minting and delivery

test("A4: dispatch by a caller other than the sealed requester is refused, mints nothing, and strands nothing", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id } = sealWorkStart(rp);
    const input = rp.h.ingress.assembleAdmissionInput(effect_id, []);
    const evaluated = await rp.h.evaluate(input.input_digest.value);
    const decision_id = (evaluated as { decision: { decision_id: string } }).decision.decision_id;

    for (const [note, caller] of [["another workflow principal", PRINCIPAL_B], ["no principal at all", undefined]] as const) {
      const refused = await rp.h.pep.admitAndDispatch(effect_id, decision_id, caller);
      assert.equal(refused.kind, "REFUSAL", `${note}: ${JSON.stringify(refused)}`);
      assert.equal((refused as { reason: string }).reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH", note);
      assert.equal(count(rp.h, "run_capability"), 0, `${note}: nothing minted`);
      assert.equal(rp.h.store.admissionsByEffect(effect_id).length, 0, `${note}: no admission`);
      assert.equal(rp.h.store.outcomesByEffect(effect_id).length, 0, `${note}: no outcome`);
      assert.equal((refused as { run_capability?: string }).run_capability, undefined, `${note}: no secret`);
    }

    // The run was NOT stranded by the refusals: its own requester still mints and is delivered.
    const admitted = await rp.h.pep.admitAndDispatch(effect_id, decision_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(typeof (admitted as { run_capability?: string }).run_capability, "string");
    assert.equal(count(rp.h, "run_capability"), 1);
  } finally {
    rp.h.close();
  }
});

test("A4/B6(4): the capability is delivered EXACTLY once, digested over the RAW secret bytes", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id } = sealWorkStart(rp);
    const admitted = await dispatch(rp.h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    const secret = (admitted as { run_capability?: string }).run_capability;
    assert.equal(typeof secret, "string");
    // B6(3): base64url, UNPADDED, of a raw 256-bit secret — 43 characters over that alphabet.
    assert.match(secret!, /^[A-Za-z0-9_-]{43}$/u);
    const raw = Buffer.from(secret!, "base64url");
    assert.equal(raw.length, 32, "256 bits");

    const row = rp.h.store.runCapability(effect_id)!;
    assert.equal(row.work_run_ref, effect_id, "the run's key IS the WORK_START's own effect_id");
    assert.equal(row.holder_ref, REQUESTER_A, "the holder is the sealed requester");
    // B5(1): SHA-256 over the RAW 32 bytes, never over the transport text — so no encoding variant
    // can be a second string digesting to this row.
    assert.equal(row.capability_digest, createHash("sha256").update(raw).digest("hex"));
    assert.notEqual(row.capability_digest, createHash("sha256").update(Buffer.from(secret!, "utf8")).digest("hex"));

    // A repeat dispatch finds the row present: nothing mints, nothing is delivered (B5(7), B6(4)).
    const repeat = await dispatch(rp.h, effect_id, PRINCIPALS.workflow);
    assert.equal(repeat.kind, "REFUSAL");
    assert.equal((repeat as { reason: string }).reason, "EFFECT_ALREADY_COMMITTED");
    assert.equal((repeat as { run_capability?: string }).run_capability, undefined);
    assert.equal(count(rp.h, "run_capability"), 1, "still exactly one row");
  } finally {
    rp.h.close();
  }
});

test("B6(4): a NON-INITIAL dispatch that IS admitted still carries no run_capability field", async () => {
  const rp = await runProfileHarness();
  try {
    // Ordinal 1 returns NO_EFFECT_CONFIRMED, which recheck #12 permits a further ordinal after.
    rp.target.onDispatch = (_e, ordinal) =>
      ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } }
        : { kind: "ACCEPTED", target_operation_ref: "wf-retry", receipt_claim: { workflow_id: undefined, started: true } };
    const { effect_id } = sealWorkStart(rp);
    const first = await dispatch(rp.h, effect_id, PRINCIPALS.workflow);
    assert.equal(first.kind, "ADMITTED", JSON.stringify(first));
    // Minting is at ADMISSION, so the outcome the dispatch reached changes nothing about delivery.
    assert.equal(typeof (first as { run_capability?: string }).run_capability, "string");
    assert.equal((first as { outcome: { result: string } }).outcome.result, "NO_EFFECT_CONFIRMED");

    const second = await dispatch(rp.h, effect_id, PRINCIPALS.workflow);
    assert.equal(second.kind, "ADMITTED", JSON.stringify(second));
    assert.equal((second as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((second as { run_capability?: string }).run_capability, undefined, "the retry re-delivers nothing");
    assert.equal(count(rp.h, "run_capability"), 1, "and writes no second row");
  } finally {
    rp.h.close();
  }
});

test("B6(4) over the wire: the response field appears exactly on the verified initial dispatch", async () => {
  const rp = await runProfileHarness();
  try {
    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"], ["tok-b", "cadp-workflow-b"]]);
    const api = await startKernelApi(
      { store: rp.h.store, cas: rp.h.cas, ingress: rp.h.ingress, pep: rp.h.pep, reconciler: rp.h.reconciler, evaluator: rp.h.evaluator, tokens },
      0,
    );
    try {
      const { effect_id } = sealWorkStart(rp);
      const input = rp.h.ingress.assembleAdmissionInput(effect_id, []);
      const evaluated = await rp.h.evaluate(input.input_digest.value);
      const decision_id = (evaluated as { decision: { decision_id: string } }).decision.decision_id;
      const call = async (token: string) => {
        const res = await fetch(`http://127.0.0.1:${api.port}/admit_and_dispatch`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          // The REQUEST body is unchanged at `{ effect_id, decision_id }`: the principal is the
          // authenticated one, never a body field (B6(4)).
          body: JSON.stringify({ effect_id, decision_id }),
        });
        return (await res.json()) as { kind?: string; reason?: string; run_capability?: string };
      };
      const wrong = await call("tok-b");
      assert.equal(wrong.reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH");
      assert.equal(wrong.run_capability, undefined);
      const initial = await call("tok-a");
      assert.equal(initial.kind, "ADMITTED", JSON.stringify(initial));
      assert.match(String(initial.run_capability), /^[A-Za-z0-9_-]{43}$/u);
      const repeat = await call("tok-a");
      assert.equal(repeat.run_capability, undefined, "never re-delivered");
    } finally {
      api.close();
    }
  } finally {
    rp.h.close();
  }
});

test("B6(3): the minted secret is in no store row, no envelope and no error text", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id } = sealWorkStart(rp);
    const admitted = await dispatch(rp.h, effect_id, PRINCIPALS.workflow);
    const secret = (admitted as { run_capability: string }).run_capability;
    const raw = Buffer.from(secret, "base64url");

    // Nothing durable holds the secret in ANY encoding: only `capability_digest` exists, and a
    // digest cannot be inverted, which is what makes B5(7)'s no-recovery model true rather than
    // asserted. Swept over every table in the store, not only the ones this lane writes.
    const tables = (rp.h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    assert.ok(tables.includes("run_capability") && tables.includes("evidence_envelope"));
    for (const table of tables) {
      const dump = JSON.stringify(rp.h.store.db.prepare(`SELECT * FROM ${table}`).all());
      for (const [encoding, needle] of [["base64url", secret], ["hex", raw.toString("hex")], ["base64", raw.toString("base64")]] as const) {
        assert.equal(dump.includes(needle), false, `${table} holds the secret as ${encoding}`);
      }
    }

    // And no thrown refusal carries it: a K3 conflict on the origin's own effect_id raises an
    // incident and a scope hold, which is the noisiest error path this effect has.
    let thrown: unknown;
    try {
      rp.h.ingress.sealEffectRequest(
        {
          effect_id,
          requester_ref: REQUESTER_A,
          work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }],
          target_ref: rp.target.targetRef(),
          operation_kind: "WORK_START",
          material_schema: "cadp.work-start.v1",
          material_ref: rp.h.ingress.putBlob(Buffer.from(JSON.stringify({ drifted: true }), "utf8")),
          prior_effect_refs: [],
        },
        PRINCIPALS.workflow,
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal((thrown as IngressRejection).reason, "REQUEST_DIGEST_CONFLICT");
    assert.equal((thrown as Error).message.includes(secret), false, "the refusal names a reason code, never the secret");
    assert.equal((thrown as Error).stack?.includes(secret), false);

    // The incident sealed by that path holds it nowhere either.
    const incidents = JSON.stringify(rp.h.store.openIncidents());
    assert.equal(incidents.includes(secret), false);
  } finally {
    rp.h.close();
  }
});

// ================================================ the complementary claims: nothing else changes

test("A4 w1: a NON-ENROLLED requester's ordinary WORK_START seals, dispatches and mints nothing", async () => {
  // Same v2 bundle, same registered run-origin contract — only the enrollment set is empty, which
  // is the reference posture until the run profile is switched on. The adjudication of B5(9) binds
  // enrolled requesters, so this WORK_START is not adjudicated at all: it seals with a work-run
  // binding naming ANOTHER run, acquires NO witness, and is therefore never minting — at its
  // initial dispatch or any later one (B5(1)(α)).
  const rp = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
  try {
    const { h, target } = rp;
    const tuple = {
      schema: "cadp.allocation-key.v1",
      work_run_ref: DEFAULT_WORK_RUN_REF,
      step_ordinal: 1,
      purpose: "work-start",
    };
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    const material = { workflow_id: `cadp-work-${effect_id}`, workflow_type: "cadpWork", task_queue: "cadp-worker", bounds: { max_steps: 8, max_effects: 6 } };
    h.ingress.sealEffectRequest(
      {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: DEFAULT_WORK_RUN_REF }],
        target_ref: target.targetRef(),
        operation_kind: "WORK_START",
        material_schema: "cadp.work-start.v1",
        material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
        prior_effect_refs: [],
        allocation_tuple: tuple,
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.effectRequest(effect_id)?.effect_id, effect_id, "an ordinary WORK_START still SEALS");
    assert.equal(h.store.runMembership(effect_id), undefined, "no witness");

    const admitted = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined, "no witness ⇒ no mint");
    assert.equal(count(h, "run_capability"), 0);
    assert.equal(count(h, "run_membership"), 0);
  } finally {
    rp.h.close();
  }
});

test("A4 w1 guard-bite: with the witness leg removed, an ordinary WORK_START MINTS — the leg is load-bearing", async () => {
  // The same non-enrolled, never-adjudicated `WORK_START` as the test above, dispatched by a PEP
  // whose minting predicate has been reduced to `operation_kind == WORK_START` alone. It mints a
  // `run_capability` row for an effect that was NEVER an authenticated self-origin at seal — the
  // exact fork B5(1)'s witness leg exists to make unconstructible, and the reason the leg is
  // reported as load-bearing safety rather than defence in depth (TD §13.1).
  const rp = await runProfileHarness(
    runProfileConfig({ run_profile_enrolled_requester_refs: [] }),
    new Set(["run_capability_witness"]),
  );
  try {
    const { h, target } = rp;
    const tuple = { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 7, purpose: "work-start" };
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    const material = { workflow_id: `cadp-work-${effect_id}`, workflow_type: "cadpWork", task_queue: "cadp-worker", bounds: { max_steps: 8, max_effects: 6 } };
    h.ingress.sealEffectRequest(
      {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: DEFAULT_WORK_RUN_REF }],
        target_ref: target.targetRef(),
        operation_kind: "WORK_START",
        material_schema: "cadp.work-start.v1",
        material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
        prior_effect_refs: [],
        allocation_tuple: tuple,
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.runMembership(effect_id), undefined, "still no witness — only the predicate was bitten");
    const admitted = await dispatch(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(typeof (admitted as { run_capability?: string }).run_capability, "string", "the prohibited mint");
    assert.equal(h.store.runCapability(effect_id)?.holder_ref, REQUESTER_A, "a run_capability row for a never-witnessed WORK_START");
  } finally {
    rp.h.close();
  }
});

test("v1 config: the seal and dispatch paths are byte-identical — no adjudication, no witness, no mint", async () => {
  const target = new WorkStartTarget();
  const h = await makeHarness({ identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B], extraAdapters: [target] });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    await h.pep.refreshTargetIdentity(target);
    const effect_id = h.ingress.allocateEffectId(
      { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 1, purpose: "work-start" },
      PRINCIPALS.workflow,
    );
    const material = { workflow_id: `cadp-work-${effect_id}`, workflow_type: "cadpWork", task_queue: "cadp-worker", bounds: { max_steps: 8, max_effects: 6 } };
    // Under v1 a WORK_START may bind its own effect_id, another run, or nothing at all: none of it
    // is adjudicated, exactly as in v0.4. The self-binding is the interesting one — it is the shape
    // that WOULD be an origin under v2 — and it acquires nothing here.
    h.ingress.sealEffectRequest(
      {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }],
        target_ref: target.targetRef(),
        operation_kind: "WORK_START",
        material_schema: "cadp.work-start.v1",
        material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.effectRequest(effect_id)?.effect_id, effect_id);
    assert.equal(h.store.runMembership(effect_id), undefined, "v1 writes no membership row");

    // The dispatch takes no principal, as every v0.4 caller does, and is neither refused nor minting.
    const input = h.ingress.assembleAdmissionInput(effect_id, []);
    const evaluated = await h.evaluate(input.input_digest.value);
    const admitted = await h.pep.admitAndDispatch(effect_id, (evaluated as { decision: { decision_id: string } }).decision.decision_id);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined);
    assert.equal(count(h, "run_capability"), 0);
    assert.equal(count(h, "run_membership"), 0);
  } finally {
    h.close();
  }
});

// ================================================ B5(3)-(4)/B6(3) — plumbing and the strict parser

test("B6(3): every non-canonical presentation of a VALID secret is refused RUN_CAPABILITY_INVALID", async () => {
  const rp = await runProfileHarness();
  try {
    // R1: a genuine origin whose capability is genuinely MINTED at its own verified initial
    // dispatch. Its canonical text is what B5(1) actually delivers, so accepting it is the control
    // that the parser below is calibrated to the mint and not to a fixture's private convention.
    const { effect_id: r1 } = sealWorkStart(rp, { origin_key: "origin-parser-minted" });
    const admitted = await dispatch(rp.h, r1, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    const minted = (admitted as { run_capability: string }).run_capability;
    assert.match(minted, /^[A-Za-z0-9_-]{43}$/u);
    const mintedMember = sealMember(rp, { work_run_ref: r1, capability: minted });
    assert.equal(
      rp.h.store.effectRequest(mintedMember.effect_id)?.effect_id, mintedMember.effect_id,
      "the canonical text of a genuinely minted capability SEALS a member request",
    );

    // R2: a second genuine origin, whose mint is stood in for by a DETERMINISTIC fixture written
    // through the store's own `insertRunCapability` — the exact row shape and the exact digest rule
    // the PEP writes (SHA-256 over the RAW bytes) — so the four encodings below are decidable
    // rather than dependent on which bytes a CSPRNG produced.
    const { effect_id: r2 } = sealWorkStart(rp, { origin_key: "origin-parser-fixture" });
    const raw = Buffer.from(CAPABILITY_FIXTURE_HEX, "hex");
    assert.equal(raw.length, 32, "256 bits");
    const canonical = raw.toString("base64url");
    rp.h.store.insertRunCapability({
      work_run_ref: r2,
      holder_ref: REQUESTER_A,
      capability_digest: createHash("sha256").update(raw).digest("hex"),
      minted_at: "2026-01-01T00:00:00.000Z",
    });

    const requestsBefore = count(rp.h, "effect_request");
    for (const { note, value, decodes } of nonCanonicalPresentations(canonical)) {
      // The premise, asserted rather than assumed: a PERMISSIVE decode of this string recovers the
      // very bytes the stored `capability_digest` was taken over. So the refusal below cannot be
      // attributed to a byte mismatch — it is the encoding, and only the encoding, being refused.
      const permissive = Buffer.from(value, "base64url");
      const recovered = decodes === "EXACT" ? permissive : permissive.subarray(0, 32);
      assert.ok(recovered.equals(raw), `${note}: the premise — permissive decoding yields the secret's bytes`);
      assert.notEqual(value, canonical, `${note}: a genuinely different string`);

      assert.throws(
        () => sealMember(rp, { work_run_ref: r2, capability: value }),
        (error: unknown) => {
          assert.ok(error instanceof IngressRejection, `${note}: ${String(error)}`);
          assert.equal(error.reason, "RUN_CAPABILITY_INVALID", note);
          // B6(3)'s logging prohibition, on the noisiest surface a refusal has: neither the
          // presented string, nor the canonical one, nor any prefix of either, reaches the message
          // or the stack — a refusal names the reason code and nothing derived from the secret.
          for (const secret of [value, canonical, raw.toString("hex"), raw.toString("base64")]) {
            assert.equal(error.message.includes(secret), false, `${note}: the message names the secret`);
            assert.equal(error.stack?.includes(secret) ?? false, false, `${note}: the stack names the secret`);
            assert.equal(error.message.includes(secret.slice(0, 8)), false, `${note}: the message leaks a prefix`);
          }
          return true;
        },
        `${note}: expected RUN_CAPABILITY_INVALID`,
      );
      // Pre-K3, like every other seal-time refusal: no `effect_request` row and no membership proof.
      assert.equal(count(rp.h, "effect_request"), requestsBefore, `${note}: zero effect_request rows`);
      assert.equal(rp.h.store.runMembership(r2)?.work_run_ref, r2, `${note}: R2's own witness is unmoved`);
    }

    // The positive control that attributes all four refusals to the ENCODING and to nothing else:
    // the canonical spelling of the identical bytes, against the identical row, SEALS.
    const member = sealMember(rp, { work_run_ref: r2, capability: canonical });
    assert.equal(rp.h.store.effectRequest(member.effect_id)?.effect_id, member.effect_id);
    assert.equal(count(rp.h, "effect_request"), requestsBefore + 1, "exactly one of the five presentations sealed");

    // And a well-formed capability that is simply not this run's is the OTHER RUN_CAPABILITY_INVALID
    // leg — including the no-row case, R1's capability being bound to R1 alone (B5(4)).
    assert.throws(
      () => sealMember(rp, { work_run_ref: r2, capability: minted }),
      (error: unknown) => (error as IngressRejection).reason === "RUN_CAPABILITY_INVALID",
      "R1's valid capability does not satisfy an R2-bound request",
    );
  } finally {
    rp.h.close();
  }
});

test("B6(3): two seals differing ONLY in the header have identical request and material digests", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-digest-invariance" });
    const raw = Buffer.from(CAPABILITY_FIXTURE_HEX, "hex");
    const canonical = raw.toString("base64url");
    rp.h.store.insertRunCapability({
      work_run_ref: run,
      holder_ref: REQUESTER_A,
      capability_digest: createHash("sha256").update(raw).digest("hex"),
      minted_at: "2026-01-01T00:00:00.000Z",
    });

    // Two member requests of the same run over byte-identical material and byte-identical work
    // bindings. One presents the capability; the other presents NOTHING. Nothing else differs but
    // the two values no two sealed records can ever share: the effect identity and the seal instant.
    const withHeader = sealMember(rp, { work_run_ref: run, capability: canonical }).request;
    const withoutHeader = sealMember(rp, { work_run_ref: run }).request;

    // MATERIAL DIGEST: identical outright. The header is not in the material, and the seal did not
    // fold it in — which is the claim B6(3) makes about effect material specifically.
    assert.equal(withHeader.material_ref, withoutHeader.material_ref, "one CAS object");
    assert.deepEqual(withHeader.material_digest, withoutHeader.material_digest);

    // REQUEST DIGEST: substitute the two unavoidably-differing fields and the digests must become
    // IDENTICAL. This is the exact statement of "otherwise identical seals" — anything the header
    // contributed to the preimage, whether as a record field or as a hidden member, survives the
    // substitution and breaks the equality.
    const normalised = { ...withoutHeader, effect_id: withHeader.effect_id, requested_at: withHeader.requested_at };
    assert.deepEqual(
      recordDigest(normalised as unknown as Record<string, unknown>, "request_digest"),
      withHeader.request_digest,
      "the presented header contributes nothing to request_digest",
    );
    // ...and each record's published digest is a function of its own published fields, so the
    // preimage holds no member the record does not show.
    assert.deepEqual(recordDigest(withHeader as unknown as Record<string, unknown>, "request_digest"), withHeader.request_digest);

    // The record's KEY SET is unchanged: the header is not a `RequestDraft` key, an
    // `EffectRequestV1` field, or a `SubjectBinding` (B6(3)).
    assert.deepEqual(Object.keys(withHeader).sort(), Object.keys(withoutHeader).sort());
    assert.equal(Object.keys(withHeader).some((key) => key.toLowerCase().includes("capability")), false);
    assert.deepEqual(withHeader.work_bindings, withoutHeader.work_bindings);

    // And it is durable NOWHERE: swept over every table, in every encoding, exactly as the minted
    // secret is swept for by the delivery test above.
    const tables = (rp.h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    for (const table of tables) {
      const dump = JSON.stringify(rp.h.store.db.prepare(`SELECT * FROM ${table}`).all());
      for (const needle of [canonical, raw.toString("hex"), raw.toString("base64")]) {
        assert.equal(dump.includes(needle), false, `${table} holds the presented secret`);
      }
    }
  } finally {
    rp.h.close();
  }
});

test("B6(3) over the wire: the header reaches the seal, and its refusal returns a reason code only", async () => {
  const rp = await runProfileHarness();
  try {
    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"]]);
    const api = await startKernelApi(
      { store: rp.h.store, cas: rp.h.cas, ingress: rp.h.ingress, pep: rp.h.pep, reconciler: rp.h.reconciler, evaluator: rp.h.evaluator, tokens },
      0,
    );
    try {
      const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-wire" });
      const raw = Buffer.from(CAPABILITY_FIXTURE_HEX, "hex");
      const canonical = raw.toString("base64url");
      rp.h.store.insertRunCapability({
        work_run_ref: run,
        holder_ref: REQUESTER_A,
        capability_digest: createHash("sha256").update(raw).digest("hex"),
        minted_at: "2026-01-01T00:00:00.000Z",
      });

      const seal = async (capability?: string) => {
        const tuple = { schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: (memberCounter += 1), purpose: "record-write" };
        const effect_id = rp.h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
        const material_ref = rp.h.ingress.putBlob(Buffer.from(JSON.stringify({ tenant: "scripted-1", resource_id: "r-1" }), "utf8"));
        const res = await fetch(`http://127.0.0.1:${api.port}/seal_effect_request`, {
          method: "POST",
          headers: {
            authorization: "Bearer tok-a",
            "content-type": "application/json",
            // The capability is a HEADER. The body below is the unchanged B6(1) shape.
            ...(capability === undefined ? {} : { [RUN_CAPABILITY_HEADER]: capability }),
          },
          body: JSON.stringify({
            effect_id,
            requester_ref: REQUESTER_A,
            work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: run }],
            target_ref: rp.h.target.targetRef(),
            operation_kind: "SCRIPTED_WRITE",
            material_schema: "test.scripted-write.v1",
            material_ref,
            prior_effect_refs: [],
            allocation_tuple: tuple,
          }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown>, effect_id };
      };

      // The header is genuinely PLUMBED: the same body seals or is refused according to it alone.
      const good = await seal(canonical);
      assert.equal(good.status, 200, JSON.stringify(good.body));
      assert.equal(good.body["effect_id"], good.effect_id);
      const bad = await seal(`${canonical}=`);
      assert.equal(bad.status, 422, JSON.stringify(bad.body));
      assert.equal(bad.body["error"], "RUN_CAPABILITY_INVALID");
      assert.equal(rp.h.store.effectRequest(bad.effect_id), undefined, "the refused seal wrote no K3 row");

      // The 200 body is the sealed record and carries no field derived from the header; the 422
      // body names the reason code and never the presented value or any prefix of it (B6(3)).
      for (const { body } of [good, bad]) {
        const rendered = JSON.stringify(body);
        for (const secret of [canonical, `${canonical}=`, raw.toString("hex"), raw.toString("base64"), canonical.slice(0, 8)]) {
          assert.equal(rendered.includes(secret), false, `the response echoes the secret: ${rendered}`);
        }
      }
    } finally {
      api.close();
    }
  } finally {
    rp.h.close();
  }
});

test("B5(3)-(4) gating: outside v2-plus-enrollment the header is inert, presented or malformed", async () => {
  const raw = Buffer.from(CAPABILITY_FIXTURE_HEX, "hex");
  const canonical = raw.toString("base64url");
  const junk = `${canonical}=`;

  // (a) v2, but the requester is NOT enrolled: the run profile is off for it, so a run-bound seal
  // presenting a malformed capability behaves exactly as it does with no header at all.
  const notEnrolled = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
  try {
    const { effect_id: run } = sealWorkStart(notEnrolled, { origin_key: "origin-unenrolled" });
    const member = sealMember(notEnrolled, { work_run_ref: run, capability: junk });
    assert.equal(
      notEnrolled.h.store.effectRequest(member.effect_id)?.effect_id, member.effect_id,
      "a non-enrolled requester's seal is not graded on the header",
    );
  } finally {
    notEnrolled.h.close();
  }

  // (b) A whole `cadp.kernel-config.v1` deployment: enrollment is not even expressible, so the
  // header is transport the seal path never reads — the v0.4 behaviour, byte for byte.
  const h = await makeHarness({ identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B] });
  try {
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify({ tenant: "scripted-1", resource_id: "r-1" }), "utf8"));
    const draft = (effect_id: string) => ({
      effect_id,
      requester_ref: REQUESTER_A,
      work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: DEFAULT_WORK_RUN_REF }],
      target_ref: h.target.targetRef(),
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref,
      prior_effect_refs: [],
    });
    const bare = h.ingress.allocateEffectId(
      { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 91, purpose: "record-write" },
      PRINCIPALS.workflow,
    );
    const presented = h.ingress.allocateEffectId(
      { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 92, purpose: "record-write" },
      PRINCIPALS.workflow,
    );
    const a = h.ingress.sealEffectRequest(draft(bare), PRINCIPALS.workflow);
    const b = h.ingress.sealEffectRequest(draft(presented), PRINCIPALS.workflow, { run_capability: junk });
    assert.equal(h.store.effectRequest(presented)?.effect_id, presented, "v1 seals a malformed presentation exactly as before");
    // Byte-identical: normalise the two fields no two records can share and the digests coincide.
    const normalised = { ...b, effect_id: a.effect_id, requested_at: a.requested_at };
    assert.deepEqual(recordDigest(normalised as unknown as Record<string, unknown>, "request_digest"), a.request_digest);
    assert.equal(count(h, "run_capability"), 0);
    assert.equal(count(h, "run_membership"), 0);
  } finally {
    h.close();
  }
});
