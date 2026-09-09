/**
 * Ingress (TD §0, §9.1): the Kernel Service write API. Seal = identity allocation +
 * canonicalization + digest + store insert. Stamps `requester_ref`/`producer_ref` from the
 * authenticated principal; enforces the produced_at source rule, WORK_STEP replay idempotency,
 * allocation-key canonicalization, and request-digest conflict handling.
 *
 * Under `cadp.kernel-config.v2` it additionally implements AP B1/B2: requester- and
 * contract-scoped allocation over descriptor-driven tuple validation, the allocation binding
 * storage, and the allocation-to-first-seal contract that closes the pre-K3 window (WP §3.3), and
 * AP B4(2)-(4): assembly completeness, which makes the K4 evidence set the Platform's complete
 * query result unioned with the caller's list rather than the caller's list alone, and AP B5(3)-(5)
 * and B5(9): the seal-time run-membership regime — enrollment ↔ binding, the run-origin
 * adjudication (ORIGIN-OR-REFUSED) whose `run_membership(E, E)` row is the durable witness that
 * authorizes minting at that effect's own initial dispatch, and the ordinary member path's
 * capability presentation, holder match and K7 usability gate.
 * Every one of those rules is gated on the ACTIVE CONFIG's schema string, so a running v0.4
 * (`cadp.kernel-config.v1`) deployment keeps its allocation, seal and assembly behaviour unchanged;
 * the run-membership rules of B5(3)-(5) are additionally gated on the run profile being ENABLED,
 * which a non-empty `run_profile_enrolled_requester_refs` is (B3(4)(c)).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { Cas } from "./cas.ts";
import { jcs, jcsDigest, nowIso, recordDigest, schemeApproved, sha256Hex } from "./canonical.ts";
import type { Digest } from "./canonical.ts";
import { newId } from "./ids.ts";
import { adapterEntry, identityEntry, resolveActivePolicy } from "./policyState.ts";
import type { ActivePolicy } from "./policyState.ts";
import { resolvePointer } from "./policyBundle.ts";
import type { KernelConfig, SubjectCompleteAssemblyEntry } from "./policyBundle.ts";
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

/** AP B6(3): the one header this surface reads beyond `authorization`, fixed exactly. */
export const RUN_CAPABILITY_HEADER = "x-cadp-run-capability";

/**
 * TRANSPORT METADATA for `seal_effect_request` (AP B5(4), B6(3)) — everything the Ingress needs
 * from the request that is NOT part of the request. `run_capability` is the `x-cadp-run-capability`
 * header's value, base64url (unpadded) of the raw 256-bit secret: it arrives as a SEPARATE argument
 * and not as a body member on purpose, so there is no parse path on which it could become a
 * `RequestDraft` key, reach `EffectRequestV1`, or enter `material_digest` or `request_digest`.
 *
 * LOGGING PROHIBITION, normative (B6(3)): this value MUST NOT be written to any log, trace, metric
 * label, incident detail or error message. Every refusal below names a reason code, an `effect_id`
 * and a `work_run_ref` — never the presented secret and never a prefix of it.
 */
export interface SealRequestMetadata {
  readonly run_capability?: string;
}

/**
 * INPUT-SHAPE GUARD for the `seal_effect_request` body, the allocation path's other new entry point
 * and the same hazard: `api.ts` casts a `JSON.parse` result to `SealRequestBody`, so `null` arrives
 * typed as a body and is not one. `sealEffectRequest` strips `allocation_tuple` by rest-
 * destructuring, and rest-destructuring `null` or `undefined` is a `TypeError` — raised BEFORE any
 * refusal leg runs, so it escapes as a 500. Every other non-object destructures to an empty draft
 * already, so normalising to `{}` puts `null` on that identical path rather than inventing an
 * outcome for it: the draft legs below refuse it as the draft-less body it is.
 */
function sealBodyShape(body: unknown): SealRequestBody {
  const shaped = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
  return shaped as SealRequestBody;
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
 * Every `content_digest` present on a draft's subject bindings, for the inherited §2.1 approved-
 * scheme check in `submitEvidence`. Generic: the binding's authority, namespace and object_id are
 * never read, so no field name or namespace decides whether a digest is checked — only whether one
 * EXISTS. A `content_digest` that is not a scheme-bearing object (absent, null, a non-object, or
 * missing either scheme member) is passed over rather than refused here: shape is `records.ts`'s
 * `validSubjectBindings` to own, and it refuses those at seal exactly as it does today. A digest
 * whose members are strings is returned even if the rest of it is malformed, so an unapproved
 * scheme is refused as an unapproved scheme rather than reported as a shape violation.
 */
function bindingContentDigests(bindings: readonly SubjectBinding[]): Digest[] {
  const digests: Digest[] = [];
  if (!Array.isArray(bindings)) return digests; // a non-array is `validSubjectBindings`'s refusal, not this one's
  for (const binding of bindings) {
    const candidate = (binding as { content_digest?: unknown } | null | undefined)?.content_digest;
    if (typeof candidate !== "object" || candidate === null) continue;
    const d = candidate as Record<string, unknown>;
    if (typeof d["algorithm"] !== "string" || typeof d["canonicalization"] !== "string") continue;
    digests.push(candidate as Digest);
  }
  return digests;
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

/**
 * AP B5(1) leg (a) / B5(9) leg 1: the run profile's `WORK_START` operation kind, and the SHAPE leg
 * of the minting predicate. It is kernel vocabulary the checkout already holds on the kernel's own
 * counting path (`pep.ts`), never a tuple field name and never a domain schema's content.
 */
export const RUN_PROFILE_WORK_START = "WORK_START";

/** AP B3(4)(a): the one namespace the kernel itself consumes (`policyBundle.ts` states why). */
const KERNEL_WORK_RUN_NAMESPACE = "work-run";

/**
 * AP B5(3): enrollment is in the STAMPED `requester_ref` domain, never in the raw authenticated-
 * principal domain, and is a v2-only registry — under `cadp.kernel-config.v1` the set is not even
 * expressible, so this is always false and every run-profile rule is inert.
 */
export function runProfileEnrolled(config: KernelConfig, requester_ref: string): boolean {
  if (config.schema !== "cadp.kernel-config.v2") return false;
  return (config.run_profile_enrolled_requester_refs ?? []).includes(requester_ref);
}

/**
 * AP B5(3)/B3(4)(c): the run profile is ENABLED exactly when a `cadp.kernel-config.v2` bundle
 * enrolls at least one `requester_ref`. That is the same predicate B3(4)(c)'s cross-field
 * invariant arms on — "`run_profile_enrolled_requester_refs` is non-empty" is what makes the
 * `kernel_subject_namespaces` declaration mandatory — so "the run profile is on" has ONE definition
 * across activation validation and the seal path rather than two that could drift.
 *
 * It is what keeps B5(3)'s `NOT_RUN_ENROLLED` from swallowing every deployment: B5(3) states the
 * enrolled set MAY be `[]`, and under an empty set nobody is enrolled, so a literal reading would
 * refuse EVERY work-run binding by EVERY requester on a bundle that has not switched the run
 * profile on at all. The rules below therefore arm as a unit, with the enrollment set as the
 * switch, and are inert — byte-identically so — under every `cadp.kernel-config.v1` bundle and
 * under every v2 bundle enrolling nobody.
 */
export function runProfileActive(config: KernelConfig): boolean {
  if (config.schema !== "cadp.kernel-config.v2") return false;
  return (config.run_profile_enrolled_requester_refs ?? []).length > 0;
}

/**
 * The request's KERNEL work-run subject (AP B3(4)(a), B5(9) leg 2): the `object_id` of the single
 * binding on the EXACT `(authority_ref, namespace)` pair `kernel_subject_namespaces` declares for
 * the work-run namespace, or `undefined` when there is no such binding.
 *
 * Matching the declared exact pair — never the namespace alone — is what stops an off-authority
 * `{other, work-run, …}` binding from standing in as a kernel work-run subject (B3(4)(a)). An
 * undeclared namespace yields zero matches and therefore `undefined`, which is the fail-closed
 * reading: B3(4)(c) already refuses at activation any bundle that enables the run profile without
 * declaring it, so this branch is unreachable through a conforming bundle and is not a second
 * policy. More than one match is likewise `undefined` — B3(4)(b)'s ambiguity lock refuses that
 * request before this is ever read, and if the lock is bitten away for a guard-bite run, an
 * ambiguous subject must not be resolved by binding order.
 *
 * One function so the seal-time membership rules and the PEP's recheck #19 can never key
 * differently on the same sealed record.
 */
export function kernelWorkRunRef(
  request: { readonly work_bindings: readonly SubjectBinding[] },
  config: KernelConfig,
): string | undefined {
  const declared = (config.kernel_subject_namespaces ?? []).find((entry) => entry.namespace === KERNEL_WORK_RUN_NAMESPACE);
  if (declared === undefined) return undefined;
  const bound = request.work_bindings.filter(
    (b) => b.authority_ref === declared.authority_ref && b.namespace === declared.namespace,
  );
  return bound.length === 1 ? bound[0]!.object_id : undefined;
}

/** AP B5(9) leg 3: the kernel work-run subject is the request's OWN `effect_id`. */
function bindsItsOwnEffectId(request: EffectRequestV1, config: KernelConfig): boolean {
  return kernelWorkRunRef(request, config) === request.effect_id;
}

/**
 * AP B5(3)'s "CARRYING a `work_run_ref`" — read the way the STORE reads one, by namespace alone,
 * which is exactly how `sealEffectRequest` fills the `effect_request.work_run_ref` column and how
 * `MAX_EFFECTS_IN_WORK_RUN`, `REQUIRE_NO_PRIOR_UNKNOWN_IN_SCOPE` and `list_effects` then count it.
 *
 * Deliberately BROADER than `kernelWorkRunRef`, and only for the `NOT_RUN_ENROLLED` leg, because
 * the two readings must not leave a gap between them: an off-authority `{other, work-run, R}`
 * binding is not a kernel work-run subject (B3(4)(a)), so it can never make its bearer a member —
 * but it IS what the kernel's namespace-only readers count, so a non-enrolled requester presenting
 * one would otherwise seal an effect onto R's budget while being no member of R. Refusing it is the
 * fail-closed reading of "enrollment cannot be acquired by presenting a binding" (WP §5.2), and it
 * makes one invariant true under an active run profile: an `effect_request` row's `work_run_ref` is
 * non-null exactly when a `run_membership` row carries the same value for that effect.
 */
function carriesWorkRunBinding(request: EffectRequestV1): boolean {
  return request.work_bindings.some((b) => b.namespace === KERNEL_WORK_RUN_NAMESPACE);
}

/**
 * AP B5(4)/B6(3) — the seal-time capability comparison, and the ONLY place a presented secret is
 * read. Three properties are load-bearing and all three are here:
 *
 *  - the transport text is DECODED to the raw bytes BEFORE hashing, because `capability_digest` is
 *    SHA-256 over the raw 32 secret bytes and never over the base64url text (B5(1), B6(3));
 *  - the comparison is CONSTANT-TIME, so a refusal leaks no prefix information about the stored
 *    digest (B5(4)); and
 *  - the LENGTH is checked FIRST, because `timingSafeEqual` THROWS on unequal-length buffers — a
 *    throw here would escape as a 500 where the contract mandates a refusal, and a malformed stored
 *    hex or a garbage presented string must be an ordinary `RUN_CAPABILITY_INVALID`.
 *
 * Nothing is returned but a boolean and nothing is logged: the caller names a reason code only.
 */
function capabilityDigestMatches(presented: string, capability_digest: string): boolean {
  const computed = createHash("sha256").update(Buffer.from(presented, "base64url")).digest();
  const stored = Buffer.from(capability_digest, "hex");
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(stored, computed);
}

/**
 * The store's subject key, `<authority_ref>|<namespace>|<object_id>` — the exact string
 * `insertEvidence` writes into `evidence_subject` and the one AP B4(2) names. One function so the
 * assembly-time computation and the commit-time recheck #18 can never key differently.
 */
export function subjectKey(binding: SubjectBinding): string {
  return `${binding.authority_ref}|${binding.namespace}|${binding.object_id}`;
}

/**
 * AP B4(1)/B4(2): the declared `subject_complete_assembly` entries whose `operation_kinds` list
 * this sealed request's `operation_kind`. Gated on the ACTIVE CONFIG's schema string, so under a
 * `cadp.kernel-config.v1` deployment the list is always empty and assembly is byte-identical to
 * v0.4's — the v2 registry cannot even be carried by a v1 bundle (`policyBundle.ts`).
 */
export function declaredAssemblyEntries(config: KernelConfig, operation_kind: string): readonly SubjectCompleteAssemblyEntry[] {
  if (config.schema !== "cadp.kernel-config.v2") return [];
  return (config.subject_complete_assembly ?? []).filter((entry) => entry.operation_kinds.includes(operation_kind));
}

/**
 * AP B4(2): every subject key the SEALED request's OWN `work_bindings` name in the entry's
 * `subject_namespace`, deduplicated. The subject set is the sealed record's, never the caller's
 * assembly-time choice and never a policy-supplied object id — the entry supplies the namespace
 * and the kind, and nothing else. An empty result is the `ASSEMBLY_SUBJECT_UNBOUND` case: the rule
 * is never vacuously satisfied by a request that binds no such subject.
 */
export function assemblySubjectKeys(
  entry: SubjectCompleteAssemblyEntry,
  work_bindings: readonly SubjectBinding[],
): string[] {
  const keys: string[] = [];
  for (const binding of work_bindings) {
    if (binding.namespace !== entry.subject_namespace) continue;
    const key = subjectKey(binding);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Verify-on-read for a row the completeness QUERY matched (AP B4(4), TD v0.4 §2.5): the stored
 * envelope must recompute to its own `envelope_digest`, and a PRESENT claim to its `claim_digest`.
 * A matched row that fails is the corruption path — no partial set is ever sealed.
 */
function envelopeVerifies(envelope: EvidenceEnvelopeV1): boolean {
  if (recordDigest(envelope as unknown as Record<string, unknown>, "envelope_digest").value !== envelope.envelope_digest.value) {
    return false;
  }
  if (envelope.availability === "PRESENT" && jcsDigest(envelope.claim).value !== envelope.claim_digest?.value) {
    return false;
  }
  return true;
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
   * the §5.3 rules, for the AP B2/B3 rules a cross-principal `REQUEST_DIGEST_CONFLICT`
   * (`allocation_principal_gate`) or a sealed request whose kernel-namespace subject is ambiguous
   * (`kernel_namespace_lock`), and for AP B5(2) a run whose `WORK_START` is committed at the target
   * being denied its own scope (`run_scope_latest_conclusive`).
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

  /**
   * `metadata` is TRANSPORT, handed in beside the body and never merged into it (AP B6(3)): the
   * `x-cadp-run-capability` header arrives here as `metadata.run_capability` and is read by exactly
   * one method, `#assertRunCapability`. It is not destructured out of the body, so it cannot become
   * a `RequestDraft` key by any parse path, and it is never written to a record, a digest or a log.
   * Defaulted, so every existing caller — in-process and over the wire — is unchanged.
   */
  sealEffectRequest(body: unknown, principal: Principal, metadata: SealRequestMetadata = {}): EffectRequestV1 {
    const active = this.active();
    // B6(1): the tuple is stripped HERE, before anything reads the draft, so "transport, never a
    // draft field" is true of the implemented parse rather than merely asserted against it.
    // The strip is itself a dereference of caller data, so the SHAPE is settled one line earlier:
    // `api.ts` hands us whatever `JSON.parse` returned under a `SealRequestBody` cast, and rest-
    // destructuring `null` throws a `TypeError` that escapes as a 500 where the contract mandates a
    // refusal. A non-object body carries no draft key, which is exactly what an empty draft carries,
    // so `null` now takes the very path `42`, `[]`, `"x"` and `true` already take today — the
    // generic draft refusals below, reached with `allocation_tuple` absent. No other input observes
    // a change. The parameter is `unknown` so the compiler refuses any read that skips this line.
    const { allocation_tuple, ...draft } = sealBodyShape(body);
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
      // B5(3)-(5) and B5(9): the run-membership regime. Runs AFTER B2(3)'s legs, which it leaves
      // unchanged, and refuses before any K3 record exists like every other pre-K3 leg.
      const membership = this.#adjudicateRunMembership(sealed, active, metadata.run_capability);
      this.store.insertEffectRequest(sealed, sealed.material_ref, work_run_ref);
      // B5(5): the membership proof is inserted in the SAME transaction as the `effect_request`
      // row. For an origin the two columns are equal, and THAT row is B5(1)(b)'s durable minting
      // witness — the only thing that ever makes this effect minting at its own initial dispatch.
      if (membership !== undefined) this.store.insertRunMembership(sealed.effect_id, membership);
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
   * AP B5(9) — RUN-ORIGIN ADJUDICATION, the seal-time half of the run-capability mechanism.
   * Returns `true` when this first seal IS an adjudicated run origin, so the caller writes the
   * `run_membership(effect_id, effect_id)` witness; returns `false` when the rule does not apply;
   * REFUSES `RUN_CAPABILITY_INVALID` when it applies and fails.
   *
   * `is_run_origin(request)` holds exactly when all three legs hold, in the sealing transaction:
   *   1. the request is `WORK_START`-SHAPED — leg (a) of B5(1)'s minting predicate and DELIBERATELY
   *      EXACTLY that leg, never the whole of it: leg (b) is the very row this rule decides whether
   *      to write, so reusing the witnessed predicate here would require this rule's own output as
   *      its input and no origin could ever be adjudicated at all;
   *   2. exactly one binding on the DECLARED exact `(authority_ref, namespace)` work-run pair; and
   *   3. that binding's `object_id` equals the request's own `effect_id`.
   *
   * ORIGIN-OR-REFUSED: a `WORK_START`-shaped request from an ENROLLED requester is adjudicated
   * ONLY as origin-or-refused and NEVER falls through to the ordinary member success path —
   * refused `RUN_CAPABILITY_INVALID` (the existing code of B5(4), no new code) EVEN WHEN it
   * presents a genuinely valid, holder-matching capability for a `COMMITTED` run. That
   * counterexample is the point: possession of a valid capability is exactly what would otherwise
   * carry a `WORK_START`-shaped request down the member path and let one requester originate a
   * second run's identity inside another run's scope. No `effect_request` row, no `run_membership`
   * row and no membership proof is created on that refusal (Spec v0.5 §9.2).
   *
   * SCOPE, stated exactly because it is what keeps this lane's change inert for everything else:
   *  - `cadp.kernel-config.v1` — the rule cannot apply at all (enrollment is not expressible), so a
   *    v0.4 deployment's seal path is byte-identical to what it is today;
   *  - a NON-ENROLLED requester's `WORK_START` — not adjudicated, seals exactly as before, and
   *    acquires NO witness, so it is never minting at any dispatch and no later `POLICY_ACTIVATE`
   *    can retroactively make it one (B5(1)(α), control A4 leg w1);
   *  - a NON-`WORK_START` request binding its own `effect_id` — fails leg 1, so it writes no
   *    self-referential row and acquires nothing by the self-binding (B5(9), Spec v0.5 §9.2). Its
   *    capability-presentation refusal is B5(4)'s ordinary path, a later lane.
   *
   * ONE ORDERING NOTE, now discharged by `#adjudicateRunMembership`: an enrolled requester's
   * `WORK_START` carrying NO `work-run` binding is leg 2's "none" case, which B5(3) refuses
   * `RUN_BINDING_REQUIRED` BEFORE this rule runs — the caller below performs that refusal AHEAD of
   * this call, so the less exact `RUN_CAPABILITY_INVALID` is no longer reachable for it.
   */
  #adjudicateRunOrigin(sealed: EffectRequestV1, active: ActivePolicy): boolean {
    if (sealed.operation_kind !== RUN_PROFILE_WORK_START) return false; // leg 1
    if (!runProfileEnrolled(active.config, sealed.requester_ref)) return false;
    if (bindsItsOwnEffectId(sealed, active.config)) return true; // legs 2 and 3
    throw new IngressRejection(
      "RUN_CAPABILITY_INVALID",
      `${sealed.effect_id} is a WORK_START that does not originate its own run scope`,
    );
  }

  /**
   * AP B5(3)-(5) and B5(9) — THE SEAL-TIME RUN-MEMBERSHIP REGIME, evaluated inside the sealing
   * transaction, on the first-seal path only, before any K3 record exists. Returns the
   * `work_run_ref` to write a `run_membership(effect_id, work_run_ref)` row for (B5(5)), or
   * `undefined` when this request joins no run; REFUSES with the exact code of the leg it fails.
   *
   * The staging is the TD's, in this order and no other:
   *  1. B5(3) ENROLLMENT ↔ BINDING, which is symmetric and decided before anything else:
   *     an ENROLLED requester's request with NO kernel work-run subject is `RUN_BINDING_REQUIRED`
   *     (refused, not merely uncounted, Spec v0.5 §5.1); a NON-ENROLLED requester's request
   *     CARRYING one is `NOT_RUN_ENROLLED`, because enrollment cannot be acquired by presenting a
   *     binding (WP §5.2). `RUN_BINDING_REQUIRED` is raised HERE, ahead of B5(9), so leg 2's "none"
   *     case never reaches the origin adjudication's less exact `RUN_CAPABILITY_INVALID`.
   *  2. B5(9) ORIGIN-OR-REFUSED for a `WORK_START`-shaped request from an enrolled requester: it is
   *     adjudicated ONLY as origin-or-refused and NEVER falls through to (4)'s member success path,
   *     so possession of a valid capability cannot carry it down that path and originate a second
   *     run's identity inside another run's scope. On the origin path — and only on it — (4)'s
   *     capability-presentation and pre-existing-K7 legs do not apply: each names a run that cannot
   *     exist yet. Everything else has already run unchanged.
   *  3. B5(4) the ORDINARY MEMBER path, for every other run-bound request from an enrolled
   *     requester: presentation, digest, holder and the K7 usability gate, in that exact order.
   *
   * SCOPE: the whole regime is inert unless the run profile is ENABLED (`runProfileActive`), which
   * no `cadp.kernel-config.v1` bundle and no v2 bundle enrolling nobody ever is. Under those, this
   * method reduces to PART 1's origin adjudication, which is itself inert there — so a v0.4
   * deployment's seal path stays byte-identical, and so does a v2 deployment that has not switched
   * the run profile on.
   *
   * PLACEMENT, stated because it is a choice: this runs on the FIRST-SEAL path only, the same
   * branch B5(9)'s adjudication already ran on, because B5(5)'s row is written there and a
   * `run_membership` PRIMARY KEY admits exactly one. An idempotent re-seal of an already-sealed
   * `effect_id` therefore presents nothing and needs nothing: it creates no effect, no membership
   * and no budget movement, it can only ever return the byte-identical stored row (any difference
   * is `REQUEST_DIGEST_CONFLICT` on the semantic payload, which the capability is not part of), and
   * B2(10)'s allocation-principal gate — which DOES run on every seal — has already refused any
   * principal but the allocation's own. Requiring a presentation there would instead break the
   * holder's retry the moment its run went `UNKNOWN`, which B5(2) is explicit is a usability
   * question about NEW run-bound requests, not a re-grading of what is already sealed.
   */
  #adjudicateRunMembership(sealed: EffectRequestV1, active: ActivePolicy, presented: string | undefined): string | undefined {
    const config = active.config;
    if (!runProfileActive(config)) {
      // Inert: `runProfileEnrolled` cannot hold with nobody enrolled, so this is `false` and no
      // membership row is written — the pre-B5(3) behaviour, preserved exactly.
      return this.#adjudicateRunOrigin(sealed, active) ? sealed.effect_id : undefined;
    }
    const work_run_ref = kernelWorkRunRef(sealed, config);
    if (!runProfileEnrolled(config, sealed.requester_ref)) {
      if (carriesWorkRunBinding(sealed)) {
        throw new IngressRejection("NOT_RUN_ENROLLED", `${sealed.requester_ref} is not enrolled in the run profile`);
      }
      return undefined;
    }
    if (work_run_ref === undefined) {
      throw new IngressRejection("RUN_BINDING_REQUIRED", `${sealed.effect_id} carries no kernel work-run subject`);
    }
    if (this.#adjudicateRunOrigin(sealed, active)) return sealed.effect_id;
    this.#assertRunCapability(sealed, work_run_ref, presented);
    return work_run_ref;
  }

  /**
   * AP B5(4) — the ordinary member path's four legs, IN ORDER, each with its exact refusal code and
   * each distinct from recheck #19's `RUN_MEMBERSHIP_UNPROVEN`, which is a PEP-time refusal on a
   * missing durable row and is raised nowhere here:
   *
   *  1. `RUN_CAPABILITY_REQUIRED` — an enrolled requester's run-bound request presenting none.
   *     Distinct from `RUN_BINDING_REQUIRED`, which covers only B5(3)'s missing-binding case.
   *  2. `RUN_CAPABILITY_INVALID` — the presented value's digest matches no `run_capability` row for
   *     THIS request's exact `work_run_ref`, INCLUDING the case where no row exists for it. The row
   *     is looked up BY THIS RUN, and that lookup is what makes borrowing unconstructible in both
   *     directions: presenting run R1's capability on an R2-bound request fails HERE, on the row
   *     for R2, and never reaches the holder comparison — so a holder presenting its OWN valid
   *     capability for the WRONG run is refused `RUN_CAPABILITY_INVALID`, not
   *     `RUN_CAPABILITY_HOLDER_MISMATCH`. This is also the STANDING, permanent refusal for any
   *     request naming a never-witnessed `WORK_START` as its run: no mint was ever authorized for
   *     it, so no row can ever exist (B5(1)(α)).
   *  3. `RUN_CAPABILITY_HOLDER_MISMATCH` — the row exists and the digest matches, but its
   *     `holder_ref` is not this request's STAMPED `requester_ref`: an exfiltrated capability
   *     presented by anyone but its holder.
   *  4. the K7 usability gate of B5(2), re-applied on EVERY presentation because Spec v0.5 §5.2
   *     grades the run scope's CURRENT validity, not when the capability was minted and not its
   *     first outcome: `RUN_SCOPE_UNRESOLVED` while unresolved, `RUN_SCOPE_REFUSED` while the
   *     latest conclusive state is `NO_EFFECT_CONFIRMED`, and a seal on `COMMITTED`.
   *
   * Possession never suffices on its own, and neither does holding: the row binds ONE capability to
   * ONE `work_run_ref` AND ONE holder, and legs 2 and 3 are the two halves of that.
   */
  #assertRunCapability(sealed: EffectRequestV1, work_run_ref: string, presented: string | undefined): void {
    if (presented === undefined || presented.length === 0) {
      throw new IngressRejection("RUN_CAPABILITY_REQUIRED", `${sealed.effect_id} is bound to ${work_run_ref}`);
    }
    // Scoped to THIS request's exact `work_run_ref` BEFORE any holder comparison (B5(4)).
    const row = this.store.runCapability(work_run_ref);
    if (row === undefined || !capabilityDigestMatches(presented, row.capability_digest)) {
      throw new IngressRejection("RUN_CAPABILITY_INVALID", `no run capability matches ${work_run_ref}`);
    }
    if (row.holder_ref !== sealed.requester_ref) {
      throw new IngressRejection("RUN_CAPABILITY_HOLDER_MISMATCH", `${work_run_ref} is not held by ${sealed.requester_ref}`);
    }
    const state = this.#runScopeState(work_run_ref);
    if (state === "COMMITTED") return;
    throw new IngressRejection(
      state === "NO_EFFECT_CONFIRMED" ? "RUN_SCOPE_REFUSED" : "RUN_SCOPE_UNRESOLVED",
      work_run_ref,
    );
  }

  /**
   * AP B5(2) — the run's K7 state, read in the sealing transaction from the `WORK_START` effect's
   * OWN outcome rows. Never K6, per Spec v0.5 §5.2 and the memo-proof rule of TD v0.4 §6.4.
   *
   *  - `COMMITTED` is read EXISTENTIALLY — ANY `COMMITTED` outcome for that `effect_id` — which is
   *    both the PEP's own `#latestCommitted` predicate and safe to state as absorbing: recheck #12
   *    refuses `EFFECT_ALREADY_COMMITTED` once one exists, so no further ordinal is ever admitted
   *    after a `COMMITTED` and "latest conclusive" cannot diverge from "present" along the dispatch
   *    path. The existential reading additionally survives a late reconciler write against an
   *    EARLIER ordinal's still-open admission, which an insertion-order "latest" would let flip a
   *    usable scope back to refused. THE FLIP IS ONE-WAY: refused/unresolved → usable, never back.
   *  - otherwise the state is the LATEST ADMITTED DISPATCH's, not the effect's first outcome and
   *    not any earlier ordinal's: `NO_EFFECT_CONFIRMED` on that ordinal is `RUN_SCOPE_REFUSED`
   *    WHILE THAT REMAINS THE LATEST STATE, and anything else — no admission at all, or an admitted
   *    ordinal whose outcome is still `UNKNOWN` — is `RUN_SCOPE_UNRESOLVED`. This is exactly why
   *    recheck #12's permitted next admission after a `NO_EFFECT_CONFIRMED` is not contradicted: a
   *    freshly admitted, still-unresolved ordinal 2 reports UNRESOLVED rather than the earlier
   *    ordinal's REFUSED, and a `COMMITTED` ordinal 2 lifts the refusal for the SAME already-
   *    delivered capability, with no re-delivery and no reconciler secret handling.
   *
   * `run_scope_latest_conclusive` is the TEST-ONLY guard-bite knob (TD §13.1): disabling it pins
   * the gate to the effect's FIRST outcome instead, under which a run whose `WORK_START` is
   * committed at the target is denied its own scope — the retry-semantics divergence made
   * observable, which is what makes this reading load-bearing rather than a detail.
   */
  #runScopeState(work_run_ref: string): "COMMITTED" | "NO_EFFECT_CONFIRMED" | "UNKNOWN" {
    const outcomes = this.store.outcomesByEffect(work_run_ref);
    if (!this.#ruleEnabled("run_scope_latest_conclusive")) {
      const first = outcomes[0];
      return first === undefined || first.result === "UNKNOWN" ? "UNKNOWN" : first.result;
    }
    if (outcomes.some((o) => o.result === "COMMITTED")) return "COMMITTED";
    const latest = this.store.admissionsByEffect(work_run_ref).at(-1);
    if (latest === undefined) return "UNKNOWN";
    return this.store.outcomesByAdmissionDigest(latest.admission_digest.value).some((o) => o.result === "NO_EFFECT_CONFIRMED")
      ? "NO_EFFECT_CONFIRMED"
      : "UNKNOWN";
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

    // Inherited §2.1 (AP Part A §2 row; the gap Execution TD B1(3) NAMES): `approved_digest_schemes`
    // in the ACTIVE policy content governs EVERY new write, and "a digest with an unapproved scheme
    // is invalid input, never a different-but-equal identity". `validSubjectBindings` (`records.ts`)
    // types a binding's `content_digest` SHAPE only and has no policy to compare against; this is the
    // policy-bound half, and it runs BEFORE the envelope is sealed, so a refused draft leaves no row.
    //
    // COVERED FIELDS, audited across the whole evidence-submission path, and why:
    //  - `subject_bindings[].content_digest` — checked for every binding that carries one. It is the
    //    ONLY caller-supplied digest-typed field on this path: `EvidenceDraft`'s other members are
    //    strings, an availability enum, and the opaque `claim`.
    //  - `claim_digest` and `envelope_digest` — NOT covered here because they are not caller values:
    //    `sealEnvelope` computes both itself under `cadp-jcs-1` (`jcsDigest` / `recordDigest`), a
    //    bootstrap scheme every active config must retain (`policyBundle.ts`), so no unapproved
    //    scheme can reach them and a draft key of either name is dropped rather than read.
    //  - `claim` — NOT walked for digest-shaped members. It is product content under `claim_schema`,
    //    which this ingress does not interpret; deciding that some member is a digest would need
    //    exactly the schema/namespace knowledge the kernel must not hold.
    // K3 (`material_digest`, `request_digest`) is checked on its own path at `sealEffectRequest` and
    // is untouched here. Nothing about REQUIRED-ness is imported: digests that EXIST are validated,
    // none is demanded, and no namespace or field name is consulted — per Execution TD B1(3),
    // required-ness is owned by product construction and the composition gate, not by the ingress.
    this.assertSchemesApproved(bindingContentDigests(draft.subject_bindings), active);

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

  /**
   * AP B4(2)-(4): assembly is the Platform's, not the caller's. Under a `cadp.kernel-config.v2`
   * deployment carrying `subject_complete_assembly` entries, the K4 evidence set is the UNION of
   * the caller's `evidence_refs` and, for every declared entry whose `operation_kinds` list this
   * request's `operation_kind`, EVERY sealed envelope of that `evidence_kind` bound to each exact
   * subject key the request's OWN `work_bindings` name in the entry's namespace. The caller may
   * add; the caller can never subtract. The whole computation and the K4 insert are ONE
   * transaction (B4(3)), so the sealed set is complete as of a single read of the store.
   *
   * Under a `cadp.kernel-config.v1` config — and under v2 for an `operation_kind` no entry lists —
   * `declaredAssemblyEntries` is empty and this method's behaviour is v0.4's, byte for byte:
   * the caller's refs, in the caller's order, undeduplicated.
   */
  assembleAdmissionInput(effect_id: string, evidence_refs: readonly string[]): AdmissionInputV1 {
    const active = this.active();
    type Assembled =
      | { kind: "input"; input: AdmissionInputV1 }
      | { kind: "corrupt"; evidence_id: string; subject_key: string };
    const outcome = this.store.withImmediate((): Assembled => {
      const request = this.store.effectRequest(effect_id);
      if (request === undefined) throw new IngressRejection("EFFECT_NOT_FOUND", effect_id);
      const refs: Array<{ evidence_id: string; envelope_digest: Digest }> = [];
      for (const id of evidence_refs) {
        const envelope = this.store.evidenceById(id);
        if (envelope === undefined) throw new IngressRejection("EVIDENCE_NOT_FOUND", id);
        refs.push({ evidence_id: id, envelope_digest: envelope.envelope_digest });
      }
      // B4(2)/B4(3). The guard-bite knob removes the completeness rule ONLY; every other leg of
      // this method is untouched, so the disabled run is exactly the pre-B4 assembly (TD §13.1).
      const declared = this.#ruleEnabled("assembly_completeness")
        ? declaredAssemblyEntries(active.config, request.operation_kind)
        : [];
      let sealed_refs = refs;
      if (declared.length > 0) {
        // Keyed by evidence_id: the union is deduplicated by identity, and a caller ref that the
        // query also matches contributes once. The stored envelope's own digest is authority.
        const union = new Map<string, Digest>(refs.map((r) => [r.evidence_id, r.envelope_digest]));
        for (const entry of declared) {
          const keys = assemblySubjectKeys(entry, request.work_bindings);
          if (keys.length === 0) {
            throw new IngressRejection(
              "ASSEMBLY_SUBJECT_UNBOUND",
              `${request.operation_kind} declares ${entry.evidence_kind} over ${entry.subject_namespace}, which this request binds nowhere`,
            );
          }
          for (const key of keys) {
            for (const envelope of this.#completeEvidenceOfKind(entry.evidence_kind, key)) {
              // B4(4): a matched row that fails verify-on-read refuses. A partial set is never sealed.
              if (!envelopeVerifies(envelope)) return { kind: "corrupt", evidence_id: envelope.evidence_id, subject_key: key };
              union.set(envelope.evidence_id, envelope.envelope_digest);
            }
          }
        }
        // Canonical order by `evidence_id` so `input_digest` is deterministic: the same complete
        // set assembles to the same K4 whatever order the caller listed its own refs in.
        sealed_refs = [...union]
          .map(([evidence_id, envelope_digest]) => ({ evidence_id, envelope_digest }))
          .sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));
      }
      const base: Record<string, unknown> = {
        policy_ref: active.policy_ref,
        effect_request_ref: effect_id,
        effect_request_digest: request.request_digest,
        evidence_refs: sealed_refs,
        assembled_at: nowIso(this.clock),
      };
      const input = { ...base, input_digest: recordDigest(base, "input_digest") } as unknown as AdmissionInputV1;
      validateAdmissionInput(input);
      try {
        this.store.insertAdmissionInput(input);
      } catch (error) {
        // Content-addressed PK: an identical assembly in the same millisecond is the same record.
        // The statement aborts, the transaction does not (SQLite ON CONFLICT ABORT).
        if (!(error instanceof UniqueViolation)) throw error;
      }
      return { kind: "input", input };
    });
    if (outcome.kind === "corrupt") {
      // The incident must survive the refusal: sealed in its OWN transaction, exactly as the K3
      // conflict path does. No `AdmissionInputV1` row was written (B4(4)).
      this.sealIncident(
        "DIGEST_CORRUPTION",
        `assembly matched evidence ${outcome.evidence_id} on ${outcome.subject_key}, which does not recompute`,
        [
          { authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id },
          { authority_ref: "cadp-store:k04", namespace: "evidence", object_id: outcome.evidence_id },
        ],
        [outcome.evidence_id],
      );
      throw new IngressRejection("DIGEST_CORRUPTION", outcome.evidence_id);
    }
    return outcome.input;
  }

  /**
   * AP B4(2): the complete set — EVERY sealed envelope of `evidence_kind` bound to this EXACT
   * subject key, over the existing `(evidence_kind, subject_key)` join. `latestEvidenceOfKind`
   * MUST NOT be used here: "latest" is not authority in sealed history (Spec v0.5 §2.6, TD v0.4
   * §6.6). A query that cannot be executed is `ASSEMBLY_QUERY_FAILED` (B4(4)) — thrown inside the
   * assembly transaction, so no `AdmissionInputV1` row survives it.
   */
  #completeEvidenceOfKind(evidence_kind: string, subject_key: string): EvidenceEnvelopeV1[] {
    let bound: EvidenceEnvelopeV1[];
    try {
      bound = this.store.evidenceBySubjectKey(subject_key);
    } catch (error) {
      throw new IngressRejection(
        "ASSEMBLY_QUERY_FAILED",
        `${evidence_kind} on ${subject_key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return bound.filter((envelope) => envelope.evidence_kind === evidence_kind);
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
