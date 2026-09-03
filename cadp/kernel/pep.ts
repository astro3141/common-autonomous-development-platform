/**
 * PEP (TD §3.4, §4): the only component that writes `EffectAdmissionV1` and dispatches.
 * Serialization lock D spans precondition → admission → dispatch → outcome; the admission
 * row is the reservation; rechecks #1–#17 run against rows read inside the transaction;
 * K7 truth stays target-authoritative (§6.3).
 *
 * `disabledChecks` is a TEST-ONLY guard-bite harness knob (TD §13.1): the production
 * composition never passes it, and the conformance suite proves each listed check is
 * load-bearing by disabling it and observing the prohibited effect.
 */

import { Cas, CasCorruption, CasMissing } from "./cas.ts";
import { jcs, jcsDigest, nowIso, recordDigest, sha256Hex } from "./canonical.ts";
import { newId } from "./ids.ts";
import { Ingress } from "./ingress.ts";
import { adapterEntry, resolveActivePolicy } from "./policyState.ts";
import type { ActivePolicy } from "./policyState.ts";
import { resolvePointer } from "./policyBundle.ts";
import { PublicationRefusal, verifyProposedBundle } from "./policyPublication.ts";
import { validateEffectAdmission, validateEffectOutcome } from "./records.ts";
import type { Constraint, EffectAdmissionV1, EffectOutcomeV1, EffectRequestV1, EvidenceEnvelopeV1, PolicyDecisionV1, SubjectBinding, TargetRef } from "./records.ts";
import { ConstitutionalStore, UniqueViolation } from "./store.ts";
import { MaterialIncomplete } from "./adapters/types.ts";
import type { AdapterRegistry, DispatchResult, ReconcileResult, TargetAdapterV1 } from "./adapters/types.ts";

export interface Refusal {
  readonly kind: "REFUSAL";
  readonly reason: string;
  readonly detail?: string;
}

export interface Admitted {
  readonly kind: "ADMITTED";
  readonly admission: EffectAdmissionV1;
  readonly outcome: EffectOutcomeV1;
}

export type AdmitResult = Refusal | Admitted;

const SUPPORTED_CONSTRAINTS = new Set([
  "MAX_DISPATCH_ORDINAL", "NOT_AFTER", "REQUIRE_TARGET_IDEMPOTENCY_PROOF", "REQUIRE_NO_PRIOR_UNKNOWN_IN_SCOPE",
  "MATERIAL_SIZE_MAX", "OPERATION_KIND_EQUALS", "TARGET_REF_EQUALS", "EVIDENCE_MAX_AGE", "MAX_EFFECTS_IN_WORK_RUN",
]);

class Refuse extends Error {
  readonly reason: string;
  readonly detail?: string;
  readonly incident: boolean;
  constructor(reason: string, detail?: string, incident = false) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
    this.incident = incident;
  }
}

/** In-process serialization domains (TD §4.6 item 3, SQLite harness variant). */
class DomainLocks {
  #locks = new Map<string, Promise<void>>();

  async acquire(domain: string): Promise<() => void> {
    while (true) {
      const current = this.#locks.get(domain);
      if (current === undefined) break;
      await current;
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = () => {
        this.#locks.delete(domain);
        resolve();
      };
    });
    this.#locks.set(domain, held);
    return release;
  }
}

export class Pep {
  readonly locks = new DomainLocks();
  readonly store: ConstitutionalStore;
  readonly cas: Cas;
  readonly ingress: Ingress;
  readonly adapters: AdapterRegistry;
  readonly pep_ref: string;
  readonly clock: () => number;
  readonly disabledChecks: ReadonlySet<string>;

  constructor(
    store: ConstitutionalStore,
    cas: Cas,
    ingress: Ingress,
    adapters: AdapterRegistry,
    pep_ref: string,
    clock: () => number = Date.now,
    disabledChecks: ReadonlySet<string> = new Set(),
  ) {
    this.store = store;
    this.cas = cas;
    this.ingress = ingress;
    this.adapters = adapters;
    this.pep_ref = pep_ref;
    this.clock = clock;
    this.disabledChecks = disabledChecks;
  }

  #enabled(check: string): boolean {
    return !this.disabledChecks.has(check);
  }

  // ================================================================ admit_and_dispatch

  async admitAndDispatch(effect_id: string, decision_id: string): Promise<AdmitResult> {
    const request = this.store.effectRequest(effect_id);
    if (request === undefined) return { kind: "REFUSAL", reason: "EFFECT_NOT_FOUND" };
    const adapter = this.adapters.byTarget(request.target_ref);
    if (adapter === undefined) return { kind: "REFUSAL", reason: "NO_ADAPTER_FOR_TARGET" };

    let material: Record<string, unknown>;
    try {
      material = JSON.parse(Buffer.from(this.cas.get(request.material_ref)).toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof CasMissing || error instanceof CasCorruption) {
        return { kind: "REFUSAL", reason: "MATERIAL_INCOMPLETE", detail: error.message };
      }
      throw error;
    }

    const domain = adapter.serialization_domain(material);
    const release = await this.locks.acquire(domain);
    try {
      return await this.#admitAndDispatchLocked(request, adapter, material, decision_id);
    } finally {
      release();
    }
  }

  async #admitAndDispatchLocked(
    request: EffectRequestV1,
    adapter: TargetAdapterV1,
    material: Record<string, unknown>,
    decision_id: string,
  ): Promise<AdmitResult> {
    const active = resolveActivePolicy(this.store, this.cas);
    const operation = adapter.describe().operations.find((o) => o.operation_kind === request.operation_kind);
    if (operation === undefined) return { kind: "REFUSAL", reason: "OPERATION_UNKNOWN" };

    // ---- pre-K6 asynchronous work (inside lock D, before the admission transaction) ----

    // Operation availability (§4.6 item 2: unavailable ⇒ admission refused).
    if (this.#enabled("operation_available") && !operation.available) {
      return { kind: "REFUSAL", reason: "OPERATION_UNAVAILABLE", detail: "adapter reports available = false" };
    }

    // Adapter-specific material completeness (bundle tip = new_sha etc.; §6.6, pre-K6).
    if (this.#enabled("material_complete")) {
      try {
        await adapter.verify_material(request.operation_kind, material);
      } catch (error) {
        if (error instanceof MaterialIncomplete || error instanceof CasMissing || error instanceof CasCorruption) {
          return { kind: "REFUSAL", reason: "MATERIAL_INCOMPLETE", detail: error.message };
        }
        throw error;
      }
    }

    // PEP_READ_THEN_ACT precondition read BEFORE K6 (§4.6 item 1): failure = deterministic
    // refusal with the read attached; no admission, no outcome.
    if (operation.dispatch_precondition === "PEP_READ_THEN_ACT" && this.#enabled("dispatch_precondition")) {
      const drift = await adapter.dispatch_precondition_read(request.operation_kind, material);
      if (drift !== undefined) {
        return { kind: "REFUSAL", reason: "DISPATCH_PRECONDITION_FAILED", detail: drift };
      }
    }

    // Mutable evidence subject probes for recheck #3 (read-only; results consumed in the tx).
    const decision = this.store.policyDecision(decision_id);
    if (decision === undefined) return { kind: "REFUSAL", reason: "DECISION_NOT_FOUND" };
    const input = this.store.admissionInput(decision.admission_input_digest.value);
    if (input === undefined) return { kind: "REFUSAL", reason: "INPUT_NOT_FOUND" };
    const probeResults = new Map<string, { revision_or_version?: string; content_digest?: string; availability: string }>();
    if (this.#enabled("subject_revision_fresh")) {
      for (const ref of input.evidence_refs) {
        const envelope = this.store.evidenceById(ref.evidence_id);
        if (envelope === undefined) continue; // tx recheck #3 will refuse
        for (const binding of envelope.subject_bindings) {
          if (binding.revision_or_version !== undefined && this.#isProbeable(adapter, binding)) {
            const key = `${binding.authority_ref}|${binding.namespace}|${binding.object_id}`;
            if (!probeResults.has(key)) probeResults.set(key, await adapter.current_revision(binding));
          }
        }
      }
    }

    // ---- the admission transaction (TD §3.4) ----

    let admission: EffectAdmissionV1;
    try {
      admission = this.store.withImmediate(() =>
        this.#admissionTransaction(request, adapter, material, decision_id, active, probeResults),
      );
    } catch (error) {
      if (error instanceof Refuse) {
        if (error.incident) {
          this.ingress.sealIncident(
            error.reason === "DIGEST_CORRUPTION" ? "DIGEST_CORRUPTION" : error.reason === "UNSUPPORTED_CONSTRAINT" ? "UNSUPPORTED_CONSTRAINT" : "DIGEST_CORRUPTION",
            error.message,
            [
              { authority_ref: "cadp-store:k04", namespace: "effect", object_id: request.effect_id },
              { authority_ref: request.target_ref.authority_ref, namespace: request.target_ref.target_type, object_id: request.target_ref.target_id },
            ],
          );
        }
        return { kind: "REFUSAL", reason: error.reason, detail: error.detail };
      }
      if (error instanceof UniqueViolation) {
        return { kind: "REFUSAL", reason: "ADMISSION_LOST_RACE", detail: error.constraint };
      }
      throw error;
    }

    // ---- dispatch (after COMMIT, still inside lock D; §3.4) ----

    const outcome = await this.#dispatchAndObserve(request, adapter, material, admission, active);
    return { kind: "ADMITTED", admission, outcome };
  }

  #isProbeable(adapter: TargetAdapterV1, binding: SubjectBinding): boolean {
    return binding.authority_ref === adapter.describe().authority_ref;
  }

  // ---------------------------------------------------------------- the 17 rechecks

  #admissionTransaction(
    requestPre: EffectRequestV1,
    adapter: TargetAdapterV1,
    material: Record<string, unknown>,
    decision_id: string,
    active: ActivePolicy,
    probes: ReadonlyMap<string, { revision_or_version?: string; content_digest?: string; availability: string }>,
  ): EffectAdmissionV1 {
    const now = this.clock();
    const store = this.store;

    // Rows read inside this transaction (per-effect mutex = BEGIN IMMEDIATE writer lock).
    const request = store.effectRequest(requestPre.effect_id);
    if (request === undefined) throw new Refuse("EFFECT_NOT_FOUND");
    const decision = store.policyDecision(decision_id);
    if (decision === undefined) throw new Refuse("DECISION_NOT_FOUND");
    const input = store.admissionInput(decision.admission_input_digest.value);
    if (input === undefined) throw new Refuse("INPUT_NOT_FOUND");
    const operation = adapter.describe().operations.find((o) => o.operation_kind === request.operation_kind)!;

    // Verify-on-read (§2.5): recompute stored digests.
    if (this.#enabled("verify_on_read")) {
      for (const [record, field, expected] of [
        [request, "request_digest", request.request_digest.value],
        [decision, "decision_digest", decision.decision_digest.value],
        [input, "input_digest", input.input_digest.value],
      ] as const) {
        if (recordDigest(record as unknown as Record<string, unknown>, field).value !== expected) {
          throw new Refuse("DIGEST_CORRUPTION", `${field} does not recompute`, true);
        }
      }
    }

    // #1 — active policy binding.
    if (this.#enabled("recheck1_policy_active")) {
      const a = active.activation;
      const d = decision.policy_ref;
      if (d.policy_id !== a.policy_id || d.revision !== a.revision || d.content_digest.value !== a.content_digest) {
        throw new Refuse("POLICY_NOT_ACTIVE");
      }
      if (sha256Hex(active.bundleBytes) !== a.content_digest) {
        throw new Refuse("DIGEST_CORRUPTION", "active policy bundle bytes", true);
      }
    }

    // #2 — exact binding decision ↔ input ↔ request; ALLOW; TTL.
    if (this.#enabled("recheck2_exact_binding")) {
      if (decision.admission_input_digest.value !== input.input_digest.value) throw new Refuse("DECISION_INPUT_MISMATCH");
      if (input.effect_request_ref !== request.effect_id || input.effect_request_digest.value !== request.request_digest.value) {
        throw new Refuse("DECISION_INPUT_MISMATCH", "input is not bound to this effect request");
      }
      if (decision.outcome !== "ALLOW") throw new Refuse("DECISION_NOT_ALLOW", decision.outcome);
      if (decision.not_after !== undefined && now >= Date.parse(decision.not_after)) throw new Refuse("DECISION_EXPIRED");
    }

    // #3 — evidence resolution + mutable subject drift.
    const evidence: EvidenceEnvelopeV1[] = [];
    for (const ref of input.evidence_refs) {
      const envelope = store.evidenceById(ref.evidence_id);
      if (envelope === undefined) throw new Refuse("EVIDENCE_NOT_FOUND", ref.evidence_id);
      if (this.#enabled("verify_on_read")) {
        if (recordDigest(envelope as unknown as Record<string, unknown>, "envelope_digest").value !== envelope.envelope_digest.value) {
          throw new Refuse("DIGEST_CORRUPTION", `evidence ${ref.evidence_id}`, true);
        }
        if (envelope.envelope_digest.value !== ref.envelope_digest.value) {
          throw new Refuse("EVIDENCE_DIGEST_MISMATCH", ref.evidence_id);
        }
        if (envelope.availability === "PRESENT") {
          if (jcsDigest(envelope.claim).value !== envelope.claim_digest!.value) {
            throw new Refuse("DIGEST_CORRUPTION", `claim of ${ref.evidence_id}`, true);
          }
        }
      }
      evidence.push(envelope);
      if (this.#enabled("subject_revision_fresh")) {
        for (const binding of envelope.subject_bindings) {
          if (binding.revision_or_version === undefined) continue;
          const probe = probes.get(`${binding.authority_ref}|${binding.namespace}|${binding.object_id}`);
          if (probe === undefined) continue;
          if (probe.availability !== "PRESENT" || probe.revision_or_version !== binding.revision_or_version) {
            throw new Refuse("SUBJECT_REVISION_DRIFT", `${binding.object_id}: bound ${binding.revision_or_version}, observed ${probe.revision_or_version ?? "UNKNOWN"}`);
          }
          if (binding.content_digest !== undefined && probe.content_digest !== undefined && probe.content_digest !== binding.content_digest.value) {
            throw new Refuse("SUBJECT_REVISION_DRIFT", `${binding.object_id}: content digest drift`);
          }
        }
      }
    }

    // #4/#16 — evidence freshness under source-time authority only.
    if (this.#enabled("recheck4_freshness")) {
      for (const constraint of decision.constraints) {
        if (constraint.kind !== "EVIDENCE_MAX_AGE") continue;
        const [kindArg, secondsArg] = constraint.args;
        for (const envelope of evidence) {
          if (envelope.evidence_kind !== kindArg) continue;
          const authority = this.#sourceTimeAuthority(envelope, active);
          if (authority !== "SOURCE") {
            throw new Refuse("EVIDENCE_FRESHNESS_UNKNOWN", `${envelope.evidence_id} derives to NONE and cannot satisfy EVIDENCE_MAX_AGE`);
          }
          if (now - Date.parse(envelope.produced_at) > Number(secondsArg) * 1000) {
            throw new Refuse("EVIDENCE_STALE", `${envelope.evidence_id} older than ${secondsArg}s`);
          }
        }
      }
    }

    // #5 — HUMAN_DECISION exact scope, single-effect use.
    if (this.#enabled("recheck5_human_scope")) {
      for (const envelope of evidence) {
        if (envelope.evidence_kind !== "HUMAN_DECISION") continue;
        const scope = (envelope.claim as { scope?: { effect_id?: string; work_run_ref?: string } })?.scope;
        const boundEffect = scope?.effect_id;
        if (boundEffect !== undefined) {
          if (boundEffect !== request.effect_id) throw new Refuse("HUMAN_DECISION_SCOPE_MISMATCH", envelope.evidence_id);
        } else if (scope?.work_run_ref !== undefined) {
          const workRun = request.work_bindings.find((b) => b.namespace === "work-run")?.object_id ?? (request.operation_kind === "WORK_START" ? request.effect_id : undefined);
          if (scope.work_run_ref !== workRun) throw new Refuse("HUMAN_DECISION_SCOPE_MISMATCH", envelope.evidence_id);
        } else {
          throw new Refuse("HUMAN_DECISION_SCOPE_MISMATCH", "decision has no scope");
        }
        // Never referenced by an admission of a DIFFERENT effect.
        for (const other of store.allAdmissions()) {
          if (other.effect_id === request.effect_id) continue;
          const otherInput = store.admissionInput(other.admission_input_digest.value);
          if (otherInput?.evidence_refs.some((r) => r.evidence_id === envelope.evidence_id)) {
            throw new Refuse("HUMAN_DECISION_REUSED", envelope.evidence_id);
          }
        }
      }
    }

    // #6 — one request_digest per effect_id (PK-guaranteed; re-verified).
    if (request.request_digest.value !== requestPre.request_digest.value) {
      throw new Refuse("DIGEST_CORRUPTION", "request digest changed between reads", true);
    }

    // #7 — open incidents (scope hold) + prior effect refs presented.
    if (this.#enabled("recheck7_scope_hold")) {
      const holding = this.ingress.scopeHeld(request);
      if (holding !== undefined) throw new Refuse("SCOPE_HELD", `open incident ${holding.evidence_id}`);
    }
    if (this.#enabled("recheck7_prior_refs")) {
      for (const prior of request.prior_effect_refs) {
        const priorAdmissions = store.admissionsByEffect(prior);
        if (priorAdmissions.length === 0) throw new Refuse("PRIOR_REF_NOT_AN_EFFECT", prior);
        const latest = this.#latestOutcome(prior);
        const presented = evidence.some(
          (e) =>
            e.evidence_kind === "TARGET_RECONCILIATION" &&
            e.subject_bindings.some((b) => b.object_id === prior) &&
            (latest === undefined ||
              (e.claim as { outcome_digest?: string })?.outcome_digest === latest.outcome_digest.value ||
              latest.evidence_ref === e.evidence_id),
        );
        if (!presented) throw new Refuse("PRIOR_EFFECT_STATE_NOT_PRESENTED", prior);
      }
    }

    // #8 — credential-reach attestation.
    if (this.#enabled("recheck8_reach")) {
      const reach = store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION");
      if (reach === undefined) throw new Refuse("CREDENTIAL_REACH_UNATTESTED");
      if (now - Date.parse(reach.produced_at) > active.config.reach_attestation_max_age_s * 1000) {
        throw new Refuse("CREDENTIAL_REACH_STALE");
      }
      if ((reach.claim as { alternate_path_found?: boolean })?.alternate_path_found !== false) {
        throw new Refuse("ALTERNATE_CREDENTIAL_PATH_FOUND");
      }
    }

    // #9 — proven target identity.
    if (this.#enabled("recheck9_target_identity")) {
      const subjectKey = `${request.target_ref.authority_ref}|${request.target_ref.target_type}|${request.target_ref.target_id}`;
      const identity = store.latestEvidenceOfKind("PEP_TARGET_IDENTITY", subjectKey);
      if (identity === undefined) throw new Refuse("TARGET_MISMATCH", "no PEP_TARGET_IDENTITY evidence for this target");
      if (now - Date.parse(identity.produced_at) > active.config.identity_probe_max_age_s * 1000) {
        throw new Refuse("TARGET_IDENTITY_STALE");
      }
      const claimed = (identity.claim as { target_id?: string })?.target_id;
      if (claimed !== request.target_ref.target_id) throw new Refuse("TARGET_MISMATCH", `proven ${claimed}`);
    }

    // #10 — constraint vocabulary + satisfaction.
    let maxOrdinalBound: number | undefined;
    if (this.#enabled("recheck10_constraints")) {
      for (const constraint of decision.constraints) {
        if (!SUPPORTED_CONSTRAINTS.has(constraint.kind)) {
          throw new Refuse("UNSUPPORTED_CONSTRAINT", constraint.kind, true);
        }
        maxOrdinalBound = this.#enforceConstraint(constraint, request, material, now, maxOrdinalBound);
      }
    }

    // #11/#15 — material bytes + every reachable CAS ref re-digest.
    if (this.#enabled("material_complete")) {
      let materialBytes: Uint8Array;
      try {
        materialBytes = this.cas.get(request.material_ref);
      } catch (error) {
        throw new Refuse("MATERIAL_INCOMPLETE", error instanceof Error ? error.message : "material missing", true);
      }
      if (jcsDigest(JSON.parse(Buffer.from(materialBytes).toString("utf8"))).value !== request.material_digest.value) {
        throw new Refuse("DIGEST_CORRUPTION", "material bytes do not re-digest", true);
      }
      for (const casRef of this.#casRefsIn(material)) {
        try {
          this.cas.get(casRef);
        } catch (error) {
          throw new Refuse("MATERIAL_INCOMPLETE", `${casRef}: ${error instanceof Error ? error.message : "missing"}`);
        }
      }
    }

    // #12 — next ordinal admissibility (§3.4).
    const admissions = store.admissionsByEffect(request.effect_id);
    const prev = admissions.at(-1);
    let ordinal = 1;
    if (prev !== undefined) {
      if (this.#enabled("recheck12_ordinal")) {
        const conclusive = this.#conclusiveOf(request.effect_id, prev.admission_digest.value);
        if (this.#latestCommitted(request.effect_id) !== undefined) {
          throw new Refuse("EFFECT_ALREADY_COMMITTED");
        }
        const nativeKeyProven =
          operation.idempotency === "NATIVE_KEY" &&
          (operation.idempotency_horizon_s === undefined ||
            now - Date.parse(prev.admitted_at) < operation.idempotency_horizon_s * 1000);
        if (!(conclusive === "NO_EFFECT_CONFIRMED" || nativeKeyProven)) {
          throw new Refuse("PRIOR_DISPATCH_UNRESOLVED");
        }
      }
      ordinal = prev.dispatch_ordinal + 1;
    }
    if (maxOrdinalBound !== undefined && ordinal > maxOrdinalBound) {
      throw new Refuse("CONSTRAINT_VIOLATED", `MAX_DISPATCH_ORDINAL(${maxOrdinalBound})`);
    }

    // #13/#17 — POLICY_ACTIVATE base + publication checks.
    if (request.operation_kind === "POLICY_ACTIVATE") {
      const expected = material["expected_active_policy_ref"] as { policy_id: string; revision: number; content_digest: { value: string }; seq: number } | undefined;
      if (this.#enabled("recheck13_activation_base")) {
        const a = active.activation;
        if (
          expected === undefined || expected.policy_id !== a.policy_id || expected.revision !== a.revision ||
          expected.content_digest?.value !== a.content_digest || expected.seq !== a.seq
        ) {
          throw new Refuse("ACTIVATION_BASE_STALE");
        }
      }
      if (this.#enabled("recheck17_publication")) {
        const proposed = material["proposed_policy_ref"] as { policy_id: string; revision: number; content_digest: { algorithm: "sha256"; canonicalization: "raw-bytes-1"; value: string } };
        try {
          verifyProposedBundle(this.cas, store, proposed, material["bundle_cas_ref"] as string);
        } catch (error) {
          if (error instanceof PublicationRefusal) throw new Refuse(error.reason, error.message);
          throw error;
        }
      }
    }

    // #14 — mutable-subject precondition well-formedness / immutability attestation.
    if (this.#enabled("recheck14_mutable_target") && operation.dispatch_precondition === "PEP_READ_THEN_ACT") {
      const attestation = store.latestEvidenceOfKind(
        "TARGET_IMMUTABILITY_ATTESTATION",
        `${request.target_ref.authority_ref}|${request.target_ref.target_type}|${request.target_ref.target_id}`,
      );
      if (attestation === undefined) throw new Refuse("MUTABLE_TARGET_WITHOUT_PRECONDITION", "no TARGET_IMMUTABILITY_ATTESTATION");
      if (now - Date.parse(attestation.produced_at) > active.config.target_immutability_attestation_max_age_s * 1000) {
        throw new Refuse("MUTABLE_TARGET_WITHOUT_PRECONDITION", "attestation stale");
      }
      if ((attestation.claim as { write_once_enforced?: boolean })?.write_once_enforced !== true) {
        throw new Refuse("MUTABLE_TARGET_WITHOUT_PRECONDITION", "attestation reports enforcement failure");
      }
    }

    // ---- K6 write: the row IS the reservation ----
    const admitted_at = nowIso(this.clock);
    const base: Record<string, unknown> = {
      admission_id: newId("admission", this.clock),
      effect_id: request.effect_id,
      dispatch_ordinal: ordinal,
      effect_request_digest: request.request_digest,
      policy_decision_ref: decision.decision_id,
      policy_decision_digest: decision.decision_digest,
      admission_input_digest: input.input_digest,
      pep_ref: this.pep_ref,
      bounded_capability: {
        target_ref: request.target_ref,
        operation_kind: request.operation_kind,
        material_digest: request.material_digest,
        single_dispatch: true,
        expires_at: new Date(Date.parse(admitted_at) + active.config.dispatch_window_s * 1000).toISOString(),
      },
      admitted_at,
    };
    if (prev !== undefined) base["prior_admission_ref"] = prev.admission_id;
    const admission = { ...base, admission_digest: recordDigest(base, "admission_digest") } as unknown as EffectAdmissionV1;
    validateEffectAdmission(admission);
    this.store.insertAdmission(admission);
    return admission;
  }

  #enforceConstraint(
    constraint: Constraint,
    request: EffectRequestV1,
    material: Record<string, unknown>,
    now: number,
    maxOrdinalBound: number | undefined,
  ): number | undefined {
    switch (constraint.kind) {
      case "MAX_DISPATCH_ORDINAL":
        return Number(constraint.args[0]);
      case "NOT_AFTER":
        if (now >= Date.parse(String(constraint.args[0]))) throw new Refuse("CONSTRAINT_VIOLATED", "NOT_AFTER");
        return maxOrdinalBound;
      case "REQUIRE_TARGET_IDEMPOTENCY_PROOF":
      case "EVIDENCE_MAX_AGE":
        return maxOrdinalBound; // enforced in #12 / #4 respectively
      case "REQUIRE_NO_PRIOR_UNKNOWN_IN_SCOPE": {
        const workRun = request.work_bindings.find((b) => b.namespace === "work-run")?.object_id;
        if (workRun !== undefined) {
          for (const effectId of this.store.effectIdsByWorkRun(workRun)) {
            if (effectId === request.effect_id) continue;
            for (const admission of this.store.admissionsByEffect(effectId)) {
              if (this.#conclusiveOf(effectId, admission.admission_digest.value) === undefined &&
                  this.store.outcomesByAdmissionDigest(admission.admission_digest.value).some((o) => o.result === "UNKNOWN")) {
                throw new Refuse("CONSTRAINT_VIOLATED", `REQUIRE_NO_PRIOR_UNKNOWN_IN_SCOPE: ${effectId}`);
              }
            }
          }
        }
        return maxOrdinalBound;
      }
      case "MATERIAL_SIZE_MAX": {
        let total = Buffer.from(jcs(material), "utf8").length;
        for (const ref of this.#casRefsIn(material)) {
          try { total += this.cas.get(ref).length; } catch { /* #15 refuses */ }
        }
        if (total > Number(constraint.args[0])) throw new Refuse("CONSTRAINT_VIOLATED", "MATERIAL_SIZE_MAX");
        return maxOrdinalBound;
      }
      case "OPERATION_KIND_EQUALS":
        if (request.operation_kind !== constraint.args[0]) throw new Refuse("CONSTRAINT_VIOLATED", "OPERATION_KIND_EQUALS");
        return maxOrdinalBound;
      case "TARGET_REF_EQUALS":
        if (`${request.target_ref.authority_ref}|${request.target_ref.target_type}|${request.target_ref.target_id}` !== constraint.args[0]) {
          throw new Refuse("CONSTRAINT_VIOLATED", "TARGET_REF_EQUALS");
        }
        return maxOrdinalBound;
      case "MAX_EFFECTS_IN_WORK_RUN": {
        const workRun = request.work_bindings.find((b) => b.namespace === "work-run")?.object_id;
        if (workRun !== undefined) {
          // §7.3: the kernel-owned bound is the sealed WORK_START material; the constraint arg
          // is a policy projection — enforce the tighter of the two.
          let bound = Number(constraint.args[0]);
          const workStart = this.store.effectRequest(workRun);
          if (workStart !== undefined) {
            try {
              const startMaterial = JSON.parse(Buffer.from(this.cas.get(workStart.material_ref)).toString("utf8")) as {
                bounds?: { max_effects?: number };
              };
              if (Number.isInteger(startMaterial.bounds?.max_effects)) {
                bound = Math.min(bound, startMaterial.bounds!.max_effects!);
              }
            } catch { /* material refusal is #15's job for the WORK_START effect itself */ }
          }
          const count = this.store.effectIdsByWorkRun(workRun).length;
          if (count > bound) throw new Refuse("MAX_EFFECTS_IN_WORK_RUN", `${count} > ${bound}`);
        }
        return maxOrdinalBound;
      }
      default:
        throw new Refuse("UNSUPPORTED_CONSTRAINT", constraint.kind, true);
    }
  }

  #sourceTimeAuthority(envelope: EvidenceEnvelopeV1, active: ActivePolicy): "SOURCE" | "NONE" {
    const entry = adapterEntry(active.config, envelope.producer_ref);
    if (entry === undefined || entry.produced_at_source.kind !== "SOURCE") return "NONE";
    if (envelope.availability !== "PRESENT") return "NONE";
    const sourceValue = resolvePointer(envelope.claim, entry.produced_at_source.claim_pointer);
    return typeof sourceValue === "string" && sourceValue === envelope.produced_at ? "SOURCE" : "NONE";
  }

  #casRefsIn(value: unknown, found: string[] = []): string[] {
    if (typeof value === "string" && /^cas:\/\/sha256\/[0-9a-f]{64}$/u.test(value)) found.push(value);
    else if (Array.isArray(value)) for (const v of value) this.#casRefsIn(v, found);
    else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) this.#casRefsIn(v, found);
    return found;
  }

  #conclusiveOf(effect_id: string, admission_digest: string): "COMMITTED" | "NO_EFFECT_CONFIRMED" | undefined {
    const outcomes = this.store.outcomesByAdmissionDigest(admission_digest);
    const committed = outcomes.some((o) => o.result === "COMMITTED");
    const noEffect = outcomes.some((o) => o.result === "NO_EFFECT_CONFIRMED");
    if (committed && noEffect) {
      this.ingress.sealIncident("OUTCOME_CONTRADICTION", `admission ${admission_digest}`, [
        { authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id },
      ]);
      throw new Refuse("OUTCOME_CONTRADICTION", admission_digest, false);
    }
    return committed ? "COMMITTED" : noEffect ? "NO_EFFECT_CONFIRMED" : undefined;
  }

  #latestCommitted(effect_id: string): EffectOutcomeV1 | undefined {
    return this.store.outcomesByEffect(effect_id).find((o) => o.result === "COMMITTED");
  }

  #latestOutcome(effect_id: string): EffectOutcomeV1 | undefined {
    return this.store.outcomesByEffect(effect_id).at(-1);
  }

  // ---------------------------------------------------------------- dispatch + outcome truth

  async #dispatchAndObserve(
    request: EffectRequestV1,
    adapter: TargetAdapterV1,
    material: Record<string, unknown>,
    admission: EffectAdmissionV1,
    active: ActivePolicy,
  ): Promise<EffectOutcomeV1> {
    if (admission.bounded_capability.expires_at !== undefined && this.clock() >= Date.parse(admission.bounded_capability.expires_at)) {
      return this.writeOutcome(request, admission, { kind: "UNKNOWN", unknown_reason: "DISPATCH_WINDOW_EXPIRED" });
    }
    let result: DispatchResult;
    try {
      result = await adapter.dispatch(request.effect_id, admission.dispatch_ordinal, request.target_ref, request.operation_kind, material);
    } catch (error) {
      result = { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
    switch (result.kind) {
      case "ACCEPTED": {
        if (!adapter.receipt_binds(request.operation_kind, material, result.receipt_claim)) {
          this.ingress.sealIncident("RECEIPT_MATERIAL_MISMATCH", `effect ${request.effect_id} receipt does not bind to material`, [
            { authority_ref: "cadp-store:k04", namespace: "effect", object_id: request.effect_id },
            { authority_ref: request.target_ref.authority_ref, namespace: request.target_ref.target_type, object_id: request.target_ref.target_id },
          ]);
          return this.writeOutcome(request, admission, { kind: "UNKNOWN", unknown_reason: "RECEIPT_UNBOUND" });
        }
        return this.writeOutcome(request, admission, {
          kind: "COMMITTED",
          target_operation_ref: result.target_operation_ref,
          receipt_claim: result.receipt_claim,
        });
      }
      case "REJECTED_NO_EFFECT": {
        const operation = adapter.describe().operations.find((o) => o.operation_kind === request.operation_kind)!;
        if (!operation.no_effect_proof_supported && operation.dispatch_precondition !== "NATIVE_CAS") {
          return this.writeOutcome(request, admission, { kind: "UNKNOWN", unknown_reason: "REJECTION_WITHOUT_PROOF_SUPPORT" });
        }
        return this.writeOutcome(request, admission, { kind: "NO_EFFECT_CONFIRMED", proof_claim: result.proof_claim });
      }
      case "AMBIGUOUS":
        return this.writeOutcome(request, admission, { kind: "UNKNOWN", unknown_reason: result.raw_observation.slice(0, 500) });
    }
  }

  /** Outcome truth rules (§6.3): sealing the receipt/proof as TARGET_RECONCILIATION evidence. */
  writeOutcome(
    request: EffectRequestV1,
    admission: EffectAdmissionV1,
    observation:
      | { kind: "COMMITTED"; target_operation_ref: string; receipt_claim: Record<string, unknown> }
      | { kind: "NO_EFFECT_CONFIRMED"; proof_claim: Record<string, unknown> }
      | { kind: "UNKNOWN"; unknown_reason: string },
    observer_ref: string = this.pep_ref,
  ): EffectOutcomeV1 {
    let evidence_ref: string | undefined;
    const base: Record<string, unknown> = {
      outcome_id: newId("outcome", this.clock),
      effect_id: request.effect_id,
      admission_digest: admission.admission_digest,
      result: observation.kind,
      target_ref: request.target_ref,
      observed_at: nowIso(this.clock),
      observer_ref,
    };
    if (observation.kind === "UNKNOWN") {
      base["unknown_reason"] = observation.unknown_reason;
    } else {
      const claim = {
        outcome_kind: observation.kind,
        effect_id: request.effect_id,
        admission_digest: admission.admission_digest.value,
        receipt: observation.kind === "COMMITTED" ? observation.receipt_claim : observation.proof_claim,
      };
      const envelope = this.ingress.sealInternalEvidence({
        evidence_kind: "TARGET_RECONCILIATION",
        subject_bindings: [
          { authority_ref: "cadp-store:k04", namespace: "effect", object_id: request.effect_id },
          { authority_ref: request.target_ref.authority_ref, namespace: request.target_ref.target_type, object_id: request.target_ref.target_id },
        ],
        availability: "PRESENT",
        claim_schema: "cadp.target-reconciliation.v1",
        claim,
        source_ref: request.target_ref.authority_ref,
        source_relation: "TARGET_AUTHORITY_OBSERVATION",
      });
      evidence_ref = envelope.evidence_id;
      if (observation.kind === "COMMITTED") base["target_operation_ref"] = observation.target_operation_ref;
    }
    if (evidence_ref !== undefined) base["evidence_ref"] = evidence_ref;
    const outcome = { ...base, outcome_digest: recordDigest(base, "outcome_digest") } as unknown as EffectOutcomeV1;
    validateEffectOutcome(outcome);
    // Contradiction guard: a conclusive write against an opposite conclusive is an incident.
    const existing = this.store.outcomesByAdmissionDigest(admission.admission_digest.value);
    const opposite = observation.kind === "COMMITTED" ? "NO_EFFECT_CONFIRMED" : observation.kind === "NO_EFFECT_CONFIRMED" ? "COMMITTED" : undefined;
    if (opposite !== undefined && existing.some((o) => o.result === opposite)) {
      this.ingress.sealIncident("OUTCOME_CONTRADICTION", `admission ${admission.admission_digest.value}`, [
        { authority_ref: "cadp-store:k04", namespace: "effect", object_id: request.effect_id },
      ]);
    }
    this.store.withImmediate(() => this.store.insertOutcome(outcome));
    // The claim's outcome_digest projection for prior-ref presentation (#7): sealed after the
    // outcome exists, by the reconciler's evidence path (see Reconciler.sealOutcomeEvidence).
    return outcome;
  }

  /**
   * Projection of a prior effect's latest outcome as presentable evidence (recheck #7):
   * a durable record of the target-authoritative observation already in K7.
   */
  sealPriorState(effect_id: string): EvidenceEnvelopeV1 {
    const request = this.store.effectRequest(effect_id);
    if (request === undefined) throw new Error(`no such effect ${effect_id}`);
    const latest = this.#latestOutcome(effect_id);
    if (latest === undefined) throw new Error(`effect ${effect_id} has no outcome to present`);
    return this.ingress.sealInternalEvidence({
      evidence_kind: "TARGET_RECONCILIATION",
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id },
        { authority_ref: request.target_ref.authority_ref, namespace: request.target_ref.target_type, object_id: request.target_ref.target_id },
      ],
      availability: "PRESENT",
      claim_schema: "cadp.prior-effect-state.v1",
      claim: {
        effect_id,
        outcome_digest: latest.outcome_digest.value,
        result: latest.result,
        ...(latest.unknown_reason !== undefined ? { unknown_reason: latest.unknown_reason } : {}),
      },
      source_ref: request.target_ref.authority_ref,
      source_relation: "TARGET_AUTHORITY_OBSERVATION",
    });
  }

  // ---------------------------------------------------------------- identity / attestations

  async refreshTargetIdentity(adapter: TargetAdapterV1): Promise<EvidenceEnvelopeV1> {
    const claim = await adapter.prove_identity();
    return this.ingress.sealInternalEvidence({
      evidence_kind: "PEP_TARGET_IDENTITY",
      subject_bindings: [
        {
          authority_ref: claim.target_ref.authority_ref,
          namespace: claim.target_ref.target_type,
          object_id: claim.target_ref.target_id,
        },
      ],
      availability: "PRESENT",
      claim_schema: "cadp.pep-target-identity.v1",
      claim: { target_id: claim.target_ref.target_id, ...claim.claim },
      source_ref: claim.target_ref.authority_ref,
      source_relation: "TARGET_AUTHORITY_OBSERVATION",
    });
  }
}

export type { TargetRef };
