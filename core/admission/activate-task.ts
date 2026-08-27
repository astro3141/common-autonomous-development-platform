/**
 * Task Contract activation — `SELECTED → ACTIVE` + `Attempt READY` (TD §12.7, §19.3, §19.3a, M1-7).
 *
 * This is the last Platform-local step before anything external happens. It turns a selection into
 * an immutable execution contract, and its whole discipline is one sentence:
 *
 *     a selection accepted against X must never be executed against Y.
 *
 * So the first thing it does is re-read the two authorities it does not own — the TaskDefinition
 * and the canonical head — and compare them to the `SelectionBindingV1` the admission recorded.
 * Only if all three facts still agree does anything get built. A disagreement is not a failure of
 * the contract build: it means the decision itself is stale, and the task goes to
 * `HELD(SELECTION_STALE)` with **zero** artifacts written (§19.3a) so a fresh Supervisor decision
 * can be made about the world as it now is.
 *
 * Everything after the gate follows §12.7's finalization order, and nothing here touches a
 * Runtime, a Workflow, a workspace or a merge: activation ends with an Attempt in `READY`.
 */

import { buildTaskContract, type TaskContractBuildResult } from "../contract/builder.ts";
import type { ContractSourceInput } from "../contract/types.ts";
import { evaluateCapabilityRequirements } from "../capability/compatibility.ts";
import { deriveRequestedCapabilities } from "../capability/derive.ts";
import { validateManifestSet } from "../capability/manifest-set.ts";
import type { BackendManifestSet, CoreExecutionRole } from "../capability/types.ts";
import {
  ACTOR_EXECUTION_OPERATION,
  AUDITOR_EXECUTION_OPERATION,
} from "../decision/types.ts";
import type { CompiledProfileV1Body, RepositoryScopeV1 } from "../profile/types.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { attemptKey as buildAttemptKey } from "../schemas/identifiers.ts";
import type { SelectionBindingV1, TaskRow } from "../store/domain-types.ts";
import {
  commitBackendIncompatible,
  commitContractActivation,
  commitContractBuildFailure,
  commitSelectionStale,
} from "../statemachine/transition-commit.ts";
import { normalizeTaskDefinition } from "../tasksource/task-definition.ts";
import type { TaskDefinition } from "../tasksource/types.ts";
import { AdmissionError } from "./errors.ts";
import type { DecisionAuthorities } from "./fact-assembly.ts";

export interface ActivateTaskCommand {
  readonly task_key: string;
  /** Caller-allocated ULIDs; Core allocates no identity (TD §12.5, §10.1). */
  readonly snapshot_id: string;
  readonly actor_grant_id: string;
  readonly auditor_grant_id: string;
  /**
   * TD §10.2 — pre-read raw bytes. `core/contract` never touches a filesystem, so the caller reads
   * the files the Project Profile declared and hands the bytes over verbatim.
   */
  readonly contract_sources: readonly ContractSourceInput[];
}

export type ActivationOutcome =
  | { readonly kind: "ACTIVATED"; readonly attempt_key: string; readonly transition_seq: number }
  | { readonly kind: "SELECTION_STALE"; readonly mismatch: SelectionMismatch }
  | { readonly kind: "BACKEND_INCOMPATIBLE"; readonly detail: string };

/** Generic, journal-safe description of why a contract could not be built. */
function describeBuildFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Which comparison failed, in generic terms admissible under I-TD7 (§19.3a). */
export interface SelectionMismatch {
  readonly failed: "task_version" | "task_definition_hash" | "base_head";
  readonly bound: string;
  readonly fresh: string;
}

/**
 * Activates one selected task.
 *
 * Returns rather than throws for the two outcomes the lifecycle defines — a stale selection and an
 * incompatible Backend — because both are ordinary durable states, not operational failures. A
 * genuine build failure (a missing contract source, a malformed input) propagates.
 */
export function activateSelectedTask(
  authorities: DecisionAuthorities,
  command: ActivateTaskCommand,
): ActivationOutcome {
  const { store } = authorities;
  const task = requireActivatableTask(store.tasks.require(command.task_key), store);
  const batch = store.batches.require(task.batch_id);
  const run = store.runs.require(batch.run_id);
  if (run.compiled_profile_hash !== batch.compiled_profile_hash) {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/batch/compiled_profile_hash",
      `batch ${batch.batch_id} and run ${run.run_id} disagree about the compiled profile`,
    );
  }

  const binding = task.selection_binding as SelectionBindingV1;

  // --- §12.7 step 0 — the equality gate, before anything is built ----------------------
  const definition = freshDefinition(authorities, task);
  const canonical_head = authorities.repository.snapshot_canonical().head;

  const mismatch = compareBinding(binding, definition, canonical_head);
  if (mismatch !== undefined) {
    commitSelectionStale(store, {
      task_key: task.task_key,
      mismatch: { ...mismatch } as unknown as CanonicalObject,
    });
    return { kind: "SELECTION_STALE", mismatch };
  }

  // --- §12.7 steps 1–7 — profile, scope, manifests, compatibility ----------------------
  // The batch's own immutable snapshot, never whatever the Profile Registry holds now (§7.4).
  const compiled_profile = store.batchView.compiledProfileSnapshotFor(batch.batch_id);
  const repository_scope = resolveRepositoryScope(compiled_profile.body, task);
  const manifests = validateManifestSet(authorities.manifests);

  const incompatible = recheckCompatibility(compiled_profile.body, manifests, repository_scope);
  if (incompatible !== undefined) {
    // TD §19.3 — held, not failed: a Backend condition can change back, so the task stays
    // resumable. Nothing retries, selects a backend or opens a decision here.
    commitBackendIncompatible(store, {
      task_key: task.task_key,
      detail: { ...incompatible } as unknown as CanonicalObject,
    });
    return { kind: "BACKEND_INCOMPATIBLE", detail: incompatible.detail };
  }

  // --- §12.7 steps 8–11 — grants, contract, snapshot, and the transition ---------------
  const n = store.attempts.nextOrdinal(task.task_key);
  const attempt_key = buildAttemptKey(task.task_key, n);

  let result;
  try {
    result = commitContractActivation(store, {
      task_key: task.task_key,
      attempt_key,
      n,
      // Runs inside the transition transaction, so the contract-source blobs, both grants, the
      // snapshot, the attempt and the task state all commit or roll back together (§10.2, §18.2).
      build: (): TaskContractBuildResult =>
        buildTaskContract({
          snapshot_id: command.snapshot_id,
          task: definition,
          attempt: n,
          // §19.3a — the bound base, which the gate just proved is still canonical.
          base_head: binding.base_head,
          compiled_profile,
          contract_sources: command.contract_sources,
          pipeline_id: requireSelected(task.pipeline_id, "pipeline_id"),
          verification_profile: requireSelected(task.verification_profile, "verification_profile"),
          repository_scope,
          manifests,
          actor_grant_id: command.actor_grant_id,
          auditor_grant_id: command.auditor_grant_id,
          blobs: store.blobs,
        }),
    });
  } catch (error) {
    // TD §19.3/§24 — the inputs were authoritative and current; the contract itself could not be
    // constructed. The activation transaction has already rolled back, so the terminal transition
    // is written on its own and no half-built artifact exists.
    commitContractBuildFailure(store, {
      task_key: task.task_key,
      detail: { failure: describeBuildFailure(error) } as unknown as CanonicalObject,
    });
    throw error;
  }

  return { kind: "ACTIVATED", attempt_key, transition_seq: result.transition.seq };
}

// --- preconditions --------------------------------------------------------------------

function requireActivatableTask(task: TaskRow, store: DecisionAuthorities["store"]): TaskRow {
  if (task.platform_state !== "SELECTED") {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/task/platform_state",
      `activation requires SELECTED, not ${task.platform_state}`,
    );
  }
  if (task.selection_binding === null || task.repository_scope_id === null) {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/task/selection_binding",
      `${task.task_key} is SELECTED without a durable selection basis`,
    );
  }
  // A second activation of the same task must not build a second contract (§19.3).
  if (store.attempts.current(task.task_key) !== undefined) {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/task/attempt",
      `${task.task_key} already has a non-terminal attempt`,
    );
  }
  return task;
}

function requireSelected(value: string | null, field: string): string {
  if (value === null) {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      `/task/${field}`,
      `a SELECTED task must carry ${field}`,
    );
  }
  return value;
}

// --- the equality gate ----------------------------------------------------------------

/**
 * One fresh normalized observation, reused for the comparison *and* for the contract body, so
 * `version` / `definition_hash` / `body_copy` can never come from different reads (§10.1).
 */
function freshDefinition(authorities: DecisionAuthorities, task: TaskRow): TaskDefinition {
  const raw = authorities.taskSource.get_task(task.external_task_ref);
  return normalizeTaskDefinition(
    {
      task_ref: raw.task_ref,
      version: raw.version,
      ...(raw.definition_hash === undefined ? {} : { definition_hash: raw.definition_hash }),
      body: raw.body,
    },
    "/task",
  );
}

function compareBinding(
  binding: SelectionBindingV1,
  fresh: TaskDefinition,
  canonical_head: string,
): SelectionMismatch | undefined {
  if (fresh.version !== binding.task_version) {
    return { failed: "task_version", bound: binding.task_version, fresh: fresh.version };
  }
  if (fresh.definition_hash !== binding.task_definition_hash) {
    return {
      failed: "task_definition_hash",
      bound: binding.task_definition_hash,
      fresh: fresh.definition_hash,
    };
  }
  if (canonical_head !== binding.base_head) {
    return { failed: "base_head", bound: binding.base_head, fresh: canonical_head };
  }
  return undefined;
}

// --- scope and compatibility ----------------------------------------------------------

/**
 * §7.1a/§12.7 — the scope the Contract freezes is *resolved*, never supplied: the durable scope id
 * is looked up in the Compiled Profile this batch is bound to. A caller cannot widen it.
 */
function resolveRepositoryScope(
  compiled: CompiledProfileV1Body,
  task: TaskRow,
): RepositoryScopeV1 {
  const scope_id = task.repository_scope_id as string;
  const scope = compiled.effective.project.repository_scopes[scope_id];
  if (scope === undefined) {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/task/repository_scope_id",
      `${scope_id} is not declared by the compiled profile this batch is bound to`,
    );
  }
  return scope;
}

/**
 * §12.7 step 7 — V10 again, against the manifests as they are *now*. Selection-time compatibility
 * is not a reusable authorization: a Backend that weakened in between must stop the activation.
 */
function recheckCompatibility(
  compiled: CompiledProfileV1Body,
  manifests: BackendManifestSet,
  repository_scope: RepositoryScopeV1,
): { readonly operation_id: string; readonly role: string; readonly capability: string; readonly actual: string; readonly detail: string } | undefined {
  const view = { repository_scope };
  const roles: ReadonlyArray<readonly [CoreExecutionRole, string]> = [
    ["ACTOR", ACTOR_EXECUTION_OPERATION],
    ["AUDITOR", AUDITOR_EXECUTION_OPERATION],
  ];

  // The capability view exists so a future task-specific restriction has a seam; v1 derives the
  // requested map from policy+role only, and infers nothing from the scope (§12.7).
  void view;

  for (const [role, operation_id] of roles) {
    const requirements = compiled.effective.policy.capability_requirements[operation_id];
    // An operation the Policy never declared carries no requirement — absence is not failure.
    if (requirements === undefined) continue;

    const outcome = evaluateCapabilityRequirements(
      deriveRequestedCapabilities(compiled.effective.policy, role),
      manifests.runtime.body,
      requirements,
    );
    const failure = outcome.failures[0];
    if (failure !== undefined) {
      return {
        operation_id,
        role,
        capability: failure.capability,
        actual: failure.actual,
        detail: `${operation_id}/${role}: ${failure.capability} is ${failure.actual}`,
      };
    }
  }
  return undefined;
}
