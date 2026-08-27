/**
 * `DriftObservationV1` — the typed read model the §11 evaluator judges (TD §11.4, M1-11).
 *
 * The same boundary the Decision Validator uses: an authoritative owner observes, a pure function
 * decides. So this carries **already-observed** facts and nothing else — no adapter, no store, no
 * callback, no `Record<string, unknown>`. Every target is named, and every current value states
 * which of three things happened to it:
 *
 *   `OBSERVED`    the authoritative read succeeded and produced a value
 *   `ABSENT`      the read succeeded and the selected entry is gone — a fact, and therefore drift
 *   `UNAVAILABLE` the read could not be performed — not "no drift", and never guessed past
 *
 * The frozen side is entirely durable Attempt-bound state. In particular the capability basis is
 * the Attempt-frozen Auditor CapabilityGrant: no historical Runtime Manifest body is stored
 * anywhere, and reading a fresh one would let a genuine Backend change be consumed here instead
 * of by §12.6/§22.2, which own it.
 */

import type { CapabilityEnforcementMap, RequestedCapabilities } from "../capability/types.ts";
import type { ContractSourceRef } from "../contract/types.ts";
import type {
  AdapterConfigured,
  CapabilityRequirements,
  CompiledComponentRef,
  DriftRule,
  DriftTarget,
} from "../profile/types.ts";

/**
 * TD §11 — the transitions at which drift is evaluated.
 *
 * M1-14 adds the MVP 1 human-merge boundary. `canonical_head: MERGE_ONLY` means "check at the
 * transition that authorizes the merge", and MVP 1 never enters `MERGING`: the human is authorized
 * at `READY_TO_MERGE → APPROVED_FOR_MANUAL_MERGE` and merges outside the Platform. Enforcing only
 * at the automatic boundary would mean `MERGE_ONLY` never fired in MVP 1 at all.
 */
export type StageBoundary =
  | "IMPLEMENTING_TO_VERIFYING"
  | "VERIFYING_TO_AUDITING"
  | "AUDITING_TO_READY_TO_MERGE"
  | "READY_TO_MERGE_TO_APPROVED_FOR_MANUAL_MERGE"
  | "READY_TO_MERGE_TO_MERGING";

export type Observation<Value> =
  | { readonly status: "OBSERVED"; readonly value: Value }
  | { readonly status: "ABSENT" }
  | { readonly status: "UNAVAILABLE" };

export const observed = <Value>(value: Value): Observation<Value> => ({
  status: "OBSERVED",
  value,
});
export const ABSENT: Observation<never> = { status: "ABSENT" };
export const UNAVAILABLE: Observation<never> = { status: "UNAVAILABLE" };

/** The frozen TaskDefinition identity. `body_copy` plays no part in drift. */
export interface FrozenTaskRef {
  readonly ref: string;
  readonly version: string;
  readonly definition_hash: string;
}

export type TaskDefinitionFacts = Omit<FrozenTaskRef, "ref">;

/**
 * TD §11.4 — the Attempt-frozen Auditor capability basis.
 *
 * `enforcement[c]` is the assurance the Platform actually selected for `requested[c]` when the
 * grant was issued, so it *is* the authorization condition, not an approximation of it.
 * `source_runtime_manifest_hash` is provenance and binding identity only: nothing ever resolves a
 * manifest body from it.
 */
export interface FrozenAuditorCapability {
  readonly source_runtime_manifest_hash: string;
  readonly requested: RequestedCapabilities;
  readonly enforcement: CapabilityEnforcementMap;
}

export interface DriftFrozenState {
  readonly project_profile: CompiledComponentRef;
  readonly execution_policy: CompiledComponentRef;
  readonly task: FrozenTaskRef;
  readonly contract_sources: readonly ContractSourceRef[];
  readonly base_head: string;
  readonly verification_profile: AdapterConfigured;
  readonly capability_requirements: CapabilityRequirements;
  readonly auditor_capability: FrozenAuditorCapability;
}

/**
 * The three `REEVALUATE_AT_BOUNDARY` facts for `VERIFYING → AUDITING`, derived from the *current*
 * Profile/Policy bodies and the frozen grant. They answer "may the remaining Auditor stage still
 * run?" — never "what would the Auditor run as now", which would be an expansion (TD §11.4).
 */
export interface AuditorStageFacts {
  /** A — the current pipeline for this contract still contains `AUDITOR`. */
  readonly has_auditor: boolean;
  /** B — its `auditor_profile` exists and is a declared role. */
  readonly auditor_profile_declared: boolean;
  /** C — the current requirement still accepts the frozen grant's enforcement. */
  readonly requirement_met: boolean;
}

export interface DriftCurrentState {
  readonly project_profile: Observation<CompiledComponentRef>;
  readonly execution_policy: Observation<CompiledComponentRef>;
  readonly task_definition: Observation<TaskDefinitionFacts>;
  readonly contract_sources: Observation<readonly ContractSourceRef[]>;
  readonly canonical_head: Observation<string>;
  readonly verification_profile: Observation<AdapterConfigured>;
  readonly capability_requirements: Observation<CapabilityRequirements>;
  readonly auditor_stage: Observation<AuditorStageFacts>;
}

export interface DriftObservationV1 {
  readonly boundary: StageBoundary;
  readonly frozen: DriftFrozenState;
  readonly current: DriftCurrentState;
  /**
   * TD §11.4 / §11.3 — the **Attempt-bound frozen** `contract_drift_policy`. The current Execution
   * Policy is one of the things being observed; it does not also get to redefine how this Attempt
   * reacts to observing it.
   */
  readonly policy: Readonly<Record<DriftTarget, DriftRule>>;
}

/** TD §11.4 — the evaluator changes no lifecycle; it returns exactly one of these. */
export type DriftOutcome =
  | { readonly kind: "CONTINUE" }
  | { readonly kind: "HOLD"; readonly target: DriftTarget }
  | { readonly kind: "INVALIDATE"; readonly target: DriftTarget }
  | { readonly kind: "UNAVAILABLE"; readonly target: DriftTarget };
