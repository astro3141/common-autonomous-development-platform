/**
 * Run opening — the settled bootstrap ordering (PREFLIGHT §4/§6):
 *
 *     compileProfile → bootstrapRun → issueSupervisorGrant → materializeDiscoveryPass
 *
 * The root calls the sealed use-cases and does none of their work itself.
 *
 * **Durable state is the discovery authority (finding 6).** The store's own `platform_run` rows —
 * not a pointer file — decide whether this deployment already owns a run: a crash after the
 * bootstrap transaction but before any bookmark write must resume the same run on restart, never
 * open a second one, and a torn or deleted bookmark must change nothing. The pointer file is kept
 * only as an operator breadcrumb; it is written, never read as authority.
 *
 * Resume completes any crashed opening idempotently: `issueSupervisorGrant` re-enters on the same
 * logical grant and a repeated discovery pass is an observation refresh (§8.4), so the sequence is
 * safe to run again from any crash point inside it.
 */

import { writeFileSync } from "node:fs";
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

/** Opens a new run, or resumes the project's single active one — from the store, fail-closed. */
export function openRun(composition: Composition): OpenedRun {
  const { store, config, compiled, deps } = composition;
  const pointerPath = join(dirname(config.store_path), "current-run.json");

  const active = store.runs.activeForProject(config.project_id);
  if (active.length > 1) {
    // Structurally impossible through this path; if it is ever observed, choosing one would be
    // authority invention. Stop and let a person look.
    throw new Error(
      `${config.project_id} has ${active.length} active runs; refusing to choose one`,
    );
  }

  if (active.length === 1) {
    const run = active[0]!;
    const batches = store.batches.forRun(run.run_id);
    const batch =
      batches.find((row) => row.status === "RUNNING" || row.status === "WAITING") ??
      batches.find((row) => row.status === "PAUSED_SAFELY") ??
      batches[0];
    if (batch === undefined) throw new Error(`${run.run_id} has no batch`);

    // Complete a possibly-crashed opening. The grant is issued only when the crash left none:
    // an existing grant is frozen authorization, and re-deriving it under possibly-changed
    // manifests is §22.2 recovery's question, never a silent re-issue here.
    if (store.grants.forRun(run.run_id).length === 0) {
      issueSupervisorGrant(store, { run_id: run.run_id, grant_id: ulid(), manifests: deps.manifests });
    }
    materializeDiscoveryPass(store, deps.taskSource, {
      run_id: run.run_id,
      batch_id: batch.batch_id,
      context: { observed_at: isoNow() },
    });

    writeFileSync(pointerPath, `${JSON.stringify({ run_id: run.run_id, batch_id: batch.batch_id })}\n`);
    return { run_id: run.run_id, batch_id: batch.batch_id };
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
