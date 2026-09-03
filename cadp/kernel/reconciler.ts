/**
 * Reconciler (TD §6.5): runs inside the Kernel Service — on start, on UNKNOWN write, and on
 * `request_reconcile`. Policy-bound attempts/backoff; after exhaustion the effect remains
 * UNKNOWN and a RECONCILE_EXHAUSTED envelope routes it to the Human exception branch (§7.5).
 * The Reconciler never dispatches.
 */

import { Cas } from "./cas.ts";
import { Ingress } from "./ingress.ts";
import { Pep } from "./pep.ts";
import { resolveActivePolicy } from "./policyState.ts";
import type { EffectAdmissionV1, EffectOutcomeV1 } from "./records.ts";
import { ConstitutionalStore } from "./store.ts";
import type { AdapterRegistry } from "./adapters/types.ts";

export class Reconciler {
  readonly store: ConstitutionalStore;
  readonly cas: Cas;
  readonly ingress: Ingress;
  readonly pep: Pep;
  readonly adapters: AdapterRegistry;
  readonly clock: () => number;

  constructor(store: ConstitutionalStore, cas: Cas, ingress: Ingress, pep: Pep, adapters: AdapterRegistry, clock: () => number = Date.now) {
    this.store = store;
    this.cas = cas;
    this.ingress = ingress;
    this.pep = pep;
    this.adapters = adapters;
    this.clock = clock;
  }

  /** Restart scan (TD §3.3): every admission with no conclusive outcome gets one pass. */
  async reconcileOpenAdmissions(): Promise<void> {
    for (const admission of this.store.allAdmissions()) {
      if (this.#conclusive(admission)) continue;
      await this.reconcileEffect(admission.effect_id);
    }
  }

  #conclusive(admission: EffectAdmissionV1): boolean {
    return this.store
      .outcomesByAdmissionDigest(admission.admission_digest.value)
      .some((o) => o.result === "COMMITTED" || o.result === "NO_EFFECT_CONFIRMED");
  }

  async reconcileEffect(effect_id: string): Promise<EffectOutcomeV1 | undefined> {
    const request = this.store.effectRequest(effect_id);
    if (request === undefined) return undefined;
    const adapter = this.adapters.byTarget(request.target_ref);
    if (adapter === undefined) return undefined;
    const admissions = this.store.admissionsByEffect(effect_id);
    const open = admissions.filter((a) => !this.#conclusive(a));
    if (open.length === 0) return undefined;

    const active = resolveActivePolicy(this.store, this.cas);
    const material = JSON.parse(Buffer.from(this.cas.get(request.material_ref)).toString("utf8")) as Record<string, unknown>;

    let last: EffectOutcomeV1 | undefined;
    for (const admission of open) {
      const priorUnknowns = this.store
        .outcomesByAdmissionDigest(admission.admission_digest.value)
        .filter((o) => o.result === "UNKNOWN" && o.observer_ref.endsWith(":reconciler")).length;
      if (priorUnknowns >= active.config.reconcile_max_attempts) {
        this.#sealExhausted(effect_id, admission);
        continue;
      }
      const result = await adapter.reconcile(effect_id, admission.dispatch_ordinal, request.target_ref, request.operation_kind, material, { admitted_at: admission.admitted_at });
      const observer = `${this.pep.pep_ref}:reconciler`;
      switch (result.kind) {
        case "COMMITTED":
          if (!adapter.receipt_binds(request.operation_kind, material, result.receipt_claim)) {
            this.ingress.sealIncident("RECEIPT_MATERIAL_MISMATCH", `reconcile receipt for ${effect_id} does not bind`, [
              { authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id },
            ]);
            last = this.pep.writeOutcome(request, admission, { kind: "UNKNOWN", unknown_reason: "RECEIPT_UNBOUND" }, observer);
            break;
          }
          last = this.pep.writeOutcome(
            request, admission,
            { kind: "COMMITTED", target_operation_ref: result.target_operation_ref, receipt_claim: result.receipt_claim },
            observer,
          );
          break;
        case "NO_EFFECT_CONFIRMED":
          last = this.pep.writeOutcome(request, admission, { kind: "NO_EFFECT_CONFIRMED", proof_claim: result.proof_claim }, observer);
          break;
        case "UNKNOWN":
          last = this.pep.writeOutcome(request, admission, { kind: "UNKNOWN", unknown_reason: result.unknown_reason }, observer);
          if (priorUnknowns + 1 >= active.config.reconcile_max_attempts) this.#sealExhausted(effect_id, admission);
          break;
      }
    }
    return last;
  }

  #sealExhausted(effect_id: string, admission: EffectAdmissionV1): void {
    const already = this.store
      .latestEvidenceOfKind("RECONCILE_EXHAUSTED", `cadp-store:k04|effect|${effect_id}`);
    if (already !== undefined) return;
    this.ingress.sealInternalEvidence({
      evidence_kind: "RECONCILE_EXHAUSTED",
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
      availability: "PRESENT",
      claim_schema: "cadp.reconcile-exhausted.v1",
      claim: { effect_id, admission_digest: admission.admission_digest.value, route: "HUMAN_EXCEPTION" },
      source_ref: this.pep.pep_ref,
      source_relation: "INDEPENDENT_OBSERVATION",
    });
  }
}
