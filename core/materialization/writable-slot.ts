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
  ACTOR_TURN_METADATA_PREFIX,
  actorSpawnOp,
  actorTurnOpPrefix,
  actorWorkspaceOp,
} from "../execution/actor-operations.ts";
import { requireExactBindingAuthority } from "./materialize-child.ts";
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
    // Review 5496386527 finding 1 — every bound row this projection touches must be the exact
    // F authority; an inexact durable binding makes the projection unavailable (throws).
    if (task.materialization_binding !== null) requireExactBindingAuthority(store, task);
    if (
      task.platform_state === "SELECTED" &&
      pipelineHasActor(task.pipeline_id) &&
      task.materialization_binding !== null &&
      task.parent_task_key !== null
    ) {
      const parent = store.tasks.get(task.parent_task_key);
      const suspendedForThisChild =
        parent !== undefined &&
        parent.platform_state === "SUSPENDED" &&
        subflowChildOf(parent.state_reason?.code) === task.task_key;
      if (suspendedForThisChild) transferred.push(task.task_key);
    }

    // --- phase-aware dispatch-started attempts ----------------------------------------------
    // Review 5496386527 finding 2 — provenance is *enumerated and strictly parsed*, never point-
    // read: an ordinal beyond the phase's one possible next turn contradicts the durable Attempt
    // counter and fails the projection closed. Legitimate completed ordinals below the next turn
    // are history and never block; the exact next ordinal is dispatch-started.
    if (attempt !== undefined && (attempt.state === "READY" || attempt.state === "REWORKING")) {
      const key = attempt.attempt_key;
      const next_turn = attempt.state === "READY" ? 1 : attempt.rework_count + 2;
      const ordinals = actorTurnProvenance(store, key);
      for (const ordinal of ordinals) {
        if (ordinal > next_turn) {
          throw new Error(
            `actor-turn:${ordinal} provenance on ${key} contradicts ${attempt.state} ` +
              `(rework_count ${attempt.rework_count}, next turn ${next_turn}); ` +
              "the writable projection is unavailable",
          );
        }
      }
      const started =
        ordinals.includes(next_turn) ||
        (attempt.state === "READY" &&
          ([actorWorkspaceOp(key), actorSpawnOp(key)].some(
            (op) => store.idempotency.get(op) !== undefined,
          ) ||
            store.adapterMetadata.get(key, REPOSITORY_ADAPTER, WORKSPACE_METADATA_KEY) !== undefined ||
            store.adapterMetadata.get(key, RUNTIME_ADAPTER, SESSION_METADATA_KEY) !== undefined));
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

const TURN_ORDINAL = /^[1-9][0-9]*$/;

/**
 * Every durable Actor-turn ordinal recorded for one Attempt — idempotency rows and adapter turn
 * metadata alike. A suffix that is not a canonical positive integer is malformed provenance and
 * throws; it is a contradiction to resolve, never absence.
 */
function actorTurnProvenance(store: PlatformStore, attempt_key: string): readonly number[] {
  const ordinals = new Set<number>();
  const parse = (source: string, suffix: string): void => {
    if (!TURN_ORDINAL.test(suffix)) {
      throw new Error(
        `malformed actor-turn provenance ${JSON.stringify(source)} on ${attempt_key}; ` +
          "the writable projection is unavailable",
      );
    }
    ordinals.add(Number(suffix));
  };
  const opPrefix = actorTurnOpPrefix(attempt_key);
  for (const op_key of store.idempotency.keysWithPrefix(opPrefix)) {
    parse(op_key, op_key.slice(opPrefix.length));
  }
  for (const row of store.adapterMetadata.forEntity(attempt_key)) {
    if (row.key.startsWith(ACTOR_TURN_METADATA_PREFIX)) {
      parse(row.key, row.key.slice(ACTOR_TURN_METADATA_PREFIX.length));
    }
  }
  return [...ordinals].sort((a, b) => a - b);
}

/** The union the §9.2e rule judges. Sorted set semantics. */
export function effectiveWritableOwners(
  view: PendingMaterializedChildWritableSlotViewV1,
): readonly string[] {
  return [...new Set([...view.active_owner_task_keys, ...view.transferred_owner_task_keys])].sort();
}
