/**
 * AP B1(5)/B2(2)(ii)/B5 — the run-capability mechanism.
 *
 * PART 1, the ALLOCATION, CONFIG, STORAGE and MINTING half: the
 * `cadp.allocation-key.run-origin.v1` contract and its lifetime immutability, the seal-time
 * `is_run_origin` adjudication (ORIGIN-OR-REFUSED) and its durable `run_membership(E, E)` witness,
 * and the WITNESSED mint delivered exactly once at the verified initial `admit_and_dispatch`.
 *
 * PART 2, B5(3)-(4)/B6(3): the request-metadata PLUMBING of the `x-cadp-run-capability` header
 * from `api.ts` to the seal, and the STRICT PARSER every presentation is read through before its
 * digest is compared.
 *
 * PART 3, B5(3)-(5): the rest of the seal-time run binding, one
 * test per reason code and in the order the Ingress grades them — `RUN_BINDING_REQUIRED`,
 * `NOT_RUN_ENROLLED`, `RUN_CAPABILITY_REQUIRED`, `RUN_CAPABILITY_INVALID` (same-holder wrong-run
 * borrowing included), `RUN_CAPABILITY_HOLDER_MISMATCH`, and B5(2)'s K7 grading of the run's own
 * `WORK_START` (`RUN_SCOPE_UNRESOLVED`, `RUN_SCOPE_REFUSED`, and both of its one-way flips) — plus
 * the `run_membership(F, W)` proof a passing member seals and the ZERO durable rows every refusal
 * leaves. Each of these NARROWS what seals, which is why Parts 1 and 2 need no re-statement: what
 * they assert seals still seals, and the two places where a request they exercised is now refused
 * one leg earlier under an exacter code are noted at those assertions. Recheck #19's
 * `RUN_MEMBERSHIP_UNPROVEN` is the PEP-time code and is asserted in PART 5, never here: no
 * seal-time leg reports it, and a refusal under it in this section would mean the wrong rule fired.
 *
 * PART 4, the last section of this file: the K7 CONFORMANCE MATRIX — B5(2)'s grading stated once
 * per reachable history of the run's own `WORK_START`, each case presenting ONE capability (the one
 * its verified initial dispatch delivered) at EVERY state that history passes through, so a case
 * that re-minted or needed a second secret fails rather than passes quietly. The four corners are
 * `UNKNOWN` at ordinal 1 lifted by reconciliation; `NO_EFFECT_CONFIRMED` at ordinal 1 lifted by a
 * `COMMITTED` ordinal 2; an ADMITTED but unresolved ordinal 2 (`RUN_SCOPE_UNRESOLVED`, never the
 * superseded ordinal-1 grading); and a `COMMITTED` ordinal 1 behind an unresolved ordinal 2 — the
 * corner recheck #12 makes unconstructible, asserted both as unreachable and as fail-closed if it
 * were reached. Each case carries the same cross-cutting claims: a permitted follow-up writes
 * `run_membership(effect_id, work_run_ref)` and reports no reason code, every refusal leaves ZERO
 * `effect_request` rows, the mint and its delivery stay once-only under controls A4/A5, and no
 * rendering of the secret reaches a refusal message, a store row or the process's own log. The
 * section closes on the gating regression: under `cadp.kernel-config.v1` and under a v2 bundle
 * whose governing registry content is absent, the very request the first case is refused for seals
 * byte-identically to the same request presenting nothing at all.
 *
 * PART 5, B5(5)'s ADMISSION-time half: `§4.4` recheck #19, the PEP's requirement that an enrolled
 * requester's run-bound effect carry the durable `run_membership` row its OWN seal wrote, naming
 * EXACTLY the run it is bound to — `RUN_MEMBERSHIP_UNPROVEN` when it is absent or names another
 * run. The matching row admits; the cross-boundary effect that reached a K3 row before its
 * requester was enrolled is refused with ZERO downstream delta; the check is load-bearing under the
 * `recheck19_run_membership` guard-bite knob; and it activates for no v1 deployment, no ungoverned
 * v2 bundle and no non-enrolled requester.
 *
 * PART 6, the last section: the CHECKED-OUT live composition (`cadp/live/ops.ts`'s `startWork`) on
 * this path, driven against the real Ingress and PEP — the request it builds under the v0.5 origin
 * profile is adjudicated an origin and acquires the `run_membership(E, E)` witness; a retry of one
 * origin over a MOVED base ref and a REBUILT worker image converges on one `effect_id`, one
 * allocation, one K3 row and ZERO incidents; and the DEFAULT (v0.4) profile still seals through a
 * v1 kernel witnessing nothing. The ops-side claims it complements — the tuple's exact shape, the
 * byte-reproducible material and the origin record's guards — are in `conformance-basesha.test.ts`.
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { startKernelApi } from "../../kernel/api.ts";
import { IngressRejection, RUN_CAPABILITY_HEADER } from "../../kernel/ingress.ts";
import type { Principal } from "../../kernel/ingress.ts";
import { recordDigest } from "../../kernel/canonical.ts";
import type { EffectRequestV1 } from "../../kernel/records.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA, KernelConfigInvalid, validateKernelConfig } from "../../kernel/policyBundle.ts";
import type { ActivatedAllocationContracts } from "../../kernel/policyBundle.ts";
import type { AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim } from "../../kernel/adapters/types.ts";
import type { SubjectBinding, TargetRef } from "../../kernel/records.ts";
import { REFERENCE_IDENTITIES, buildReferenceKernelConfig } from "../../deployment/referencePolicy.ts";
import { startWork } from "../../live/ops.ts";
import type { StartWorkDependencies, SurfaceImageIdentity, WorkStartKernelClient } from "../../live/ops.ts";
import type { LiveEnvManifest } from "../../live/env.ts";
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
    /**
     * The WHOLE `work_bindings` array, for the cases this helper's single binding cannot express —
     * `[]` above all, which is B5(3)'s missing-binding case. The run-origin schema projects nothing
     * (`binding_projection: []`), so B2(3.4) demands no binding of its own and such a request
     * reaches the run-profile legs carrying exactly what the test gave it.
     */
    work_bindings?: readonly SubjectBinding[];
    /** Presented as REQUEST METADATA, for the legs graded BEFORE any header is read. */
    capability?: string;
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
      work_bindings: options.work_bindings ?? [{
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
    options.capability === undefined ? {} : { run_capability: options.capability },
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
  options: {
    work_run_ref: string;
    capability?: string;
    principal?: Principal;
    requester_ref?: string;
    /** The WHOLE `work_bindings` array; `[]` is B5(3)'s missing-binding case for a member request. */
    work_bindings?: readonly SubjectBinding[];
  },
): { effect_id: string; request: EffectRequestV1 } {
  const { h } = rp;
  const principal = options.principal ?? PRINCIPALS.workflow;
  const tuple = {
    schema: "cadp.allocation-key.v1",
    work_run_ref: options.work_run_ref,
    step_ordinal: (memberCounter += 1),
    purpose: "record-write",
  };
  const effect_id = h.ingress.allocateEffectId(tuple, principal);
  // Deliberately free of any effect-specific member, so two members of the same run seal over
  // BYTE-IDENTICAL material and therefore over one CAS key and one `material_digest`.
  const material = { tenant: "scripted-1", resource_id: "r-1" };
  const request = h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: options.work_bindings ??
        [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: options.work_run_ref }],
      target_ref: h.target.targetRef(),
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    principal,
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

/**
 * Every rendering of ONE capability a leak could plausibly take: the canonical transport text
 * itself, the two other encodings of the identical bytes, and an 8-character prefix of the
 * canonical text — the "surely a fragment is harmless" case B6(3) does not exempt.
 */
function capabilityRenderings(capability: string): readonly string[] {
  const raw = Buffer.from(capability, "base64url");
  return [capability, raw.toString("hex"), raw.toString("base64"), capability.slice(0, 8)];
}

function assertNoCapabilityText(haystack: string, capability: string, note: string): void {
  for (const rendering of capabilityRenderings(capability)) {
    assert.equal(haystack.includes(rendering), false, `${note}: a capability rendering is present`);
  }
}

/**
 * B6(3) over the OBSERVABLE LOG: the process's own output streams, recorded for the duration of a
 * case and swept afterwards. `console.log`/`console.error` write through these two `write`
 * functions, so patching them covers every logging surface the Kernel actually has (`kernelService`
 * is the only module in the checkout that logs at all, and nothing on the seal, mint, dispatch or
 * reconcile path does). Each chunk is FORWARDED to the original writer as well as recorded — the
 * test runner's own reporter writes through the same function, and swallowing its output would
 * corrupt the run rather than test it.
 */
function captureObservableText(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  // While `probing`, chunks are recorded but NOT forwarded — the self-check below writes through
  // both streams to prove the recording path is live, and a sweep over a transcript that silently
  // recorded nothing would be a vacuous assertion rather than a weaker one.
  let probing = true;
  const patched = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    (stream as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return probing ? true : original(chunk, ...rest);
    };
    return { stream, original };
  });
  const probe = "cadp-run-capability-log-probe";
  console.log(probe);
  console.error(probe);
  assert.equal(chunks.filter((chunk) => chunk.includes(probe)).length, 2, "the log capture records both streams");
  probing = false;
  chunks.length = 0;
  return {
    text: () => chunks.join(""),
    restore: () => {
      for (const { stream, original } of patched) (stream as unknown as { write: unknown }).write = original;
    },
  };
}

/**
 * The A4/A5 DELIVERY invariants of a whole K7 case, asserted after every state the run passed
 * through: control A5's one-capability-per-run (`run_capability`'s primary key is the run, and this
 * store holds exactly the one row), control A4's mint-once (the row still digests the ONE secret
 * that was delivered at the verified initial dispatch, so no later ordinal re-minted under the same
 * key), and B5(7)/B6(3)'s no-recovery (no table holds any rendering of it — a digest is all there
 * is). Stated as a function of the DELIVERED text, so a re-mint that replaced the row would fail
 * here even though the row count stayed at one.
 */
function assertDeliveryInvariants(rp: RunProfileHarness, run: string, capability: string, note: string): void {
  assert.equal(count(rp.h, "run_capability"), 1, `${note}: exactly one capability row in the store`);
  const row = rp.h.store.runCapability(run);
  assert.equal(row?.work_run_ref, run, `${note}: the row is keyed by the run`);
  assert.equal(row?.holder_ref, REQUESTER_A, `${note}: the holder is the sealed requester`);
  assert.equal(
    row?.capability_digest,
    createHash("sha256").update(Buffer.from(capability, "base64url")).digest("hex"),
    `${note}: the row still digests the ONE delivered secret — nothing re-minted`,
  );
  const tables = (rp.h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((entry) => entry.name);
  for (const table of tables) {
    const dump = JSON.stringify(rp.h.store.db.prepare(`SELECT * FROM ${table}`).all());
    for (const rendering of capabilityRenderings(capability).slice(0, 3)) {
      assert.equal(dump.includes(rendering), false, `${note}: ${table} holds the secret`);
    }
  }
}

/**
 * A follow-up that PASSES every leg of B5(3)-(4) and B5(2)'s K7 grading: it seals, it raises NO
 * refusal reason (the `IngressRejection` catch is the assertion — a graded-but-permitted path must
 * not report a code), and B5(5) writes `run_membership(effect_id, work_run_ref)` in the SAME
 * transaction as the K3 row, naming the RUN in the second column and never the follow-up itself.
 */
function sealsFollowUp(rp: RunProfileHarness, run: string, capability: string, note: string): string {
  const requests = count(rp.h, "effect_request");
  let effect_id: string;
  try {
    effect_id = sealMember(rp, { work_run_ref: run, capability }).effect_id;
  } catch (error) {
    return assert.fail(
      `${note}: expected a seal with no refusal reason, got ${
        error instanceof IngressRejection ? error.reason : String(error)
      }`,
    );
  }
  assert.equal(rp.h.store.effectRequest(effect_id)?.effect_id, effect_id, `${note}: the follow-up SEALS`);
  assert.equal(count(rp.h, "effect_request"), requests + 1, `${note}: exactly one K3 row`);
  const membership = rp.h.store.runMembership(effect_id);
  assert.equal(membership?.effect_id, effect_id, `${note}: run_membership's first column is the follow-up`);
  assert.equal(membership?.work_run_ref, run, `${note}: run_membership's second column is the RUN`);
  return effect_id;
}

/**
 * Every seal-time refusal of B5(3)-(5) is PRE-K3: it is graded inside the sealing transaction and
 * BEFORE the `effect_request` insert, so a refused seal's durable delta is ZERO rows — no K3
 * record and no membership proof (Spec v0.5 §9.2). Asserted here once, for every reason code,
 * rather than restated at each call site. The reason code is compared EXACTLY: the order of the
 * legs is the contract, and a refusal under a neighbouring code would satisfy a looser assertion
 * while meaning something else entirely.
 *
 * `capability`, when given, is the secret the refused presentation carried: the refusal's own
 * message and stack are then swept for every rendering of it (B6(3)), which is the surface a
 * refusal path can leak on that no store sweep would catch.
 */
function refuses(
  rp: RunProfileHarness,
  reason: string,
  seal: () => unknown,
  note: string = reason,
  capability?: string,
): void {
  const requests = count(rp.h, "effect_request");
  const memberships = count(rp.h, "run_membership");
  assert.throws(
    seal,
    (error: unknown) => {
      assert.ok(error instanceof IngressRejection, `${note}: ${String(error)}`);
      assert.equal(error.reason, reason, `${note}: ${error.message}`);
      if (capability !== undefined) {
        assertNoCapabilityText(error.message, capability, `${note}: the refusal message`);
        assertNoCapabilityText(error.stack ?? "", capability, `${note}: the refusal stack`);
      }
      return true;
    },
    `${note}: expected ${reason}`,
  );
  assert.equal(count(rp.h, "effect_request"), requests, `${note}: zero effect_request rows`);
  assert.equal(count(rp.h, "run_membership"), memberships, `${note}: zero run_membership rows`);
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
  // The run profile is deliberately OFF here (empty enrollment). This test is about the allocation
  // contract's lifetime immutability, and its vehicle is the harness's own `POLICY_ACTIVATE` — a
  // run-bound request by `workflow:cadp-work` naming a run it holds no capability for, which with
  // the profile switched on is B5(4)'s `RUN_CAPABILITY_REQUIRED` before recheck #17 is ever
  // reached. Enrollment is irrelevant to everything asserted below (B2(2)(ii) is generic over
  // schemas), so switching it off keeps the subject of the test the subject of the test.
  const { h } = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
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
  // Enrollment off for the same reason as the test above: the vehicle is the harness's own
  // run-bound `POLICY_ACTIVATE`, and nothing asserted here seals a run-profile request. Allocation
  // is not gated on enrollment at all (B1(2)), so the key derivation under test is unaffected.
  const { h } = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
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
    // matches the DECLARED exact pair, so this never satisfies the adjudication. With B5(3) landed
    // it does not even reach it — a request naming no DECLARED work-run subject is leg 2's "none"
    // case, which `RUN_BINDING_REQUIRED` refuses one leg earlier under the exacter code.
    assert.throws(
      () => sealWorkStart(rp, { origin_key: "origin-fourth", authority_ref: "other" }),
      (error: unknown) => (error as IngressRejection).reason === "RUN_BINDING_REQUIRED",
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
    // B5(2): a presentation is graded on the run's OWN `WORK_START` K7 state, so R2 is driven to
    // `COMMITTED` before anything is presented against it — otherwise every leg below would be
    // refused `RUN_SCOPE_UNRESOLVED` and none of them would be about the encoding. Pre-inserting
    // the row above is what keeps the fixture in place across that dispatch: the mint is skipped
    // when a `run_capability` row already exists (B5(1)), so nothing is delivered and the
    // deterministic secret stays this run's only one.
    const started = await dispatch(rp.h, r2, PRINCIPALS.workflow);
    assert.equal(started.kind, "ADMITTED", JSON.stringify(started));
    assert.equal((started as { run_capability?: string }).run_capability, undefined, "the fixture row suppressed the mint");

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

test("B6(3): a CONSUMED header and no header at all seal identical request and material digests", async () => {
  const rp = await runProfileHarness();
  // The counterpart store: the SAME v2 bundle with the run profile switched OFF, where the header
  // is transport the seal path never reads. It is a second harness rather than a second seal on
  // the first one because, with B5(4) landed, an enrolled requester's run-bound request presenting
  // NOTHING is refused `RUN_CAPABILITY_REQUIRED` — so "the same request without the header" is only
  // sealable where the header is inert. That makes the comparison the stronger of the two: a
  // CONSUMED capability leaves a record byte-identical to the one sealed where none was read.
  const inert = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
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
    // B5(2): the run's `WORK_START` must be `COMMITTED` for either presentation below to be graded
    // usable; the pre-inserted fixture row suppresses the mint at that dispatch (B5(1)).
    assert.equal((await dispatch(rp.h, run, PRINCIPALS.workflow)).kind, "ADMITTED");

    // Two member requests naming the same run, over byte-identical material and byte-identical
    // work bindings, sealed by the same stamped requester against the same target. One presents
    // the capability and has it CONSUMED by B5(4)'s legs; the other presents NOTHING on the store
    // where the profile is off. Nothing else differs but the two values no two sealed records can
    // ever share: the effect identity and the seal instant.
    const withHeader = sealMember(rp, { work_run_ref: run, capability: canonical }).request;
    const withoutHeader = sealMember(inert, { work_run_ref: run }).request;

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
    inert.h.close();
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
      // B5(2): the run must be `COMMITTED` for the good presentation below to be graded usable;
      // the pre-inserted fixture row suppresses the mint at that dispatch (B5(1)).
      assert.equal((await dispatch(rp.h, run, PRINCIPALS.workflow)).kind, "ADMITTED");

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

// ================================================ B5(3)-(5) — the seal-time run binding, in order

test("B5(3)-(5): an origin seals headerless, mints once at its dispatch, and its capability seals a member", async () => {
  const rp = await runProfileHarness();
  try {
    // (1) THE ORIGIN. An enrolled requester's self-bound `WORK_START`, presenting NO header —
    // B5(9)'s origin path is exempted from B5(4)'s presentation legs precisely because the run it
    // would present for is the one this seal is originating (there is no row and no K7 state yet).
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-happy-path" });
    assert.equal(rp.h.store.effectRequest(run)?.effect_id, run, "the origin seals with no capability presented");
    assert.equal(rp.h.store.runMembership(run)?.work_run_ref, run, "B5(5) writes the self-referential witness");

    // (2) THE VERIFIED INITIAL DISPATCH mints and delivers exactly once, to the sealed requester.
    const admitted = await dispatch(rp.h, run, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    const capability = (admitted as { run_capability?: string }).run_capability;
    assert.match(String(capability), /^[A-Za-z0-9_-]{43}$/u, "the one delivery of the one-shot secret");
    assert.equal(count(rp.h, "run_capability"), 1);
    assert.equal(rp.h.store.runCapability(run)?.holder_ref, REQUESTER_A, "the holder is the sealed requester");

    // (3) THE WORK_START IS COMMITTED — the K7 state B5(2)'s grading reads, and the only one of the
    // three that makes the scope usable.
    assert.deepEqual(rp.h.store.outcomesByEffect(run).map((o) => o.result), ["COMMITTED"]);

    // (4) THE FOLLOW-UP. An ordinary member of that run presenting the delivered capability passes
    // every leg — decode, digest, holder, K7 — and B5(5) writes `run_membership(follow_up, E)` in
    // the SAME transaction as the K3 row: the durable proof recheck #19 reads at admission.
    const followUp = sealMember(rp, { work_run_ref: run, capability: capability! });
    assert.equal(rp.h.store.effectRequest(followUp.effect_id)?.effect_id, followUp.effect_id, "the member SEALS");
    const membership = rp.h.store.runMembership(followUp.effect_id);
    assert.equal(membership?.effect_id, followUp.effect_id);
    assert.equal(membership?.work_run_ref, run, "the member's proof names the RUN, never itself");
    assert.equal(count(rp.h, "run_membership"), 2, "the origin's witness and the member's proof, and nothing else");
    assert.equal(count(rp.h, "run_capability"), 1, "sealing a member mints nothing and re-delivers nothing");
  } finally {
    rp.h.close();
  }
});

test("B5(3): an enrolled requester's request that binds no work run is refused RUN_BINDING_REQUIRED", async () => {
  const rp = await runProfileHarness();
  try {
    // Enrollment IS the statement that this requester's effects are run-scoped, so an unbound
    // request from one is refused rather than merely uncounted (Spec v0.5 §5.1). The refusal is
    // graded AHEAD of B5(9)'s adjudication, whose leg-2 "none" case would report the less exact
    // `RUN_CAPABILITY_INVALID` for the very same request.
    refuses(rp, "RUN_BINDING_REQUIRED", () => sealWorkStart(rp, { origin_key: "origin-unbound", work_bindings: [] }));

    // A genuine, `COMMITTED` run of this requester's own, whose capability it genuinely holds...
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-bound-control" });
    const admitted = await dispatch(rp.h, run, PRINCIPALS.workflow);
    const capability = (admitted as { run_capability: string }).run_capability;

    // ...does not make an UNBOUND request bound: the binding legs are graded on the sealed record
    // before any header is read, so the same code is raised whatever is presented.
    refuses(
      rp, "RUN_BINDING_REQUIRED",
      () => sealWorkStart(rp, { origin_key: "origin-unbound-2", work_bindings: [], capability }),
      "unbound while holding a valid capability",
    );
    // THE PRECEDENCE, asserted rather than assumed: for an allocation schema that PROJECTS onto the
    // work-run pair, B2(3.4) demands that binding and runs BEFORE any run-profile leg, so an
    // unbound member request never reaches B5(3) at all. B5(3)'s missing-binding case is therefore
    // exactly the non-projecting schemas' — the run-origin one above — and this leg records which
    // rule owns which request rather than leaving the two codes looking interchangeable.
    refuses(
      rp, "ALLOCATION_BINDING_MISMATCH",
      () => sealMember(rp, { work_run_ref: run, capability, work_bindings: [] }),
      "an unbound member request under a PROJECTING schema",
    );

    // Positive control: the identical member request, bound, SEALS — so the three refusals are
    // attributed to the missing binding and to nothing else about this requester.
    const member = sealMember(rp, { work_run_ref: run, capability });
    assert.equal(rp.h.store.effectRequest(member.effect_id)?.effect_id, member.effect_id);
  } finally {
    rp.h.close();
  }
});

test("B5(3): a NON-enrolled requester carrying a work-run binding is refused NOT_RUN_ENROLLED", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-enrollment" });
    const admitted = await dispatch(rp.h, run, PRINCIPALS.workflow);
    const capability = (admitted as { run_capability: string }).run_capability;

    // REQUESTER_B is a registered identity that the enrolled set does not name. Its request binds
    // A's run: enrollment cannot be acquired by presenting a binding (WP §5.2, WP control 5).
    refuses(
      rp, "NOT_RUN_ENROLLED",
      () => sealMember(rp, { work_run_ref: run, principal: PRINCIPAL_B, requester_ref: REQUESTER_B }),
      "a non-enrolled requester binding another's run",
    );
    // Nor by presenting a capability for it — even A's genuinely valid one, exfiltrated: the
    // enrollment leg is graded before anything reads the header, so this is NOT_RUN_ENROLLED and
    // not the `RUN_CAPABILITY_HOLDER_MISMATCH` the holder leg would raise if it were reached.
    refuses(
      rp, "NOT_RUN_ENROLLED",
      () => sealMember(rp, { work_run_ref: run, capability, principal: PRINCIPAL_B, requester_ref: REQUESTER_B }),
      "a non-enrolled requester presenting a valid capability",
    );

    // Positive control, and the exact scope of the leg: the same non-enrolled requester's request
    // that binds NO work run is untouched — it seals, is never adjudicated, and acquires no
    // witness and no membership proof (B5(1)(α)).
    const unbound = sealWorkStart(rp, {
      origin_key: "origin-b-unbound", principal: PRINCIPAL_B, requester_ref: REQUESTER_B, work_bindings: [],
    });
    assert.equal(rp.h.store.effectRequest(unbound.effect_id)?.effect_id, unbound.effect_id, "a non-enrolled unbound request SEALS");
    assert.equal(rp.h.store.runMembership(unbound.effect_id), undefined, "and acquires no membership proof");
  } finally {
    rp.h.close();
  }
});

test("B5(4): an enrolled, run-bound, NON-origin request presenting nothing is refused RUN_CAPABILITY_REQUIRED", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-required" });
    const admitted = await dispatch(rp.h, run, PRINCIPALS.workflow);
    const capability = (admitted as { run_capability: string }).run_capability;

    // The run is `COMMITTED` and its capability exists and is held by this very requester: the ONLY
    // thing missing is the presentation, which is what makes this code distinct from
    // `RUN_BINDING_REQUIRED` (a missing binding) and from `RUN_CAPABILITY_INVALID` (a presentation
    // that fails). Nothing about the run is unusable — the request simply proves nothing.
    refuses(rp, "RUN_CAPABILITY_REQUIRED", () => sealMember(rp, { work_run_ref: run }));

    // Positive control: the identical request presenting the delivered capability SEALS, so the
    // refusal is attributed to the absent header alone.
    const member = sealMember(rp, { work_run_ref: run, capability });
    assert.equal(rp.h.store.effectRequest(member.effect_id)?.effect_id, member.effect_id);
    assert.equal(rp.h.store.runMembership(member.effect_id)?.work_run_ref, run);
  } finally {
    rp.h.close();
  }
});

test("B5(4): a capability matching no row for THIS run — borrowing included — is refused RUN_CAPABILITY_INVALID", async () => {
  const rp = await runProfileHarness();
  try {
    // TWO genuine runs of the SAME requester, each `COMMITTED`, each with its own minted, genuinely
    // valid, holder-matching capability. Everything about the two capabilities is legitimate; the
    // only thing wrong below is WHICH RUN each is presented against.
    const { effect_id: r1 } = sealWorkStart(rp, { origin_key: "origin-borrow-1" });
    const { effect_id: r2 } = sealWorkStart(rp, { origin_key: "origin-borrow-2" });
    const c1 = ((await dispatch(rp.h, r1, PRINCIPALS.workflow)) as { run_capability: string }).run_capability;
    const c2 = ((await dispatch(rp.h, r2, PRINCIPALS.workflow)) as { run_capability: string }).run_capability;
    assert.equal(rp.h.store.runCapability(r1)?.holder_ref, REQUESTER_A);
    assert.equal(rp.h.store.runCapability(r2)?.holder_ref, REQUESTER_A, "SAME holder: the holder leg cannot be what refuses");

    // SAME-HOLDER, WRONG-RUN BORROWING, both directions. The lookup is keyed by the request's OWN
    // `work_run_ref`, so R1's capability matches no R2 row at all — this is the digest leg, NOT
    // `RUN_CAPABILITY_HOLDER_MISMATCH`, which would require a matched row.
    refuses(rp, "RUN_CAPABILITY_INVALID", () => sealMember(rp, { work_run_ref: r2, capability: c1 }), "R1's capability on an R2-bound request");
    refuses(rp, "RUN_CAPABILITY_INVALID", () => sealMember(rp, { work_run_ref: r1, capability: c2 }), "the converse");

    // The NO-ROW case, which the same message covers deliberately (B6(3)): a fabricated run that
    // was never witnessed and never minted against has no row, permanently.
    refuses(
      rp, "RUN_CAPABILITY_INVALID",
      () => sealMember(rp, { work_run_ref: DEFAULT_WORK_RUN_REF, capability: c1 }),
      "a never-witnessed run",
    );
    // A well-formed capability that is nobody's, and a non-canonical encoding of a real one: the
    // decode leg and the digest leg, both under this one code.
    refuses(
      rp, "RUN_CAPABILITY_INVALID",
      () => sealMember(rp, { work_run_ref: r1, capability: Buffer.from(CAPABILITY_FIXTURE_HEX, "hex").toString("base64url") }),
      "a capability no row holds",
    );
    refuses(rp, "RUN_CAPABILITY_INVALID", () => sealMember(rp, { work_run_ref: r1, capability: `${c1}=` }), "a non-canonical encoding");

    // Positive controls: each capability against its OWN run SEALS, so all five refusals are
    // attributed to the run keying and to nothing about the capabilities themselves.
    for (const [work_run_ref, capability] of [[r1, c1], [r2, c2]] as const) {
      const member = sealMember(rp, { work_run_ref, capability });
      assert.equal(rp.h.store.runMembership(member.effect_id)?.work_run_ref, work_run_ref);
    }
  } finally {
    rp.h.close();
  }
});

test("B5(4): a MATCHED row held by another requester is refused RUN_CAPABILITY_HOLDER_MISMATCH", async () => {
  // Both requesters enrolled, so the enrollment legs are satisfied for each and the only thing
  // graded below is the holder — this is the exfiltration case of control A4, where possession is
  // real and authority is not.
  const rp = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [REQUESTER_A, REQUESTER_B] }));
  try {
    // B's own run: originated by B, dispatched by B, so the row's `holder_ref` is B's stamped ref
    // and the secret went to B and to nobody else.
    const { effect_id: runB } = sealWorkStart(rp, { origin_key: "origin-holder-b", principal: PRINCIPAL_B, requester_ref: REQUESTER_B });
    const admitted = await dispatch(rp.h, runB, PRINCIPAL_B);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    const capabilityB = (admitted as { run_capability: string }).run_capability;
    assert.equal(rp.h.store.runCapability(runB)?.holder_ref, REQUESTER_B);
    assert.deepEqual(rp.h.store.outcomesByEffect(runB).map((o) => o.result), ["COMMITTED"], "the scope is usable, for its holder");

    // A presents B's exfiltrated capability on a request bound to B's run. The digest leg PASSES —
    // the row is B's and the secret is B's — and the holder leg is what refuses: possession is
    // never sufficient, because the row binds one capability to one run AND one holder.
    refuses(rp, "RUN_CAPABILITY_HOLDER_MISMATCH", () => sealMember(rp, { work_run_ref: runB, capability: capabilityB }));

    // Positive control on the same row, the same secret and the same run: its HOLDER's identical
    // request SEALS, so the refusal is attributed to the stamped requester and to nothing else.
    const held = sealMember(rp, { work_run_ref: runB, capability: capabilityB, principal: PRINCIPAL_B, requester_ref: REQUESTER_B });
    assert.equal(rp.h.store.effectRequest(held.effect_id)?.effect_id, held.effect_id);
    assert.equal(rp.h.store.runMembership(held.effect_id)?.work_run_ref, runB);
  } finally {
    rp.h.close();
  }
});

test("B5(2)/B5(4): an unresolved run scope is refused RUN_SCOPE_UNRESOLVED, and reconciliation lifts it", async () => {
  const rp = await runProfileHarness();
  try {
    // (a) NO ADMITTED DISPATCH AT ALL. The capability row is stood in for by the deterministic
    // fixture — the exact row shape and digest rule the PEP writes — so the run has a valid,
    // holder-matching capability and no K7 state whatever. K7 grading is the only leg left.
    const { effect_id: idle } = sealWorkStart(rp, { origin_key: "origin-unresolved-idle" });
    const raw = Buffer.from(CAPABILITY_FIXTURE_HEX, "hex");
    const fixture = raw.toString("base64url");
    rp.h.store.insertRunCapability({
      work_run_ref: idle,
      holder_ref: REQUESTER_A,
      capability_digest: createHash("sha256").update(raw).digest("hex"),
      minted_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(rp.h.store.admissionsByEffect(idle).length, 0, "no admitted dispatch");
    refuses(rp, "RUN_SCOPE_UNRESOLVED", () => sealMember(rp, { work_run_ref: idle, capability: fixture }), "a run with no dispatch");

    // (b) THE LATEST DISPATCH IS `UNKNOWN`. An AMBIGUOUS dispatch writes an UNKNOWN outcome, which
    // is non-conclusive by construction — the capability WAS delivered (minting is at admission),
    // and the scope is still unusable: "unusable until reconciliation resolves it" (Spec v0.5 §5.2).
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-unresolved-dispatch" });
    rp.target.onDispatch = (effect_id) =>
      effect_id === run ? { kind: "AMBIGUOUS", raw_observation: "target timed out" } : {
        kind: "ACCEPTED", target_operation_ref: `wf-${effect_id}`, receipt_claim: { workflow_id: `cadp-work-${effect_id}`, started: true },
      };
    const admitted = await dispatch(rp.h, run, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    const capability = (admitted as { run_capability: string }).run_capability;
    assert.deepEqual(rp.h.store.outcomesByEffect(run).map((o) => o.result), ["UNKNOWN"]);
    refuses(rp, "RUN_SCOPE_UNRESOLVED", () => sealMember(rp, { work_run_ref: run, capability }), "an UNKNOWN latest dispatch");

    // THE FLIP, one-way and with no re-delivery: reconciliation returns COMMITTED and the SAME
    // already-delivered capability — never touched by any reconciler path — now SEALS.
    const reconciled = await rp.h.reconciler.reconcileEffect(run);
    assert.equal(reconciled?.result, "COMMITTED", JSON.stringify(reconciled));
    const member = sealMember(rp, { work_run_ref: run, capability });
    assert.equal(rp.h.store.runMembership(member.effect_id)?.work_run_ref, run, "the same capability, now usable");
    assert.equal(count(rp.h, "run_capability"), 2, "no second row was minted for either run");

    // (c) THE NEGATIVE CONTROL for "latest conclusive", which is what stops a superseded grading
    // from deciding: a run whose ordinal 1 was NO_EFFECT_CONFIRMED and whose ordinal 2 is admitted
    // but UNKNOWN reads UNRESOLVED — not the earlier ordinal's RUN_SCOPE_REFUSED, and not a seal.
    const { effect_id: retried } = sealWorkStart(rp, { origin_key: "origin-unresolved-retry" });
    rp.target.onDispatch = (effect_id, ordinal) =>
      effect_id !== retried
        ? { kind: "ACCEPTED", target_operation_ref: `wf-${effect_id}`, receipt_claim: { workflow_id: `cadp-work-${effect_id}`, started: true } }
        : ordinal === 1
          ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } }
          : { kind: "AMBIGUOUS", raw_observation: "target timed out" };
    const first = await dispatch(rp.h, retried, PRINCIPALS.workflow);
    const retriedCapability = (first as { run_capability: string }).run_capability;
    assert.deepEqual(rp.h.store.outcomesByEffect(retried).map((o) => o.result), ["NO_EFFECT_CONFIRMED"]);
    const second = await dispatch(rp.h, retried, PRINCIPALS.workflow);
    assert.equal((second as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.deepEqual(rp.h.store.outcomesByEffect(retried).map((o) => o.result), ["NO_EFFECT_CONFIRMED", "UNKNOWN"]);
    refuses(
      rp, "RUN_SCOPE_UNRESOLVED",
      () => sealMember(rp, { work_run_ref: retried, capability: retriedCapability }),
      "ordinal 2 admitted and unresolved",
    );
  } finally {
    rp.h.close();
  }
});

test("B5(2)/B5(4): a latest-conclusive NO_EFFECT_CONFIRMED scope is refused RUN_SCOPE_REFUSED, and a later COMMITTED lifts it", async () => {
  const rp = await runProfileHarness();
  try {
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-refused" });
    // Ordinal 1 confirms NO EFFECT; recheck #12 permits a further ordinal after exactly this.
    rp.target.onDispatch = (effect_id, ordinal) =>
      effect_id === run && ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } }
        : { kind: "ACCEPTED", target_operation_ref: `wf-${effect_id}`, receipt_claim: { workflow_id: `cadp-work-${effect_id}`, started: true } };
    const admitted = await dispatch(rp.h, run, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    const capability = (admitted as { run_capability: string }).run_capability;
    assert.deepEqual(rp.h.store.outcomesByEffect(run).map((o) => o.result), ["NO_EFFECT_CONFIRMED"]);

    // The capability is valid and holder-matching; the SCOPE is what is refused — and only while
    // that remains the latest conclusive state, which is the whole claim and deliberately not
    // "forever" (B5(2)).
    refuses(rp, "RUN_SCOPE_REFUSED", () => sealMember(rp, { work_run_ref: run, capability }));

    // THE SECOND FLIP: the permitted next admission's dispatch reaches COMMITTED at ordinal 2, and
    // the SAME already-delivered capability — no re-delivery, no second row — now SEALS.
    const retry = await dispatch(rp.h, run, PRINCIPALS.workflow);
    assert.equal(retry.kind, "ADMITTED", JSON.stringify(retry));
    assert.equal((retry as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((retry as { run_capability?: string }).run_capability, undefined, "the retry re-delivers nothing");
    assert.equal(count(rp.h, "run_capability"), 1, "and writes no second row");
    assert.deepEqual(rp.h.store.outcomesByEffect(run).map((o) => o.result), ["NO_EFFECT_CONFIRMED", "COMMITTED"]);

    const member = sealMember(rp, { work_run_ref: run, capability });
    assert.equal(rp.h.store.effectRequest(member.effect_id)?.effect_id, member.effect_id, "the same capability, now usable");
    assert.equal(rp.h.store.runMembership(member.effect_id)?.work_run_ref, run);
  } finally {
    rp.h.close();
  }
});

// ================================================ PART 4 — the K7 seal-time conformance MATRIX

/** The run's own `WORK_START` outcome history, in `dispatch_ordinal` order: what B5(2) grades. */
function outcomes(rp: RunProfileHarness, effect_id: string): string[] {
  return rp.h.store.outcomesByEffect(effect_id).map((outcome) => outcome.result);
}

/** An `ACCEPTED` dispatch for every effect but the one under script, so only the run is scripted. */
function acceptOthers(effect_id: string): DispatchResult {
  return {
    kind: "ACCEPTED",
    target_operation_ref: `wf-${effect_id}`,
    receipt_claim: { workflow_id: `cadp-work-${effect_id}`, started: true },
  };
}

/**
 * A genuine origin, dispatched once under `script`, returning the ONE capability the verified
 * initial dispatch delivered. Every case below presents THIS value and no other — at every state
 * of the run — which is what makes "the flip is about the SCOPE, not about the secret" a claim the
 * assertions can actually distinguish: a case that re-minted, or that needed a second secret after
 * reconciliation, fails at the first presentation rather than passing silently.
 */
async function originateRun(
  rp: RunProfileHarness,
  origin_key: string,
  script: (effect_id: string, ordinal: number) => DispatchResult,
): Promise<{ run: string; capability: string }> {
  const { effect_id: run } = sealWorkStart(rp, { origin_key });
  assert.equal(rp.h.store.runMembership(run)?.work_run_ref, run, `${origin_key}: B5(5)'s self-referential witness`);
  rp.target.onDispatch = (effect_id, ordinal) => (effect_id === run ? script(effect_id, ordinal) : acceptOthers(effect_id));
  const admitted = await dispatch(rp.h, run, PRINCIPALS.workflow);
  assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
  const capability = (admitted as { run_capability?: string }).run_capability;
  // B6(4): minting is at ADMISSION, so the secret is delivered whatever outcome the dispatch
  // reached — including the UNKNOWN and NO_EFFECT_CONFIRMED states the cases below start from.
  assert.match(String(capability), /^[A-Za-z0-9_-]{43}$/u, `${origin_key}: the one delivery`);
  return { run, capability: capability! };
}

test("K7 matrix (i): UNKNOWN at ordinal 1, then reconciliation to COMMITTED, permits sealing", async () => {
  const rp = await runProfileHarness();
  const logs = captureObservableText();
  let capability: string | undefined;
  try {
    // Ordinal 1 is AMBIGUOUS, so the run's only admitted dispatch has a NON-CONCLUSIVE outcome:
    // the scope is unusable and the capability is already in the requester's hands.
    const originated = await originateRun(rp, "origin-k7-unknown", () => ({ kind: "AMBIGUOUS", raw_observation: "target timed out" }));
    const run = originated.run;
    capability = originated.capability;
    assert.deepEqual(outcomes(rp, run), ["UNKNOWN"]);
    refuses(rp, "RUN_SCOPE_UNRESOLVED", () => sealMember(rp, { work_run_ref: run, capability }), "ordinal 1 UNKNOWN", capability);

    // RECONCILIATION resolves the SAME admission to COMMITTED — the only lawful way out of UNKNOWN
    // (Spec v0.5 §5.2: "unusable until reconciliation resolves it"), and a path that touches the
    // capability nowhere: the reconciler mints nothing and returns an outcome, never a secret.
    const reconciled = await rp.h.reconciler.reconcileEffect(run);
    assert.equal(reconciled?.result, "COMMITTED", JSON.stringify(reconciled));
    assert.deepEqual(outcomes(rp, run), ["UNKNOWN", "COMMITTED"]);
    assert.equal(
      Object.keys(reconciled!).some((key) => key.toLowerCase().includes("capability")), false,
      "no outcome record carries a capability field",
    );
    assert.equal(rp.h.store.admissionsByEffect(run).length, 1, "reconciliation resolves ordinal 1; it admits nothing");

    // THE FLIP: the SAME capability, never re-delivered, now seals — and writes its membership proof.
    sealsFollowUp(rp, run, capability, "after reconciliation to COMMITTED");
    assertDeliveryInvariants(rp, run, capability, "UNKNOWN then reconciled COMMITTED");
  } finally {
    logs.restore();
    if (capability !== undefined) assertNoCapabilityText(logs.text(), capability, "the observable log");
    rp.h.close();
  }
});

test("K7 matrix (ii): NO_EFFECT_CONFIRMED at ordinal 1 then a COMMITTED ordinal 2 permits sealing, and ordinal 2 delivers no new capability", async () => {
  const rp = await runProfileHarness();
  const logs = captureObservableText();
  let capability: string | undefined;
  try {
    // Ordinal 1 proves NO EFFECT — the one conclusive state recheck #12 admits a further ordinal
    // after — and ordinal 2 is ACCEPTED, so the run reaches COMMITTED under a LATER admission than
    // the one that minted. The capability is the ordinal-1 delivery throughout.
    const originated = await originateRun(
      rp, "origin-k7-noeffect-committed",
      (effect_id, ordinal) => (ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } }
        : acceptOthers(effect_id)),
    );
    const run = originated.run;
    capability = originated.capability;
    assert.deepEqual(outcomes(rp, run), ["NO_EFFECT_CONFIRMED"]);
    // The intermediate state, stated so the ORDER of this case is part of the record: while that is
    // the latest conclusive grading the scope is REFUSED, not unresolved and not usable.
    refuses(rp, "RUN_SCOPE_REFUSED", () => sealMember(rp, { work_run_ref: run, capability }), "ordinal 1 NO_EFFECT_CONFIRMED", capability);

    // ORDINAL 2, admitted and COMMITTED. A4/A5: the mint is a property of the INITIAL dispatch, so
    // this admission delivers nothing, writes no second row, and leaves the ordinal-1 secret the
    // only capability this run has ever had.
    const retry = await dispatch(rp.h, run, PRINCIPALS.workflow);
    assert.equal(retry.kind, "ADMITTED", JSON.stringify(retry));
    assert.equal((retry as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((retry as { run_capability?: string }).run_capability, undefined, "ordinal 2 delivers NO new capability");
    assert.deepEqual(outcomes(rp, run), ["NO_EFFECT_CONFIRMED", "COMMITTED"]);

    sealsFollowUp(rp, run, capability, "after a COMMITTED ordinal 2");
    assertDeliveryInvariants(rp, run, capability, "NO_EFFECT_CONFIRMED then COMMITTED at ordinal 2");
  } finally {
    logs.restore();
    if (capability !== undefined) assertNoCapabilityText(logs.text(), capability, "the observable log");
    rp.h.close();
  }
});

test("K7 matrix (iii): an ADMITTED but unresolved ordinal 2 is refused RUN_SCOPE_UNRESOLVED, never the ordinal-1 grading", async () => {
  const rp = await runProfileHarness();
  const logs = captureObservableText();
  let capability: string | undefined;
  try {
    // Ordinal 1 proves NO EFFECT and ordinal 2 is AMBIGUOUS: the run's LATEST admitted dispatch is
    // unresolved while an earlier CONCLUSIVE row still exists. This is the case that distinguishes
    // "the latest admitted dispatch decides" from "the greatest-ordinal conclusive row decides" —
    // the second reading would report the superseded ordinal-1 `RUN_SCOPE_REFUSED` here.
    const originated = await originateRun(
      rp, "origin-k7-unresolved-ordinal-2",
      (_e, ordinal) => (ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } }
        : { kind: "AMBIGUOUS", raw_observation: "target timed out" }),
    );
    const run = originated.run;
    capability = originated.capability;
    assert.deepEqual(outcomes(rp, run), ["NO_EFFECT_CONFIRMED"]);

    const retry = await dispatch(rp.h, run, PRINCIPALS.workflow);
    assert.equal(retry.kind, "ADMITTED", JSON.stringify(retry));
    assert.equal((retry as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((retry as { run_capability?: string }).run_capability, undefined, "ordinal 2 delivers NO new capability");
    assert.deepEqual(outcomes(rp, run), ["NO_EFFECT_CONFIRMED", "UNKNOWN"]);
    assert.equal(rp.h.store.admissionsByEffect(run).length, 2, "two admitted dispatches, the latter unresolved");

    // The EXACT code: `RUN_SCOPE_UNRESOLVED`, and deliberately not the `RUN_SCOPE_REFUSED` this very
    // capability was refused under one ordinal earlier.
    refuses(rp, "RUN_SCOPE_UNRESOLVED", () => sealMember(rp, { work_run_ref: run, capability }), "ordinal 2 admitted and unresolved", capability);

    // The positive control, on the SAME capability: reconciling the ordinal-2 admission to COMMITTED
    // makes the scope usable, so the refusal above is attributed to that admission's unresolved
    // state and to nothing about the presentation or the earlier ordinal.
    const reconciled = await rp.h.reconciler.reconcileEffect(run);
    assert.equal(reconciled?.result, "COMMITTED", JSON.stringify(reconciled));
    assert.deepEqual(outcomes(rp, run), ["NO_EFFECT_CONFIRMED", "UNKNOWN", "COMMITTED"]);
    sealsFollowUp(rp, run, capability, "after ordinal 2 reconciled to COMMITTED");
    assertDeliveryInvariants(rp, run, capability, "an unresolved ordinal 2");
  } finally {
    logs.restore();
    if (capability !== undefined) assertNoCapabilityText(logs.text(), capability, "the observable log");
    rp.h.close();
  }
});

test("K7 matrix (iv): a COMMITTED ordinal 1 with an admitted, unresolved ordinal 2 is refused RUN_SCOPE_UNRESOLVED", async () => {
  // The fourth corner of the matrix, and the one the production kernel makes UNCONSTRUCTIBLE: once
  // a `COMMITTED` outcome exists, recheck #12 refuses every further dispatch
  // `EFFECT_ALREADY_COMMITTED`, so no later ordinal can be admitted to displace it. Both halves are
  // asserted — that the state cannot be reached (part A) and that the grading is fail-closed if it
  // somehow were (part B) — because "one-way in practice" is a claim about recheck #12, and the K7
  // grading must not be relying on it: it reads the LATEST admitted dispatch, not "any COMMITTED
  // this run ever had".
  const production = await runProfileHarness();
  // Part B's store, with recheck #12's ordinal admissibility BITTEN (TD §13.1's test-only knob) —
  // the one guard whose refusal is what keeps part A's state unreachable.
  const bitten = await runProfileHarness(runProfileConfig(), new Set(["recheck12_ordinal"]));
  const logs = captureObservableText();
  let capability: string | undefined;
  let bittenCapability: string | undefined;
  try {
    // ---- part A: the production store. Ordinal 1 COMMITS, and the scope is usable.
    const originated = await originateRun(production, "origin-k7-committed", (effect_id) => acceptOthers(effect_id));
    const run = originated.run;
    capability = originated.capability;
    assert.deepEqual(outcomes(production, run), ["COMMITTED"]);
    sealsFollowUp(production, run, capability, "a COMMITTED ordinal 1");

    // No ordinal 2 is admissible, so the unresolved-ordinal-2 state below cannot arise here: the
    // refusal is pre-K6 and leaves the run exactly where it was.
    const refused = await dispatch(production.h, run, PRINCIPALS.workflow);
    assert.equal(refused.kind, "REFUSAL", JSON.stringify(refused));
    assert.equal((refused as { reason: string }).reason, "EFFECT_ALREADY_COMMITTED");
    assert.equal((refused as { run_capability?: string }).run_capability, undefined, "a refused dispatch delivers nothing");
    assert.equal(production.h.store.admissionsByEffect(run).length, 1, "still ONE admitted dispatch");
    assert.deepEqual(outcomes(production, run), ["COMMITTED"]);
    sealsFollowUp(production, run, capability, "after the refused ordinal 2");
    assertDeliveryInvariants(production, run, capability, "a COMMITTED ordinal 1");

    // ---- part B: the same run shape on the bitten store, where ordinal 2 IS admitted and returns
    // AMBIGUOUS. The greatest-ordinal CONCLUSIVE row is still ordinal 1's COMMITTED, and the scope
    // reads UNRESOLVED anyway: the latest admitted dispatch decides, fail-closed.
    const bittenRun = await originateRun(
      bitten, "origin-k7-committed-then-unresolved",
      (effect_id, ordinal) => (ordinal === 1 ? acceptOthers(effect_id) : { kind: "AMBIGUOUS", raw_observation: "target timed out" }),
    );
    bittenCapability = bittenRun.capability;
    assert.deepEqual(outcomes(bitten, bittenRun.run), ["COMMITTED"]);
    sealsFollowUp(bitten, bittenRun.run, bittenCapability, "the bitten store's COMMITTED ordinal 1");

    const secondary = await dispatch(bitten.h, bittenRun.run, PRINCIPALS.workflow);
    assert.equal(secondary.kind, "ADMITTED", JSON.stringify(secondary));
    assert.equal((secondary as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((secondary as { run_capability?: string }).run_capability, undefined, "ordinal 2 delivers NO new capability");
    assert.deepEqual(outcomes(bitten, bittenRun.run), ["COMMITTED", "UNKNOWN"]);
    refuses(
      bitten, "RUN_SCOPE_UNRESOLVED",
      () => sealMember(bitten, { work_run_ref: bittenRun.run, capability: bittenCapability }),
      "a COMMITTED ordinal 1 behind an unresolved ordinal 2",
      bittenCapability,
    );
    assertDeliveryInvariants(bitten, bittenRun.run, bittenCapability, "a bitten ordinal 2");
  } finally {
    logs.restore();
    for (const secret of [capability, bittenCapability]) {
      if (secret !== undefined) assertNoCapabilityText(logs.text(), secret, "the observable log");
    }
    production.h.close();
    bitten.h.close();
  }
});

test("K7 under v1 and under a v2 schema alone: the grading is unreachable and legacy sealing is byte-identical", async () => {
  const raw = Buffer.from(CAPABILITY_FIXTURE_HEX, "hex");
  const canonical = raw.toString("base64url");
  const digest = createHash("sha256").update(raw).digest("hex");
  // A non-canonical presentation of the same secret, which the strict parser refuses wherever the
  // profile governs. Outside it, it must be exactly as inert as the canonical text.
  const malformed = `${canonical}=`;

  /**
   * The EXACT shape B5(2) refuses `RUN_SCOPE_UNRESOLVED` under the governed profile: an enrolled
   * requester's member request bound to a run whose `WORK_START` has NO admitted dispatch at all,
   * presenting a valid, holder-matching capability. Sealed here on stores where the profile does
   * NOT govern — so a seal is the proof that the K7 leg was never reached.
   */
  const sealsUngraded = (rp: RunProfileHarness, run: string, note: string): void => {
    rp.h.store.insertRunCapability({ work_run_ref: run, holder_ref: REQUESTER_A, capability_digest: digest, minted_at: "2026-01-01T00:00:00.000Z" });
    assert.equal(rp.h.store.admissionsByEffect(run).length, 0, `${note}: the run has no admitted dispatch`);
    const graded = sealMember(rp, { work_run_ref: run, capability: canonical });
    assert.equal(rp.h.store.effectRequest(graded.effect_id)?.effect_id, graded.effect_id, `${note}: the unresolved-scope shape SEALS`);
    // ...and so does the malformed presentation, and so does no presentation at all: none of the
    // three is read, which is what "the header is inert transport" means (B6(3)).
    const junk = sealMember(rp, { work_run_ref: run, capability: malformed });
    const bare = sealMember(rp, { work_run_ref: run });
    assert.equal(rp.h.store.effectRequest(junk.effect_id)?.effect_id, junk.effect_id, `${note}: a malformed presentation SEALS`);
    assert.equal(rp.h.store.effectRequest(bare.effect_id)?.effect_id, bare.effect_id, `${note}: and so does no presentation at all`);
    // BYTE-IDENTICAL: normalise the two values no two sealed records can ever share — the effect
    // identity and the seal instant — and the three request digests coincide exactly.
    for (const [seal, sealNote] of [[graded, "canonical"], [junk, "malformed"]] as const) {
      const sealed = rp.h.store.effectRequest(seal.effect_id)!;
      const normalised = { ...sealed, effect_id: bare.request.effect_id, requested_at: bare.request.requested_at };
      assert.deepEqual(
        recordDigest(normalised as unknown as Record<string, unknown>, "request_digest"),
        bare.request.request_digest,
        `${note}: the ${sealNote} presentation contributes nothing to request_digest`,
      );
    }
    assert.equal(count(rp.h, "run_membership"), 0, `${note}: no membership proof is written`);
    assert.equal(count(rp.h, "run_capability"), 1, `${note}: the fixture row only — nothing minted`);
    assert.equal(rp.h.store.runCapability(run)?.capability_digest, digest, `${note}: and the fixture row is untouched`);
  };

  // (a) THE GOVERNED CONTROL, so every seal below is attributed to the GATE and not to the shape
  // being unobjectionable: on a store where the profile governs, that exact request — same fixture
  // capability, same holder, same never-dispatched run — is refused `RUN_SCOPE_UNRESOLVED`.
  const governed = await runProfileHarness();
  try {
    const { effect_id: run } = sealWorkStart(governed, { origin_key: "origin-k7-gate-control" });
    governed.h.store.insertRunCapability({ work_run_ref: run, holder_ref: REQUESTER_A, capability_digest: digest, minted_at: "2026-01-01T00:00:00.000Z" });
    refuses(
      governed, "RUN_SCOPE_UNRESOLVED",
      () => sealMember(governed, { work_run_ref: run, capability: canonical }),
      "the governed control",
      canonical,
    );
  } finally {
    governed.h.close();
  }

  // (b) A whole `cadp.kernel-config.v1` deployment — live v0.4. The run is an ordinary self-bound
  // `WORK_START` under the v1 allocation schema (the run-origin contract is a v2 registry and is
  // not even registered here), which is the shape that WOULD be an origin under the governed
  // profile. It acquires no witness, mints nothing at its own dispatch, and its members seal
  // ungraded whatever they present.
  const v1 = await runProfileHarness({});
  try {
    const tuple = { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 41, purpose: "work-start" };
    const run = v1.h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    const material = { workflow_id: `cadp-work-${run}`, workflow_type: "cadpWork", task_queue: "cadp-worker", bounds: { max_steps: 8, max_effects: 6 } };
    v1.h.ingress.sealEffectRequest(
      {
        effect_id: run,
        requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: run }],
        target_ref: v1.target.targetRef(),
        operation_kind: "WORK_START",
        material_schema: "cadp.work-start.v1",
        material_ref: v1.h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
        prior_effect_refs: [],
        allocation_tuple: tuple,
      },
      PRINCIPALS.workflow,
      { run_capability: malformed },
    );
    assert.equal(v1.h.store.effectRequest(run)?.effect_id, run, "v1 seals the origin-shaped WORK_START");
    assert.equal(v1.h.store.runMembership(run), undefined, "v1 writes no witness");
    sealsUngraded(v1, run, "cadp.kernel-config.v1");
  } finally {
    v1.h.close();
  }

  // (c) NO ACTIVATION FROM THE SCHEMA ALONE. The same v2 bundle as every governed test in this
  // file — the run-origin contract registered, the work-run namespace declared — with the ONE piece
  // of governing registry content absent: the enrollment set is empty. The schema string does not
  // switch the profile on, so the identical unresolved-scope shape seals here too.
  const schemaOnly = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
  try {
    const { effect_id: run } = sealWorkStart(schemaOnly, { origin_key: "origin-k7-schema-only" });
    assert.equal(schemaOnly.h.store.runMembership(run), undefined, "an empty enrollment adjudicates nothing");
    sealsUngraded(schemaOnly, run, "cadp.kernel-config.v2 with an empty enrollment");
  } finally {
    schemaOnly.h.close();
  }

  // (d) ...and the profile cannot be HALF activated either: B3(4)(c) refuses at validation any
  // bundle that names an enrolled requester while declaring no work-run namespace, so there is no
  // reachable config in which the K7 grading runs against an undeclared subject pair.
  refuseConfig(
    configOf({ kernel_subject_namespaces: [] }),
    activatedContracts(),
    "KERNEL_NAMESPACE_UNDECLARED",
    "an enrollment with no declared work-run namespace",
  );
  // And under v1 the registry is not expressible at all: a v1 bundle carrying the enrollment key is
  // refused by the closed-schema rule, which is why a live v0.4 deployment cannot reach these rules
  // by configuration at all (AP B3(3)).
  const v1Bundle = configOf() as Record<string, unknown>;
  v1Bundle["schema"] = "cadp.kernel-config.v1";
  // Every other v2-only key REMOVED, so the refusal below is about the enrollment registry alone
  // and not about whichever v2 key the closed-schema loop happened to reach first.
  for (const key of ["allocation_schema_descriptors", "allocation_schemas", "subject_complete_assembly", "kernel_subject_namespaces"]) {
    delete v1Bundle[key];
  }
  let thrown: unknown;
  try {
    validateKernelConfig(v1Bundle);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof KernelConfigInvalid, String(thrown));
  assert.match((thrown as Error).message, /unknown key data\.cadp\.run_profile_enrolled_requester_refs \(closed schema\)/u);
});

// ================================ PART 5 — recheck #19, the ADMISSION-time membership proof

/**
 * A store that CARRIES the run profile's registries but does not GOVERN with them: the same v2
 * bundle every governed test in this file uses, with an EMPTY enrollment. A run-bound request from
 * REQUESTER_A seals here exactly as it does under v0.4 — no adjudication, no presentation leg and
 * NO `run_membership` row — which is the one lawful way to put an effect in the store that a later
 * enrolling activation turns into #19's unproven case.
 */
async function ungovernedHarness(disabledChecks?: ReadonlySet<string>): Promise<RunProfileHarness> {
  return runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }), disabledChecks);
}

/**
 * A run and one ordinary run-bound member of it, both sealed while the profile governed nobody. The
 * member is the effect #19 grades: a lawful K3 row, bound to a real run, carrying no membership
 * proof because no rule that writes one was engaged when it sealed.
 */
function sealUngoverned(rp: RunProfileHarness, origin_key: string): { run: string; member: string } {
  const { effect_id: run } = sealWorkStart(rp, { origin_key });
  assert.equal(rp.h.store.runMembership(run), undefined, `${origin_key}: an empty enrollment adjudicates nothing`);
  const member = sealMember(rp, { work_run_ref: run }).effect_id;
  assert.equal(rp.h.store.effectRequest(member)?.effect_id, member, `${origin_key}: the member SEALS ungoverned`);
  assert.equal(rp.h.store.runMembership(member), undefined, `${origin_key}: and acquires no membership proof`);
  return { run, member };
}

/**
 * THE CROSS-BOUNDARY STEP: a `POLICY_ACTIVATE` adding REQUESTER_A to
 * `run_profile_enrolled_requester_refs`, so the effects sealed above become an ENROLLED requester's
 * without anything about them changing. Activation governs what may be SEALED next; B5(5) writes no
 * row for a past seal and the store has no `UPDATE` and no back-dating insert, so the proof #19
 * wants can never appear after the fact — the same lifecycle discipline B5(1)(α) states for
 * minting-eligibility. The `RUN_CAPABILITY_REQUIRED` control is what proves the activation actually
 * ENGAGED the profile, so a refusal below is never attributable to a bundle that did nothing.
 */
async function enrollRequesterA(rp: RunProfileHarness): Promise<void> {
  const activated = await rp.h.activatePolicy({ revision: 2, configOverrides: runProfileConfig() as never });
  assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));
  refuses(
    rp, "RUN_CAPABILITY_REQUIRED",
    () => sealMember(rp, { work_run_ref: DEFAULT_WORK_RUN_REF }),
    "the profile now governs REQUESTER_A",
  );
}

test("#19: an enrolled requester's run-bound effect whose membership row names its run is ADMITTED", async () => {
  const rp = await runProfileHarness();
  try {
    // THE ORIGIN's own admission is #19's first pass, and the one case where the two columns of the
    // row are equal: B5(5) wrote `run_membership(E, E)` inside its sealing transaction, and the run
    // it is bound to IS itself, so the proof and the binding agree exactly.
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-19-match" });
    assert.equal(rp.h.store.runMembership(run)?.work_run_ref, run, "the self-referential witness");
    const started = await dispatch(rp.h, run, PRINCIPALS.workflow);
    assert.equal(started.kind, "ADMITTED", JSON.stringify(started));
    const capability = (started as { run_capability: string }).run_capability;

    // THE MEMBER: its proof names the run, its binding names the run, so #19 passes on rows read
    // inside the admission transaction and the effect is admitted and dispatched. This is the
    // positive half every refusal below is attributed against — the shape is otherwise identical.
    const member = sealMember(rp, { work_run_ref: run, capability }).effect_id;
    assert.equal(rp.h.store.runMembership(member)?.work_run_ref, run, "B5(5)'s proof, written at the member's own seal");
    const admitted = await dispatch(rp.h, member, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 1);
    assert.equal((admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
    assert.equal(rp.h.target.effects.includes(member), true, "the member's dispatch reaches the target");
    // And admitting a member mints nothing and re-delivers nothing: #19 reads the membership row,
    // it never touches the capability the seal was graded against (B5(7)).
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined, "a member's admission mints nothing");
    assertDeliveryInvariants(rp, run, capability, "a member admitted under #19");
  } finally {
    rp.h.close();
  }
});

test("#19: an enrolled requester's run-bound effect with NO membership row is refused RUN_MEMBERSHIP_UNPROVEN", async () => {
  const rp = await ungovernedHarness();
  const raw = Buffer.from(CAPABILITY_FIXTURE_HEX, "hex");
  const capability = raw.toString("base64url");
  try {
    const { run, member } = sealUngoverned(rp, "origin-19-absent");
    // CAPABILITY MATERIAL EXISTS for that very run while the refusal is taken, so the no-exposure
    // sweep below has something to find if this path ever read or reported one. #19 needs no secret
    // at all: authority after restart is reconstructed from rows (TD v0.4 §4.5), and the row it
    // wants is the membership proof.
    rp.h.store.insertRunCapability({
      work_run_ref: run,
      holder_ref: REQUESTER_A,
      capability_digest: createHash("sha256").update(raw).digest("hex"),
      minted_at: "2026-01-01T00:00:00.000Z",
    });
    await enrollRequesterA(rp);

    const refused = await dispatch(rp.h, member, PRINCIPALS.workflow);
    assert.equal(refused.kind, "REFUSAL", JSON.stringify(refused));
    assert.equal((refused as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN", JSON.stringify(refused));
    // NO DOWNSTREAM ADMITTED EFFECT. The refusal is raised inside the admission transaction and
    // BEFORE the K6 write, so the reservation never exists: no admission row, no outcome row, and
    // nothing dispatched — the run-bound effect is stopped at the Platform, not at the target.
    assert.equal(rp.h.store.admissionsByEffect(member).length, 0, "no admission row");
    assert.equal(rp.h.store.outcomesByEffect(member).length, 0, "no outcome row");
    assert.equal(rp.h.target.effects.includes(member), false, "nothing reached the target");
    assert.equal(count(rp.h, "run_membership"), 0, "and the refusal writes no proof of its own");
    // NO CAPABILITY MATERIAL is exposed or moved: the result carries no `run_capability` field, no
    // rendering of the fixture secret appears in the refusal, and the fixture row is untouched.
    assert.equal((refused as { run_capability?: string }).run_capability, undefined, "a refused dispatch delivers nothing");
    assertNoCapabilityText(JSON.stringify(refused), capability, "the refusal result");
    assert.equal(count(rp.h, "run_capability"), 1, "the fixture row only — nothing minted");
    assert.equal(
      rp.h.store.runCapability(run)?.capability_digest,
      createHash("sha256").update(raw).digest("hex"),
      "and the fixture row is unchanged",
    );
  } finally {
    rp.h.close();
  }
});

test("#19: a membership row naming ANOTHER run is refused RUN_MEMBERSHIP_UNPROVEN — the row is COMPARED, not counted", async () => {
  const rp = await ungovernedHarness();
  try {
    const { run, member } = sealUngoverned(rp, "origin-19-wrong-run");
    const { effect_id: other } = sealWorkStart(rp, { origin_key: "origin-19-wrong-run-other" });
    // The honest seal path cannot produce this row: B5(5) writes the request's OWN sealed
    // `work_run_ref` into the second column, so a proof written at seal always names the run the
    // request is bound to. The row is therefore fabricated directly on the store — the idiom Part 2
    // already uses for a `run_capability` fixture — because the branch under test is the
    // COMPARISON: a #19 that merely required a row to EXIST would admit this effect into a run it
    // proved membership of nowhere, which is the escape B5(5)'s exact-match wording forbids.
    rp.h.store.insertRunMembership(member, other);
    await enrollRequesterA(rp);

    const refused = await dispatch(rp.h, member, PRINCIPALS.workflow);
    assert.equal(refused.kind, "REFUSAL", JSON.stringify(refused));
    assert.equal((refused as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN", JSON.stringify(refused));
    // The detail names both run refs — the one proved and the one bound — which is the difference
    // between this leg and the absent-row leg above, stated in the record rather than inferred.
    const detail = String((refused as { detail?: string }).detail);
    assert.equal(detail.includes(other), true, `the detail names the PROVED run: ${detail}`);
    assert.equal(detail.includes(run), true, `the detail names the BOUND run: ${detail}`);
    assert.equal(rp.h.store.admissionsByEffect(member).length, 0, "no admission row");
    assert.equal(rp.h.store.outcomesByEffect(member).length, 0, "no outcome row");
    assert.equal(rp.h.target.effects.includes(member), false, "nothing reached the target");
    assert.equal(count(rp.h, "run_capability"), 0, "and nothing was minted or delivered");
  } finally {
    rp.h.close();
  }
});

test("#19 guard-bite: with the check disabled the unproven effect is ADMITTED and DISPATCHED — the recheck is load-bearing", async () => {
  // TD §13.1's test-only knob, through the SAME `disabledChecks` mechanism every other numbered
  // recheck is proven load-bearing by (`recheck12_ordinal`, `recheck18_assembly_complete`, …): one
  // production store and one bitten store running a byte-identical script.
  const production = await ungovernedHarness();
  const bitten = await ungovernedHarness(new Set(["recheck19_run_membership"]));
  const script = async (rp: RunProfileHarness) => {
    const { member } = sealUngoverned(rp, "origin-19-guard-bite");
    await enrollRequesterA(rp);
    return { member, result: await dispatch(rp.h, member, PRINCIPALS.workflow) };
  };
  try {
    const kept = await script(production);
    assert.equal(kept.result.kind, "REFUSAL", JSON.stringify(kept.result));
    assert.equal((kept.result as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN");
    assert.equal(production.h.store.admissionsByEffect(kept.member).length, 0, "production: no reservation");
    assert.equal(production.h.target.effects.includes(kept.member), false, "production: no external effect");

    // THE PROHIBITED DURABLE DELTA: with #19 disabled the very same effect is reserved at K6,
    // dispatched, and committed at the target — an enrolled requester's run-bound work admitted
    // into a run it proved membership of NOWHERE, which is what makes #19 safety and not tidiness.
    const bit = await script(bitten);
    assert.equal(bit.result.kind, "ADMITTED", JSON.stringify(bit.result));
    assert.equal((bit.result as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 1);
    assert.equal(bitten.h.store.admissionsByEffect(bit.member).length, 1, "bitten: a K6 reservation exists");
    assert.deepEqual(bitten.h.store.outcomesByEffect(bit.member).map((o) => o.result), ["COMMITTED"]);
    assert.equal(bitten.h.target.effects.includes(bit.member), true, "bitten: the effect reached the target");
    assert.equal(count(bitten.h, "run_membership"), 0, "and no membership proof exists for it, then or now");
    // The bite is confined to #19: nothing else about the bitten admission changes, and disabling
    // the check mints nothing either — minting is B5(1)'s witnessed predicate, a separate leg.
    assert.equal((bit.result as { run_capability?: string }).run_capability, undefined);
    assert.equal(count(bitten.h, "run_capability"), 0);
  } finally {
    production.h.close();
    bitten.h.close();
  }
});

test("#19 does not activate under v1, under an ungoverned v2 bundle, or for a NON-ENROLLED requester", async () => {
  // (a) A whole `cadp.kernel-config.v1` deployment — live v0.4. `run_profile_enrolled_requester_refs`
  // is not even expressible (AP B3(3)), so the gate's first condition is unsatisfiable: a run-bound
  // request carrying no membership row — which under v1 is EVERY run-bound request, since nothing
  // writes the row — is admitted and dispatched exactly as it is today.
  const v1 = await runProfileHarness({});
  try {
    const member = sealMember(v1, { work_run_ref: DEFAULT_WORK_RUN_REF }).effect_id;
    assert.equal(v1.h.store.runMembership(member), undefined, "v1 writes no membership proof");
    const admitted = await dispatch(v1.h, member, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
    assert.equal(v1.h.target.effects.includes(member), true, "the v1 dispatch path is unchanged");
  } finally {
    v1.h.close();
  }

  // (b) The v2 registries CARRIED but not GOVERNING: the identical unproven effect the two refusal
  // tests above are built on, admitted here. The one difference is the enrolling activation, so
  // those refusals are attributed to enrollment and to nothing else about the shape.
  const ungoverned = await ungovernedHarness();
  try {
    const { member } = sealUngoverned(ungoverned, "origin-19-ungoverned");
    const admitted = await dispatch(ungoverned.h, member, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(ungoverned.h.target.effects.includes(member), true, "an empty enrollment grades nothing");
  } finally {
    ungoverned.h.close();
  }

  // (c) A GOVERNED store and a NON-ENROLLED requester. The gate is per-requester, so REQUESTER_B's
  // request is untouched on a store where REQUESTER_A's would be graded — and its request binds no
  // run either, the second half of the gate. It seals, admits, dispatches and mints nothing
  // (B5(1)(α)): no witness, no proof, and no #19.
  const governed = await runProfileHarness();
  try {
    const { effect_id } = sealWorkStart(governed, {
      origin_key: "origin-19-non-enrolled", principal: PRINCIPAL_B, requester_ref: REQUESTER_B, work_bindings: [],
    });
    assert.equal(governed.h.store.runMembership(effect_id), undefined, "a non-enrolled requester proves nothing");
    const admitted = await dispatch(governed.h, effect_id, PRINCIPAL_B);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined, "and mints nothing");
    assert.equal(count(governed.h, "run_capability"), 0);
  } finally {
    governed.h.close();
  }
});

// ===================================================== PART 6 — the LIVE COMPOSITION on this path

/**
 * PART 6, the cross-kernel half of the `cadp/live/ops.ts` origin lane: the CHECKED-OUT live
 * `startWork`, driven against THIS file's real Ingress and PEP rather than a scripted client.
 *
 * The ops-side claims — the tuple's exact shape, the byte-reproducible material, the origin record
 * and its guards — are asserted in `conformance-basesha.test.ts`, where the kernel is scripted and
 * the bytes are inspectable. What can only be asserted HERE is what the real Authority Plane does
 * with what ops seals: that the request ops builds IS adjudicated a run origin (B5(9)), that the
 * durable `run_membership(E, E)` witness it acquires names the effect itself in BOTH columns, and
 * that a retry of one origin converges on one `effect_id`, one allocation, one K3 row, an unchanged
 * `request_digest` and ZERO `REQUEST_DIGEST_CONFLICT` incidents — the exact failure the material
 * pinning exists to make unconstructible. The complementary leg closes the lane: the DEFAULT
 * (v0.4) profile still seals through a v1 kernel, acquiring no witness and no membership row.
 */

const OPS_SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";
const OPS_MOVED_SHA = "1111111111111111111111111111111111111111";
const OPS_IMAGE: SurfaceImageIdentity = {
  image: "cadp-surface:0.151.0-2.1.221",
  image_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tool_versions: { "codex-cli": "1.2.3", claude: "4.5.6", grok: "absent" },
};
const OPS_REBUILT_IMAGE: SurfaceImageIdentity = { ...OPS_IMAGE, image: "cadp-surface:0.152.0-2.1.222", tool_versions: { "codex-cli": "9.9.9" } };
const OPS_MANIFEST = { repo_id: "42", repo_full_name: "owner/repo" } as unknown as LiveEnvManifest;
const OPS_ITEM = ["implement median", "8", "6"];

/** The live `KernelClient` surface, re-homed onto this harness's in-process kernel. */
function opsClient(rp: RunProfileHarness): WorkStartKernelClient {
  const { h } = rp;
  return {
    async allocateEffectId(tuple: unknown) {
      return { effect_id: h.ingress.allocateEffectId(tuple as Parameters<typeof h.ingress.allocateEffectId>[0], PRINCIPALS.workflow) };
    },
    async putBlob(bytes: Uint8Array) {
      return { cas_key: h.ingress.putBlob(bytes) };
    },
    async sealEffectRequest(body: unknown) {
      return h.ingress.sealEffectRequest(body, PRINCIPALS.workflow);
    },
    async assembleAdmissionInput(effect_id: string, evidence_refs: string[]) {
      return h.ingress.assembleAdmissionInput(effect_id, evidence_refs);
    },
    async evaluate(input_digest: string) {
      return h.evaluate(input_digest);
    },
    async admitAndDispatch(effect_id: string, decision_id: string) {
      return h.pep.admitAndDispatch(effect_id, decision_id, PRINCIPALS.workflow);
    },
  } as unknown as WorkStartKernelClient;
}

function opsDeps(rp: RunProfileHarness, overrides: Partial<StartWorkDependencies> = {}): StartWorkDependencies {
  return {
    manifest: OPS_MANIFEST,
    client: opsClient(rp),
    namespaceId: "cadp-v04",
    resolveBase: () => OPS_SHA,
    surfaceImage: () => OPS_IMAGE,
    ...overrides,
  };
}

function opsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-origin-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** KERNEL_INCIDENT is sealed as evidence, so the count is over the envelope table, by kind. */
function incidents(h: Harness): number {
  return (h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'KERNEL_INCIDENT'").get() as { n: number }).n;
}

test("live composition: ops.startWork under \"v05\" seals an ADJUDICATED origin, and its retry converges with zero incidents", async () => {
  const rp = await runProfileHarness();
  const dir = opsDir();
  try {
    const originKey = "live-origin-1";
    const first = await startWork(dir, "development", OPS_ITEM, { originProfile: "v05", originKey, dependencies: opsDeps(rp) });
    assert.ok(first !== undefined, "the live composition's own WORK_START is admitted through the real chain");
    assert.equal(first.origin_key, originKey);

    // B5(9): what ops sealed IS an origin — the durable `run_membership(E, E)` witness, both
    // columns the effect itself, which is what makes it minting at its own initial dispatch.
    const membership = rp.h.store.runMembership(first.effect_id);
    assert.equal(membership?.effect_id, first.effect_id, "run_membership's first column is the origin");
    assert.equal(membership?.work_run_ref, first.effect_id, "and its second column is the origin too");
    assert.equal(count(rp.h, "run_membership"), 1, "exactly one witness");

    // Leg 2/3 as the STORED request records them: exactly one work-run binding, naming itself.
    const row = rp.h.store.effectRequest(first.effect_id)!;
    const workRun = row.work_bindings.filter((b) => b.authority_ref === WORK_RUN_AUTHORITY && b.namespace === "work-run");
    assert.equal(workRun.length, 1, "exactly one binding on the declared work-run pair");
    assert.equal(workRun[0]?.object_id, first.effect_id, "whose object_id is the allocated effect_id itself");
    const request_digest = row.request_digest.value;

    // THE RETRY, with the base ref MOVED and the worker image REBUILT under it. One origin_key ⇒
    // one effect_id (A5), and the material the record pinned ⇒ an idempotent re-seal rather than
    // the `REQUEST_DIGEST_CONFLICT` that would strand this origin for the store's lifetime.
    const retry = await startWork(dir, "development", OPS_ITEM, {
      originProfile: "v05",
      originKey,
      dependencies: opsDeps(rp, { resolveBase: () => OPS_MOVED_SHA, surfaceImage: () => OPS_REBUILT_IMAGE }),
    });
    const retried = retry?.effect_id ?? first.effect_id;
    assert.equal(retried, first.effect_id, "one origin_key → one effect_id, across the retry");
    assert.equal(count(rp.h, "effect_request"), 1, "one K3 row: the re-seal was the idempotent no-op");
    assert.equal(count(rp.h, "effect_allocation"), 1, "one allocation for the origin");
    assert.equal(rp.h.store.effectRequest(first.effect_id)!.request_digest.value, request_digest, "the stored request is unchanged");
    assert.equal(count(rp.h, "run_membership"), 1, "and no second witness");
    assert.equal(incidents(rp.h), 0, "ZERO KERNEL_INCIDENT rows — no REQUEST_DIGEST_CONFLICT anywhere");
  } finally {
    rp.h.close();
  }
});

test("live composition: the DEFAULT (v0.4) profile still seals through a v1 kernel, witnessing nothing", async () => {
  // A `cadp.kernel-config.v1` deployment — the live one. The zero-sentinel `cadp.allocation-key.v1`
  // tuple is the only allocation this kernel accepts, the seal carries no work-run binding, no
  // adjudication is even expressible, and the request acquires no witness: exactly today.
  const v1 = await runProfileHarness({});
  const dir = opsDir();
  try {
    const started = await startWork(dir, "development", OPS_ITEM, { ordinalArg: "4242", dependencies: opsDeps(v1) });
    assert.ok(started !== undefined, "the v0.4 path is untouched end to end");
    assert.equal(started.origin_key, undefined, "and has no origin key");
    const row = v1.h.store.effectRequest(started.effect_id)!;
    assert.equal(row.work_bindings.some((b) => b.namespace === "work-run"), false, "no work-run binding on the v0.4 path");
    assert.equal(v1.h.store.runMembership(started.effect_id), undefined, "no witness, so it is minting at no dispatch");
    assert.equal(count(v1.h, "run_membership"), 0);
    assert.equal(count(v1.h, "run_capability"), 0);
    assert.equal(incidents(v1.h), 0);
  } finally {
    v1.h.close();
  }
});
