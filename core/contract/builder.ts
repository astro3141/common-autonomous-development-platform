/**
 * Task Contract build (TD §12.7 finalization order, §10.1).
 *
 * Deterministic assembly of already-observed authoritative inputs: no clock, no randomness, no
 * filesystem, no adapter call, no durable row. The result is an in-memory bundle — persistence of
 * `task_contract_snapshot` / `capability_grant` belongs to the domain-store batch (M0-23).
 *
 * Identity values (`snapshot_id`, both `grant_id`s, `attempt`) are caller-supplied, preserving the
 * Batch 5 rule that the Broker never allocates identity.
 */

import { issueCapabilityGrant, type CapabilityGrantResult } from "../capability/broker.ts";
import { hashManifest } from "../capability/validate-manifest.ts";
import type { BackendManifestSet, TaskContractCapabilityView } from "../capability/types.ts";
import type { CompileResult } from "../profile/compiler.ts";
import type { TaskDefinition } from "../tasksource/types.ts";
import type { BlobStore } from "../store/blob-store.ts";
import { captureContractSources } from "./contract-source.ts";
import { contractError } from "./errors.ts";
import { sealTaskContract, type TaskContractResult } from "./task-contract.ts";
import type { ContractSourceInput, ContractSourceRef, RepositoryScopeV1, SubflowBindingV1 } from "./types.ts";

export interface TaskContractBuildInput {
  readonly snapshot_id: string;
  /** Already normalized through the §8.1a boundary. */
  readonly task: TaskDefinition;
  readonly attempt: number;
  /** Repository fact observed by the RepositoryAdapter; this module never queries a repository. */
  readonly base_head: string;
  /** The Batch 4 result — its own hash is used, so no caller-supplied profile hash is trusted. */
  readonly compiled_profile: CompileResult;
  readonly contract_sources: readonly ContractSourceInput[];
  readonly pipeline_id: string;
  readonly verification_profile: string;
  readonly repository_scope: RepositoryScopeV1;
  /** Validated Batch 5 set; its component hashes and runtime provenance are used directly. */
  readonly manifests: BackendManifestSet;
  readonly actor_grant_id: string;
  readonly auditor_grant_id: string;
  readonly blobs: BlobStore;
  /**
   * §10.1a — present exactly for a subflow child. The builder freezes this already-committed
   * relation verbatim; it never selects or derives a parent.
   */
  readonly subflow_binding?: SubflowBindingV1;
}

export interface TaskContractBuildResult {
  readonly actor_grant: CapabilityGrantResult;
  readonly auditor_grant: CapabilityGrantResult;
  readonly contract: TaskContractResult;
  readonly contract_sources: readonly ContractSourceRef[];
}

export function buildTaskContract(input: TaskContractBuildInput): TaskContractBuildResult {
  const profileBody = input.compiled_profile.body;

  // §10.1a — a subflow child's frozen pipeline must terminate in RESUME_PARENT: its completion is
  // the parent's resumption predicate (§19.5.2), never a canonical merge.
  if (input.subflow_binding !== undefined) {
    const steps = profileBody.effective.project.pipelines[input.pipeline_id]?.steps ?? [];
    if (steps.length === 0 || steps[steps.length - 1] !== "RESUME_PARENT") {
      throw contractError("/pipeline_id", "a subflow child pipeline must terminate in RESUME_PARENT");
    }
  }

  // Declared order is the authority; the caller's input order never is (§10.2).
  const declaredPaths = profileBody.effective.project.contract_sources.map((entry) => entry.path);
  const contractSources = captureContractSources(declaredPaths, input.contract_sources, input.blobs);

  const scope = repositoryScope(input.repository_scope);

  // §12.7 seam: the view is constructed before any grant is issued and passed as a required input.
  const view: TaskContractCapabilityView = { repository_scope: scope };

  const actor_grant = issueCapabilityGrant({
    grant_id: input.actor_grant_id,
    role: "ACTOR",
    effective_policy: profileBody.effective.policy,
    runtime_manifest: input.manifests.runtime,
    task_contract_capability_view: view,
  });
  const auditor_grant = issueCapabilityGrant({
    grant_id: input.auditor_grant_id,
    role: "AUDITOR",
    effective_policy: profileBody.effective.policy,
    runtime_manifest: input.manifests.runtime,
    task_contract_capability_view: view,
  });

  const runtimeBody = input.manifests.runtime.body;

  const contract = sealTaskContract({
    snapshot_id: input.snapshot_id,
    task: {
      ref: input.task.task_ref,
      version: input.task.version,
      definition_hash: input.task.definition_hash,
      body_copy: input.task.body,
    },
    attempt: input.attempt,
    base_head: input.base_head,
    compiled_profile_hash: input.compiled_profile.compiled_hash,
    contract_sources: contractSources,
    pipeline_id: input.pipeline_id,
    verification_profile: input.verification_profile,
    repository_scope: scope,
    backend_requirements: {
      // Recomputed from the validated bodies so no forged hash can be bound.
      runtime_manifest_hash: hashManifest(runtimeBody),
      workflow_manifest_hash: hashManifest(input.manifests.workflow.body),
      repository_manifest_hash: hashManifest(input.manifests.repository.body),
      verification_manifest_hash: hashManifest(input.manifests.verification.body),
      provenance: {
        runtime_adapter_version: runtimeBody.adapter_version,
        backend_instance_id: runtimeBody.backend_instance_id,
      },
    },
    ...(input.subflow_binding === undefined ? {} : { subflow_binding: input.subflow_binding }),
    capability_grants: {
      actor: { grant_id: actor_grant.body.grant_id, grant_hash: actor_grant.grant_hash },
      auditor: { grant_id: auditor_grant.body.grant_id, grant_hash: auditor_grant.grant_hash },
    },
    // Frozen from the task definition — there is no completion-condition input on this API.
    completion_conditions: [...input.task.body.acceptance_notes],
  });

  return { actor_grant, auditor_grant, contract, contract_sources: contractSources };
}

function repositoryScope(scope: RepositoryScopeV1): RepositoryScopeV1 {
  if (typeof scope !== "object" || scope === null) {
    throw contractError("/repository_scope", "expected an object");
  }
  // Paths are carried verbatim: no normalization, glob handling, dedup or sorting (§10.1).
  return {
    allowed_paths: [...scope.allowed_paths],
    forbidden_paths: [...scope.forbidden_paths],
  };
}
