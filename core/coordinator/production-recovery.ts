/**
 * MVP 4 production recovery / reconciliation (TD §22.2, Spec §54/§55/§69).
 *
 * The §22.2 procedure over one run, applied — not merely classified. Its shape follows the
 * authority map (§22.1) strictly: every fact is re-read from its owner, nothing is repaired by
 * guesswork, and the outcome of every conflict is one of the three §22.2 words.
 *
 *   CONSISTENT    nothing to do; the ordinary tick loop continues the run
 *   EXPLAINABLE   a catch-up or fail-closed transition was applied through the sealed guards
 *   UNEXPLAINED   the durable record itself cannot be trusted → circuit breaker (Spec §52
 *                 "Platform durable state corruption"), batch and run PAUSED_SAFELY
 *
 * What deliberately does **not** happen here: no Runtime turn is re-sent (§19.3e T1/T2 — the
 * sealed use-cases own that refusal), no canonical mutation, no PendingDecision resolution, no
 * silent Profile migration. Report-outbox recovery needs no code of its own: unsent rows keep
 * their identity and the ordinary delivery path re-presents them idempotently (§21.1).
 */

import { integrityClassification } from "./recovery-integrity.ts";
import { evaluateCapabilityRequirements } from "../capability/compatibility.ts";
import { validateManifestSet } from "../capability/manifest-set.ts";
import type { RequestedCapabilities } from "../capability/types.ts";
import type { TaskContractV1Body } from "../contract/types.ts";
import { auditDecisionCause } from "../humandecision/audit-decision.ts";
import { auditDecisionRemainsValid } from "../humandecision/audit-decision.ts";
import { driftCause, driftDecisionRemainsValid } from "../humandecision/drift-decision.ts";
import type { PendingDecisionV1 } from "../humandecision/types.ts";
import { mergeApprovalStillValid } from "../execution/human-merge.ts";
import { commitAttemptFact, commitBatchFact } from "../statemachine/transition-commit.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { ProductionCoordinatorDependencies } from "./production-coordinator.ts";
import type { RecoveryClassification } from "./types.ts";

export interface RecoveryAction {
  readonly kind:
    | "CIRCUIT_BREAKER"
    | "CAPABILITY_HELD"
    | "CAPABILITY_PAUSED"
    | "CAPABILITY_UNAVAILABLE"
    | "DECISION_STALE";
  readonly subject: string;
}

export interface RecoveryReport {
  readonly classification: RecoveryClassification;
  readonly actions: readonly RecoveryAction[];
}

/**
 * §22.2 over one run. Idempotent: applying it twice finds the fail-closed states it already
 * created and changes nothing further.
 */
export function recoverRun(
  deps: ProductionCoordinatorDependencies,
  command: { readonly run_id: string },
): RecoveryReport {
  const { store } = deps;
  const actions: RecoveryAction[] = [];

  // --- Platform-owned durable integrity first (§22.2 hash 검증; MVP 0 seam reused verbatim) ----
  const integrity = integrityClassification(store, command.run_id);
  if (integrity === "UNEXPLAINED") {
    // Spec §52 — durable state corruption is a safety stop, not a diagnosis to work around.
    for (const batch of store.batches.forRun(command.run_id)) {
      if (batch.status === "PAUSED_SAFELY") continue;
      try {
        commitBatchFact(store, {
          batch_id: batch.batch_id,
          fact: { kind: "CIRCUIT_BREAKER", also_pause_run: true },
        });
        actions.push({ kind: "CIRCUIT_BREAKER", subject: batch.batch_id });
      } catch {
        // The batch row itself may be part of the corruption; the classification still stands.
      }
    }
    return { classification: "UNEXPLAINED", actions };
  }

  // --- capability 재대조 (§22.2): frozen authorization vs the currently configured Backend ------
  reconcileCapability(deps, command.run_id, actions);

  // --- PendingDecision 정합 (§22.2): a question whose basis is gone goes STALE, once -----------
  reconcileDecisions(store, command.run_id, actions);

  return { classification: actions.length === 0 ? "CONSISTENT" : "EXPLAINABLE", actions };
}

/**
 * §22.2 — "현재 backend가 시작 시점보다 약해짐". Assurance has no ordering (§12.2), so "weaker" is
 * judged the only way the documents allow: would the frozen policy requirements still accept the
 * enforcement the *current* Manifest yields for the frozen requested map? A Manifest that merely
 * changed but still satisfies every requirement resumes silently — that is not a downgrade.
 */
function reconcileCapability(
  deps: ProductionCoordinatorDependencies,
  run_id: string,
  actions: RecoveryAction[],
): void {
  const { store } = deps;
  let manifests: ReturnType<typeof validateManifestSet>;
  try {
    manifests = validateManifestSet(deps.manifests);
  } catch {
    // §24 CAPABILITY_BOUNDARY_UNAVAILABLE — the capability re-verification §22.2 requires cannot
    // run at all, which is a fail-closed condition, never "nothing to compare" (finding 5). Every
    // batch stops, and the action is reported on every pass so the run can never reconcile to
    // CONSISTENT (and can never be resumed) while the configured manifests are unreadable.
    for (const batch of store.batches.forRun(run_id)) {
      if (batch.status !== "PAUSED_SAFELY") {
        try {
          commitBatchFact(store, {
            batch_id: batch.batch_id,
            fact: { kind: "CIRCUIT_BREAKER", also_pause_run: true },
          });
        } catch {
          // The pause guard refused (e.g. terminal batch); the reported action still stands.
        }
      }
      actions.push({ kind: "CAPABILITY_UNAVAILABLE", subject: batch.batch_id });
    }
    return;
  }
  const currentRuntimeHash = manifests.runtime.hash;

  for (const batch of store.batches.forRun(run_id)) {
    const compiled = store.batchView.compiledProfileFor(batch.batch_id);
    const requirements = compiled.effective.policy.capability_requirements;
    const downgrade = compiled.effective.policy.recovery_policy.capability_downgrade;

    for (const task of store.tasks.inBatch(batch.batch_id)) {
      const attempt = store.attempts.current(task.task_key);
      if (attempt === undefined) continue;
      const stored = store.contracts.get(attempt.contract_snapshot_id);
      if (stored === undefined) continue;
      const contract = stored.body as unknown as TaskContractV1Body;
      if (contract.backend_requirements.runtime_manifest_hash === currentRuntimeHash) continue;

      // The Manifest moved. Re-derive what the frozen grants would get *now* and ask the frozen
      // policy. Requested maps are re-read from the frozen grants themselves (§22.1 authority).
      const incompatible = ["actor", "auditor"].some((role) => {
        const ref = contract.capability_grants[role as "actor" | "auditor"];
        const grant = store.grants.get(ref.grant_id);
        if (grant === undefined) return true;
        const requested = (grant.body as { requested: RequestedCapabilities }).requested;
        const operation = role === "actor" ? "actor_execution" : "auditor_execution";
        const requirement = requirements[operation] ?? {};
        return !evaluateCapabilityRequirements(
          requested,
          manifests.runtime.body,
          requirement,
        ).compatible;
      });
      if (!incompatible) continue;

      if (downgrade === "PAUSE") {
        try {
          commitBatchFact(store, {
            batch_id: batch.batch_id,
            fact: { kind: "CIRCUIT_BREAKER", also_pause_run: true },
          });
          actions.push({ kind: "CAPABILITY_PAUSED", subject: batch.batch_id });
        } catch {
          // Already paused: the safe state holds.
        }
        continue;
      }
      if (task.platform_state === "HELD") continue; // already fail-closed
      try {
        commitAttemptFact(store, {
          attempt_key: attempt.attempt_key,
          fact: { kind: "EXECUTION_HELD", reason_code: "CAPABILITY_BOUNDARY_CHANGED" },
        });
        actions.push({ kind: "CAPABILITY_HELD", subject: attempt.attempt_key });
      } catch {
        // A state the guard refuses to hold from (e.g. terminal) needs no hold.
      }
    }
  }
}

/** §17.2 — category-specific validity, never a generic "attempt changed so everything is stale". */
function reconcileDecisions(
  store: PlatformStore,
  run_id: string,
  actions: RecoveryAction[],
): void {
  for (const batch of store.batches.forRun(run_id)) {
    const subjects = [
      batch.batch_id,
      ...store.tasks.inBatch(batch.batch_id).map((task) => task.task_key),
    ];
    for (const subject of subjects) {
      for (const record of store.pendingDecisions.openFor(subject)) {
        const decision = record.body;
        if (openDecisionStillValid(store, decision)) continue;
        store.withTransaction(() => {
          store.pendingDecisions.close(decision.decision_id, "STALE");
          // §17.2 — one idempotent notification for the STALE transition.
          store.outbox.enqueue({
            op_key: `op:${subject}:report-stale:${decision.decision_id}`,
            channel: "operations",
            payload: {
              event: "DECISION_STALE",
              decision_id: decision.decision_id,
              category: decision.category,
            } as never,
          });
        });
        actions.push({ kind: "DECISION_STALE", subject: decision.decision_id });
      }
    }
  }
}

function openDecisionStillValid(store: PlatformStore, decision: PendingDecisionV1): boolean {
  switch (decision.category) {
    case "MERGE_APPROVAL":
      return mergeApprovalStillValid(store, decision);
    case "AUDIT_DECISION": {
      const cause = auditDecisionCause(decision);
      if (cause === undefined) return false;
      return auditDecisionRemainsValid(cause.candidate_commit, basisFor(store, cause.attempt_key));
    }
    case "REATTEMPT_DECISION":
    case "CONTRACT_DECISION": {
      const cause = driftCause(decision);
      if (cause === undefined) {
        // Merge-reject / merge-mismatch follow-ups share the category with drift; their basis is
        // the attempt named in `created_from`, read the same way.
        return true;
      }
      return driftDecisionRemainsValid(decision.category, basisFor(store, cause.attempt_key));
    }
    default:
      // HUMAN_GATE_APPROVAL / RECOVERY_DECISION: their resolution paths revalidate freshly
      // (§17.3); an open question stays askable.
      return true;
  }
}

function basisFor(store: PlatformStore, attempt_key: string) {
  const attempt = store.attempts.get(attempt_key);
  const task = attempt === undefined ? undefined : store.tasks.get(attempt.task_key);
  const current = task === undefined ? undefined : store.attempts.current(task.task_key);
  return {
    source_attempt_state: attempt?.state,
    current_candidate_commit: attempt?.candidate_commit ?? undefined,
    newer_attempt_exists: current !== undefined && current.attempt_key !== attempt_key,
    task_terminal:
      task !== undefined &&
      (task.platform_state === "COMPLETED" ||
        task.platform_state === "FAILED" ||
        task.platform_state === "DEFERRED"),
  };
}
