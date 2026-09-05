/**
 * Improvement-transition seal TargetAdapterV1 (#117 §5.1 — a TD §6.4 reference adapter row).
 *
 * `FINDING_SEAL` is the ONE governed operation that can produce a Finding with clearing or
 * delegation power. Its "external target" is the deployment's own evidence store, reached
 * exclusively through the landed `submit_evidence` API authenticated as the dedicated workload
 * identity `governed:reclassification`, which no worker, workflow or other adapter holds
 * (precedent: the constitutional-store adapter already targets the deployment's own store).
 *
 * `NATIVE_KEY` idempotency keys on the landed §6.2 value `cadp-v04:<effect_id>`, carried both as
 * the material's ingress-enforced `idempotency_key` (hence covered by `material_digest`) and as
 * the dispatch `source_ref`; §5.3 rule (a) makes that true at the target. Predecessor-edge
 * uniqueness (invariant U) is a SEPARATE store constraint on the sealed draft's own `supersedes`
 * singleton and is deliberately not the idempotency key.
 *
 * `dispatch_precondition: NONE` — the material names no mutable target subject: the operation
 * appends exactly one new immutable envelope (the landed RECORD_WRITE classification), so
 * recheck #14 is vacuous as landed and no TARGET_IMMUTABILITY_ATTESTATION is required.
 */

import { jcsDigest } from "../canonical.ts";
import { Ingress, IngressRejection } from "../ingress.ts";
import type { Principal } from "../ingress.ts";
import type { SubjectBinding, TargetRef } from "../records.ts";
import { ConstitutionalStore } from "../store.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";
import { validateFindingClaim } from "../../product/improvement/contracts.ts";
import {
  FINDING_CLAIM_SCHEMA, FINDING_SEAL_AUTHORITY_REF, FINDING_SEAL_OPERATION,
  FINDING_SEAL_SERIALIZATION_DOMAIN, FINDING_SEAL_TARGET_TYPE, GOVERNED_PRINCIPAL,
  GOVERNED_PRODUCER_REF, GOVERNED_TRANSITION_MATERIAL_SCHEMA, draftDigest, governedEdgeKey,
  validateGovernedTransitionMaterial,
} from "../../product/improvement/transition.ts";
import type { GovernedTransitionMaterialV1 } from "../../product/improvement/transition.ts";

export const FINDING_SEAL_TARGET_ID = "k04" as const;

export function findingSealTargetRef(): TargetRef {
  return { authority_ref: FINDING_SEAL_AUTHORITY_REF, target_type: FINDING_SEAL_TARGET_TYPE, target_id: FINDING_SEAL_TARGET_ID };
}

/** E's mandatory work bindings (§5.1): the predecessor's evidence binding + exactly one work run. */
export function findingSealWorkBindings(predecessor_evidence_id: string, work_run_ref: string): SubjectBinding[] {
  return [
    { authority_ref: "cadp-store:k04", namespace: "evidence", object_id: predecessor_evidence_id },
    { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: work_run_ref },
  ];
}

export class FindingSealAdapter implements TargetAdapterV1 {
  readonly ingress: Ingress;
  readonly store: ConstitutionalStore;
  /** The governed workload credential — held by this adapter inside the PEP only (FC5). */
  readonly #principal: Principal;

  constructor(ingress: Ingress, store: ConstitutionalStore, principal: Principal = { principal: GOVERNED_PRINCIPAL }) {
    this.ingress = ingress;
    this.store = store;
    this.#principal = principal;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: FINDING_SEAL_TARGET_TYPE,
      authority_ref: FINDING_SEAL_AUTHORITY_REF,
      operations: [
        {
          operation_kind: FINDING_SEAL_OPERATION,
          material_schema: GOVERNED_TRANSITION_MATERIAL_SCHEMA,
          available: true,
          idempotency: "NATIVE_KEY",
          dispatch_precondition: "NONE",
          reconcile: "BY_QUERY_PREDICATE",
          no_effect_proof_supported: true,
        },
      ],
    };
  }

  /**
   * Not needed for write correctness (both §5.3 keys dedup inside the store transaction), but it
   * makes the reconcile-time NO_EFFECT read race-free: no dispatch of this domain can be in
   * flight while the read runs (§4.6 item 3).
   */
  serialization_domain(): string {
    return FINDING_SEAL_SERIALIZATION_DOMAIN;
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return {
      target_ref: findingSealTargetRef(),
      claim: { schema: "k04", target_id: FINDING_SEAL_TARGET_ID, governed_producer_ref: GOVERNED_PRODUCER_REF },
    };
  }

  async current_revision(_subject: SubjectBinding): Promise<RevisionRead> {
    return { availability: "UNKNOWN" };
  }

  /**
   * Pre-dispatch product-contract conformance (§4 rule 3, §5.1): the adapter refuses a material
   * or a draft the product contract rejects — a `MATERIAL_INCOMPLETE`-class refusal that never
   * reaches the target. This is defence-in-depth to the admission predicates, not the authority.
   */
  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind !== FINDING_SEAL_OPERATION) return;
    const shape = validateGovernedTransitionMaterial(material);
    if (!shape.ok) throw new MaterialIncomplete(`governed-transition material invalid: ${shape.errors.join("; ")}`);
    const m = material as unknown as GovernedTransitionMaterialV1;
    const claim = validateFindingClaim(m.descendant_draft.claim, m.descendant_draft.subject_bindings);
    if (!claim.ok) throw new MaterialIncomplete(`descendant draft invalid: ${claim.errors.join("; ")}`);
  }

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(
    effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
  ): Promise<DispatchResult> {
    if (operation_kind !== FINDING_SEAL_OPERATION) return { kind: "AMBIGUOUS", raw_observation: `unknown operation ${operation_kind}` };
    const m = material as unknown as GovernedTransitionMaterialV1;
    const source_ref = `cadp-v04:${effect_id}`;
    // FC18(b): a dispatch whose source_ref would not be the material's effect-bound replay key is
    // refused before send — the target must never see a key the sealed material does not carry.
    if (m.idempotency_key !== source_ref) {
      return { kind: "REJECTED_NO_EFFECT", proof_claim: { reason: "source_ref_mismatch", declared: m.idempotency_key, required: source_ref } };
    }
    const draft = m.descendant_draft;
    try {
      const envelope = this.ingress.submitEvidence(
        {
          evidence_kind: "IMPROVEMENT_FINDING",
          subject_bindings: draft.subject_bindings,
          availability: "PRESENT",
          claim_schema: FINDING_CLAIM_SCHEMA,
          claim: draft.claim,
          producer_ref: GOVERNED_PRODUCER_REF,
          source_ref,
          source_relation: "SELF_REPORT",
        },
        this.#principal,
      );
      return {
        kind: "ACCEPTED",
        target_operation_ref: `evidence:${envelope.evidence_id}`,
        receipt_claim: {
          evidence_id: envelope.evidence_id,
          envelope_digest: envelope.envelope_digest.value,
          source_ref,
          // A target-native field that is a function of the material (§6.4 receipt binding rule).
          draft_digest: jcsDigest({
            evidence_kind: envelope.evidence_kind,
            subject_bindings: envelope.subject_bindings,
            claim: envelope.claim,
          }).value,
        },
      };
    } catch (error) {
      if (error instanceof IngressRejection && error.reason === "GOVERNED_SEAL_CONFLICT") {
        // The edge is permanently held by a different governed transition: terminal, and the
        // §5.4 incident + scope hold are already sealed by the ingress.
        return { kind: "REJECTED_NO_EFFECT", proof_claim: { reason: "governed_seal_conflict", detail: error.message } };
      }
      if (error instanceof IngressRejection && error.reason === "GOVERNED_DRAFT_SHAPE_INVALID") {
        return { kind: "REJECTED_NO_EFFECT", proof_claim: { reason: "governed_draft_shape_invalid", detail: error.message } };
      }
      return { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The authoritative primary edge read (§5.1). Logical commitment is convergence to THE governed
   * edge, so the edge predicate — not the effect key — is what is read: a byte-identical
   * restatement admitted as a second effect converges to the same single envelope and is
   * COMMITTED with the same receipt.
   */
  async reconcile(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
  ): Promise<ReconcileResult> {
    if (operation_kind !== FINDING_SEAL_OPERATION) return { kind: "UNKNOWN", unknown_reason: `unknown operation ${operation_kind}` };
    const m = material as unknown as GovernedTransitionMaterialV1;
    const edge = governedEdgeKey(m.descendant_draft.claim);
    if (edge === undefined) {
      return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { reason: "governed_draft_shape_invalid", read_authority: "primary" } };
    }
    const held = this.store.evidenceByGovernedEdge(GOVERNED_PRODUCER_REF, edge.evidence_id, edge.envelope_digest);
    if (held === undefined) {
      // No governed edge for F exists at all, so this effect produced nothing.
      return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { reason: "no_governed_edge", edge_evidence_id: edge.evidence_id, read_authority: "primary" } };
    }
    const heldDigest = jcsDigest({ evidence_kind: held.evidence_kind, subject_bindings: held.subject_bindings, claim: held.claim }).value;
    if (heldDigest !== draftDigest(m.descendant_draft)) {
      // The edge is permanently held by a DIFFERENT governed transition: terminal, never commits.
      return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { reason: "governed_seal_conflict", holder_evidence_id: held.evidence_id, read_authority: "primary" } };
    }
    return {
      kind: "COMMITTED",
      target_operation_ref: `evidence:${held.evidence_id}`,
      receipt_claim: {
        evidence_id: held.evidence_id,
        envelope_digest: held.envelope_digest.value,
        source_ref: held.source_ref,
        draft_digest: heldDigest,
      },
    };
  }

  receipt_binds(operation_kind: string, material: Record<string, unknown>, receipt_claim: Record<string, unknown>): boolean {
    if (operation_kind !== FINDING_SEAL_OPERATION) return false;
    const m = material as unknown as GovernedTransitionMaterialV1;
    return receipt_claim["draft_digest"] === draftDigest(m.descendant_draft);
  }
}
