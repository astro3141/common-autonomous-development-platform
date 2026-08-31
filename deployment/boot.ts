/**
 * Boot sequence — the §22.2 startup ordering the process entrypoint must follow (finding 3):
 *
 *     compose → openRun → recoverRun → (only then) ingress + ticks
 *
 * Recovery is not optional decoration on a restart: a persisted run may hold unresolved INTENTs,
 * a weakened backend or externally-completed work, and every one of those must be reconciled —
 * or fail-closed — **before** the first tick can start an external operation. `bootRun` is the
 * one function that owns that ordering, so a test can hold the entrypoint to it without spawning
 * a process.
 */

import { recoverRun, type RecoveryReport } from "../core/coordinator/production-recovery.ts";
import type { Composition } from "./compose.ts";
import { openRun, type OpenedRun } from "./open-run.ts";

export interface BootResult {
  readonly opened: OpenedRun;
  readonly report: RecoveryReport;
}

/** Opens (or resumes) the run and reconciles it. No tick has happened when this returns. */
export function bootRun(composition: Composition): BootResult {
  const opened = openRun(composition);
  const report = recoverRun(composition.deps, { run_id: opened.run_id });
  return { opened, report };
}
