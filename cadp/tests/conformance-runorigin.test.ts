/**
 * AP B1(5)/B2(2)(ii)/B5(1)/B5(5)/B5(9) and WP §3.6 — the ALLOCATION/CONFIG/STORAGE/MINTING half of
 * the run-capability mechanism.
 *
 * What is asserted here, and against which rule:
 *   - `cadp.allocation-key.run-origin.v1` rides the generic registries with no new path, and its
 *     tuple allocates (WP §3.6, AP B1(5));
 *   - its allocation contract is IMMUTABLE for the store's lifetime — BOTH registry entries, with
 *     REMOVAL of either refused under the same code, and the precedence B2(8) pins: a deletion is
 *     `SCHEMA_DESCRIPTOR_CHANGED`, never `ALLOCATION_SCHEMA_UNREGISTERED` (B2(2)(ii));
 *   - the identity consequence that immutability exists for: one `(requester_ref, origin_key)` →
 *     exactly ONE `effect_id`, across an intervening unrelated `POLICY_ACTIVATE` (WP control 13);
 *   - `is_run_origin` — origin-or-refused, with the durable `run_membership(E, E)` on the origin
 *     path and `RUN_CAPABILITY_INVALID` on a non-self binding EVEN WITH a valid capability row for
 *     the run it names (B5(9), Spec v0.5 §9.2's negative control), with a guard-bite;
 *   - minting and delivery: the stamped-vs-sealed dispatch equality, the once-only mint keyed by
 *     the store, the pinned SHA-256-over-raw-bytes digest, and the secret's total absence from
 *     every durable row, every serialization and every error text (B5(1), B5(7), B6(3), B6(4)).
 *
 * The last test is the complementary claim: under `cadp.kernel-config.v1` none of it runs.
 *
 * NOT in this lane, and deliberately not asserted here: seal-time capability PRESENTATION
 * (`RUN_CAPABILITY_HOLDER_MISMATCH`, `RUN_SCOPE_UNRESOLVED`, `RUN_SCOPE_REFUSED`,
 * `RUN_CAPABILITY_REQUIRED`), the `x-cadp-run-capability` header, recheck #19,
 * `RUN_BINDING_REQUIRED`/`NOT_RUN_ENROLLED`, and the live `origin_key` derivation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { inspect } from "node:util";

import { startKernelApi } from "../kernel/api.ts";
import { validateKernelConfig, KernelConfigInvalid } from "../kernel/policyBundle.ts";
import type { AllocationTuple, Principal } from "../kernel/ingress.ts";
import type { SubjectBinding, TargetRef } from "../kernel/records.ts";
import type { AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim } from "../kernel/adapters/types.ts";
import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import {
  PRINCIPALS, RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY, RUN_ORIGIN_DESCRIPTOR, V2_ALLOCATION_SCHEMAS,
  V2_ALLOCATION_SCHEMA_DESCRIPTORS, makeHarness, stopSharedOpa, v2ConfigOverrides,
} from "./support/harness.ts";
import type { Harness, HarnessOptions } from "./support/harness.ts";

after(() => stopSharedOpa());

const REQUESTER_A = "workflow:cadp-work";
const REQUESTER_B = "workflow:cadp-work-b";
const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: REQUESTER_B,
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};

/** The exact `(authority_ref, namespace)` pair the harness bundle declares for the work run. */
const WORK_RUN_AUTHORITY = "cadp-store:k04";

/**
 * A scripted target that accepts `WORK_START`, so a run origin can be sealed, admitted and
 * dispatched through the PRODUCTION kernel path. Fault injection is at the transport seam only.
 */
class RunTarget implements TargetAdapterV1 {
  readonly target_type = "RUN";

  readonly authority_ref = "scripted:run";

  readonly operations: AdapterOperation[] = [
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
    return "run-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: this.targetRef(), claim: { tenant: "run-1" } };
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
      target_operation_ref: `run-op-${effect_id}-${ordinal}`,
      receipt_claim: { args_digest: material["args_digest"], started: true },
    };
  }

  async reconcile(): Promise<ReconcileResult> {
    return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { authoritative_absence: true, read_authority: "primary" } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["args_digest"] === material["args_digest"];
  }

  targetRef(): TargetRef {
    return { authority_ref: this.authority_ref, target_type: this.target_type, target_id: "run-1" };
  }
}

/**
 * A v2 harness carrying the run-origin allocation contract and an ENROLLED requester — the
 * configuration B5's rules are gated on. `run_profile_enrolled_requester_refs` being non-empty is
 * what makes B3(4)(c) require the `work-run` namespace declaration, which `v2ConfigOverrides`
 * already supplies.
 */
async function runHarness(options: HarnessOptions & { enrolled?: readonly string[] } = {}): Promise<Harness & { run: RunTarget }> {
  const run = new RunTarget();
  const h = await makeHarness({
    ...options,
    identityRegistry: options.identityRegistry ?? [...REFERENCE_IDENTITIES, IDENTITY_B],
    extraAdapters: [run, ...(options.extraAdapters ?? [])],
    configOverrides: v2ConfigOverrides({
      allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, RUN_ORIGIN_DESCRIPTOR],
      allocation_schemas: [...V2_ALLOCATION_SCHEMAS, RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY],
      run_profile_enrolled_requester_refs: options.enrolled ?? [REQUESTER_A],
      ...(options.configOverrides ?? {}),
    }) as never,
  });
  return Object.assign(h, { run });
}

function originTuple(origin_key: string): AllocationTuple {
  return { schema: "cadp.allocation-key.run-origin.v1", origin_key, purpose: "work-start" } as AllocationTuple;
}

/** Seal a `WORK_START` through the production path, with B6(1)'s tuple as its transport sibling. */
function sealOrigin(
  h: Harness & { run: RunTarget },
  options: {
    effect_id: string;
    tuple?: unknown;
    work_run_ref?: string;
    principal?: Principal;
    requester_ref?: string;
    args?: string;
  },
): { args_digest: string } {
  const args = { workflow_id: `cadp-work-${options.effect_id}`, note: options.args ?? "origin" };
  const args_digest = createHash("sha256").update(JSON.stringify(args), "utf8").digest("hex");
  const material = {
    workflow_id: args.workflow_id,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    args_digest,
    bounds: { max_steps: 8, max_effects: 6 },
  };
  h.ingress.sealEffectRequest(
    {
      effect_id: options.effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: [
        { authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: options.work_run_ref ?? options.effect_id },
      ],
      target_ref: h.run.targetRef(),
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      ...(options.tuple === undefined ? {} : { allocation_tuple: options.tuple }),
    },
    options.principal ?? PRINCIPALS.workflow,
  );
  return { args_digest };
}

/** Assemble → evaluate → return the ALLOW decision id for an already-sealed effect. */
async function decisionFor(h: Harness, effect_id: string): Promise<string> {
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION", JSON.stringify(evaluated));
  const decision = (evaluated as { decision: { outcome: string; decision_id: string } }).decision;
  assert.equal(decision.outcome, "ALLOW", JSON.stringify(decision));
  return decision.decision_id;
}

/** The whole positive origin path: allocate → seal → evaluate → dispatch as the sealed requester. */
async function originRun(h: Harness & { run: RunTarget }, origin_key: string) {
  const tuple = originTuple(origin_key);
  const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
  sealOrigin(h, { effect_id, tuple });
  const decision_id = await decisionFor(h, effect_id);
  const admitted = await h.pep.admitAndDispatch(effect_id, decision_id, PRINCIPALS.workflow);
  return { effect_id, tuple, decision_id, admitted };
}

function refusal(fn: () => unknown, reason: string, note: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { reason?: string }).reason, reason, `${note}: ${String((error as Error).message)}`);
    return true;
  }, note);
}

function countRows(h: Harness, table: string): number {
  return (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function incidents(h: Harness): number {
  return (h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'KERNEL_INCIDENT'").get() as { n: number }).n;
}

/**
 * B5(1)/B5(7)/B6(3): the secret exists NOWHERE durable. Every row of every table in the store is
 * rendered and swept for the delivered text, for its raw bytes in hex, and for the base64 (padded
 * and standard-alphabet) spellings a careless encoder might have written instead — so the sweep
 * catches a leak that merely re-encoded the same bytes.
 */
function assertSecretNowhereInStore(h: Harness, run_capability: string): void {
  const raw = Buffer.from(run_capability, "base64url");
  const spellings = [run_capability, raw.toString("hex"), raw.toString("base64"), raw.toString("base64").replace(/=+$/u, "")];
  const tables = (h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(tables.includes("run_capability"), "the sweep must cover the one table that holds a digest of it");
  for (const table of tables) {
    const dump = JSON.stringify(h.store.db.prepare(`SELECT * FROM ${table}`).all(), (_k, v: unknown) =>
      v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v);
    for (const spelling of spellings) {
      assert.ok(!dump.includes(spelling), `${table} carries the run capability secret`);
    }
  }
}

// ================================================================ B1(5)/WP §3.6 — the schema

test("B1(5)/WP §3.6: the run-origin schema validates and allocates, with no new kernel path", async () => {
  // Validation layer: the descriptor's single ENTROPY field, an EMPTY binding_projection and the
  // one fixed purpose_relation pair ride the generic registries — B2(2)(iii)'s coverage rule is
  // satisfied precisely BECAUSE the only field is ENTROPY.
  const h = await runHarness();
  try {
    const active = h.store.activeActivation()!;
    assert.ok(active !== undefined);
    const tuple = originTuple("origin-alpha");
    const first = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    // WP control 13: a retry of ONE logical origin — the same `origin_key` — converges.
    assert.equal(h.ingress.allocateEffectId({ ...tuple }, PRINCIPALS.workflow), first, "one origin, one identity");
    // ...and two DISTINCT origins over byte-identical work are distinct identities, because the
    // discriminator identifies the origin and never the work's content.
    assert.notEqual(h.ingress.allocateEffectId(originTuple("origin-beta"), PRINCIPALS.workflow), first);
    // B1(5): `origin_key` confers no effect-identity authority — the key is requester-scoped, so
    // another principal presenting the same `origin_key` receives a different identity.
    assert.notEqual(h.ingress.allocateEffectId(tuple, PRINCIPAL_B), first);
    assert.equal(countRows(h, "effect_allocation"), 3);

    // The tuple's key set is exactly the descriptor's: a vertical's own field is refused, which is
    // WP §3.6's vertical-generality claim (`origin_key` is all any vertical must supply).
    refusal(
      () => h.ingress.allocateEffectId({ ...tuple, repo_id: "github.com/x/y" } as never, PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "a vertical field is outside the descriptor's key set",
    );
    refusal(
      () => h.ingress.allocateEffectId({ ...tuple, origin_key: "" } as never, PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "origin_key violates NONEMPTY_STRING",
    );
    // B2(5): the entry's `purpose_relation` totality over the purposes this schema may allocate is
    // enforced by the ONE generic allocation-time rule — no per-schema carve-out and no kernel
    // knowledge of which purpose this schema's entry happens to pair.
    refusal(
      () => h.ingress.allocateEffectId({ ...tuple, purpose: "record-write" } as never, PRINCIPALS.workflow),
      "ALLOCATION_PURPOSE_NOT_REGISTERED",
      "a purpose the run-origin entry pairs no operation_kind with",
    );
    assert.equal(countRows(h, "effect_allocation"), 3, "no refused tuple minted an identity");
  } finally {
    h.close();
  }
});

// ================================================================ B2(2)(ii) — contract immutability

/** A minimal v2 config, so the immutability rule is asserted against bundle data and nothing else. */
function v2Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "cadp.kernel-config.v2",
    approved_digest_schemes: [
      { algorithm: "sha256", canonicalization: "raw-bytes-1" },
      { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
      { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1" },
    ],
    root_public_keys: [{ key_id: "root-1", alg: "Ed25519", public_key: "cm9vdA==", valid_from: "2026-01-01T00:00:00.000Z" }],
    attestation_keys: [],
    identity_registry: [{
      principal: "cadp-workflow", producer_ref: REQUESTER_A,
      identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
    }],
    adapter_registry: [{ producer_ref: REQUESTER_A, evidence_kinds: ["HUMAN_DECISION"], source_relation: "SELF_REPORT", produced_at_source: { kind: "NONE" } }],
    allocation_purposes: ["work-start"],
    allocation_schema_descriptors: [clone(RUN_ORIGIN_DESCRIPTOR)],
    allocation_schemas: [clone(RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY)],
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function refuseConfig(config: Record<string, unknown>, priors: readonly unknown[], reason: string, note: string): void {
  let thrown: unknown;
  try {
    validateKernelConfig(config, priors);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof KernelConfigInvalid, `${note}: expected KernelConfigInvalid, got ${String(thrown)}`);
  assert.equal((thrown as KernelConfigInvalid).reason, reason, `${note}: ${(thrown as Error).message}`);
}

test("B2(2)(ii): the run-origin contract is immutable — BOTH entries, change or removal alike", () => {
  const prior = v2Config();
  // Positive control first: re-presenting the same contract is not drift, and neither is an
  // unrelated change elsewhere in the bundle. The digest covers ONE entry, by construction.
  validateKernelConfig(v2Config(), [prior]);
  validateKernelConfig(v2Config({ allocation_purposes: ["work-start", "pr-create"] }), [prior]);

  // (a) the DESCRIPTOR entry: a role change, a value-contract change, a renamed field.
  refuseConfig(v2Config({
    allocation_schema_descriptors: [{ ...clone(RUN_ORIGIN_DESCRIPTOR), fields: [{ field: "origin_key", role: "PROJECTED", value_contract: "NONEMPTY_STRING" }] }],
    // A PROJECTED field needs a mapping, so this bundle would otherwise be
    // ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE: the immutability comparison takes precedence.
    allocation_schemas: [{ schema: RUN_ORIGIN_DESCRIPTOR.schema, binding_projection: [{ tuple_field: "origin_key", authority_ref: "cadp-store:k04", namespace: "origin" }], purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }] }],
  }), [prior], "SCHEMA_DESCRIPTOR_CHANGED", "descriptor role change");
  refuseConfig(v2Config({
    allocation_schema_descriptors: [{ ...clone(RUN_ORIGIN_DESCRIPTOR), fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "EFFECT_ID" }] }],
  }), [prior], "SCHEMA_DESCRIPTOR_CHANGED", "descriptor value_contract change");

  // (b) the MAPPING entry — claimed for this schema and no other.
  refuseConfig(v2Config({
    allocation_schemas: [{ ...clone(RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY), purpose_relation: [{ purpose: "work-start", operation_kind: "SCRIPTED_WRITE" }] }],
  }), [prior], "SCHEMA_DESCRIPTOR_CHANGED", "mapping purpose_relation change");

  // (c) REMOVAL of either entry, which is the prohibited mutation of an activated contract and
  // never the absence of a never-registered schema.
  refuseConfig(v2Config({ allocation_schemas: [] }), [prior], "SCHEMA_DESCRIPTOR_CHANGED", "mapping deleted");
  refuseConfig(v2Config({ allocation_schema_descriptors: [] }), [prior], "SCHEMA_DESCRIPTOR_CHANGED", "descriptor deleted");
  refuseConfig(v2Config({ allocation_schema_descriptors: [], allocation_schemas: [] }), [prior], "SCHEMA_DESCRIPTOR_CHANGED", "both deleted");

  // The comparison is against the SEALED STORE, not the active bundle: withdrawing the contract in
  // one activation and re-adding a DIFFERENT one in the next is the laundering path, and the
  // history is what closes it. (The withdrawal itself is already refused above; this asserts that
  // an EARLIER prior still binds even when a later one does not carry the entry.)
  const withoutEntries = v2Config({ allocation_schema_descriptors: [], allocation_schemas: [] });
  refuseConfig(v2Config({
    allocation_schema_descriptors: [{ ...clone(RUN_ORIGIN_DESCRIPTOR), fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "EFFECT_ID" }] }],
  }), [prior, withoutEntries], "SCHEMA_DESCRIPTOR_CHANGED", "re-added under a different shape after a withdrawal");
});

test("B2(8): the immutability comparison PRECEDES the generic coverage refusals", () => {
  const prior = v2Config();
  // A run-origin mapping with no descriptor is exactly `assertProjectionCoverage`'s
  // ALLOCATION_SCHEMA_UNREGISTERED case — which would misreport a DELETION as an absence. With no
  // prior activation it is that code; with one, the immutability comparison takes it first.
  const descriptorDeleted = v2Config({ allocation_schema_descriptors: [] });
  refuseConfig(descriptorDeleted, [], "ALLOCATION_SCHEMA_UNREGISTERED", "no history: the generic coverage rule owns it");
  refuseConfig(descriptorDeleted, [prior], "SCHEMA_DESCRIPTOR_CHANGED", "with history: the prohibited mutation owns it");
});

test("B2(2)(ii): the base descriptor rule binds every schema id; only run-origin's MAPPING binds", () => {
  const base = {
    allocation_purposes: ["work-start"],
    allocation_schema_descriptors: [clone(V2_ALLOCATION_SCHEMA_DESCRIPTORS[1]), clone(RUN_ORIGIN_DESCRIPTOR)],
    allocation_schemas: [
      { schema: "cadp.allocation-key.external.v1", binding_projection: [
        { tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" },
        { tuple_field: "candidate_base_sha", authority_ref: "github.com", namespace: "base-commit" },
        { tuple_field: "candidate_sha", authority_ref: "github.com", namespace: "commit" },
      ], purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }] },
      clone(RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY),
    ],
  };
  const prior = v2Config(base);

  // The base rule: another schema's DESCRIPTOR cannot change either — a different wire shape
  // requires a different schema id.
  refuseConfig(v2Config({
    ...base,
    allocation_schema_descriptors: [
      { ...clone(V2_ALLOCATION_SCHEMA_DESCRIPTORS[1]), fields: [{ field: "repo_id", role: "PROJECTED", value_contract: "NONEMPTY_STRING" }] },
      clone(RUN_ORIGIN_DESCRIPTOR),
    ],
    allocation_schemas: [
      { schema: "cadp.allocation-key.external.v1", binding_projection: [{ tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" }], purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }] },
      clone(RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY),
    ],
  }), [prior], "SCHEMA_DESCRIPTOR_CHANGED", "external descriptor change");

  // The asymmetry, stated so neither rule reads as the general one: the external schema's MAPPING
  // stays MUTABLE and contract-scoped (B1(5), B2(9)) — repointing a projection target is exactly
  // the drift that contract-scoped re-allocation exists to recover from.
  validateKernelConfig(v2Config({
    ...base,
    allocation_schemas: [
      { schema: "cadp.allocation-key.external.v1", binding_projection: [
        { tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" },
        { tuple_field: "candidate_base_sha", authority_ref: "github.com", namespace: "commit" },
        { tuple_field: "candidate_sha", authority_ref: "github.com", namespace: "base-commit" },
      ], purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }] },
      clone(RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY),
    ],
  }), [prior]);
});

test("B2(2)(ii) end to end: a POLICY_ACTIVATE carrying a drifted run-origin contract is refused", async () => {
  const h = await runHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // The activation path is `verifyProposedBundle` — genesis validation's and recheck #17's
    // shared function — so the refusal here is the one control A5 observes.
    const drifted = await h.activatePolicy({
      revision: 2,
      configOverrides: {
        allocation_schemas: [...V2_ALLOCATION_SCHEMAS, { ...clone(RUN_ORIGIN_ALLOCATION_SCHEMA_ENTRY), purpose_relation: [] }],
      } as never,
    });
    const refused = drifted.admitted as { kind: string; reason?: string; detail?: string };
    assert.equal(refused.kind, "REFUSAL", JSON.stringify(refused));
    assert.equal(refused.reason, "KERNEL_CONFIG_INVALID");
    assert.match(String(refused.detail), /SCHEMA_DESCRIPTOR_CHANGED/u, "the AP code survives into the activation detail");
    assert.equal(h.store.activeActivation()?.seq, 1, "no activation landed");

    // Positive control on the same store: an activation that leaves the run-origin entries
    // byte-identical activates normally, so the refusal above is the entry's and not the bundle's.
    const ok = await h.activatePolicy({
      revision: 3,
      configOverrides: {
        identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B, {
          principal: "cadp-workflow-c", producer_ref: "workflow:cadp-work-c",
          identity_class: { ...IDENTITY_B.identity_class },
        }],
      } as never,
    });
    assert.equal((ok.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(ok.admitted));
    assert.equal(h.store.activeActivation()?.seq, 2);
  } finally {
    h.close();
  }
});

test("B1(5)/WP control 13: one origin_key → one effect_id, ACROSS an unrelated POLICY_ACTIVATE", async () => {
  const h = await runHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const tuple = originTuple("origin-stable");
    const before = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);

    const activated = await h.activatePolicy({
      revision: 2,
      configOverrides: {
        identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B, {
          principal: "cadp-workflow-c", producer_ref: "workflow:cadp-work-c",
          identity_class: { ...IDENTITY_B.identity_class },
        }],
      } as never,
    });
    assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));

    // The consequence immutability exists for: the contract cannot have taken a second value, so
    // the derived key cannot have either. This assertion carries NO allocation-contract qualifier
    // — unlike control 1's, which belongs to the external schema and is unchanged by it.
    const after = h.ingress.allocateEffectId({ ...tuple }, PRINCIPALS.workflow);
    assert.equal(after, before, "one logical origin, one run identity, under any activation sequence");
    assert.equal(
      (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_allocation WHERE allocation_schema = ?").get(tuple.schema) as { n: number }).n,
      1,
      "exactly one allocation row for that origin, for the store's lifetime",
    );
  } finally {
    h.close();
  }
});

// ================================================================ B5(9) — origin-or-refused

test("B5(9): a self-bound minting WORK_START seals as an origin and writes run_membership(E, E)", async () => {
  const h = await runHarness();
  try {
    const tuple = originTuple("origin-self");
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    sealOrigin(h, { effect_id, tuple });

    const sealed = h.store.effectRequest(effect_id)!;
    assert.equal(sealed.effect_id, effect_id);
    // B5(5): the durable proof recheck #19 will read, inserted on the ORDINARY path — the origin
    // is not exempted from it. `work_run_ref` IS the WORK_START's own `effect_id`.
    const membership = h.store.runMembership(effect_id);
    assert.equal(membership?.effect_id, effect_id);
    assert.equal(membership?.work_run_ref, effect_id, "the run a WORK_START originates IS its own effect_id");
    // Identity ONLY: originating a scope confers no capability and no validity. Neither exists
    // until this WORK_START is dispatched (B5(1)) and graded (B5(2)).
    assert.equal(h.store.runCapability(effect_id), undefined, "no capability is acquired by originating");
    assert.equal(incidents(h), 0);

    // An idempotent re-seal is untouched by any of it: one row, one membership row, no conflict.
    sealOrigin(h, { effect_id, tuple });
    assert.equal(countRows(h, "effect_request"), 1);
    assert.equal(countRows(h, "run_membership"), 1);
    assert.equal(incidents(h), 0, "the K3 idempotency rule is unchanged");

    // B5(9): "a NON-`WORK_START` request binding its own effect_id acquires nothing by it"
    // (Spec v0.5 §9.2). Self-binding is not a shortcut — here the request never even reaches the
    // adjudication, because B2(3.5)'s purpose leg refuses an operation_kind the allocated purpose
    // does not pair with, before any K3 record exists.
    const other = h.ingress.allocateEffectId(originTuple("origin-not-a-start"), PRINCIPALS.workflow);
    refusal(
      () => h.ingress.sealEffectRequest(
        {
          effect_id: other,
          requester_ref: REQUESTER_A,
          work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: other }],
          target_ref: h.target.targetRef(),
          operation_kind: "SCRIPTED_WRITE",
          material_schema: "test.scripted-write.v1",
          material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify({ tenant: "scripted-1" }), "utf8")),
          prior_effect_refs: [],
          allocation_tuple: originTuple("origin-not-a-start"),
        },
        PRINCIPALS.workflow,
      ),
      "ALLOCATION_PURPOSE_MISMATCH",
      "a self-binding non-WORK_START acquires nothing",
    );
    assert.equal(h.store.runMembership(other), undefined, "and no membership proof");
  } finally {
    h.close();
  }
});

test("B5(9): a NON-self-bound minting WORK_START is RUN_CAPABILITY_INVALID — valid capability or not", async () => {
  for (const bite of [false, true]) {
    const h = await runHarness(bite ? { disabledIngressRules: new Set(["run_origin_adjudication"]) } : {});
    try {
      h.sealReach();
      await h.pep.refreshTargetIdentity(h.run);

      // A real, valid, holder-matching capability for run R1, whose WORK_START is COMMITTED — the
      // counterexample B5(9) names: possession of a genuinely valid capability is exactly what
      // would otherwise carry a minting WORK_START down the ordinary member path.
      const origin = await originRun(h, "origin-r1");
      assert.equal((origin.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(origin.admitted));
      const capability = h.store.runCapability(origin.effect_id);
      assert.equal(capability?.holder_ref, REQUESTER_A, "a valid row exists for the run R2 will name");

      // R2: a SECOND minting WORK_START, allocated under its own origin_key, whose work-run
      // binding names R1 rather than its own effect_id.
      const tuple = originTuple("origin-r2");
      const second = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
      const attempt = () => sealOrigin(h, { effect_id: second, tuple, work_run_ref: origin.effect_id });

      if (!bite) {
        refusal(attempt, "RUN_CAPABILITY_INVALID", "minting WORK_START bound to another run");
        assert.equal(h.store.effectRequest(second), undefined, "no effect_request row");
        assert.equal(h.store.runMembership(second), undefined, "and NO membership proof");
        assert.equal(incidents(h), 0, "a caller error, never an incident");
        assert.deepEqual(h.store.runCapability(origin.effect_id), capability, "R1's row is untouched");
        assert.deepEqual(h.store.effectIdsByWorkRun(origin.effect_id), [origin.effect_id], "R1's scope gains nothing");
      } else {
        // Guard-bite: without the adjudication the second WORK_START SEALS inside R1's scope —
        // one requester originating a second run's identity inside another run's scope, and an
        // effect counted against a run it never proved membership in. That is the prohibited delta.
        attempt();
        assert.equal(h.store.effectRequest(second)?.effect_id, second);
        assert.deepEqual(h.store.effectIdsByWorkRun(origin.effect_id), [origin.effect_id, second], "R1's scope absorbed R2");
        assert.equal(h.store.runMembership(second), undefined, "with no membership proof at all");
      }
    } finally {
      h.close();
    }
  }
});

test("B5(9): the adjudication is scoped to the run profile — a v2 bundle enrolling nobody is unchanged", async () => {
  // B5(9) adjudicates a minting WORK_START FROM AN ENROLLED REQUESTER. A v2 deployment that has
  // not enabled the run profile keeps its seal behaviour, which is what makes enrollment the
  // switch B5(3)/B3(4)(c) say it is.
  const h = await runHarness({ enrolled: [] });
  try {
    const tuple = originTuple("origin-unenrolled");
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    sealOrigin(h, { effect_id, tuple, work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-0000000000aa" });
    assert.equal(h.store.effectRequest(effect_id)?.effect_id, effect_id);
    assert.equal(h.store.runMembership(effect_id), undefined, "and no membership proof is manufactured either");
  } finally {
    h.close();
  }
});

// ================================================================ B5(1)/B6(4) — minting and delivery

test("B5(1): a minting WORK_START dispatched by anyone but its sealed requester mints NOTHING", async () => {
  const h = await runHarness();
  try {
    h.sealReach();
    await h.pep.refreshTargetIdentity(h.run);
    const tuple = originTuple("origin-mismatch");
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    sealOrigin(h, { effect_id, tuple });
    const decision_id = await decisionFor(h, effect_id);

    // Another `workflow`-class principal — authorized for the method, not for THIS effect.
    for (const [note, caller] of [["another principal", PRINCIPAL_B], ["no principal at all", undefined]] as const) {
      const refused = await h.pep.admitAndDispatch(effect_id, decision_id, caller) as { kind: string; reason?: string; detail?: string };
      assert.equal(refused.kind, "REFUSAL", `${note}: ${JSON.stringify(refused)}`);
      assert.equal(refused.reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH", note);
      assert.equal(h.store.runCapability(effect_id), undefined, `${note}: nothing minted`);
      assert.equal(h.store.admissionsByEffect(effect_id).length, 0, `${note}: no admission reserved`);
      assert.equal(h.store.outcomesByEffect(effect_id).length, 0, `${note}: no outcome written`);
    }

    // Positive control: the sealed requester's own dispatch succeeds, so the refusals above are
    // attributed to the caller identity and not to a broken chain.
    const admitted = await h.pep.admitAndDispatch(effect_id, decision_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.notEqual(h.store.runCapability(effect_id), undefined);
  } finally {
    h.close();
  }
});

test("B5(1) guard-bite: without the equality, another principal receives the run's one-shot secret", async () => {
  // The prohibited delta the rule exists to make unconstructible: B receives the capability for a
  // run whose `holder_ref` is A, so nothing A can ever do recovers it (B5(7)) and A's run is
  // permanently stranded — reachable by any authorized caller who simply races the dispatch.
  const h = await runHarness({ disabledChecks: new Set(["work_start_dispatch_requester"]) });
  try {
    h.sealReach();
    await h.pep.refreshTargetIdentity(h.run);
    const tuple = originTuple("origin-bitten");
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    sealOrigin(h, { effect_id, tuple });
    const admitted = await h.pep.admitAndDispatch(effect_id, await decisionFor(h, effect_id), PRINCIPAL_B);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(typeof (admitted as { run_capability?: string }).run_capability, "string", "guard-bite: B holds A's secret");
    assert.equal(h.store.runCapability(effect_id)?.holder_ref, REQUESTER_A, "while the row binds it to A, forever");
  } finally {
    h.close();
  }
});

test("B5(1)/B6(4): the capability is minted once, delivered once, and stored only as a digest", async () => {
  const h = await runHarness();
  try {
    h.sealReach();
    await h.pep.refreshTargetIdentity(h.run);
    // The first dispatch resolves NO_EFFECT_CONFIRMED, so B5(2)'s next-ordinal retry is reachable
    // and "a repeat dispatch mints nothing" is asserted on a real second ADMITTED result rather
    // than only on a refusal.
    h.run.onDispatch = () => ({ kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } });
    const { effect_id, admitted } = await originRun(h, "origin-mint");
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    const run_capability = (admitted as { run_capability?: string }).run_capability;
    assert.equal(typeof run_capability, "string", "the verified INITIAL dispatch delivers the secret");

    // B6(3): base64url, unpadded, of a 256-bit secret.
    assert.match(run_capability!, /^[A-Za-z0-9_-]{43}$/u, "base64url (unpadded) of 32 bytes");
    const raw = Buffer.from(run_capability!, "base64url");
    assert.equal(raw.length, 32, "256 bits from a CSPRNG");

    // B5(1): `capability_digest` is SHA-256 over the RAW 32 SECRET BYTES, never over the transport
    // text — one canonical preimage, so no encoding variant is a second string digesting to it.
    const row = h.store.runCapability(effect_id)!;
    assert.equal(row.capability_digest, createHash("sha256").update(raw).digest("hex"));
    assert.notEqual(row.capability_digest, createHash("sha256").update(run_capability!, "utf8").digest("hex"), "not the text's digest");
    assert.equal(row.holder_ref, REQUESTER_A, "the stamped requester of the WORK_START");
    assert.equal(row.work_run_ref, effect_id, "keyed by the minting WORK_START's own effect_id");
    assert.ok(!Object.keys(row).includes("revoked_at"), "no revocation column exists in this generation");

    // B5(7)/B6(3): the secret is not durable anywhere and is invisible to any serialization of the
    // result — a log, a trace or an incident CANNOT carry it, structurally rather than by
    // discipline.
    assertSecretNowhereInStore(h, run_capability!);
    assert.ok(!JSON.stringify(admitted).includes(run_capability!), "JSON.stringify of the result omits it");
    assert.ok(!JSON.stringify({ ...admitted }).includes(run_capability!), "a spread of the result omits it");
    assert.ok(!inspect(admitted, { depth: 9 }).includes(run_capability!), "util.inspect omits it");

    // B6(4)/B5(2): the REPEAT dispatch — a further ordinal after NO_EFFECT_CONFIRMED — finds the
    // row present, mints nothing, delivers nothing. What a later dispatch can change is only the
    // usability of the capability already in the holder's hands, never its delivery.
    h.run.onDispatch = undefined;
    const second = await h.pep.admitAndDispatch(effect_id, await decisionFor(h, effect_id), PRINCIPALS.workflow);
    assert.equal(second.kind, "ADMITTED", JSON.stringify(second));
    assert.equal((second as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2, "a genuine second dispatch");
    assert.equal((second as { run_capability?: string }).run_capability, undefined, "and NO second delivery");
    assert.deepEqual(h.store.runCapability(effect_id), row, "the row is byte-unchanged: minted once, ever");
    assert.equal(countRows(h, "run_capability"), 1);

    // Every error text on the path names a reason code and never the secret (B6(3)).
    const third = await h.pep.admitAndDispatch(effect_id, "cadp-v04:decision:nope", PRINCIPALS.workflow);
    assert.equal(third.kind, "REFUSAL");
    assert.ok(!JSON.stringify(third).includes(run_capability!), "a refusal carries no secret");
    let thrown = "";
    try {
      h.ingress.sealEffectRequest({ effect_id, requester_ref: "workflow:not-me" }, PRINCIPALS.workflow);
    } catch (error) {
      thrown = (error as Error).message;
    }
    assert.ok(thrown.length > 0 && !thrown.includes(run_capability!), "a thrown ingress error carries no secret");
    assertSecretNowhereInStore(h, run_capability!);
  } finally {
    h.close();
  }
});

test("B6(4) over the wire: `run_capability` rides the initial admit_and_dispatch response only", async () => {
  const h = await runHarness();
  try {
    h.sealReach();
    await h.pep.refreshTargetIdentity(h.run);
    h.run.onDispatch = () => ({ kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } });

    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"], ["tok-b", "cadp-workflow-b"]]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    try {
      const call = async (token: string, body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${api.port}/admit_and_dispatch`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      const tuple = originTuple("origin-wire");
      const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
      sealOrigin(h, { effect_id, tuple });
      const decision_id = await decisionFor(h, effect_id);

      // The principal is the one the API layer resolves from `authorization`, never a body field.
      const wrong = await call("tok-b", { effect_id, decision_id });
      assert.equal(wrong.json["reason"], "WORK_START_DISPATCH_REQUESTER_MISMATCH", JSON.stringify(wrong.json));
      assert.equal(wrong.json["run_capability"], undefined);
      assert.equal(h.store.runCapability(effect_id), undefined, "a refused dispatch mints nothing");

      const first = await call("tok-a", { effect_id, decision_id });
      assert.equal(first.json["kind"], "ADMITTED", JSON.stringify(first.json));
      const delivered = first.json["run_capability"];
      assert.equal(typeof delivered, "string", "delivered on the verified initial dispatch");
      assert.equal(
        h.store.runCapability(effect_id)?.capability_digest,
        createHash("sha256").update(Buffer.from(delivered as string, "base64url")).digest("hex"),
      );

      const repeat = await call("tok-a", { effect_id, decision_id: await decisionFor(h, effect_id) });
      assert.equal(repeat.json["kind"], "ADMITTED", JSON.stringify(repeat.json));
      assert.equal(repeat.json["run_capability"], undefined, "absent in every non-initial result");
      assertSecretNowhereInStore(h, delivered as string);
    } finally {
      api.close();
    }
  } finally {
    h.close();
  }
});

// ================================================================ v1-config regression

test("v1 config: no adjudication, no minting, no requester gate — the v0.4 dispatch path exactly", async () => {
  const run = new RunTarget();
  const h = Object.assign(
    await makeHarness({ identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B], extraAdapters: [run] }),
    { run },
  );
  try {
    h.sealReach();
    await h.pep.refreshTargetIdentity(run);
    const effect_id = h.ingress.allocateEffectId(
      { schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000", step_ordinal: 1, purpose: "work-start" },
      PRINCIPALS.workflow,
    );
    // A minting WORK_START bound to ANOTHER run seals under v1, exactly as it does today: B5's
    // rules are v0.5 contract and the running v0.4 deployment must not observe them.
    sealOrigin(h, { effect_id, work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-0000000000bb" });
    assert.equal(h.store.effectRequest(effect_id)?.effect_id, effect_id);
    assert.equal(h.store.runMembership(effect_id), undefined, "no membership row under v1");

    // ...and it dispatches with NO principal at all, minting nothing.
    const admitted = await h.pep.admitAndDispatch(effect_id, await decisionFor(h, effect_id));
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined, "no capability under v1");
    assert.equal(h.store.runCapability(effect_id), undefined);
    assert.equal(countRows(h, "run_capability"), 0);
    assert.equal(countRows(h, "run_membership"), 0);
    assert.equal(incidents(h), 0);
  } finally {
    h.close();
  }
});
