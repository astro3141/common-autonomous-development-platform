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
import type { PlatformStore } from "../store/platform-store.ts";
import { integrityClassification } from "./recovery-integrity.ts";
import type { RecoveryClassification } from "./types.ts";

export interface CoordinatorDependencies {
  readonly store: PlatformStore;
  /**
   * Generic interface only. MVP 0 uses a test double; the production adapter is MVP 1 and no
   * backend package is referenced from Core.
   */
  readonly workflow: WorkflowAdapter;
}

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
    // The logic lives in `recovery-integrity.ts` so the MVP 4 production recovery reuses it.
    return integrityClassification(this.#store, run_id);
  }
}
