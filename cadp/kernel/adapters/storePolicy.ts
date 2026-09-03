/**
 * Constitutional-store TargetAdapterV1 (TD §6.4 `POLICY_ACTIVATE`): publication and
 * activation are ONE dispatch in ONE transaction — publish-if-absent `policy_ref` plus the
 * activation-CAS predecessor+1 insert. `UNIQUE(expected_prev_seq)` + `CHECK` reject any stale
 * base at the target itself (NATIVE_CAS), so a superseded constitution can never be
 * reinstated by a late dispatch (C22/C22b).
 */

import { Cas } from "../cas.ts";
import { sha256Hex } from "../canonical.ts";
import { Ingress } from "../ingress.ts";
import { manifestOf, payloadDigestOf } from "../policyBundle.ts";
import type { SubjectBinding, TargetRef } from "../records.ts";
import { ConstitutionalStore, UniqueViolation } from "../store.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";

interface ActivateMaterial {
  proposed_policy_ref: { policy_id: string; revision: number; content_digest: { value: string }; issuer_ref: string };
  bundle_cas_ref: string;
  expected_active_policy_ref: { policy_id: string; revision: number; content_digest: { value: string }; seq: number };
}

export class StorePolicyAdapter implements TargetAdapterV1 {
  readonly store: ConstitutionalStore;
  readonly cas: Cas;
  readonly ingress: Ingress;
  readonly clock: () => number;

  constructor(store: ConstitutionalStore, cas: Cas, ingress: Ingress, clock: () => number = Date.now) {
    this.store = store;
    this.cas = cas;
    this.ingress = ingress;
    this.clock = clock;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: "POLICY_ACTIVATION",
      authority_ref: "cadp-store:k04",
      operations: [
        {
          operation_kind: "POLICY_ACTIVATE",
          material_schema: "cadp.policy-activate.v1",
          available: true,
          idempotency: "NATIVE_PRECONDITION",
          dispatch_precondition: "NATIVE_CAS",
          reconcile: "BY_QUERY_PREDICATE",
          no_effect_proof_supported: true,
        },
      ],
    };
  }

  serialization_domain(): string {
    return "policy_activation";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    // Self-identification: the activation log the credentialed connection actually reaches.
    const active = this.store.activeActivation();
    return {
      target_ref: { authority_ref: "cadp-store:k04", target_type: "POLICY_ACTIVATION", target_id: "k04" },
      claim: { schema: "k04", active_seq: active?.seq ?? 0 },
    };
  }

  async current_revision(_subject: SubjectBinding): Promise<RevisionRead> {
    return { availability: "UNKNOWN" };
  }

  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind !== "POLICY_ACTIVATE") return;
    const m = material as unknown as ActivateMaterial;
    if (typeof m.bundle_cas_ref !== "string") throw new MaterialIncomplete("bundle_cas_ref missing");
    this.cas.get(m.bundle_cas_ref); // existence + digest (C30)
  }

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    _operation: string,
    material: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const m = material as unknown as ActivateMaterial;
    const bundleBytes = this.cas.get(m.bundle_cas_ref);
    const contentDigest = sha256Hex(bundleBytes);
    const payload = payloadDigestOf(bundleBytes);
    const manifest = manifestOf(bundleBytes);
    try {
      const receipt = this.store.withImmediate(() => {
        // (1) publish-if-absent; a differing existing row aborts as REJECTED_NO_EFFECT + incident.
        const existing = this.store.policyRef(m.proposed_policy_ref.policy_id, m.proposed_policy_ref.revision);
        if (existing === undefined) {
          this.store.insertPolicyRef({
            policy_id: m.proposed_policy_ref.policy_id,
            revision: m.proposed_policy_ref.revision,
            content_digest: contentDigest,
            issuer_ref: m.proposed_policy_ref.issuer_ref,
            bundle_cas_key: m.bundle_cas_ref,
            payload_digest: payload.value,
            manifest_revision: manifest?.revision ?? "",
          });
        } else if (existing.content_digest !== m.proposed_policy_ref.content_digest.value) {
          throw new PublishConflict();
        }
        // (2) activation CAS: predecessor+1, explicit seq.
        const current = this.store.activeActivation();
        if (current === undefined || current.seq !== m.expected_active_policy_ref.seq) {
          throw new StaleBase(current?.seq ?? 0);
        }
        const seq = m.expected_active_policy_ref.seq + 1;
        this.store.insertActivation({
          seq,
          expected_prev_seq: m.expected_active_policy_ref.seq,
          policy_id: m.proposed_policy_ref.policy_id,
          revision: m.proposed_policy_ref.revision,
          content_digest: contentDigest,
          activated_by_ref: this.ingress.pep_ref,
          activation_evidence_id: _effect_id,
          activated_at: new Date(this.clock()).toISOString(),
        });
        return { seq, content_digest: contentDigest, policy_id: m.proposed_policy_ref.policy_id, revision: m.proposed_policy_ref.revision };
      });
      return { kind: "ACCEPTED", target_operation_ref: `policy_activation:${receipt.seq}`, receipt_claim: receipt };
    } catch (error) {
      if (error instanceof PublishConflict) {
        this.ingress.sealIncident("REQUEST_DIGEST_CONFLICT", "POLICY_REF_CONFLICT: (policy_id, revision) already published with different bytes", [
          { authority_ref: "cadp-store:k04", namespace: "policy", object_id: `${m.proposed_policy_ref.policy_id}@${m.proposed_policy_ref.revision}` },
        ]);
        return { kind: "REJECTED_NO_EFFECT", proof_claim: { reason: "POLICY_REF_CONFLICT", expected_seq: m.expected_active_policy_ref.seq } };
      }
      if (error instanceof StaleBase || error instanceof UniqueViolation) {
        const current = this.store.activeActivation();
        return {
          kind: "REJECTED_NO_EFFECT",
          proof_claim: {
            reason: "ACTIVATION_BASE_STALE",
            expected_seq: m.expected_active_policy_ref.seq,
            observed_seq: current?.seq ?? 0,
            content_digest: contentDigest,
          },
        };
      }
      return { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
  }

  async reconcile(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    _operation: string,
    material: Record<string, unknown>,
  ): Promise<ReconcileResult> {
    const m = material as unknown as ActivateMaterial;
    const successorSeq = m.expected_active_policy_ref.seq + 1;
    const successor = this.store.activationBySeq(successorSeq);
    if (
      successor !== undefined &&
      successor.policy_id === m.proposed_policy_ref.policy_id &&
      successor.revision === m.proposed_policy_ref.revision &&
      successor.content_digest === m.proposed_policy_ref.content_digest.value
    ) {
      return {
        kind: "COMMITTED",
        target_operation_ref: `policy_activation:${successorSeq}`,
        receipt_claim: { seq: successorSeq, content_digest: successor.content_digest, policy_id: successor.policy_id, revision: successor.revision },
      };
    }
    const current = this.store.activeActivation();
    if (current !== undefined && (current.seq > m.expected_active_policy_ref.seq && (successor === undefined || successor.content_digest !== m.proposed_policy_ref.content_digest.value))) {
      // A different successor landed: this activation can never insert (UNIQUE expected_prev_seq).
      return {
        kind: "NO_EFFECT_CONFIRMED",
        proof_claim: { reason: "DIFFERENT_SUCCESSOR", observed_seq: current.seq, successor_digest: successor?.content_digest ?? null },
      };
    }
    return { kind: "UNKNOWN", unknown_reason: "no successor row and base still active — activation state indeterminate" };
  }

  receipt_binds(_operation: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    const m = material as unknown as ActivateMaterial;
    return receipt["content_digest"] === m.proposed_policy_ref.content_digest.value;
  }
}

class PublishConflict extends Error {}
class StaleBase extends Error {
  readonly observed: number;
  constructor(observed: number) {
    super(`stale activation base: observed seq ${observed}`);
    this.observed = observed;
  }
}
