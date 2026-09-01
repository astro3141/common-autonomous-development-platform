/**
 * PendingMaterializedChildWritableSlotViewV1 — the D25 (#71) §19.3c owner-set projection.
 *
 * The writable slot is not a durable row: it is derived, on every read, from existing
 * task/attempt/materialisation-binding/suspension/idempotency/adapter-metadata rows. The MVP 0/1
 * `active_writable_candidate_count` definition is unchanged; this module adds the exact task-key
 * set behind that count, the D24 *transferred* owner set, and the phase-aware "current writable
 * phase dispatch already started" attempt set:
 *
 *   READY      the initial dispatch protocol — any durable record/ref for
 *              `op:<attempt>:workspace`, `op:<attempt>:actor-spawn` or `op:<attempt>:actor-turn:1`
 *   REWORKING  only the §26 M1-15 exact next turn `op:<attempt>:actor-turn:<rework_count+2>` —
 *              records of already-completed phases never count
 *
 * Any state (FAILED included) of the exact phase operation counts as started: under I-TD2 an
 * authorized external effect cannot precede its durable INTENT, so a complete local projection
 * with zero such records is the authority for "the next Actor side effect has not begun".
 * A projection that cannot be computed exactly (count/set mismatch, unreadable row) throws —
 * never a silent empty set.
 */

import type { PendingMaterializedChildWritableSlotViewV1 } from "../decision/types.ts";
import {
  actorSpawnOp,
  actorTurnMetadataKey,
  actorTurnOp,
  actorWorkspaceOp,
} from "../execution/actor-operations.ts";
import {
  REPOSITORY_ADAPTER,
  RUNTIME_ADAPTER,
  SESSION_METADATA_KEY,
  WORKSPACE_METADATA_KEY,
} from "../execution/start-implementation.ts";
import { subflowChildOf } from "../statemachine/types.ts";
import { WRITABLE_ATTEMPT_STATES } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";

export type { PendingMaterializedChildWritableSlotViewV1 };

/**
 * Builds the view, or returns `null` for a legacy batch with no D24 materialisation state at all
 * (no snapshot, no bound task, no transferred owner) — where the empty-owner predicate is exactly
 * `active_writable_candidate_count == 0` and the count-only path stays byte-for-byte equivalent.
 */
export function pendingWritableSlotView(
  store: PlatformStore,
  batch_id: string,
): PendingMaterializedChildWritableSlotViewV1 | null {
  const tasks = store.tasks.inBatch(batch_id);
  const hasMaterializationState =
    store.materializations.forBatch(batch_id).length > 0 ||
    tasks.some((task) => task.materialization_binding !== null);
  if (!hasMaterializationState) return null;

  const compiled = store.batchView.compiledProfileFor(batch_id);
  const pipelineHasActor = (pipeline_id: string | null): boolean => {
    if (pipeline_id === null) return false;
    const pipeline = compiled.effective.project.pipelines[pipeline_id];
    return pipeline !== undefined && pipeline.steps.includes("ACTOR");
  };

  const active: string[] = [];
  const transferred: string[] = [];
  const dispatchStarted: string[] = [];

  for (const task of tasks) {
    const attempt = store.attempts.current(task.task_key);

    // --- active owners: the exact keys the sealed count counts (§19.3c) ---------------------
    if (
      task.platform_state === "ACTIVE" &&
      attempt !== undefined &&
      (WRITABLE_ATTEMPT_STATES as readonly string[]).includes(attempt.state) &&
      pipelineHasActor(task.pipeline_id)
    ) {
      active.push(task.task_key);
    }

    // --- transferred owners: post-E SELECTED bound children (§19.3c D24 set) ----------------
    if (
      task.platform_state === "SELECTED" &&
      pipelineHasActor(task.pipeline_id) &&
      task.materialization_binding !== null &&
      task.parent_task_key !== null
    ) {
      const snapshot = store.materializations.get(task.materialization_binding.materialization_id);
      const parent = store.tasks.get(task.parent_task_key);
      const suspendedForThisChild =
        parent !== undefined &&
        parent.platform_state === "SUSPENDED" &&
        subflowChildOf(parent.state_reason?.code) === task.task_key;
      if (
        snapshot !== undefined &&
        snapshot.hash === task.materialization_binding.materialization_hash &&
        suspendedForThisChild
      ) {
        transferred.push(task.task_key);
      }
    }

    // --- phase-aware dispatch-started attempts ----------------------------------------------
    if (attempt !== undefined && (attempt.state === "READY" || attempt.state === "REWORKING")) {
      const key = attempt.attempt_key;
      const started =
        attempt.state === "READY"
          ? [actorWorkspaceOp(key), actorSpawnOp(key), actorTurnOp(key, 1)].some(
              (op) => store.idempotency.get(op) !== undefined,
            ) ||
            store.adapterMetadata.get(key, REPOSITORY_ADAPTER, WORKSPACE_METADATA_KEY) !== undefined ||
            store.adapterMetadata.get(key, RUNTIME_ADAPTER, SESSION_METADATA_KEY) !== undefined ||
            store.adapterMetadata.get(key, RUNTIME_ADAPTER, actorTurnMetadataKey(1)) !== undefined
          : store.idempotency.get(actorTurnOp(key, attempt.rework_count + 2)) !== undefined ||
            store.adapterMetadata.get(key, RUNTIME_ADAPTER, actorTurnMetadataKey(attempt.rework_count + 2)) !==
              undefined;
      if (started) dispatchStarted.push(key);
    }
  }

  // §19.3c — the exact-key set must reconstruct the sealed count, or the projection is not a
  // complete durable computation and nothing downstream may consume it.
  const counted = store.batchView.project(batch_id).active_writable_candidate_count;
  if (counted !== active.length) {
    throw new Error(
      `writable owner projection incomplete: count ${counted} vs keys ${active.length} in ${batch_id}`,
    );
  }

  return {
    active_owner_task_keys: [...new Set(active)].sort(),
    transferred_owner_task_keys: [...new Set(transferred)].sort(),
    current_writable_phase_dispatch_started_attempt_keys: [...new Set(dispatchStarted)].sort(),
  };
}

/** The union the §9.2e rule judges. Sorted set semantics. */
export function effectiveWritableOwners(
  view: PendingMaterializedChildWritableSlotViewV1,
): readonly string[] {
  return [...new Set([...view.active_owner_task_keys, ...view.transferred_owner_task_keys])].sort();
}
