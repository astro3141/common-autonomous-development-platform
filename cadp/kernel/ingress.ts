/**
 * Ingress (TD §0, §9.1): the Kernel Service write API. Seal = identity allocation +
 * canonicalization + digest + store insert. Stamps `requester_ref`/`producer_ref` from the
 * authenticated principal; enforces the produced_at source rule, WORK_STEP replay idempotency,
 * allocation-key canonicalization, and request-digest conflict handling.
 *
 * Under `cadp.kernel-config.v2` it additionally implements AP B1/B2: requester- and
 * contract-scoped allocation over descriptor-driven tuple validation, the allocation binding
 * storage, and the allocation-to-first-seal contract that closes the pre-K3 window (WP §3.3).
 * Every one of those rules is gated on the ACTIVE CONFIG's schema string, so a running v0.4
 * (`cadp.kernel-config.v1`) deployment keeps its allocation and seal behaviour unchanged.
 */

import { Cas } from "./cas.ts";
import { jcs, jcsDigest, nowIso, recordDigest, schemeApproved, sha256Hex } from "./canonical.ts";
import type { Digest } from "./canonical.ts";
import { newId } from "./ids.ts";
import { adapterEntry, identityEntry, resolveActivePolicy } from "./policyState.ts";
import type { ActivePolicy } from "./policyState.ts";
import { resolvePointer } from "./policyBundle.ts";
import { validateAdmissionInput, validateEffectRequest, validateEvidenceEnvelope } from "./records.ts";
import type { AdmissionInputV1, EffectRequestV1, EvidenceEnvelopeV1, EvidenceKind, Provenance, SubjectBinding, TargetRef } from "./records.ts";
import { ConstitutionalStore, UniqueViolation } from "./store.ts";
import type { AllocationBinding } from "./store.ts";

export class IngressRejection extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
  }
}

export interface Principal {
  /** Exact authenticated identity string (SPIFFE id / IdP subject). */
  readonly principal: string;
}

/**
 * The governed-edge key T(F) (#117 §5.3 rule (b)): derived by the STORE from the submitted
 * draft's OWN `supersedes` singleton, never from a dispatch-chosen value. The Kernel reads two
 * exact ref fields here and interprets no product semantics (TD §9.1) — the same shape the
 * WORK_STEP replay rule reads `step_ordinal` from.
 */
function governedEdgeKeyOf(claim: unknown): { evidence_id: string; envelope_digest: string } | undefined {
  const supersedes = (claim as { supersedes?: unknown } | undefined)?.supersedes;
  if (!Array.isArray(supersedes) || supersedes.length !== 1) return undefined;
  const only = supersedes[0] as { evidence_id?: unknown; envelope_digest?: unknown };
  if (typeof only?.evidence_id !== "string" || only.evidence_id.length === 0) return undefined;
  if (typeof only.envelope_digest !== "string" || only.envelope_digest.length === 0) return undefined;
  return { evidence_id: only.evidence_id, envelope_digest: only.envelope_digest };
}

export type IncidentKind =
  | "REQUEST_DIGEST_CONFLICT"
  | "ADMISSIONLESS_COMMIT_OBSERVED"
  | "RECEIPT_MATERIAL_MISMATCH"
  | "DIGEST_CORRUPTION"
  | "ALTERNATE_CREDENTIAL_PATH"
  | "OUTCOME_CONTRADICTION"
  | "EVALUATOR_INTEGRITY_FAILURE"
  | "UNSUPPORTED_CONSTRAINT"
  | "WORK_STEP_CONFLICT"
  /**
   * v1.1 governed sealing (#117 §5.4, a declared TD §2.6 delta). Raised when a registry-opted
   * governed writer's submission collides on either §5.3 key. Its subject bindings put the
   * landed §2.6 scope hold on the predecessor's evidence binding, so an open conflict freezes
   * all further governed sealing against that predecessor until a root-signed BREAK_GLASS
   * releases it. Reuse of WORK_STEP_CONFLICT was rejected: its contract names a work-run/step
   * replay key and would hold the wrong scope.
   */
  | "GOVERNED_SEAL_CONFLICT"
  | "BREAK_GLASS_REJECTED";

export interface EvidenceDraft {
  readonly evidence_kind: EvidenceKind;
  readonly subject_bindings: readonly SubjectBinding[];
  readonly availability: "PRESENT" | "UNKNOWN";
  readonly claim_schema: string;
  readonly claim?: unknown;
  readonly unknown_reason?: string;
  readonly producer_ref: string;
  readonly source_ref: string;
  readonly execution_or_run_ref?: string;
  readonly produced_at?: string;
  readonly source_relation: Provenance["source_relation"];
}

export interface RequestDraft {
  readonly effect_id: string;
  readonly requester_ref: string;
  readonly work_bindings: readonly SubjectBinding[];
  readonly target_ref: TargetRef;
  readonly operation_kind: string;
  readonly material_schema: string;
  readonly material_ref: string;
  readonly prior_effect_refs: readonly string[];
}

/**
 * The `seal_effect_request` body (AP B6(1)): the `RequestDraft` keys unchanged, plus ONE optional
 * top-level sibling carrying the allocated wire tuple verbatim. It is TRANSPORT, never a draft
 * field: the Ingress strips it below before the draft is used, so it is never a `RequestDraft`
 * key, never reaches `EffectRequestV1` and never enters `request_digest`. REQUIRED on a first
 * seal; on a re-seal ignored-if-identical and refused-if-different (B6(2)).
 *
 * Typed `unknown` because it is exactly that on arrival — an unvalidated `JSON.parse` member — so
 * the compiler refuses any read of it that has not passed `#assertTupleDigest`'s shape guard.
 */
export interface SealRequestBody extends RequestDraft {
  readonly allocation_tuple?: unknown;
}

/**
 * A presented allocation tuple (AP B1, B2(5)). `schema` and `purpose` are the two RESERVED kernel
 * fields and the only tuple vocabulary the Kernel holds; every other member is the schema owner's,
 * named only in that schema's descriptor and never in kernel code. Under a `cadp.kernel-config.v1`
 * deployment the v0.4 shape `cadp.allocation-key.v1` is still the only one accepted, by the
 * unchanged hard-coded checks of `#allocateV04`.
 */
export interface AllocationTuple {
  readonly schema: string;
  readonly purpose: string;
  readonly [field: string]: unknown;
}

/** AP B2(5): the two reserved fields, present in every schema's key set and in no descriptor. */
const RESERVED_TUPLE_FIELDS: readonly string[] = ["schema", "purpose"];

/**
 * INPUT-SHAPE GUARD for the v2 allocation path. `api.ts` hands the Ingress whatever `JSON.parse`
 * returned under a `AllocationTuple` cast, so `null`, `[]`, `42` and `{}` all arrive here typed as
 * a tuple and are none of one. Every member read below — the requester-field sweep, `Object.keys`,
 * `tuple.purpose`, the descriptor field sweep — would dereference caller data, and a `TypeError`
 * out of any of them escapes `api.ts`'s `IngressRejection` arm as a 500. B2(5) makes a malformed
 * tuple a REFUSAL, so the shape is settled here BEFORE the first member is read: a presented tuple
 * is a JSON object (not null, not an array) whose reserved `schema` is a non-empty string.
 * The detail strings are the ones the member checks already emit for these same inputs, so the
 * guard moves the refusal earlier without changing what any reachable caller observes.
 */
function assertTupleShape(tuple: unknown): void {
  if (typeof tuple !== "object" || tuple === null || Array.isArray(tuple)) {
    throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "tuple must be a JSON object");
  }
  const schema = (tuple as Record<string, unknown>)["schema"];
  if (typeof schema !== "string" || schema.length === 0) {
    throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "schema");
  }
}

/**
 * AP B1(1): the requester is STAMPED from the authenticated principal, never accepted from the
 * body — the same rule §9.1 S3 already applies to `requester_ref` on the seal draft. A tuple
 * presenting one of these is refused rather than silently out-scoped by the stamped value.
 */
const REQUESTER_TUPLE_FIELDS: readonly string[] = ["requester_ref", "requester", "principal"];

/** The platform effect-id shape the kernel already validates on this path (AP B2(2)(i)). */
const EFFECT_ID_PREFIX = "cadp-v04:effect:";

/**
 * AP B2(2)(i): the closed, GENERIC `value_contract` vocabulary — the v0.4 typed-tuple rules
 * re-homed out of kernel field names. Every contract is a constraint on the PARSED JSON value,
 * never on the wire lexeme: `api.ts` parses the body before any validation runs, so `1`, `1.0` and
 * `1e0` are already one value here and converge on one `effect_id`, which is the retry convergence
 * of B1(2). The kernel dispatches on the descriptor string and never learns the field's name.
 */
function valueSatisfies(value: unknown, value_contract: string): boolean {
  switch (value_contract) {
    case "POSITIVE_INTEGER":
      return typeof value === "number" && Number.isInteger(value) && value >= 1;
    case "NONEMPTY_STRING":
      return typeof value === "string" && value.length > 0;
    case "EFFECT_ID":
      return typeof value === "string" && value.length > 0 && value.startsWith(EFFECT_ID_PREFIX);
    default:
      return false; // closed vocabulary; activation validation already refuses anything else
  }
}

/**
 * AP B2(1): `allocation_contract_payload.v1` — an object with EXACTLY the two member names
 * `descriptor` and `allocation_schema`, each the schema's registry entry verbatim as active at
 * allocation time. Pinned as one function because the same preimage must be computed by all three
 * of its uses — B1(2)'s key derivation, B2(3.3)'s first-seal contract integrity and B2(9)'s drift
 * recovery — which cannot agree otherwise.
 */
export function allocationContractDigest(descriptor: unknown, allocation_schema: unknown): string {
  return sha256Hex(jcs({ descriptor, allocation_schema }));
}

export class Ingress {
  readonly store: ConstitutionalStore;
  readonly cas: Cas;
  readonly pep_ref: string;
  readonly clock: () => number;
  /**
   * TEST-ONLY guard-bite harness knob (TD §13.1), the same shape the PEP already carries: the
   * production composition never passes it, and the conformance suite proves each rule is
   * load-bearing by disabling it and observing the prohibited effect — a second governed edge for
   * the §5.3 rules, and for the AP B2/B3 rules a cross-principal `REQUEST_DIGEST_CONFLICT`
   * (`allocation_principal_gate`) or a sealed request whose kernel-namespace subject is ambiguous
   * (`kernel_namespace_lock`).
   */
  readonly disabledRules: ReadonlySet<string>;

  constructor(
    store: ConstitutionalStore,
    cas: Cas,
    pep_ref: string,
    clock: () => number = Date.now,
    disabledRules: ReadonlySet<string> = new Set(),
  ) {
    this.store = store;
    this.cas = cas;
    this.pep_ref = pep_ref;
    this.clock = clock;
    this.disabledRules = disabledRules;
  }

  private active(): ActivePolicy {
    return resolveActivePolicy(this.store, this.cas);
  }

  // ---------------------------------------------------------------- put_blob

  /** The only way bytes enter CAS (TD §6.6); hard-capped by the active kernel config. */
  putBlob(bytes: Uint8Array): string {
    const active = this.active();
    if (bytes.length > active.config.cas_upload_max_bytes) {
      throw new IngressRejection("BLOB_TOO_LARGE", `${bytes.length} > cas_upload_max_bytes`);
    }
    return this.cas.put(bytes);
  }

  // ---------------------------------------------------------------- allocation

  /**
   * Idempotent allocation on the canonical tuple (TD §7.4, C23), taking the stamped principal the
   * API layer already resolves for `seal_effect_request` and `submit_evidence` (AP B1(1)).
   *
   * The two paths are gated on the ACTIVE KERNEL CONFIG's schema, not on the tuple's: a running
   * `cadp.kernel-config.v1` (v0.4) deployment keeps the hard-coded v1 validation and the unscoped
   * key it has today, byte for byte; a `cadp.kernel-config.v2` (v0.5) deployment runs the
   * descriptor-driven validation and the requester- and contract-scoped key of B1(2). Spec v0.5
   * §10 requires a v0.5 genesis in a new store namespace, so no stored row is ever re-keyed.
   *
   * B1(1)'s two STAMPING rules — resolve the principal through the active `identity_registry`
   * (unregistered ⇒ `FORBIDDEN_FOR_PRINCIPAL`) and refuse a tuple presenting a requester field —
   * belong to the v0.5 contract and therefore run ONLY on the v2 path, INSIDE the gate. Under a v1
   * config this method's observable behaviour is exactly v0.4's: the principal is unused (the key
   * is unscoped, so there is nothing to resolve it for) and an extra tuple member is ignored by the
   * hard-coded checks, as it is today. Neither rule is weakened where it applies: B1's requester
   * scoping and B2's binding storage exist only under `cadp.kernel-config.v2`, which is a
   * generation boundary (B3(5)), and the API layer independently refuses an unregistered principal
   * on every method under every config (`api.ts` reach matrix).
   */
  allocateEffectId(tuple: AllocationTuple, principal: Principal): string {
    const active = this.active();
    if (active.config.schema !== "cadp.kernel-config.v2") return this.#allocateV04(tuple, active);
    const identity = identityEntry(active.config, principal.principal);
    if (identity === undefined) throw new IngressRejection("FORBIDDEN_FOR_PRINCIPAL", "unregistered principal");
    // Shape before members: everything below this line dereferences caller-supplied data.
    assertTupleShape(tuple);
    for (const field of REQUESTER_TUPLE_FIELDS) {
      if ((tuple as Record<string, unknown>)[field] !== undefined) {
        throw new IngressRejection("ALLOCATION_TUPLE_INVALID", `${field} is stamped from the caller, never presented`);
      }
    }
    return this.#allocateDescriptorDriven(tuple, identity.producer_ref, active);
  }

  /** The v0.4 path, unchanged: one hard-coded schema, typed fields, and an unscoped key. */
  #allocateV04(tuple: AllocationTuple, active: ActivePolicy): string {
    if (tuple.schema !== "cadp.allocation-key.v1") throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "schema");
    const work_run_ref = tuple["work_run_ref"];
    const step_ordinal = tuple["step_ordinal"];
    if (typeof work_run_ref !== "string" || !work_run_ref.startsWith(EFFECT_ID_PREFIX)) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "work_run_ref");
    }
    if (!Number.isInteger(step_ordinal) || (step_ordinal as number) < 1) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "step_ordinal must be an integer ≥ 1");
    }
    if (!active.config.allocation_purposes.includes(tuple.purpose)) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", `unknown purpose ${tuple.purpose}`);
    }
    const canonical = jcs({
      schema: tuple.schema,
      work_run_ref,
      step_ordinal,
      purpose: tuple.purpose,
    });
    const key = `cadp-v04:alloc:${sha256Hex(canonical)}`;
    return this.store.withImmediate(() => {
      const existing = this.store.allocationByKey(key);
      if (existing !== undefined) return existing;
      const effect_id = newId("effect", this.clock);
      this.store.insertAllocation(key, effect_id);
      return effect_id;
    });
  }

  /**
   * AP B1(2)/B1(4)/B2(5): one generic path for EVERY schema. The tuple's key set is
   * `{schema, purpose}` ∪ the descriptor's fields and each non-reserved value is checked against
   * its field's `value_contract` — both axes compared against descriptor strings, so no schema's
   * field name lives in kernel code. The derived key carries the stamped `requester_ref` and the
   * `allocation_contract_digest`, which is what makes retries converge per principal, keeps two
   * principals' identical tuples on distinct effect identities, and makes contract drift
   * RECOVERABLE by re-allocation instead of stranding the tuple on an unrefreshable row (B2(9);
   * the store has no runtime UPDATE).
   */
  #allocateDescriptorDriven(tuple: AllocationTuple, requester_ref: string, active: ActivePolicy): string {
    const schema = tuple.schema;
    if (typeof schema !== "string" || schema.length === 0) throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "schema");
    // B2(5): both entries or nothing — no allocation may come to exist that a first seal would
    // have to check against nothing, and the key is not derivable without the contract it pins.
    const descriptor = (active.config.allocation_schema_descriptors ?? []).find((entry) => entry.schema === schema);
    const mapping = (active.config.allocation_schemas ?? []).find((entry) => entry.schema === schema);
    if (descriptor === undefined || mapping === undefined) {
      throw new IngressRejection("ALLOCATION_SCHEMA_UNREGISTERED", schema);
    }
    const declared = new Set<string>([...RESERVED_TUPLE_FIELDS, ...descriptor.fields.map((f) => f.field)]);
    for (const key of Object.keys(tuple)) {
      if (!declared.has(key)) throw new IngressRejection("ALLOCATION_TUPLE_INVALID", `${schema} has no field ${key}`);
    }
    if (typeof tuple.purpose !== "string" || tuple.purpose.length === 0) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "purpose");
    }
    for (const field of descriptor.fields) {
      const value = (tuple as Record<string, unknown>)[field.field];
      if (value === undefined) throw new IngressRejection("ALLOCATION_TUPLE_INVALID", `${schema} requires ${field.field}`);
      if (!valueSatisfies(value, field.value_contract)) {
        throw new IngressRejection("ALLOCATION_TUPLE_INVALID", `${field.field} violates ${field.value_contract}`);
      }
    }
    // The v0.4 `allocation_purposes` membership check is UNCHANGED and keeps its refusal code
    // (B2(5)); the entry's totality over the purposes this schema may allocate is the new one.
    if (!active.config.allocation_purposes.includes(tuple.purpose)) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", `unknown purpose ${tuple.purpose}`);
    }
    if (!mapping.purpose_relation.some((relation) => relation.purpose === tuple.purpose)) {
      throw new IngressRejection("ALLOCATION_PURPOSE_NOT_REGISTERED", `${schema} pairs no operation_kind with ${tuple.purpose}`);
    }
    const binding: AllocationBinding = {
      requester_ref,
      allocation_schema: schema,
      // The tuple is an object, so `cadp-jcs-1` alone fixes these bytes (B1(3)).
      allocation_binding_digest: sha256Hex(jcs(tuple)),
      allocation_contract_digest: allocationContractDigest(descriptor, mapping),
      purpose: tuple.purpose,
    };
    const key = `cadp-v04:alloc:${sha256Hex(jcs({
      requester_ref,
      tuple,
      allocation_contract_digest: binding.allocation_contract_digest,
    }))}`;
    return this.store.withImmediate(() => {
      const existing = this.store.allocationByKey(key);
      if (existing !== undefined) return existing;
      const effect_id = newId("effect", this.clock);
      this.store.insertAllocation(key, effect_id, binding);
      return effect_id;
    });
  }

  // ---------------------------------------------------------------- seal_effect_request

  sealEffectRequest(body: SealRequestBody, principal: Principal): EffectRequestV1 {
    const active = this.active();
    // B6(1): the tuple is stripped HERE, before anything reads the draft, so "transport, never a
    // draft field" is true of the implemented parse rather than merely asserted against it.
    const { allocation_tuple, ...draft } = body;
    const identity = identityEntry(active.config, principal.principal);
    if (identity === undefined) throw new IngressRejection("FORBIDDEN_FOR_PRINCIPAL", "unregistered principal");
    // S3: requester_ref is stamped from the authenticated caller; a differing declared ref is rejected.
    if (draft.requester_ref !== identity.producer_ref) {
      throw new IngressRejection("REQUESTER_REF_MISMATCH", `declared ${draft.requester_ref} != authenticated ${identity.producer_ref}`);
    }
    const materialBytes = this.cas.get(draft.material_ref); // seal requires the material object to exist
    const materialObject = JSON.parse(Buffer.from(materialBytes).toString("utf8")) as Record<string, unknown>;
    // §6.2: a target-native idempotency key is bound to the effect identity at the Ingress —
    // the requester cannot choose it; a wrong value is rejected, so material_digest covers it.
    if (materialObject["idempotency_key"] !== undefined && materialObject["idempotency_key"] !== `cadp-v04:${draft.effect_id}`) {
      throw new IngressRejection("IDEMPOTENCY_KEY_INVALID", `must be cadp-v04:${draft.effect_id}`);
    }
    const material_digest = jcsDigest(materialObject);
    const work_run_ref = draft.work_bindings.find((b) => b.namespace === "work-run")?.object_id;

    const record: EffectRequestV1 = {
      effect_id: draft.effect_id,
      requester_ref: identity.producer_ref,
      work_bindings: draft.work_bindings,
      target_ref: draft.target_ref,
      operation_kind: draft.operation_kind,
      material_schema: draft.material_schema,
      material_digest,
      material_ref: draft.material_ref,
      prior_effect_refs: draft.prior_effect_refs,
      requested_at: nowIso(this.clock),
      request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: "" },
    };
    const sealed: EffectRequestV1 = { ...record, request_digest: recordDigest(record as unknown as Record<string, unknown>, "request_digest") };
    validateEffectRequest(sealed);
    this.assertSchemesApproved([sealed.material_digest, sealed.request_digest], active);

    // AP B2: under a v0.5 (`cadp.kernel-config.v2`) deployment the allocation row is authority for
    // this seal. Its read, the equality legs and the `effect_request` insert are ONE transaction
    // with the allocation row locked for the duration (BEGIN IMMEDIATE, the §3.4 SQLite variant),
    // so a mismatching first seal is refused deterministically before any K3 record exists under
    // every interleaving — the check is against the immutable allocation row, never against a
    // race-visible request row. Under a v1 config none of it runs and the path is v0.4's.
    const allocationBound = active.config.schema === "cadp.kernel-config.v2";
    const outcome = this.store.withImmediate((): { kind: "row"; row: EffectRequestV1 } | { kind: "conflict" } => {
      // B2(10): EVERY seal — first seal and re-seal alike — resolves the allocation row and
      // compares the stamped principal BEFORE the existing-row lookup and before any K3
      // comparison. No KERNEL_INCIDENT and no scope hold: a mismatching seal is a caller error
      // against an effect identity the caller does not own, and holding the owner's scope on it
      // would let any principal freeze another's effect scope with one bad seal. Only the
      // allocation's own requester ever reaches the K3 identical/conflict semantics.
      const allocation = allocationBound ? this.#allocationOf(sealed.effect_id) : undefined;
      if (allocation !== undefined && this.#ruleEnabled("allocation_principal_gate")) {
        if (allocation.requester_ref !== identity.producer_ref) {
          throw new IngressRejection("ALLOCATION_PRINCIPAL_MISMATCH", sealed.effect_id);
        }
      }
      const existing = this.store.effectRequest(sealed.effect_id);
      if (existing !== undefined) {
        // B6(2): a re-seal MAY omit the tuple and MAY repeat it; a DIFFERENT tuple is the same
        // falsehood about the same allocation a first seal refuses, under the same code. The K3
        // semantic payload is untouched, so this can never turn an idempotent re-seal into a
        // REQUEST_DIGEST_CONFLICT.
        if (allocation !== undefined && allocation_tuple !== undefined) {
          this.#assertTupleDigest(allocation, allocation_tuple);
        }
        // Same effect_id: identical semantic content → idempotent no-op returning the stored
        // row (TD §3.3); any difference → REQUEST_DIGEST_CONFLICT incident + scope hold (C8).
        const semantic = (r: EffectRequestV1) =>
          jcs({
            requester_ref: r.requester_ref, work_bindings: r.work_bindings, target_ref: r.target_ref,
            operation_kind: r.operation_kind, material_schema: r.material_schema,
            material_digest: r.material_digest, material_ref: r.material_ref, prior_effect_refs: r.prior_effect_refs,
          });
        if (semantic(existing) === semantic(sealed)) return { kind: "row", row: existing };
        return { kind: "conflict" };
      }
      // FIRST seal (no `effect_request` row): B2(3)'s legs, all of them generic equalities over
      // bundle data and the caller's own tuple, every one refusing BEFORE any K3 record exists.
      if (allocation !== undefined) this.#assertFirstSealBinding(sealed, allocation, allocation_tuple, active);
      this.store.insertEffectRequest(sealed, sealed.material_ref, work_run_ref);
      return { kind: "row", row: sealed };
    });
    if (outcome.kind === "conflict") {
      // The incident must survive the rejected write: sealed in its OWN transaction.
      this.sealIncident("REQUEST_DIGEST_CONFLICT", `effect ${sealed.effect_id} re-sealed with different material`, [
        { authority_ref: "cadp-store:k04", namespace: "effect", object_id: sealed.effect_id },
        { authority_ref: sealed.target_ref.authority_ref, namespace: sealed.target_ref.target_type, object_id: sealed.target_ref.target_id },
      ]);
      throw new IngressRejection("REQUEST_DIGEST_CONFLICT");
    }
    return outcome.row;
  }

  /**
   * AP B2(3): the allocation row this `effect_id` names, read inside the sealing transaction.
   * Absent ⇒ `ALLOCATION_NOT_FOUND`, which closes caller-invented effect identities (Spec v0.5 K3).
   * A row carrying no v2 binding is the mixed-generation case Spec v0.5 §10 forbids (a v0.5
   * deployment is a v0.5 genesis in a new store namespace); it is refused the same way, closed.
   */
  #allocationOf(effect_id: string): AllocationBinding {
    const row = this.store.allocationByEffectId(effect_id);
    if (row?.binding === undefined) throw new IngressRejection("ALLOCATION_NOT_FOUND", effect_id);
    return row.binding;
  }

  /**
   * B2(3.2): the re-presented tuple must digest to the stored binding. Nothing inverts the digest.
   *
   * `allocation_tuple` is caller data straight off `JSON.parse`, so the shape is settled here too,
   * in the SAME refusal: an allocated tuple is always a JSON object (`assertTupleShape` gates every
   * v2 allocation), so `null`, an array and a scalar can never digest-equal a stored binding and
   * were already `ALLOCATION_BINDING_MISMATCH` — this states it structurally instead of resting on
   * `jcs` tolerating a scalar, and lets the caller's members be read below without a `TypeError`.
   */
  #assertTupleDigest(allocation: AllocationBinding, tuple: unknown): Record<string, unknown> {
    if (
      typeof tuple !== "object" || tuple === null || Array.isArray(tuple) ||
      sha256Hex(jcs(tuple)) !== allocation.allocation_binding_digest
    ) {
      throw new IngressRejection("ALLOCATION_BINDING_MISMATCH", "re-presented tuple is not the allocated one");
    }
    return tuple as Record<string, unknown>;
  }

  /**
   * The first-seal legs of AP B2(3), in the order the TD stages them, all inside the sealing
   * transaction and all before any K3 record exists. Every string compared is either bundle-
   * authored data or the caller's own tuple: the core reads none of them for meaning.
   */
  #assertFirstSealBinding(
    sealed: EffectRequestV1,
    allocation: AllocationBinding,
    tuple: unknown,
    active: ActivePolicy,
  ): void {
    // B3(4)(b): the kernel-namespace ambiguity lock runs before B2(3)'s legs, so binding order can
    // never decide what any kernel reader sees — including a reader still selecting by namespace
    // alone. More than one binding in a DECLARED namespace, regardless of authority_ref.
    if (this.#ruleEnabled("kernel_namespace_lock")) {
      for (const declared of active.config.kernel_subject_namespaces ?? []) {
        const bound = sealed.work_bindings.filter((b) => b.namespace === declared.namespace);
        if (bound.length > 1) {
          throw new IngressRejection("KERNEL_NAMESPACE_AMBIGUOUS", `${bound.length} bindings in ${declared.namespace}`);
        }
      }
    }
    // B6(1): the allocated tuple is re-presented as transport and is REQUIRED here.
    if (tuple === undefined) throw new IngressRejection("ALLOCATION_TUPLE_REQUIRED", sealed.effect_id);
    // The guard returns the tuple narrowed to an object, so B2(3.4) below reads members of a value
    // whose shape has been established rather than of whatever the caller happened to send.
    const bound_tuple = this.#assertTupleDigest(allocation, tuple);
    // B2(3.3): contract integrity gates the two legs below it. Without it a byte-identical tuple
    // could be re-presented under a bundle that swapped which tuple_field projects onto which
    // target, and every other equality would still pass while the sealed material is the inverse
    // of what was allocated. Either entry withdrawn fails this leg too — there is no digest to
    // equal. The recovery is a re-allocation, which B1(2)'s contract-scoped key makes converge on
    // a FRESH effect_id rather than back onto this row.
    const schema = allocation.allocation_schema;
    const descriptor = (active.config.allocation_schema_descriptors ?? []).find((entry) => entry.schema === schema);
    const mapping = (active.config.allocation_schemas ?? []).find((entry) => entry.schema === schema);
    if (
      descriptor === undefined || mapping === undefined ||
      allocationContractDigest(descriptor, mapping) !== allocation.allocation_contract_digest
    ) {
      throw new IngressRejection("ALLOCATION_CONTRACT_CHANGED", schema);
    }
    // B2(3.4): EXACTLY ONE sealed binding per projected (authority_ref, namespace) pair, carrying
    // the allocated tuple field's value. Zero or a value mismatch is a MISMATCH; two or more —
    // including two carrying the same object_id — is AMBIGUOUS, because `records.ts` imposes no
    // SubjectBinding uniqueness and an exists-based check would leave the projected target
    // ambiguous with the check already passed. The full pair is matched, never the namespace
    // alone, so an identically-named subject under a different authority never satisfies it.
    for (const projection of mapping.binding_projection) {
      const bound = sealed.work_bindings.filter(
        (b) => b.authority_ref === projection.authority_ref && b.namespace === projection.namespace,
      );
      if (bound.length > 1) {
        throw new IngressRejection(
          "ALLOCATION_BINDING_AMBIGUOUS",
          `${bound.length} bindings on ${projection.authority_ref}|${projection.namespace}`,
        );
      }
      if (bound.length === 0 || bound[0]!.object_id !== bound_tuple[projection.tuple_field]) {
        throw new IngressRejection(
          "ALLOCATION_BINDING_MISMATCH",
          `${projection.authority_ref}|${projection.namespace} does not bind ${projection.tuple_field}`,
        );
      }
    }
    // B2(3.5): for EVERY allocation schema without exception, the sealed operation_kind is the one
    // the registered purpose_relation pairs with the allocated purpose; no pair is itself a refusal.
    const pair = mapping.purpose_relation.find((relation) => relation.purpose === allocation.purpose);
    if (pair === undefined || pair.operation_kind !== sealed.operation_kind) {
      throw new IngressRejection(
        "ALLOCATION_PURPOSE_MISMATCH",
        `${allocation.purpose} pairs with ${pair?.operation_kind ?? "no operation_kind"}, sealed ${sealed.operation_kind}`,
      );
    }
  }

  // ---------------------------------------------------------------- submit_evidence

  submitEvidence(draft: EvidenceDraft, principal: Principal): EvidenceEnvelopeV1 {
    const active = this.active();
    if (draft.evidence_kind === "GENESIS" || draft.evidence_kind === "BREAK_GLASS") {
      // C29: root document kinds are accepted only by the root listener, never here.
      throw new IngressRejection("FORBIDDEN_FOR_PRINCIPAL", `${draft.evidence_kind} is a root-listener document`);
    }
    const identity = identityEntry(active.config, principal.principal);
    if (identity === undefined) throw new IngressRejection("FORBIDDEN_FOR_PRINCIPAL", "unregistered principal");
    // Producer stamping (§9.1): declared producer must equal the authenticated identity's.
    if (draft.producer_ref !== identity.producer_ref) {
      throw new IngressRejection("PRODUCER_REF_MISMATCH", `declared ${draft.producer_ref} != authenticated ${identity.producer_ref}`);
    }
    // C28: any class-shaped assertion at the draft's top level is rejected; identity_class is
    // derived from the active registry, never submitted.
    const rawDraft = draft as unknown as Record<string, unknown>;
    for (const forbidden of ["identity_class", "reviewer_identity_class", "provenance", "integrity"]) {
      if (rawDraft[forbidden] !== undefined) {
        throw new IngressRejection("DRAFT_FIELD_FORBIDDEN", `${forbidden} is Ingress/policy-derived`);
      }
    }
    const adapter = adapterEntry(active.config, identity.producer_ref);
    if (adapter === undefined) throw new IngressRejection("FORBIDDEN_FOR_PRINCIPAL", "producer not in adapter_registry");
    if (!adapter.evidence_kinds.includes(draft.evidence_kind)) {
      throw new IngressRejection("EVIDENCE_KIND_FORBIDDEN", `${identity.producer_ref} may not produce ${draft.evidence_kind}`);
    }
    if (adapter.source_relation !== draft.source_relation) {
      throw new IngressRejection("SOURCE_RELATION_FORBIDDEN", `registry allows ${adapter.source_relation}`);
    }

    // produced_at rule (§9.1 S1).
    let produced_at: string;
    if (adapter.produced_at_source.kind === "SOURCE" && draft.availability === "PRESENT") {
      const sourceValue = resolvePointer(draft.claim, adapter.produced_at_source.claim_pointer);
      if (typeof sourceValue !== "string" || draft.produced_at !== sourceValue) {
        throw new IngressRejection("PRODUCED_AT_SOURCE_MISMATCH", "produced_at must equal the claim's source timestamp exactly");
      }
      produced_at = sourceValue;
    } else {
      produced_at = nowIso(this.clock);
    }

    if (draft.availability === "UNKNOWN" && ((draft as { claim?: unknown }).claim !== undefined)) {
      throw new IngressRejection("UNKNOWN_WITH_CLAIM", "UNKNOWN forbids claim/claim_digest (Spec K2)");
    }

    // Kind-specific ingress rules.
    if (draft.evidence_kind === "BACKEND_EXECUTION" && draft.availability === "PRESENT") {
      this.assertBackendSurfaceRole(draft.subject_bindings);
      this.assertBackendObservedLocators(draft.claim);
    }
    if (draft.evidence_kind === "HUMAN_DECISION" || draft.evidence_kind === "AGENT_DECISION") {
      // A delegated agent decision carries the exact same §9.3 pre-sealed-scope obligations.
      this.assertHumanDecisionScope(draft, produced_at);
    }

    const received_at = nowIso(this.clock);
    const envelope = this.sealEnvelope(draft, identity.producer_ref, produced_at, {
      source_relation: draft.source_relation,
      integrity: "AUTHENTICATED_SOURCE",
    });

    if (draft.evidence_kind === "WORK_STEP") {
      return this.insertWorkStep(envelope, received_at);
    }
    if (adapter.replay_idempotency !== undefined || adapter.governed_edge !== undefined) {
      return this.insertGovernedEvidence(envelope, received_at, adapter);
    }
    this.store.withImmediate(() => this.store.insertEvidence(envelope, received_at));
    return envelope;
  }

  /** Kernel-internal evidence (incidents, PEP identity, reconciliation receipts …). */
  sealInternalEvidence(
    draft: Omit<EvidenceDraft, "producer_ref" | "source_relation"> & { source_relation: Provenance["source_relation"]; producer_ref?: string },
  ): EvidenceEnvelopeV1 {
    const produced_at = draft.produced_at ?? nowIso(this.clock);
    const envelope = this.sealEnvelope(
      { ...draft, producer_ref: draft.producer_ref ?? this.pep_ref } as EvidenceDraft,
      draft.producer_ref ?? this.pep_ref,
      produced_at,
      { source_relation: draft.source_relation, integrity: "AUTHENTICATED_SOURCE" },
    );
    this.store.withImmediate(() => this.store.insertEvidence(envelope, nowIso(this.clock)));
    return envelope;
  }

  private sealEnvelope(
    draft: EvidenceDraft,
    producer_ref: string,
    produced_at: string,
    provenance: Provenance,
  ): EvidenceEnvelopeV1 {
    const base: Record<string, unknown> = {
      evidence_id: newId("evidence", this.clock),
      evidence_kind: draft.evidence_kind,
      subject_bindings: draft.subject_bindings,
      availability: draft.availability,
      claim_schema: draft.claim_schema,
      producer_ref,
      source_ref: draft.source_ref,
      produced_at,
      provenance,
    };
    if (draft.execution_or_run_ref !== undefined) base["execution_or_run_ref"] = draft.execution_or_run_ref;
    if (draft.availability === "PRESENT") {
      base["claim"] = draft.claim;
      base["claim_digest"] = jcsDigest(draft.claim);
    } else {
      base["unknown_reason"] = draft.unknown_reason;
    }
    const envelope = { ...base, envelope_digest: recordDigest(base, "envelope_digest") } as unknown as EvidenceEnvelopeV1;
    validateEvidenceEnvelope(envelope);
    return envelope;
  }

  /** WORK_STEP lookup-before-allocate replay idempotency on the semantic payload (TD §7.4, C33). */
  private insertWorkStep(envelope: EvidenceEnvelopeV1, received_at: string): EvidenceEnvelopeV1 {
    const workRun = envelope.subject_bindings.find((b) => b.namespace === "work-run")?.object_id;
    const claim = envelope.claim as { step_ordinal?: unknown } | undefined;
    const ordinal = claim?.step_ordinal;
    if (workRun === undefined || !Number.isInteger(ordinal) || (ordinal as number) < 1) {
      throw new IngressRejection("WORK_STEP_INVALID", "requires a work-run subject binding and integer claim.step_ordinal ≥ 1");
    }
    const semantic = (e: EvidenceEnvelopeV1) =>
      jcs({
        subject_bindings: e.subject_bindings,
        claim_schema: e.claim_schema,
        claim: e.claim,
        availability: e.availability,
        unknown_reason: e.unknown_reason,
      });
    const outcome = this.store.withImmediate((): { kind: "row"; row: EvidenceEnvelopeV1 } | { kind: "conflict" } => {
      const existing = this.store.workStepByOrdinal(workRun, ordinal as number);
      if (existing !== undefined) {
        if (semantic(existing) === semantic(envelope)) return { kind: "row", row: existing }; // replay converges, no incident
        return { kind: "conflict" };
      }
      this.store.insertEvidence(envelope, received_at, workRun, ordinal as number);
      return { kind: "row", row: envelope };
    });
    if (outcome.kind === "conflict") {
      this.sealIncident("WORK_STEP_CONFLICT", `work run ${workRun} step ${ordinal} re-submitted with different payload`, [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: workRun },
      ]);
      throw new IngressRejection("WORK_STEP_CONFLICT");
    }
    return outcome.row;
  }

  /**
   * Registry-declared governed-writer ingress rules (#117 §5.3 — a TD §9.1 delta), the landed
   * WORK_STEP lookup-before-allocate pattern applied to two keys inside ONE store transaction,
   * with the identical three-way outcome shape and the identical semantic-equality set.
   *
   * rule (a) REPLAY — key (producer_ref, source_ref = cadp-v04:<effect_id>). Deterministically
   *          effect-bound as Spec K3 requires; this is what makes the adapter's NATIVE_KEY
   *          declaration true at the target.
   * rule (b) GOVERNED-EDGE UNIQUENESS (invariant U) — key (producer_ref, T(F)) where the STORE
   *          derives T(F) from the submitted draft's OWN claim.supersedes singleton. Deliberately
   *          NOT an idempotency key: different effects intentionally share it.
   *
   * Neither key is caller-chosen and the check reads only the store's own contents, so omitting
   * an already-sealed governed descendant from a later admission's evidence list cannot reach it.
   */
  private insertGovernedEvidence(
    envelope: EvidenceEnvelopeV1,
    received_at: string,
    adapter: { replay_idempotency?: string; governed_edge?: string },
  ): EvidenceEnvelopeV1 {
    const semantic = (e: EvidenceEnvelopeV1) =>
      jcs({
        subject_bindings: e.subject_bindings,
        claim_schema: e.claim_schema,
        claim: e.claim,
        availability: e.availability,
        unknown_reason: e.unknown_reason,
      });

    // Shape guard (defence-in-depth to the §6.4 admission DENY): for a governed-edge producer a
    // draft whose supersedes is not exactly one exact ref cannot even be keyed, so the
    // multi-predecessor governed artifact is unconstructible (invariant I6, second enforcement).
    let edge: { evidence_id: string; envelope_digest: string } | undefined;
    if (adapter.governed_edge === "SUPERSEDES_SINGLETON" && this.#ruleEnabled("governed_edge_unique")) {
      edge = governedEdgeKeyOf(envelope.claim);
      if (edge === undefined) {
        throw new IngressRejection("GOVERNED_DRAFT_SHAPE_INVALID", "claim.supersedes must be exactly one exact { evidence_id, envelope_digest }");
      }
    }

    type Outcome =
      | { kind: "row"; row: EvidenceEnvelopeV1 }
      | { kind: "conflict"; rule: "replay" | "edge"; existing: EvidenceEnvelopeV1 };
    const outcome = this.store.withImmediate((): Outcome => {
      if (adapter.replay_idempotency === "SOURCE_REF_UNIQUE" && this.#ruleEnabled("governed_replay")) {
        const existing = this.store.evidenceByProducerSourceRef(envelope.producer_ref, envelope.source_ref);
        if (existing !== undefined) {
          if (semantic(existing) === semantic(envelope)) return { kind: "row", row: existing };
          return { kind: "conflict", rule: "replay", existing };
        }
      }
      if (edge !== undefined) {
        const held = this.store.evidenceByGovernedEdge(envelope.producer_ref, edge.evidence_id, edge.envelope_digest);
        if (held !== undefined) {
          // Identical payload ⇒ one artifact, one edge, two audit trails (cross-effect restatement).
          if (semantic(held) === semantic(envelope)) return { kind: "row", row: held };
          return { kind: "conflict", rule: "edge", existing: held };
        }
      }
      this.store.insertEvidence(envelope, received_at, undefined, undefined, edge);
      return { kind: "row", row: envelope };
    });
    if (outcome.kind === "conflict") {
      // The incident must survive the rejected write: sealed in its OWN transaction. Its subject
      // bindings are the §5.4 set the ingress can derive at this seam — the refused effect (the
      // source_ref IS cadp-v04:<effect_id>), the envelope that holds the edge, and the
      // predecessor F, which is the binding that makes the scope hold bite on further sealing.
      const refusedEffect = envelope.source_ref.startsWith("cadp-v04:") ? envelope.source_ref.slice("cadp-v04:".length) : envelope.source_ref;
      const bindings: SubjectBinding[] = [
        { authority_ref: "cadp-store:k04", namespace: "effect", object_id: refusedEffect },
        { authority_ref: "cadp-store:k04", namespace: "evidence", object_id: outcome.existing.evidence_id },
      ];
      const dispatching = this.store.admissionsByEffect(refusedEffect).at(-1);
      if (dispatching !== undefined) {
        bindings.push({ authority_ref: "cadp-store:k04", namespace: "admission", object_id: dispatching.admission_digest.value });
      }
      if (edge !== undefined) bindings.push({ authority_ref: "cadp-store:k04", namespace: "evidence", object_id: edge.evidence_id });
      // §5.4 detail: which rule refused, the conflicting key value, and the digest of the refused
      // draft's semantic payload — enough to audit the collision without re-reading the store.
      const key = outcome.rule === "replay"
        ? `${envelope.producer_ref}|${envelope.source_ref}`
        : `${envelope.producer_ref}|${edge!.evidence_id}|${edge!.envelope_digest}`;
      this.sealIncident(
        "GOVERNED_SEAL_CONFLICT",
        `${outcome.rule} key ${key} is held by ${outcome.existing.evidence_id} with a different payload (refused payload digest ${sha256Hex(semantic(envelope))})`,
        bindings,
        [refusedEffect, outcome.existing.evidence_id, ...(edge === undefined ? [] : [edge.evidence_id])],
      );
      throw new IngressRejection("GOVERNED_SEAL_CONFLICT", outcome.rule);
    }
    return outcome.row;
  }

  #ruleEnabled(rule: string): boolean {
    return !this.disabledRules.has(rule);
  }

  private assertBackendObservedLocators(claim: unknown): void {
    // Requested ≠ observed (TD §9.2): every PRESENT observed field must carry a locator (C13).
    const observed = (claim as { observed?: Record<string, unknown> } | undefined)?.observed;
    if (typeof observed !== "object" || observed === null) {
      throw new IngressRejection("BACKEND_CLAIM_INVALID", "cadp.backend.v1 requires an observed sub-object");
    }
    for (const [field, value] of Object.entries(observed)) {
      const v = value as { availability?: string; value?: unknown; locator?: unknown };
      if (v?.availability === "PRESENT" && (typeof v.locator !== "string" || v.locator.length === 0)) {
        throw new IngressRejection("OBSERVED_WITHOUT_LOCATOR", `observed.${field} is PRESENT without a locator`);
      }
    }
  }

  private assertBackendSurfaceRole(subjectBindings: readonly SubjectBinding[]): void {
    const roles = subjectBindings.filter((binding) => binding.namespace === "surface-role");
    const allowed = new Set(["WORKER", "REVIEWER", "PLANNER"]);
    if (roles.length !== 1 || !allowed.has(roles[0]!.object_id)) {
      throw new IngressRejection(
        "BACKEND_SURFACE_ROLE_INVALID",
        "PRESENT BACKEND_EXECUTION requires exactly one surface-role binding in WORKER/REVIEWER/PLANNER",
      );
    }
  }

  private assertHumanDecisionScope(draft: EvidenceDraft, issued_at: string): void {
    // §9.3: an effect-scoped decision must name an effect sealed BEFORE it was issued, and the
    // surface must have presented the exact request digest.
    const claim = draft.claim as {
      scope?: { effect_id?: string; work_run_ref?: string };
      presented_request_digest?: Digest;
      decision?: string;
    };
    if (claim?.scope === undefined || typeof claim.decision !== "string") {
      throw new IngressRejection("HUMAN_DECISION_INVALID", "scope and decision are mandatory");
    }
    const effectId = claim.scope.effect_id;
    if (effectId !== undefined) {
      const request = this.store.effectRequest(effectId);
      if (request === undefined) throw new IngressRejection("HUMAN_DECISION_INVALID", "scope.effect_id does not exist");
      const presented = claim.presented_request_digest;
      if (presented === undefined || presented.value !== request.request_digest.value) {
        throw new IngressRejection("HUMAN_DECISION_INVALID", "presented_request_digest does not match the sealed request");
      }
      if (Date.parse(issued_at) <= Date.parse(request.requested_at)) {
        throw new IngressRejection("HUMAN_DECISION_INVALID", "decision issued before the effect was sealed");
      }
    } else if (claim.scope.work_run_ref === undefined) {
      throw new IngressRejection("HUMAN_DECISION_INVALID", "scope must name effect_id or work_run_ref");
    }
  }

  // ---------------------------------------------------------------- assemble_admission_input

  assembleAdmissionInput(effect_id: string, evidence_refs: readonly string[]): AdmissionInputV1 {
    const active = this.active();
    const request = this.store.effectRequest(effect_id);
    if (request === undefined) throw new IngressRejection("EFFECT_NOT_FOUND", effect_id);
    const refs: Array<{ evidence_id: string; envelope_digest: Digest }> = [];
    for (const id of evidence_refs) {
      const envelope = this.store.evidenceById(id);
      if (envelope === undefined) throw new IngressRejection("EVIDENCE_NOT_FOUND", id);
      refs.push({ evidence_id: id, envelope_digest: envelope.envelope_digest });
    }
    const base: Record<string, unknown> = {
      policy_ref: active.policy_ref,
      effect_request_ref: effect_id,
      effect_request_digest: request.request_digest,
      evidence_refs: refs,
      assembled_at: nowIso(this.clock),
    };
    const input = { ...base, input_digest: recordDigest(base, "input_digest") } as unknown as AdmissionInputV1;
    validateAdmissionInput(input);
    try {
      this.store.withImmediate(() => this.store.insertAdmissionInput(input));
    } catch (error) {
      // Content-addressed PK: an identical assembly in the same millisecond is the same record.
      if (!(error instanceof UniqueViolation)) throw error;
    }
    return input;
  }

  // ---------------------------------------------------------------- incidents / scope hold

  sealIncident(kind: IncidentKind, detail: string, subject_bindings: readonly SubjectBinding[], offending_refs: readonly string[] = []): EvidenceEnvelopeV1 {
    return this.sealInternalEvidence({
      evidence_kind: "KERNEL_INCIDENT",
      subject_bindings,
      availability: "PRESENT",
      claim_schema: "cadp.incident.v1",
      claim: { incident_kind: kind, detail, offending_refs },
      source_ref: this.pep_ref,
      source_relation: "INDEPENDENT_OBSERVATION",
    });
  }

  /** Incident seal usable while already inside a store transaction. */
  private sealIncidentInTx(kind: IncidentKind, detail: string, subject_bindings: readonly SubjectBinding[]): void {
    const envelope = this.sealEnvelopeForIncident(kind, detail, subject_bindings);
    this.store.insertEvidence(envelope, nowIso(this.clock));
  }

  private sealEnvelopeForIncident(kind: IncidentKind, detail: string, subject_bindings: readonly SubjectBinding[]): EvidenceEnvelopeV1 {
    return this.sealEnvelope(
      {
        evidence_kind: "KERNEL_INCIDENT",
        subject_bindings,
        availability: "PRESENT",
        claim_schema: "cadp.incident.v1",
        claim: { incident_kind: kind, detail, offending_refs: [] },
        producer_ref: this.pep_ref,
        source_ref: this.pep_ref,
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      this.pep_ref,
      nowIso(this.clock),
      { source_relation: "INDEPENDENT_OBSERVATION", integrity: "AUTHENTICATED_SOURCE" },
    );
  }

  /** Scope-hold rule (TD §2.6): does this effect intersect any open incident's subjects? */
  scopeHeld(request: EffectRequestV1): EvidenceEnvelopeV1 | undefined {
    const keys = new Set<string>();
    keys.add(`cadp-store:k04|effect|${request.effect_id}`);
    keys.add(`${request.target_ref.authority_ref}|${request.target_ref.target_type}|${request.target_ref.target_id}`);
    for (const b of request.work_bindings) keys.add(`${b.authority_ref}|${b.namespace}|${b.object_id}`);
    for (const incident of this.store.openIncidents()) {
      for (const b of incident.subject_bindings) {
        if (keys.has(`${b.authority_ref}|${b.namespace}|${b.object_id}`)) return incident;
      }
    }
    return undefined;
  }

  private assertSchemesApproved(digests: readonly Digest[], active: ActivePolicy): void {
    for (const d of digests) {
      if (!schemeApproved(d, active.config.approved_digest_schemes)) {
        throw new IngressRejection("DIGEST_SCHEME_UNAPPROVED", `${d.algorithm}/${d.canonicalization}`);
      }
    }
  }
}
