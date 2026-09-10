/**
 * PEP (TD §3.4, §4): the only component that writes `EffectAdmissionV1` and dispatches.
 * Serialization lock D spans precondition → admission → dispatch → outcome; the admission
 * row is the reservation; rechecks #1–#17, plus AP B4(5)'s #18 and AP B5(5)'s #19, run against rows
 * read inside the transaction; K7 truth stays target-authoritative (§6.3).
 *
 * It is also where AP B5(1) mints: a run capability is minted in the SAME transaction as the
 * admission, at the INITIAL dispatch of a `WORK_START` whose seal-time origin WITNESS exists, and
 * only for a caller whose stamped `requester_ref` is the sealed one. Nothing else mints, ever.
 *
 * `disabledChecks` is a TEST-ONLY guard-bite harness knob (TD §13.1): the production
 * composition never passes it, and the conformance suite proves each listed check is
 * load-bearing by disabling it and observing the prohibited effect.
 */

import { createHash, randomBytes } from "node:crypto";

import { Cas, CasCorruption, CasMissing } from "./cas.ts";
import { jcs, jcsDigest, nowIso, recordDigest, sha256Hex } from "./canonical.ts";
import { newId } from "./ids.ts";
// `subjectKey` is aliased: recheck #9 already binds that identifier to a local target-key string.
import {
  Ingress, RUN_PROFILE_WORK_START, assemblySubjectKeys, declaredAssemblyEntries, declaredWorkRunRef,
  runProfileEnrolled, subjectKey as subjectKeyOf,
} from "./ingress.ts";
import type { Principal } from "./ingress.ts";
import { adapterEntry, identityEntry, resolveActivePolicy } from "./policyState.ts";
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
  /**
   * AP B6(4): the freshly minted run capability, base64url (unpadded) of the raw 256-bit secret.
   * Present EXACTLY when all of: this is the INITIAL dispatch of that `effect_id`, the sealed
   * request is run-capability-minting under B5(1)'s WITNESSED predicate (both legs), and the
   * caller passed B5(1)'s stamped-vs-sealed `requester_ref` equality. Absent in every other case
   * without exception — non-minting operations, a refused dispatch, and any non-initial result.
   *
   * DELIVERY IS THE ONLY CHANNEL AND IT IS ONE-SHOT (B5(7)): only `capability_digest` is stored and
   * a digest cannot be inverted, so nothing re-delivers this value — not a repeat dispatch, not the
   * reconciler, not any read method. A composition that logs or persists an `AdmitResult` verbatim
   * would defeat B6(3)'s logging prohibition; the value belongs in the caller's secret custody and
   * nowhere else.
   */
  readonly run_capability?: string;
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

  /**
   * AP B5(1): `admit_and_dispatch` takes the authenticated principal, the same pattern the API
   * layer already uses for `seal_effect_request` and `submit_evidence`. It is OPTIONAL in this
   * signature and fail-closed when omitted: a caller with no principal stamps to no
   * `requester_ref`, so it can never satisfy the equality below and can never mint. Every
   * pre-existing in-process caller therefore keeps its behaviour for every non-minting effect and
   * is refused — never silently served — for a minting one.
   */
  async admitAndDispatch(effect_id: string, decision_id: string, caller?: Principal): Promise<AdmitResult> {
    const request = this.store.effectRequest(effect_id);
    if (request === undefined) return { kind: "REFUSAL", reason: "EFFECT_NOT_FOUND" };
    // B5(1): for an effect that IS run-capability-minting, the PEP REFUSES the dispatch unless the
    // caller's stamped `requester_ref` equals the sealed request's. Checked HERE, before the lock,
    // the pre-K6 adapter reads and the admission transaction, so the refusal writes NO admission,
    // NO outcome and mints nothing. The alternative — dispatch anyway and merely withhold the
    // secret from the wrong caller — was rejected by the TD: it leaves the run permanently
    // stranded, reachable by any authorized caller who simply races the dispatch.
    //
    // The caller is resolved to a stamped `requester_ref` ONLY for an effect that IS minting, so a
    // dispatch of anything else costs exactly what it costs today. Minting-ness is fixed at seal —
    // the witness row is written in the same transaction as the request row this method already
    // read — so it cannot change between here and the admission transaction's re-read.
    const minting = this.#isRunCapabilityMinting(request);
    const stamped = minting ? this.#stampedRequesterRef(caller) : undefined;
    if (minting && stamped !== request.requester_ref) {
      return {
        kind: "REFUSAL",
        reason: "WORK_START_DISPATCH_REQUESTER_MISMATCH",
        detail: `${stamped ?? "unauthenticated caller"} is not the sealed requester of ${effect_id}`,
      };
    }
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
      return await this.#admitAndDispatchLocked(request, adapter, material, decision_id, stamped);
    } finally {
      release();
    }
  }

  /**
   * AP B5(1)/B5(3): the caller's identity in the STAMPED `requester_ref` domain — resolved through
   * the active `identity_registry` exactly as the Ingress stamps a seal, never the raw
   * authenticated-principal string and never a body field. An absent or unregistered principal
   * stamps to `undefined`, which equals no sealed `requester_ref` and therefore mints nothing.
   */
  #stampedRequesterRef(caller: Principal | undefined): string | undefined {
    if (caller === undefined) return undefined;
    return identityEntry(resolveActivePolicy(this.store, this.cas).config, caller.principal)?.producer_ref;
  }

  /**
   * AP B5(1): the WITNESSED minting predicate — `run-capability-minting(E)` holds exactly when
   * BOTH (a) `E`'s sealed request is a `WORK_START` (the SHAPE leg) AND (b) `E` was adjudicated a
   * run origin AT SEAL, witnessed by a durable `run_membership(E, E)` row. That row is written on
   * one path only, inside `E`'s own sealing transaction (`ingress.ts`, B5(9)), so it is proof of a
   * SEAL-TIME adjudication rather than a shape re-derived at dispatch under whatever config is
   * active by then.
   *
   * Two consequences, both normative and both load-bearing here:
   *  (α) an ORDINARY `WORK_START` — `operation_kind == WORK_START` but no witness — is NEVER
   *      minting, not at its initial dispatch and not at any later one, and no later
   *      `POLICY_ACTIVATE` can retroactively make it one: the witness is fixed in `E`'s sealing
   *      transaction and the store has no runtime `UPDATE` and no back-dating insert. This is what
   *      closes the cross-boundary fork recheck #19 cannot see, one step earlier, at the mint;
   *  (β) a genuine self-origin mints EXACTLY ONCE at its initial dispatch, with once-and-only-once
   *      enforced by the `run_capability` primary key rather than by caller discipline.
   *
   * Deliberately NOT gated on the active config's schema: minting-eligibility is FIXED AT SEAL by
   * the witness and never re-evaluated at dispatch under changed config. A `cadp.kernel-config.v1`
   * deployment can hold no witness row — nothing writes one under v1 — so this is inert there.
   *
   * `run_capability_witness` is the TEST-ONLY guard-bite knob for leg (b) (TD §13.1): disabling it
   * restores the SHAPE-ONLY predicate, under which any ordinary `WORK_START` mints — the prohibited
   * durable delta control A4 leg w1 makes observable.
   */
  #isRunCapabilityMinting(request: EffectRequestV1): boolean {
    if (request.operation_kind !== RUN_PROFILE_WORK_START) return false;
    if (!this.#enabled("run_capability_witness")) return true;
    return this.store.runMembership(request.effect_id)?.work_run_ref === request.effect_id;
  }

  async #admitAndDispatchLocked(
    request: EffectRequestV1,
    adapter: TargetAdapterV1,
    material: Record<string, unknown>,
    decision_id: string,
    stamped: string | undefined,
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

    let admitted: { admission: EffectAdmissionV1; run_capability?: string };
    try {
      admitted = this.store.withImmediate(() =>
        this.#admissionTransaction(request, adapter, material, decision_id, active, probeResults, stamped),
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

    const { admission, run_capability } = admitted;
    const outcome = await this.#dispatchAndObserve(request, adapter, material, admission, active);
    // B6(4): the field is present EXACTLY on the verified initial dispatch that minted, and absent
    // in every other case. A minted capability is delivered whatever the dispatch OUTCOME turns
    // out to be — the mint is at admission, and K7 grading moves the scope's USABILITY (B5(2)),
    // never its delivery.
    return run_capability === undefined
      ? { kind: "ADMITTED", admission, outcome }
      : { kind: "ADMITTED", admission, outcome, run_capability };
  }

  #isProbeable(adapter: TargetAdapterV1, binding: SubjectBinding): boolean {
    return binding.authority_ref === adapter.describe().authority_ref;
  }

  // -------------------------------- the 17 rechecks, plus AP B4(5)'s #18 and AP B5(5)'s #19

  #admissionTransaction(
    requestPre: EffectRequestV1,
    adapter: TargetAdapterV1,
    material: Record<string, unknown>,
    decision_id: string,
    active: ActivePolicy,
    probes: ReadonlyMap<string, { revision_or_version?: string; content_digest?: string; availability: string }>,
    stamped: string | undefined,
  ): { admission: EffectAdmissionV1; run_capability?: string } {
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

    // #5 — HUMAN_DECISION / AGENT_DECISION exact scope, single-effect use.
    if (this.#enabled("recheck5_human_scope")) {
      for (const envelope of evidence) {
        if (envelope.evidence_kind !== "HUMAN_DECISION" && envelope.evidence_kind !== "AGENT_DECISION") continue;
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
      // §4.4 #7: each prior's LATEST outcome must be presented in the input — either the
      // genuine TARGET_RECONCILIATION receipt envelope the outcome references, or the
      // outcome record itself, named byte-exact by digest inside the SEALED material
      // (K4-bound via the request; the evaluator sees it in effect_material.prior_outcomes).
      const presentedOutcomes = (material["prior_outcomes"] as Array<{ effect_id?: string; outcome_digest?: string }> | undefined) ?? [];
      for (const prior of request.prior_effect_refs) {
        const priorAdmissions = store.admissionsByEffect(prior);
        if (priorAdmissions.length === 0) throw new Refuse("PRIOR_REF_NOT_AN_EFFECT", prior);
        const latest = this.#latestOutcome(prior);
        if (latest === undefined) throw new Refuse("PRIOR_EFFECT_STATE_NOT_PRESENTED", `${prior}: admission has no outcome row yet`);
        const viaReceipt = evidence.some(
          (e) => e.evidence_kind === "TARGET_RECONCILIATION" && latest.evidence_ref === e.evidence_id,
        );
        const viaOutcomeRecord = presentedOutcomes.some(
          (o) => o.effect_id === prior && o.outcome_digest === latest.outcome_digest.value,
        );
        if (!viaReceipt && !viaOutcomeRecord) throw new Refuse("PRIOR_EFFECT_STATE_NOT_PRESENTED", prior);
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

    // #18 — assembly completeness is as-of a transaction, so it is RE-PROVEN here (AP B4(5)).
    // The complete set for every declared (evidence_kind, subject-key) pair is recomputed from
    // rows read INSIDE this transaction and compared against the set the bound `AdmissionInputV1`
    // carries; any difference refuses. Without it a producer could seal a contrary envelope after
    // assembly and the decision would be silently stale (Spec v0.5 §2.7). The honest cost is
    // stated in B4(5): a producer that keeps sealing envelopes for a subject can keep admission
    // failing — a liveness cost of a safety rule, resolved by a fresh assembly and evaluation.
    // Gated on the v2 config by `declaredAssemblyEntries`, so a v1 deployment's recheck list is
    // exactly items #1–#17.
    if (this.#enabled("recheck18_assembly_complete")) {
      for (const entry of declaredAssemblyEntries(active.config, request.operation_kind)) {
        const keys = assemblySubjectKeys(entry, request.work_bindings);
        if (keys.length === 0) {
          // Unreachable through `assemble_admission_input`, which refuses the same request
          // `ASSEMBLY_SUBJECT_UNBOUND` before any K4 row exists; kept fail-closed rather than
          // vacuously satisfied, because "never vacuously satisfied" (B4(2)) is the rule, not a
          // property of one entry point.
          throw new Refuse(
            "ASSEMBLY_INCOMPLETE_AT_COMMIT",
            `${entry.evidence_kind} is declared over ${entry.subject_namespace}, which this request binds nowhere`,
          );
        }
        for (const key of keys) {
          const complete = new Set(
            store.evidenceBySubjectKey(key).filter((e) => e.evidence_kind === entry.evidence_kind).map((e) => e.evidence_id),
          );
          const carried = new Set(
            evidence
              .filter((e) => e.evidence_kind === entry.evidence_kind && e.subject_bindings.some((b) => subjectKeyOf(b) === key))
              .map((e) => e.evidence_id),
          );
          const missing = [...complete].filter((evidence_id) => !carried.has(evidence_id));
          if (missing.length > 0 || carried.size !== complete.size) {
            throw new Refuse(
              "ASSEMBLY_INCOMPLETE_AT_COMMIT",
              `${entry.evidence_kind} on ${key}: the bound input carries ${carried.size} of ${complete.size}${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}`,
            );
          }
        }
      }
    }

    // #19 — the DURABLE MEMBERSHIP PROOF (AP B5(5)). For a request whose sealed `requester_ref` is
    // enrolled and which names a declared work-run subject, the PEP requires the `run_membership`
    // row B5(5)'s insert wrote in that request's OWN sealing transaction, with a `work_run_ref`
    // EXACTLY equal to the run this request is bound to — absent or different refuses
    // `RUN_MEMBERSHIP_UNPROVEN`. The row is read HERE, inside the admission transaction, because
    // authority after restart is reconstructed from rows and never from process memory (TD v0.4
    // §4.5): the secret itself is not needed at admission and is never touched on this path.
    //
    // What it is FOR, stated exactly so it is not read as more than it is. B5(4)'s presentation
    // legs are seal-time, and their proof — the capability — is deliberately one-shot and not
    // re-presentable at dispatch. #19 is the ADMISSION-time restatement of the same fact in the
    // only durable form there is: this effect proved, at seal, membership of the run it claims.
    // A request that reached a K3 row by any path that did NOT write that proof — a run-bound
    // request sealed while the profile was not yet governing this requester, whose `requester_ref`
    // a later `POLICY_ACTIVATE` then enrolled — is admitted no further, though its seal was lawful
    // when it happened. What it is NOT for: it can never catch a fork whose follow-up seal wrote
    // its own proof, which is exactly the retroactive-promotion case B5(1)'s WITNESSED minting
    // predicate closes one step earlier, at the mint (`#isRunCapabilityMinting`, control A4 leg w1).
    //
    // GATE, and why every other deployment is untouched: `runProfileEnrolled` is expressible ONLY
    // under `cadp.kernel-config.v2` and only for a `requester_ref` the active registry names, and
    // `declaredWorkRunRef` is the Ingress's own lookup on the DECLARED exact `(authority_ref,
    // namespace)` pair — the same one B5(9) and B5(4) are defined over, so the PEP can never
    // disagree with the seal about which run a request is bound to. A v1 config, a v2 config whose
    // enrollment does not name this requester, and a request naming no declared work-run subject
    // all skip it, leaving those admission paths exactly what they were.
    if (this.#enabled("recheck19_run_membership") && runProfileEnrolled(active.config, request.requester_ref)) {
      const bound = declaredWorkRunRef(request, active.config);
      if (bound !== undefined) {
        const proof = store.runMembership(request.effect_id);
        if (proof === undefined || proof.work_run_ref !== bound) {
          // The detail names the caller's own sealed refs and nothing else: no capability, no
          // digest and no row beyond the two run refs already in the request it sent (B6(3)).
          throw new Refuse(
            "RUN_MEMBERSHIP_UNPROVEN",
            proof === undefined
              ? `${request.effect_id} is bound to ${bound} and proves membership of no run`
              : `${request.effect_id} proves membership of ${proof.work_run_ref}, not ${bound}`,
          );
        }
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
    // AP B5(1): the mint, in the SAME transaction as the admission and after it, so a refused
    // admission mints nothing and a minted capability is never orphaned from its K6 row.
    const run_capability = this.#mintRunCapability(request, ordinal, stamped);
    return run_capability === undefined ? { admission } : { admission, run_capability };
  }

  /**
   * AP B5(1)/B6(4) — MINTING, and every condition on it, evaluated against rows read inside the
   * admission transaction. Returns the base64url (unpadded) secret to deliver, or `undefined` when
   * this dispatch mints nothing, which is every case but one:
   *
   *  - not the INITIAL dispatch (`dispatch_ordinal > 1`) — a repeat finds the row present, mints
   *    nothing and returns nothing, which is what "returned exactly once" means on the wire;
   *  - not run-capability-minting under B5(1)'s WITNESSED predicate — an ordinary `WORK_START`
   *    carrying no `run_membership(E,E)` witness mints nothing at its initial dispatch either;
   *  - the caller is not the sealed requester — already refused before the lock; re-checked here so
   *    the mint cannot be reached by a path that skipped that refusal;
   *  - a `run_capability` row already exists for this run — belt and braces to the primary key.
   *
   * The secret is a 256-bit CSPRNG value that exists ONLY in this local and in the returned string:
   * what is STORED is `SHA-256` over the RAW 32 bytes — never over the base64url text, so no
   * encoding variant (padding, alternate alphabet, case) can be a second string digesting to this
   * row — and a digest cannot be inverted, so there is no recovery and no re-delivery (B5(7)).
   * Nothing here writes the secret to a log, a trace, an incident, an error message or any record:
   * the refusal above names a reason code and the caller's own stamped ref, the insert stores only
   * the digest, and no `KERNEL_INCIDENT` is raised on any path this method reaches (B6(3)).
   */
  #mintRunCapability(request: EffectRequestV1, ordinal: number, stamped: string | undefined): string | undefined {
    if (ordinal !== 1) return undefined;
    if (!this.#isRunCapabilityMinting(request)) return undefined;
    if (stamped !== request.requester_ref) return undefined;
    if (this.store.runCapability(request.effect_id) !== undefined) return undefined;
    const secret = randomBytes(32);
    this.store.insertRunCapability({
      // B5(1): the primary key IS the minting `WORK_START`'s own `effect_id` (TD v0.4 §7.4), which
      // by the witness leg is also both columns of the `run_membership` row that authorized it.
      work_run_ref: request.effect_id,
      holder_ref: request.requester_ref,
      capability_digest: createHash("sha256").update(secret).digest("hex"),
      minted_at: nowIso(this.clock),
    });
    return secret.toString("base64url");
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
            let declared: unknown;
            let readable = false;
            try {
              const startMaterial = JSON.parse(Buffer.from(this.cas.get(workStart.material_ref)).toString("utf8")) as {
                bounds?: { max_effects?: unknown };
              };
              declared = startMaterial.bounds?.max_effects;
              readable = true;
            } catch { /* material refusal is #15's job for the WORK_START effect itself */ }
            if (readable && declared !== undefined) {
              // #127: a declared bound that is not a positive integer refuses — it is never
              // silently widened to the policy cap (`Number.isInteger(NaN)` used to drop it;
              // a NaN/Infinity bound arrives here as null after JSON serialization).
              if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 1) {
                throw new Refuse("CONSTRAINT_VIOLATED", `MALFORMED_WORK_BOUNDS: max_effects=${String(declared)}`);
              }
              bound = Math.min(bound, declared);
            }
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
