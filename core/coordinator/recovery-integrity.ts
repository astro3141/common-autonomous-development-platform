/**
 * Platform-owned durable-integrity classification (TD §22.4) — the MVP 0 recovery seam's logic,
 * extracted so the MVP 4 production recovery reuses it verbatim instead of growing a second
 * implementation. No adapter is queried and nothing is mutated; the checks are the stores' own
 * load/re-hash paths.
 */

import { HumanDecisionError } from "../humandecision/errors.ts";
import { subjectKey } from "../humandecision/pending-decision.ts";
import { StoreError } from "../store/errors.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { RecoveryClassification } from "./types.ts";

/** Store failures that mean "the durable record itself is wrong", not "the code is wrong". */
const INTEGRITY_CODES: readonly string[] = [
  "ARTIFACT_CORRUPT",
  "ARTIFACT_CONFLICT",
  "DOMAIN_ROW_MISSING",
  "DOMAIN_ROW_INVALID",
];

export function integrityClassification(
  store: PlatformStore,
  run_id: string,
): RecoveryClassification {
  try {
    return classify(store, run_id);
  } catch (error) {
    // Only durable-record failures are classified. A programming bug must still surface.
    if (error instanceof StoreError && INTEGRITY_CODES.includes(error.code)) return "UNEXPLAINED";
    if (error instanceof HumanDecisionError) return "UNEXPLAINED";
    throw error;
  }
}

function classify(store: PlatformStore, run_id: string): RecoveryClassification {
  // The supplied recovery root must exist; a missing root is an unexplained state, not a
  // separate NOT_FOUND outcome (TD §22.4).
  const run = store.runs.get(run_id);
  if (run === undefined) return "UNEXPLAINED";
  if (store.compiledProfiles.get(run.compiled_profile_hash) === undefined) return "UNEXPLAINED";

  // A run-scoped SUPERVISOR grant is optional — but if a row exists it must still load and
  // re-hash (§18.1a, §22.4 "존재할 때").
  for (const grant of store.grants.forRun(run_id)) {
    if (store.grants.get(grant.grant_id) === undefined) return "UNEXPLAINED";
  }

  // PROJECT-scoped decisions hang off `platform_run.project_id`, not off any batch.
  const projectSubject = subjectKey({ kind: "PROJECT", project_id: run.project_id });
  for (const decision of store.pendingDecisions.forSubject(projectSubject)) {
    if (!terminalHashPresent(decision)) return "UNEXPLAINED";
  }

  // Walk only the relations the existing schema already declares (§18.1a).
  for (const batch of store.batches.forRun(run_id)) {
    if (store.compiledProfiles.get(batch.compiled_profile_hash) === undefined) {
      return "UNEXPLAINED";
    }
    if (!batchIntact(store, batch.batch_id)) return "UNEXPLAINED";
  }

  return "CONSISTENT";
}

function batchIntact(store: PlatformStore, batch_id: string): boolean {
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
      const grants = (
        contract.body as unknown as {
          capability_grants?: Record<string, { grant_id?: string }>;
        }
      ).capability_grants;
      for (const role of ["actor", "auditor"] as const) {
        const grantId = grants?.[role]?.grant_id;
        if (typeof grantId !== "string") return false;
        if (store.grants.get(grantId) === undefined) return false;
      }
    }
  }
  return true;
}

/** A terminal decision must carry the frozen hash the store re-verifies on load (§17.1f). */
function terminalHashPresent(decision: {
  body: { status: string };
  record_hash: string | null;
}): boolean {
  return decision.body.status === "OPEN" || decision.record_hash !== null;
}
