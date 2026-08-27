/**
 * Narrow run bootstrap (TD §26 step 1–2).
 *
 * Just enough to have something to submit against: persist an already-compiled Profile, open a
 * run bound to its hash, and open that run's first batch. No YAML parser, no profile registry, no
 * scheduler, and no new schema — the Compiled Profile arrives as the existing compiler's result,
 * because compiling it is the Profile module's job, not this one's.
 *
 * All three writes share one transaction, so a failure leaves no half-built run behind.
 */

import type { CompileResult } from "../profile/compiler.ts";
import type { BatchRow, PlatformRunRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";

export interface RunBootstrapCommand {
  /** Caller-allocated identities; Core allocates none (TD §6.1). */
  readonly run_id: string;
  readonly batch_id: string;
  readonly project_id: string;
  readonly compiled_profile: CompileResult;
}

export interface RunBootstrapResult {
  readonly run: PlatformRunRow;
  readonly batch: BatchRow;
  readonly compiled_profile_hash: string;
}

/**
 * MVP 1 opens exactly one batch because MVP 1 runs one at a time — that is a property of this
 * bootstrap, not an invariant of the schema, which already allows a run to hold many.
 */
export function bootstrapRun(
  store: PlatformStore,
  command: RunBootstrapCommand,
): RunBootstrapResult {
  const compiled_profile_hash = command.compiled_profile.compiled_hash;

  return store.withTransaction(() => {
    store.compiledProfiles.put(command.compiled_profile);
    const run = store.runs.create({
      run_id: command.run_id,
      project_id: command.project_id,
      compiled_profile_hash,
    });
    const batch = store.batches.create({
      batch_id: command.batch_id,
      run_id: command.run_id,
      ordinal: 1,
      compiled_profile_hash,
    });
    return { run, batch, compiled_profile_hash };
  });
}
