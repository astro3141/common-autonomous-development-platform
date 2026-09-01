/**
 * `monitor_once` — prospective read-only monitoring (TD §22.5, D20/D21).
 *
 * **Monitoring is observation, not authority. An anomaly is not a lifecycle fact.** This module
 * derives anomaly observations from durable, re-readable sources and returns them; it performs no
 * transition, no retry, no session spawn, no issue creation and no actuation of any kind. The one
 * thing an anomaly may cause is what its `recommended_reobservation_scope` says: an authoritative
 * re-observation through §22.1's owners, which the ordinary tick and `recoverRun` already are.
 *
 * The §22.5 signal vocabulary is carried in full (finding 13):
 *
 *   DURABLE_PROGRESS_STALE          machine-owned state older than its resolved threshold
 *   EXTERNAL_COMPLETION_UNPROJECTED backend terminal operation vs Platform non-terminal projection
 *   INTENT_UNRESOLVED               a write-ahead INTENT past its threshold
 *   TERMINAL_DIVERGENCE             backend/repository terminal *state* vs Platform non-terminal
 *   EXPECTED_SUCCESSOR_MISSING      a committed transition whose op-grammar successor never began
 *   RECOVERY_OR_HOLD_REPEATED       the same subject re-held for the same reason within a window
 *   REQUIRED_REF_MISSING            an active state whose required durable artifact cannot be read
 *   NEXT_OWNER_MISSING              a blocked record whose I-TD8 owner derivation fails
 *
 * Coverage honesty (§22.5): a failed authority query degrades that authority to `UNAVAILABLE` in
 * `authority_coverage` and suppresses only the claims that needed it — one dead authority never
 * kills the packet, and absence of an answer is never a confident ABSENT. Thresholds resolve per
 * `pipeline:state` key when declared, then per state, then the default, and every threshold-based
 * anomaly names the key it resolved through (`threshold_ref`). All numbers stay deployment
 * configuration — never a Core constant, never Compiled-Profile policy, never actuation authority.
 */

import type { RuntimeTurnHandle, VerificationRunHandle } from "../../adapters/interfaces/handles.ts";
import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type { VerificationAdapter } from "../../adapters/interfaces/verification-adapter.ts";
import { STATE_TRANSITION_KIND } from "../statemachine/transition-commit.ts";
import { isTerminalTask } from "../store/domain-types.ts";
import type { ProductionCoordinatorDependencies } from "./production-coordinator.ts";

/** §22.5 — the derived observation. A read model, never an authority artifact. */
export interface AnomalyObservationV1 {
  readonly anomaly_kind:
    | "DURABLE_PROGRESS_STALE"
    | "EXTERNAL_COMPLETION_UNPROJECTED"
    | "INTENT_UNRESOLVED"
    | "TERMINAL_DIVERGENCE"
    | "EXPECTED_SUCCESSOR_MISSING"
    | "RECOVERY_OR_HOLD_REPEATED"
    | "REQUIRED_REF_MISSING"
    | "NEXT_OWNER_MISSING";
  readonly subject_ref: string;
  readonly signal_refs: readonly string[];
  readonly observed_at: string;
  readonly observed_window: { readonly from: string; readonly to: string };
  readonly coverage: "COMPLETE" | "PARTIAL" | "JOINED_MID_SUBJECT";
  readonly coverage_basis_refs: readonly string[];
  readonly trigger_config_ref: string;
  /** The resolved threshold key, for threshold-based signals (§22.5 provenance). */
  readonly threshold_ref?: string;
  readonly recommended_reobservation_scope: string;
}

/** Deployment-owned trigger configuration. Numbers live here, never in Core invariants. */
export interface MonitorTriggerConfig {
  /** Staleness threshold in milliseconds for machine-owned states. */
  readonly stale_after_ms: number;
  /** Optional per-state overrides (§22.5 state-aware threshold resolution). */
  readonly stale_after_ms_by_state?: Readonly<Record<string, number>>;
  /** Optional per-`pipeline:state` overrides — the most specific §22.5 key. */
  readonly stale_after_ms_by_pipeline_state?: Readonly<Record<string, number>>;
  /** Unresolved-INTENT threshold in milliseconds. */
  readonly intent_unresolved_after_ms: number;
  /** RECOVERY_OR_HOLD_REPEATED window and count (defaults: 24h, 3). */
  readonly repeat_window_ms?: number;
  readonly repeat_count?: number;
  /** A reference naming this configuration for provenance. */
  readonly config_ref: string;
}

export interface MonitorCommand {
  readonly run_id: string;
  /** Injected clock (§22.5) — wall clock is never lifecycle authority. */
  readonly now: string;
  readonly trigger_config: MonitorTriggerConfig;
}

/** §22.5 partial-result semantics: which authorities answered during this scan. */
export type AuthorityCoverage = Readonly<
  Record<
    "store" | "runtime" | "repository" | "verification",
    "AVAILABLE" | "UNAVAILABLE" | "NOT_QUERIED"
  >
>;

export interface MonitorReport {
  readonly anomalies: readonly AnomalyObservationV1[];
  readonly authority_coverage: AuthorityCoverage;
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

type MonitorDeps = Pick<ProductionCoordinatorDependencies, "store" | "runtime"> & {
  readonly repository?: RepositoryAdapter;
  readonly verification?: VerificationAdapter;
};

/** One bounded, caller-driven, read-only scan. Never schedules itself and never acts. */
export function monitorOnce(deps: MonitorDeps, command: MonitorCommand): MonitorReport {
  const { store } = deps;
  const anomalies: AnomalyObservationV1[] = [];
  const now = Date.parse(command.now);
  const config = command.trigger_config;
  const coverage: Record<string, "AVAILABLE" | "UNAVAILABLE" | "NOT_QUERIED"> = {
    store: "AVAILABLE",
    runtime: "NOT_QUERIED",
    repository: "NOT_QUERIED",
    verification: "NOT_QUERIED",
  };
  const report = (): MonitorReport => ({
    anomalies,
    authority_coverage: coverage as AuthorityCoverage,
  });

  const run = store.runs.get(command.run_id);
  if (run === undefined) return report();

  const base = { observed_at: command.now, trigger_config_ref: config.config_ref };

  /** §22.5 keyed threshold resolution: pipeline:state → state → default, provenance included. */
  const staleThreshold = (
    pipeline: string | null,
    state: string,
  ): { readonly ms: number; readonly ref: string } => {
    if (pipeline !== null) {
      const key = `${pipeline}:${state}`;
      const specific = config.stale_after_ms_by_pipeline_state?.[key];
      if (specific !== undefined) {
        return { ms: specific, ref: `${config.config_ref}#by_pipeline_state[${key}]` };
      }
    }
    const byState = config.stale_after_ms_by_state?.[state];
    if (byState !== undefined) {
      return { ms: byState, ref: `${config.config_ref}#by_state[${state}]` };
    }
    return { ms: config.stale_after_ms, ref: `${config.config_ref}#default` };
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
        const threshold = staleThreshold(task.pipeline_id, attempt.state);
        const updated = Date.parse(attempt.updated_at);
        if (Number.isFinite(updated) && now - updated > threshold.ms) {
          anomalies.push({
            ...base,
            anomaly_kind: "DURABLE_PROGRESS_STALE",
            subject_ref: attempt.attempt_key,
            signal_refs: [`store:task_attempt:${attempt.attempt_key}:updated_at`],
            observed_window: { from: attempt.updated_at, to: command.now },
            coverage: "COMPLETE",
            coverage_basis_refs: ["store:task_attempt"],
            threshold_ref: threshold.ref,
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

      if (attempt === undefined) continue;

      // --- REQUIRED_REF_MISSING ---------------------------------------------------------------
      // The store answered (source available); a missing required artifact is a real ABSENT —
      // exactly the distinction §22.5 requires before claiming absence. A *corrupt* read is
      // unavailability instead, and claims nothing.
      if (!isTerminalAttemptState(attempt.state)) {
        try {
          if (store.contracts.get(attempt.contract_snapshot_id) === undefined) {
            anomalies.push({
              ...base,
              anomaly_kind: "REQUIRED_REF_MISSING",
              subject_ref: attempt.attempt_key,
              signal_refs: [`store:task_contract_snapshot:${attempt.contract_snapshot_id}`],
              observed_window: { from: attempt.updated_at, to: command.now },
              coverage: "COMPLETE",
              coverage_basis_refs: ["store:task_contract_snapshot (readable, row absent)"],
              recommended_reobservation_scope: `attempt:${attempt.attempt_key}`,
            });
          }
        } catch {
          coverage["store"] = "UNAVAILABLE";
        }
      }

      // --- EXPECTED_SUCCESSOR_MISSING ---------------------------------------------------------
      // Derived only from the frozen op-key grammar and the state machine (§22.5): a committed
      // READY expects `op:<attempt>:workspace`; REWORKING expects the next actor turn.
      if (attempt.state === "READY" || attempt.state === "REWORKING") {
        const successor =
          attempt.state === "READY"
            ? `op:${attempt.attempt_key}:workspace`
            : `op:${attempt.attempt_key}:actor-turn:${attempt.rework_count + 1}`;
        const threshold = staleThreshold(task.pipeline_id, attempt.state);
        const updated = Date.parse(attempt.updated_at);
        if (
          Number.isFinite(updated) &&
          now - updated > threshold.ms &&
          store.idempotency.get(successor) === undefined
        ) {
          anomalies.push({
            ...base,
            anomaly_kind: "EXPECTED_SUCCESSOR_MISSING",
            subject_ref: attempt.attempt_key,
            signal_refs: [`store:idempotency:${successor} (readable, row absent)`],
            observed_window: { from: attempt.updated_at, to: command.now },
            coverage: "COMPLETE",
            coverage_basis_refs: ["store:idempotency", "state-machine successor grammar (§21)"],
            threshold_ref: threshold.ref,
            recommended_reobservation_scope: `attempt:${attempt.attempt_key}`,
          });
        }
      }

      // --- EXTERNAL_COMPLETION_UNPROJECTED (runtime operation terminal) -----------------------
      // The *current* turn only (M1-15): a prior turn's terminal projection is history, not an
      // anomaly (finding 12 regression).
      if (attempt.state === "IMPLEMENTING") {
        const turn = store.adapterMetadata.get(
          attempt.attempt_key,
          "runtime",
          `actor_turn:${attempt.rework_count + 1}`,
        );
        if (turn !== undefined) {
          try {
            const result = deps.runtime.get_turn_result(turn.value as unknown as RuntimeTurnHandle);
            coverage["runtime"] = "AVAILABLE";
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
            // The runtime authority was queried but did not answer, so its coverage is
            // UNAVAILABLE; no anomaly can be claimed from that failed observation (§22.5).
            coverage["runtime"] = "UNAVAILABLE";
          }
        }
      }

      // --- EXTERNAL_COMPLETION_UNPROJECTED (verification run terminal) ------------------------
      if (attempt.state === "VERIFYING" && deps.verification !== undefined) {
        const run_ref = store.adapterMetadata.get(attempt.attempt_key, "verification", "run");
        if (run_ref !== undefined) {
          try {
            const observation = deps.verification.get_verification_result(
              run_ref.value as unknown as VerificationRunHandle,
            );
            coverage["verification"] = "AVAILABLE";
            if (observation.state !== "RUNNING") {
              anomalies.push({
                ...base,
                anomaly_kind: "EXTERNAL_COMPLETION_UNPROJECTED",
                subject_ref: attempt.attempt_key,
                signal_refs: ["verification:run", `store:task_attempt:${attempt.attempt_key}`],
                observed_window: { from: attempt.updated_at, to: command.now },
                coverage: "COMPLETE",
                coverage_basis_refs: ["store:adapter_metadata", "verification:run_observation"],
                recommended_reobservation_scope: `attempt:${attempt.attempt_key}`,
              });
            }
          } catch {
            coverage["verification"] = "UNAVAILABLE";
          }
        }
      }

      // --- TERMINAL_DIVERGENCE (repository terminal state vs Platform non-terminal) -----------
      // Both merge-pending states: awaiting the human answer (READY_TO_MERGE) and holding an
      // answer that has not been confirmed applied (APPROVED_FOR_MANUAL_MERGE). A candidate
      // already in canonical under either is the §22.5 divergence.
      if (
        (attempt.state === "READY_TO_MERGE" || attempt.state === "APPROVED_FOR_MANUAL_MERGE") &&
        attempt.candidate_commit !== null &&
        deps.repository !== undefined
      ) {
        try {
          const head = deps.repository.snapshot_canonical().head;
          coverage["repository"] = "AVAILABLE";
          const merged =
            head === attempt.candidate_commit ||
            deps.repository.verify_lineage(attempt.candidate_commit, head);
          if (merged) {
            anomalies.push({
              ...base,
              anomaly_kind: "TERMINAL_DIVERGENCE",
              subject_ref: attempt.attempt_key,
              signal_refs: [
                `repository:canonical:${head}`,
                `store:task_attempt:${attempt.attempt_key}`,
              ],
              observed_window: { from: attempt.updated_at, to: command.now },
              coverage: "COMPLETE",
              coverage_basis_refs: ["repository:snapshot_canonical", "repository:verify_lineage"],
              recommended_reobservation_scope: `attempt:${attempt.attempt_key}`,
            });
          }
        } catch {
          coverage["repository"] = "UNAVAILABLE";
        }
      }

      // --- RECOVERY_OR_HOLD_REPEATED ----------------------------------------------------------
      // Derived from the journal, only over parseable instants — an unparseable clock claims
      // nothing rather than fabricating a window.
      {
        const windowMs = config.repeat_window_ms ?? 24 * 3_600_000;
        const needed = config.repeat_count ?? 3;
        const byReason = new Map<string, { count: number; earliest: string }>();
        for (const entry of store.decisions.read()) {
          if (entry.kind !== STATE_TRANSITION_KIND) continue;
          const payload = entry.payload as {
            primary_entity_key?: string;
            task?: { to?: string };
            reason_code?: string | null;
          };
          if (
            payload.primary_entity_key !== attempt.attempt_key &&
            payload.primary_entity_key !== task.task_key
          ) {
            continue;
          }
          if (payload.task?.to !== "HELD") continue;
          const at = Date.parse(entry.ts);
          if (!Number.isFinite(at) || now - at > windowMs) continue;
          const reason = (payload.reason_code ?? "unreasoned").replace(
            /^BLOCKED_BY_DECISION:.*$/,
            "BLOCKED_BY_DECISION",
          );
          const seen = byReason.get(reason);
          byReason.set(reason, {
            count: (seen?.count ?? 0) + 1,
            earliest: seen === undefined || entry.ts < seen.earliest ? entry.ts : seen.earliest,
          });
        }
        for (const [reason, { count, earliest }] of byReason) {
          if (count < needed) continue;
          anomalies.push({
            ...base,
            anomaly_kind: "RECOVERY_OR_HOLD_REPEATED",
            subject_ref: task.task_key,
            signal_refs: [`store:decision_log:state_transition HELD(${reason}) ×${count}`],
            // The window's `from` is the earliest counted entry's own timestamp — an observed
            // instant, never clock arithmetic performed here (injected-clock rule, §22.5).
            observed_window: { from: earliest, to: command.now },
            coverage: "COMPLETE",
            coverage_basis_refs: ["store:decision_log"],
            threshold_ref: `${config.config_ref}#repeat[${needed}@${windowMs}ms]`,
            recommended_reobservation_scope: `task:${task.task_key}`,
          });
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
      threshold_ref: `${config.config_ref}#intent_unresolved`,
      recommended_reobservation_scope: `op:${record.opKey}`,
    });
  }

  return report();
}

function isTerminalAttemptState(state: string): boolean {
  return state === "MERGED" || state === "SUCCEEDED" || state === "INVALIDATED" || state === "FAILED";
}
