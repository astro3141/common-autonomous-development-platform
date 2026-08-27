/**
 * Direct HARD dependency admission fact (TD §8.4a, M1-5).
 *
 * The one question this module answers is whether the direct HARD dependencies of the task being
 * admitted are clear *right now*. It is not a scheduler: there is no graph, no traversal, no cycle
 * detection and no queue, and nothing it computes is durable.
 *
 * Two observations decide each dependency, and both are required:
 *
 *   external  — a fresh `get_task_state` call, never the target's stored `external_snapshot`
 *   platform  — the target's durable row, which may legitimately not exist
 *
 * Requiring both is the trust boundary M1-5 exists for. External `CLOSED` alone would let a
 * TaskSource observation paper over a Platform-managed dependency that is still ACTIVE, HELD or
 * FAILED; Platform `COMPLETED` alone would let a prerequisite that the authoritative source has
 * reopened pass unnoticed. Neither fact may overrule the other, and neither is reconciled here —
 * a divergence blocks this admission and changes nothing else (TD §8.4a; MVP 4 owns reconciliation).
 */

import { taskKey as buildTaskKey } from "../schemas/identifiers.ts";
import type { TaskRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { ExternalTaskState, TaskDependency, TaskSourceV1 } from "../tasksource/types.ts";

/** The typed fact the state machine consumes. Transition-time only — never persisted. */
export interface DependencyAdmissionView {
  readonly hard_dependencies_clear: boolean;
}

/**
 * The §8.4a rule, as a pure function of the two observations.
 *
 * `CLOSED` is necessary either way. Beyond that the only question is whether the Platform ever
 * owned this dependency's execution: if it did (`admitted_at != null`) its own lifecycle must also
 * say `COMPLETED`, which is what makes SELECTED/ACTIVE/HELD/DEFERRED/FAILED — and the abnormal
 * DISCOVERED-with-`admitted_at` case — fail closed.
 */
export function isDirectHardDependencySatisfied(
  external_state: ExternalTaskState,
  target: TaskRow | null,
): boolean {
  if (external_state !== "CLOSED") return false;
  if (target === null || target.admitted_at === null) return true;
  return target.platform_state === "COMPLETED";
}

export interface HardDependencyEvaluation {
  readonly store: PlatformStore;
  readonly taskSource: TaskSourceV1;
  /** The run's project, which fixes the first separator of every `task_key` (§6.1). */
  readonly project_id: string;
  /** Exactly what `get_dependencies(current_task_ref)` returned in this same invocation. */
  readonly dependencies: readonly TaskDependency[];
}

/**
 * Evaluates the direct HARD dependencies in the order the TaskSource returned them.
 *
 * `SOFT` entries are skipped entirely — they are not admission blockers, so no state is read for
 * them at all. Evaluation stops at the first unsatisfied HARD dependency: the answer is already
 * decided, and issuing further external reads would only add observations nobody uses. That
 * short-circuit is semantic, never a way to swallow a failure — an adapter error propagates.
 */
export function evaluateHardDependencies(
  input: HardDependencyEvaluation,
): DependencyAdmissionView {
  for (const dependency of input.dependencies) {
    if (dependency.kind !== "HARD") continue;

    // Fresh, once per HARD dependency. A stored snapshot is a past observation, not authority.
    const external = input.taskSource.get_task_state(dependency.depends_on_ref);
    // The ref stays opaque; the shared helper builds the key without interpreting it.
    const target =
      input.store.tasks.get(buildTaskKey(input.project_id, dependency.depends_on_ref)) ?? null;

    if (!isDirectHardDependencySatisfied(external, target)) {
      return { hard_dependencies_clear: false };
    }
  }
  // No HARD dependency, or every one of them satisfied.
  return { hard_dependencies_clear: true };
}
