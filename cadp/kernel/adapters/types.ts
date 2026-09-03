/** TargetAdapterV1 (TD §6.1). `describe()` is a declaration that must be proven by the adapter conformance suite. */

import type { TargetRef, SubjectBinding } from "../records.ts";

export type Idempotency = "NONE" | "NATIVE_KEY" | "NATIVE_PRECONDITION";
export type DispatchPrecondition = "NATIVE_CAS" | "PEP_READ_THEN_ACT" | "NONE";

export interface AdapterOperation {
  readonly operation_kind: string;
  readonly material_schema: string;
  readonly available: boolean;
  readonly idempotency: Idempotency;
  readonly idempotency_horizon_s?: number;
  readonly dispatch_precondition: DispatchPrecondition;
  readonly reconcile: "NONE" | "BY_OPERATION_REF" | "BY_QUERY_PREDICATE";
  readonly no_effect_proof_supported: boolean;
}

export interface TargetIdentityClaim {
  readonly target_ref: TargetRef;
  readonly claim: Record<string, unknown>;
}

export type DispatchResult =
  | { kind: "ACCEPTED"; target_operation_ref: string; receipt_claim: Record<string, unknown> }
  | { kind: "REJECTED_NO_EFFECT"; proof_claim: Record<string, unknown> }
  | { kind: "AMBIGUOUS"; raw_observation: string };

export type ReconcileResult =
  | { kind: "COMMITTED"; target_operation_ref: string; receipt_claim: Record<string, unknown> }
  | { kind: "NO_EFFECT_CONFIRMED"; proof_claim: Record<string, unknown> }
  | { kind: "UNKNOWN"; unknown_reason: string };

export interface RevisionRead {
  readonly revision_or_version?: string;
  readonly content_digest?: string;
  readonly availability: "PRESENT" | "UNKNOWN";
}

/** Thrown by dispatch preconditions and material verification; maps to pre-K6 refusals. */
export class MaterialIncomplete extends Error {}

export interface TargetAdapterV1 {
  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] };
  serialization_domain(material: Record<string, unknown>): string;
  prove_identity(): Promise<TargetIdentityClaim>;
  current_revision(subject: SubjectBinding): Promise<RevisionRead>;
  /**
   * Pre-K6 material completeness beyond CAS existence (TD §6.6) — e.g. GIT_PUSH bundle tip
   * must BE new_sha. Throws MaterialIncomplete.
   */
  verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void>;
  /**
   * PEP_READ_THEN_ACT pre-K6 precondition read (TD §4.6 item 1). Returns undefined when the
   * precondition holds; a string describes the observed drift (deterministic refusal).
   */
  dispatch_precondition_read(operation_kind: string, material: Record<string, unknown>): Promise<string | undefined>;
  dispatch(
    effect_id: string,
    dispatch_ordinal: number,
    target_ref: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
  ): Promise<DispatchResult>;
  reconcile(
    effect_id: string,
    dispatch_ordinal: number,
    target_ref: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
    context?: { admitted_at?: string },
  ): Promise<ReconcileResult>;
  /** Receipt binding rule (TD §6.4): at least one target-native receipt field is a function of the material. */
  receipt_binds(operation_kind: string, material: Record<string, unknown>, receipt_claim: Record<string, unknown>): boolean;
}

export interface AdapterRegistry {
  byTarget(target_ref: TargetRef): TargetAdapterV1 | undefined;
  all(): ReadonlyArray<TargetAdapterV1>;
}

export function makeAdapterRegistry(adapters: readonly TargetAdapterV1[]): AdapterRegistry {
  return {
    byTarget(target_ref: TargetRef) {
      return adapters.find((a) => {
        const d = a.describe();
        return d.authority_ref === target_ref.authority_ref && d.target_type === target_ref.target_type;
      });
    },
    all: () => adapters,
  };
}
