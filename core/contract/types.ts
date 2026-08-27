/**
 * Immutable Task Contract v1 contracts (TD §10.1, M0-21).
 *
 * The contract hash is the envelope hash and is deliberately absent from the body.
 */

import type { TaskDefinitionBodyV1 } from "../tasksource/types.ts";
import type { RepositoryScopeV1 } from "../profile/types.ts";
export type { RepositoryScopeV1 };

export const TASK_CONTRACT_SCHEMA = "platform/task-contract";

/** TD §10.2 (M0-22) — caller supplies pre-read bytes; `core/contract` never touches a filesystem. */
export interface ContractSourceInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** `content_hash` is both the integrity identity and the blob address — there is no `storage_ref`. */
export interface ContractSourceRef {
  readonly path: string;
  readonly content_hash: string;
}

/**
 * TD §11.4 (M1-11) — the current bytes of one declared Contract Source.
 *
 * `ABSENT` is a *successful* read of a source that is no longer there, which is a fact about the
 * world and therefore drift. An implementation that cannot perform the read at all throws instead;
 * the two must never collapse into one another.
 */
export type ContractSourceRead =
  | { readonly kind: "PRESENT"; readonly bytes: Uint8Array }
  | { readonly kind: "ABSENT" };

/**
 * Raw bytes only: comparison is the §10.2 raw SHA-256, so no normalization, decoding or
 * modification-time shortcut may take place behind this seam.
 */
export interface ContractSourceReader {
  read_contract_source(path: string): ContractSourceRead;
}

export interface TaskContractTaskV1 {
  readonly ref: string;
  readonly version: string;
  readonly definition_hash: string;
  /** Normalized TaskDefinition body, never raw document text. */
  readonly body_copy: TaskDefinitionBodyV1;
}

export interface BackendRequirementsProvenanceV1 {
  readonly runtime_adapter_version: string;
  readonly backend_instance_id: string;
}

export interface BackendRequirementsV1 {
  readonly runtime_manifest_hash: string;
  readonly workflow_manifest_hash: string;
  readonly repository_manifest_hash: string;
  readonly verification_manifest_hash: string;
  readonly provenance: BackendRequirementsProvenanceV1;
}

export interface CapabilityGrantRefV1 {
  readonly grant_id: string;
  readonly grant_hash: string;
}

/** Only actor and auditor — a SUPERVISOR grant is never part of a Task Contract (§10.1). */
export interface TaskContractGrantsV1 {
  readonly actor: CapabilityGrantRefV1;
  readonly auditor: CapabilityGrantRefV1;
}

/** TD §10.1 — exactly twelve top-level fields, all required. */
export interface TaskContractV1Body {
  readonly snapshot_id: string;
  readonly task: TaskContractTaskV1;
  readonly attempt: number;
  readonly base_head: string;
  readonly compiled_profile_hash: string;
  readonly contract_sources: readonly ContractSourceRef[];
  readonly pipeline_id: string;
  readonly verification_profile: string;
  readonly repository_scope: RepositoryScopeV1;
  readonly backend_requirements: BackendRequirementsV1;
  readonly capability_grants: TaskContractGrantsV1;
  /** Immutable copy of `task.body_copy.acceptance_notes` — no independent authority (§10.1). */
  readonly completion_conditions: readonly string[];
}

export const TASK_CONTRACT_BODY_FIELDS: readonly string[] = [
  "snapshot_id",
  "task",
  "attempt",
  "base_head",
  "compiled_profile_hash",
  "contract_sources",
  "pipeline_id",
  "verification_profile",
  "repository_scope",
  "backend_requirements",
  "capability_grants",
  "completion_conditions",
];
