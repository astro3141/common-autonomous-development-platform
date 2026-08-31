/**
 * `monitor_once` — prospective read-only monitoring (TD §22.5, D20/D21).
 *
 * **Monitoring is observation, not authority. An anomaly is not a lifecycle fact.** This module
 * derives anomaly observations from durable, re-readable sources and returns them; it performs no
 * transition, no retry, no session spawn, no issue creation and no actuation of any kind. The one
 * thing an anomaly may cause is what its `recommended_reobservation_scope` says: an authoritative
 * re-observation through §22.1's owners, which the ordinary tick and `recoverRun` already are.
 *
 * Coverage honesty (§22.5): every signal here is derived from the Platform Store — a durable
 * source that survives restarts and subscribers — so `COMPLETE` coverage is claimable with the
 * store itself as the basis. The single adapter-assisted signal
 * (`EXTERNAL_COMPLETION_UNPROJECTED`) degrades to `PARTIAL` when the adapter cannot answer,
 * and absence of an answer never becomes a confident ABSENT claim.
 *
 * Thresholds are deployment configuration, resolved per lifecycle state when declared — never a
 * Core constant, never Compiled-Profile policy, and never an actuation authority.
 */

import type { RuntimeTurnHandle } from "../../adapters/interfaces/handles.ts";
import { isTerminalTask } from "../store/domain-types.ts";
import type { ProductionCoordinatorDependencies } from "./production-coordinator.ts";

/** §22.5 — the derived observation. A read model, never an authority artifact. */
export interface AnomalyObservationV1 {
  readonly anomaly_kind:
    | "DURABLE_PROGRESS_STALE"
    | "INTENT_UNRESOLVED"
    | "EXTERNAL_COMPLETION_UNPROJECTED"
    | "NEXT_OWNER_MISSING";
  readonly subject_ref: string;
  readonly signal_refs: readonly string[];
  readonly observed_at: string;
  readonly observed_window: { readonly from: string; readonly to: string };
  readonly coverage: "COMPLETE" | "PARTIAL" | "JOINED_MID_SUBJECT";
  readonly coverage_basis_refs: readonly string[];
  readonly trigger_config_ref: string;
  readonly recommended_reobservation_scope: string;
}

/** Deployment-owned trigger configuration. Numbers live here, never in Core invariants. */
export interface MonitorTriggerConfig {
  /** Staleness threshold in milliseconds for machine-owned states. */
  readonly stale_after_ms: number;
  /** Optional per-state overrides (§22.5 state-aware threshold resolution). */
  readonly stale_after_ms_by_state?: Readonly<Record<string, number>>;
  /** Unresolved-INTENT threshold in milliseconds. */
  readonly intent_unresolved_after_ms: number;
  /** A reference naming this configuration for provenance. */
  readonly config_ref: string;
}

export interface MonitorCommand {
  readonly run_id: string;
  /** Injected clock (§22.5) — wall clock is never lifecycle authority. */
  readonly now: string;
  readonly trigger_config: MonitorTriggerConfig;
}

/** The attempt states a machine, not a person, is expected to move (§22.5 threshold keying). */
const MACHINE_OWNED_ATTEMPT_STATES: readonly string[] = [
  "READY",
  "IMPLEMENTING",
  "VERIFYING",
  "AUDITING",
  "REWORKING",
  "MERGING",
];

/** One bounded, caller-driven, read-only scan. Never schedules itself and never acts. */
export function monitorOnce(
  deps: Pick<ProductionCoordinatorDependencies, "store" | "runtime">,
  command: MonitorCommand,
): readonly AnomalyObservationV1[] {
  const { store } = deps;
  const anomalies: AnomalyObservationV1[] = [];
  const now = Date.parse(command.now);
  const config = command.trigger_config;

  const run = store.runs.get(command.run_id);
  if (run === undefined) return anomalies;

  const base = {
    observed_at: command.now,
    trigger_config_ref: config.config_ref,
  };

  for (const batch of store.batches.forRun(command.run_id)) {
    for (const task of store.tasks.inBatch(batch.batch_id)) {
      if (isTerminalTask(task.platform_state)) continue;
      const attempt = store.attempts.current(task.task_key);

      // --- DURABLE_PROGRESS_STALE -------------------------------------------------------------
      if (
        task.platform_state === "ACTIVE" &&
        attempt !== undefined &&
        MACHINE_OWNED_ATTEMPT_STATES.includes(attempt.state)
      ) {
        const threshold =
          config.stale_after_ms_by_state?.[attempt.state] ?? config.stale_after_ms;
        const updated = Date.parse(attempt.updated_at);
        if (Number.isFinite(updated) && now - updated > threshold) {
          anomalies.push({
            ...base,
            anomaly_kind: "DURABLE_PROGRESS_STALE",
            subject_ref: attempt.attempt_key,
            signal_refs: [`store:task_attempt:${attempt.attempt_key}:updated_at`],
            observed_window: { from: attempt.updated_at, to: command.now },
            coverage: "COMPLETE",
            coverage_basis_refs: ["store:task_attempt"],
            recommended_reobservation_scope: `attempt:${attempt.attempt_key}`,
          });
        }
      }

      // --- NEXT_OWNER_MISSING (I-TD8 derivation) ----------------------------------------------
      if (task.platform_state === "HELD") {
        const reason = task.state_reason?.code ?? "";
        const match = /^BLOCKED_BY_DECISION:(.+)$/.exec(reason);
        if (match !== null) {
          const decision = store.pendingDecisions.get(match[1] ?? "");
          if (decision === undefined || decision.body.status !== "OPEN") {
            anomalies.push({
              ...base,
              anomaly_kind: "NEXT_OWNER_MISSING",
              subject_ref: task.task_key,
              signal_refs: [`store:task:${task.task_key}:state_reason`, `decision:${match[1]}`],
              observed_window: { from: task.updated_at, to: command.now },
              coverage: "COMPLETE",
              coverage_basis_refs: ["store:task", "store:pending_human_decision"],
              recommended_reobservation_scope: `task:${task.task_key}`,
            });
          }
        }
      }

      // --- EXTERNAL_COMPLETION_UNPROJECTED ----------------------------------------------------
      if (attempt !== undefined && attempt.state === "IMPLEMENTING") {
        const turn = store.adapterMetadata
          .forEntity(attempt.attempt_key)
          .find((row) => row.adapter_id === "runtime" && row.key.startsWith("actor_turn:"));
        if (turn !== undefined) {
          try {
            const result = deps.runtime.get_turn_result(
              turn.value as unknown as RuntimeTurnHandle,
            );
            if (result.backend_status === "COMPLETED") {
              anomalies.push({
                ...base,
                anomaly_kind: "EXTERNAL_COMPLETION_UNPROJECTED",
                subject_ref: attempt.attempt_key,
                signal_refs: [`runtime:${turn.key}`, `store:task_attempt:${attempt.attempt_key}`],
                observed_window: { from: attempt.updated_at, to: command.now },
                coverage: "COMPLETE",
                coverage_basis_refs: ["store:adapter_metadata", "runtime:turn_result"],
                recommended_reobservation_scope: `attempt:${attempt.attempt_key}`,
              });
            }
          } catch {
            // A turn without a terminal projection is not an anomaly, and an unobservable one is
            // an honest UNKNOWN — never a confident absence claim (§22.5).
          }
        }
      }
    }
  }

  // --- INTENT_UNRESOLVED (store-wide; the idempotency table is the durable source itself) ------
  for (const record of store.idempotency.unresolvedIntents()) {
    const at = Date.parse(record.ts);
    if (!Number.isFinite(at) || now - at <= config.intent_unresolved_after_ms) continue;
    anomalies.push({
      ...base,
      anomaly_kind: "INTENT_UNRESOLVED",
      subject_ref: record.opKey,
      signal_refs: [`store:idempotency:${record.opKey}`],
      observed_window: { from: record.ts, to: command.now },
      coverage: "COMPLETE",
      coverage_basis_refs: ["store:idempotency"],
      recommended_reobservation_scope: `op:${record.opKey}`,
    });
  }

  return anomalies;
}
