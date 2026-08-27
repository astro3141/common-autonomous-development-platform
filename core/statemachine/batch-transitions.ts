/**
 * BatchState guards (TD §20, §20.1 – §20.3).
 *
 * Pure. `safe_independent_runnable_exists` is supplied by the Coordinator — Batch 8 never walks a
 * dependency graph or asks a repository, so Hold-and-Continue (Spec §48) stays a Coordinator
 * judgement while the state itself stays deterministic here.
 */

import type { BatchRow } from "../store/domain-types.ts";
import { illegal, TransitionError } from "./errors.ts";
import type { BatchFact, BatchOutcome } from "./types.ts";

/** The durable counts §20.1/§20.2 are decided from. */
export interface BatchTaskCounts {
  readonly admitted_non_terminal: number;
  readonly active: number;
  readonly selected: number;
  readonly open_blocking_decisions: number;
}

export function nextBatchOutcome(
  batch: BatchRow,
  fact: BatchFact,
  counts: BatchTaskCounts,
): BatchOutcome {
  switch (fact.kind) {
    case "CIRCUIT_BREAKER":
      // Spec §52: a safety stop is always available, and never resumes by itself.
      return { batch_state: "PAUSED_SAFELY", pause_run: fact.also_pause_run };

    case "EVALUATE_WAITING": {
      if (batch.status !== "RUNNING") {
        throw illegal(`WAITING requires a RUNNING batch, not ${batch.status}`);
      }
      const waiting =
        counts.admitted_non_terminal >= 1 &&
        counts.active === 0 &&
        counts.selected === 0 &&
        counts.open_blocking_decisions >= 1 &&
        !fact.safe_independent_runnable_exists;
      if (!waiting) {
        throw new TransitionError(
          "PRECONDITION_FAILED",
          "the §20.1 WAITING condition does not hold; an arbitrary HELD task alone is not WAITING",
        );
      }
      return { batch_state: "WAITING", pause_run: false };
    }

    case "RESUME": {
      if (batch.status !== "WAITING") {
        throw illegal(`resume requires a WAITING batch, not ${batch.status}`);
      }
      if (!fact.safe_independent_runnable_exists && counts.open_blocking_decisions >= 1) {
        throw new TransitionError(
          "PRECONDITION_FAILED",
          "nothing has become runnable and the blocking decisions are still open",
        );
      }
      return { batch_state: "RUNNING", pause_run: false };
    }

    case "EVALUATE_COMPLETION": {
      if (batch.status !== "RUNNING" && batch.status !== "WAITING") {
        throw illegal(`completion requires RUNNING or WAITING, not ${batch.status}`);
      }
      if (!batch.admission_closed) {
        throw new TransitionError(
          "PRECONDITION_FAILED",
          "admission is still open; a batch completes only after admission is closed (§20.2)",
        );
      }
      if (counts.admitted_non_terminal !== 0) {
        // HELD is not terminal, so a held task keeps the batch from completing.
        throw new TransitionError(
          "PRECONDITION_FAILED",
          `${counts.admitted_non_terminal} admitted task(s) are not terminal`,
        );
      }
      return { batch_state: "COMPLETED", pause_run: false };
    }
  }
}
