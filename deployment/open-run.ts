/**
 * Run opening — the settled bootstrap ordering (PREFLIGHT §4/§6):
 *
 *     compileProfile → bootstrapRun → issueSupervisorGrant → materializeDiscoveryPass
 *
 * The root calls the sealed use-cases and does none of their work itself. Re-entry is the
 * use-cases' own: an existing conforming run is re-used, a conflicting one refuses.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import { bootstrapRun } from "../core/admission/bootstrap.ts";
import { issueSupervisorGrant } from "../core/admission/supervisor-grant.ts";
import { materializeDiscoveryPass } from "../core/discovery/materialize.ts";
import type { Composition } from "./compose.ts";
import { isoNow, ulid } from "./identities.ts";

export interface OpenedRun {
  readonly run_id: string;
  readonly batch_id: string;
}

/**
 * Opens a new run, or resumes the one this deployment already opened.
 *
 * Resume-over-restart is deliberately boring: the deployment keeps a pointer file next to the
 * store, and the pointer is *verified against durable state* before it is believed — the store is
 * the authority, the file is a bookmark. A pointer whose run is COMPLETED (or gone) simply means a
 * fresh run is opened.
 */
export function openRun(composition: Composition): OpenedRun {
  const { store, config, compiled, deps } = composition;
  const pointerPath = join(dirname(config.store_path), "current-run.json");

  const pointed = readPointer(pointerPath);
  if (pointed !== undefined) {
    const run = store.runs.get(pointed.run_id);
    const batch = store.batches.get(pointed.batch_id);
    if (
      run !== undefined &&
      batch !== undefined &&
      batch.run_id === run.run_id &&
      run.project_id === config.project_id &&
      run.status !== "COMPLETED"
    ) {
      return { run_id: run.run_id, batch_id: batch.batch_id };
    }
  }

  const run_id = `run:${ulid()}`;
  const batch_id = `batch:${run_id}:1`;

  bootstrapRun(store, {
    run_id,
    batch_id,
    project_id: config.project_id,
    compiled_profile: compiled,
  });
  // IG-1 ordering — the run-scoped SUPERVISOR grant exists before the first Supervisor spawn.
  issueSupervisorGrant(store, { run_id, grant_id: ulid(), manifests: deps.manifests });
  materializeDiscoveryPass(store, deps.taskSource, {
    run_id,
    batch_id,
    context: { observed_at: isoNow() },
  });

  writeFileSync(pointerPath, `${JSON.stringify({ run_id, batch_id })}\n`);
  return { run_id, batch_id };
}

function readPointer(path: string): OpenedRun | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const pointer = raw as { run_id?: unknown; batch_id?: unknown };
  return typeof pointer.run_id === "string" && typeof pointer.batch_id === "string"
    ? { run_id: pointer.run_id, batch_id: pointer.batch_id }
    : undefined;
}
