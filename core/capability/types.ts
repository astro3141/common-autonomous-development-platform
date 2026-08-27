/**
 * Capability model v1 contracts (TD §12.1–§12.7).
 *
 * Vocabularies come from `core/schemas/capability-vocabulary.ts` — the single source of truth
 * shared with the adapter boundary. Nothing here invents a capability, an assurance or a role.
 */

import type { CanonicalObject } from "../schemas/canonical-json.ts";
import {
  CAPABILITY_NAMES,
  ENFORCEMENT_ASSURANCES,
  type CapabilityName,
  type EnforcementAssurance,
} from "../schemas/capability-vocabulary.ts";

export { CAPABILITY_NAMES, ENFORCEMENT_ASSURANCES };
export type { CapabilityName, EnforcementAssurance };

export const BACKEND_MANIFEST_SCHEMA = "platform/backend-capability-manifest";
export const CAPABILITY_GRANT_SCHEMA = "platform/capability-grant";

/** TD §12.2a — the four component manifests of one backend selection. */
export type BackendKind = "RUNTIME" | "WORKFLOW" | "REPOSITORY" | "VERIFICATION";
export const BACKEND_KINDS: readonly BackendKind[] = [
  "RUNTIME",
  "WORKFLOW",
  "REPOSITORY",
  "VERIFICATION",
];

/** TD §12.5 — Platform authority role. Distinct from `role_profile_id`/`runtime_profile`. */
export type CoreExecutionRole = "SUPERVISOR" | "ACTOR" | "AUDITOR";
export const CORE_EXECUTION_ROLES: readonly CoreExecutionRole[] = [
  "SUPERVISOR",
  "ACTOR",
  "AUDITOR",
];

/** TD §12.2a — per-capability directional enforcement claim. */
export interface DirectionalEnforcement {
  readonly allow: EnforcementAssurance;
  readonly deny: EnforcementAssurance;
}

/** Common body of every component manifest. */
export interface BackendManifestBody {
  readonly backend_kind: BackendKind;
  readonly adapter_id: string;
  readonly adapter_version: string;
  /** Provenance reference admissible under I-TD7 (a producer contract, not a syntax check). */
  readonly backend_instance_id: string;
  /** Adapter-owned provenance. Opaque to Core and never a policy authority. */
  readonly features: CanonicalObject;
}

/** RUNTIME manifests carry the two additional required fields (TD §12.2a). */
export interface RuntimeManifestBody extends BackendManifestBody {
  readonly backend_kind: "RUNTIME";
  readonly receipt_supported: boolean;
  readonly capability_enforcement: Readonly<Record<CapabilityName, DirectionalEnforcement>>;
}

export const MANIFEST_COMMON_FIELDS: readonly string[] = [
  "backend_kind",
  "adapter_id",
  "adapter_version",
  "backend_instance_id",
  "features",
];

export const RUNTIME_ONLY_FIELDS: readonly string[] = ["receipt_supported", "capability_enforcement"];

/** A manifest that passed validation, together with the hash of its own envelope. */
export interface ValidatedManifest<Body extends BackendManifestBody = BackendManifestBody> {
  readonly body: Body;
  readonly hash: string;
}

/** TD §12.2a — exactly one manifest per kind. The set itself is never hashed. */
export interface BackendManifestSet {
  readonly runtime: ValidatedManifest<RuntimeManifestBody>;
  readonly workflow: ValidatedManifest<BackendManifestBody>;
  readonly repository: ValidatedManifest<BackendManifestBody>;
  readonly verification: ValidatedManifest<BackendManifestBody>;
}

/**
 * TD §12.7 — the capability-relevant projection of a prospective Task Contract.
 *
 * Not a durable artifact, not an envelope, not hashed, not a lifecycle state: a builder input
 * seam. In v1 its contents do **not** influence capability derivation — no path→capability
 * inference exists.
 */
export interface TaskContractCapabilityView {
  readonly repository_scope: {
    readonly allowed_paths: readonly string[];
    readonly forbidden_paths: readonly string[];
  };
}

export type RequestedCapabilities = Readonly<Record<CapabilityName, boolean>>;
export type CapabilityEnforcementMap = Readonly<Record<CapabilityName, EnforcementAssurance>>;

/** TD §7.1b — the requirement entry for one capability of one already-selected operation. */
export interface CapabilityRequirement {
  readonly accepted: readonly EnforcementAssurance[];
}

export type CapabilityRequirementMap = Readonly<
  Partial<Record<CapabilityName, CapabilityRequirement>>
>;

/** TD §12.5 — CapabilityGrant v1 body. `grant_hash` is the envelope hash, never a member. */
export interface CapabilityGrantV1Body {
  readonly grant_id: string;
  readonly role: CoreExecutionRole;
  readonly source_runtime_manifest_hash: string;
  readonly requested: RequestedCapabilities;
  readonly enforcement: CapabilityEnforcementMap;
}

export const GRANT_BODY_FIELDS: readonly string[] = [
  "grant_id",
  "role",
  "source_runtime_manifest_hash",
  "requested",
  "enforcement",
];
