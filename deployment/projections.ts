/**
 * Read-model projections shared by the ingress and the #55 observation server. Store reads only:
 * no adapter, no transition, no authority (§5.11/§22.1).
 */

import type { PlatformStore } from "../core/store/platform-store.ts";

export function runProjection(store: PlatformStore, run_id: string): unknown {
  const run = store.runs.get(run_id);
  if (run === undefined) return { run: null };
  const batches = store.batches.forRun(run_id).map((batch) => ({
    batch_id: batch.batch_id,
    status: batch.status,
    admission_closed: batch.admission_closed,
    tasks: store.tasks.inBatch(batch.batch_id).map((task) => ({
      task_key: task.task_key,
      external_task_ref: task.external_task_ref,
      platform_state: task.platform_state,
      state_reason: task.state_reason,
      attempt: projectAttempt(store, task.task_key),
      open_decisions: store.pendingDecisions.openFor(task.task_key).map((record) => ({
        decision_id: record.body.decision_id,
        category: record.body.category,
        question: record.body.question,
        options: record.body.options,
      })),
    })),
  }));
  return { run: { run_id: run.run_id, status: run.status, project_id: run.project_id }, batches };
}

function projectAttempt(store: PlatformStore, task_key: string): unknown {
  const attempt = store.attempts.current(task_key);
  return attempt === undefined
    ? null
    : {
        attempt_key: attempt.attempt_key,
        state: attempt.state,
        candidate_commit: attempt.candidate_commit,
        rework_count: attempt.rework_count,
      };
}

