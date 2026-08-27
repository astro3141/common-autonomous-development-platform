/**
 * Platform Coordinator — MVP 0 shell (TD §5.6, §5.6a, §14.2, §22.4; §25 `interface + dummy`).
 *
 * Three operations and nothing else:
 *
 *   tickOnce()          caller-driven single step; no timer, no side effect
 *   observe(handle)     one `WorkflowAdapter.status` poll, returned verbatim
 *   recover(run_id)     Platform-owned durable integrity classification
 *
 * The object is stateless: it holds dependency references and no authoritative mutable state, so
 * dropping it and building a new one over the same store changes nothing (§5.6). Production
 * orchestration — task discovery, Supervisor turns, fact assembly, side effects, report delivery —
 * is MVP 1 integration and is deliberately absent here.
 */

import type { WorkflowAdapter, WorkflowObservation } from "../../adapters/interfaces/workflow-adapter.ts";
import type { WorkflowHandle } from "../../adapters/interfaces/handles.ts";
import { HumanDecisionError } from "../humandecision/errors.ts";
import { subjectKey } from "../humandecision/pending-decision.ts";
import { StoreError } from "../store/errors.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { RecoveryClassification } from "./types.ts";

export interface CoordinatorDependencies {
  readonly store: PlatformStore;
  /**
   * Generic interface only. MVP 0 uses a test double; the production adapter is MVP 1 and no
   * backend package is referenced from Core.
   */
  readonly workflow: WorkflowAdapter;
}

/** Store failures that mean "the durable record itself is wrong", not "the code is wrong". */
const INTEGRITY_CODES: readonly string[] = [
  "ARTIFACT_CORRUPT",
  "ARTIFACT_CONFLICT",
  "DOMAIN_ROW_MISSING",
  "DOMAIN_ROW_INVALID",
];

export class Coordinator {
  readonly #store: PlatformStore;
  readonly #workflow: WorkflowAdapter;

  constructor(dependencies: CoordinatorDependencies) {
    this.#store = dependencies.store;
    this.#workflow = dependencies.workflow;
  }

  /**
   * TD §5.6a — one caller-driven step. MVP 0 keeps this a deterministic no-op seam: the point is
   * to give the MVP 1 loop a stable place to live, not to build a scheduler now. There is no
   * timer, no self-rescheduling and no external work; §14.2's 30s poll is MVP 1 configuration.
   */
  tickOnce(): void {
    // Intentionally empty (TD §25 `interface + dummy`).
  }

  /**
   * TD §14.2 — a single `status` poll, returned exactly as the adapter normalized it.
   *
   * The observation is *not* a transition fact: `state`/`stage`/`refs` carry backend-normalized
   * vocabulary this document does not fix, so nothing here interprets them into Core lifecycle
   * meaning. An adapter failure propagates to the caller; turning it into a hold or a pause is
   * MVP 1 orchestration, not an observation concern.
   */
  observe(workflow_handle: WorkflowHandle): WorkflowObservation {
    return this.#workflow.status(workflow_handle);
  }

  /**
   * TD §22.4 — classification only, over Platform-owned durable state.
   *
   * No adapter is queried and nothing is mutated: `UNEXPLAINED` does not pause anything, it just
   * says the durable record cannot be trusted. The integrity checks are the Batch 8 stores' own
   * load/re-hash paths, reused rather than reimplemented.
   */
  recover(run_id: string): RecoveryClassification {
    try {
      return this.#classify(run_id);
    } catch (error) {
      // Only durable-record failures are classified. A programming bug must still surface.
      if (error instanceof StoreError && INTEGRITY_CODES.includes(error.code)) return "UNEXPLAINED";
      if (error instanceof HumanDecisionError) return "UNEXPLAINED";
      throw error;
    }
  }

  #classify(run_id: string): RecoveryClassification {
    const store = this.#store;

    // The supplied recovery root must exist; a missing root is an unexplained state, not a
    // separate NOT_FOUND outcome (TD §22.4).
    const run = store.runs.get(run_id);
    if (run === undefined) return "UNEXPLAINED";
    if (store.compiledProfiles.get(run.compiled_profile_hash) === undefined) return "UNEXPLAINED";

    // A run-scoped SUPERVISOR grant is optional in MVP 0 — Batch 8 never issues one — but if a
    // row exists it must still load and re-hash (§18.1a, §22.4 "존재할 때").
    for (const grant of store.grants.forRun(run_id)) {
      if (store.grants.get(grant.grant_id) === undefined) return "UNEXPLAINED";
    }

    // PROJECT-scoped decisions hang off `platform_run.project_id`, not off any batch, so they are
    // enumerated here. Another project's decisions are a different subject key and stay untouched.
    const projectSubject = subjectKey({ kind: "PROJECT", project_id: run.project_id });
    for (const decision of store.pendingDecisions.forSubject(projectSubject)) {
      if (!terminalHashPresent(decision)) return "UNEXPLAINED";
    }

    // Walk only the relations the existing schema already declares (§18.1a).
    for (const batch of store.batches.forRun(run_id)) {
      if (store.compiledProfiles.get(batch.compiled_profile_hash) === undefined) {
        return "UNEXPLAINED";
      }
      if (!this.#batchIntact(batch.batch_id)) return "UNEXPLAINED";
    }

    return "CONSISTENT";
  }

  #batchIntact(batch_id: string): boolean {
    const store = this.#store;

    for (const decision of store.pendingDecisions.forSubject(batch_id)) {
      if (!terminalHashPresent(decision)) return false;
    }

    for (const task of store.tasks.inBatch(batch_id)) {
      for (const decision of store.pendingDecisions.forSubject(task.task_key)) {
        if (!terminalHashPresent(decision)) return false;
      }

      for (const attempt of store.attempts.forTask(task.task_key)) {
        // The contract snapshot is required by the schema; absence is referential inconsistency.
        const contract = store.contracts.get(attempt.contract_snapshot_id);
        if (contract === undefined) return false;

        // The frozen contract names both grants (§10.1), so a missing row is detectable rather
        // than merely invisible. Loading each one re-verifies its hash (§18.1a).
        const grants = (contract.body as unknown as { capability_grants?: Record<string, { grant_id?: string }> })
          .capability_grants;
        for (const role of ["actor", "auditor"] as const) {
          const grantId = grants?.[role]?.grant_id;
          if (typeof grantId !== "string") return false;
          if (store.grants.get(grantId) === undefined) return false;
        }
      }
    }
    return true;
  }
}

/** A terminal decision must carry the frozen hash the store re-verifies on load (§17.1f). */
function terminalHashPresent(decision: { body: { status: string }; record_hash: string | null }): boolean {
  return decision.body.status === "OPEN" || decision.record_hash !== null;
}
