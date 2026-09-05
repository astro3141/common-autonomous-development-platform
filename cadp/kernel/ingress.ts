/**
 * Ingress (TD §0, §9.1): the Kernel Service write API. Seal = identity allocation +
 * canonicalization + digest + store insert. Stamps `requester_ref`/`producer_ref` from the
 * authenticated principal; enforces the produced_at source rule, WORK_STEP replay idempotency,
 * allocation-key canonicalization, and request-digest conflict handling.
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

export interface AllocationTuple {
  readonly schema: "cadp.allocation-key.v1";
  readonly work_run_ref: string;
  readonly step_ordinal: number;
  readonly purpose: string;
}

export class Ingress {
  readonly store: ConstitutionalStore;
  readonly cas: Cas;
  readonly pep_ref: string;
  readonly clock: () => number;
  /**
   * TEST-ONLY guard-bite harness knob (TD §13.1), the same shape the PEP already carries: the
   * production composition never passes it, and the conformance suite proves each §5.3 rule is
   * load-bearing by disabling it and observing the prohibited effect (a second governed edge).
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

  /** Idempotent allocation on the canonical tuple (TD §7.4, C23). */
  allocateEffectId(tuple: AllocationTuple): string {
    const active = this.active();
    if (tuple.schema !== "cadp.allocation-key.v1") throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "schema");
    if (typeof tuple.work_run_ref !== "string" || !tuple.work_run_ref.startsWith("cadp-v04:effect:")) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "work_run_ref");
    }
    if (!Number.isInteger(tuple.step_ordinal) || tuple.step_ordinal < 1) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", "step_ordinal must be an integer ≥ 1");
    }
    if (!active.config.allocation_purposes.includes(tuple.purpose)) {
      throw new IngressRejection("ALLOCATION_TUPLE_INVALID", `unknown purpose ${tuple.purpose}`);
    }
    const canonical = jcs({
      schema: tuple.schema,
      work_run_ref: tuple.work_run_ref,
      step_ordinal: tuple.step_ordinal,
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

  // ---------------------------------------------------------------- seal_effect_request

  sealEffectRequest(draft: RequestDraft, principal: Principal): EffectRequestV1 {
    const active = this.active();
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

    const outcome = this.store.withImmediate((): { kind: "row"; row: EffectRequestV1 } | { kind: "conflict" } => {
      const existing = this.store.effectRequest(sealed.effect_id);
      if (existing !== undefined) {
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
      this.assertBackendObservedLocators(draft.claim);
    }
    if (draft.evidence_kind === "HUMAN_DECISION") {
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
