/**
 * Measurement Projection — attempt-level aggregate (TD §5.12, §24.1; D20/D21).
 *
 * "실행된 계약으로 귀속하라 — 라벨로 분류하지 말라": every value here is a read-only derivation of
 * an existing durable record, attributed to the frozen contract and the real transitions.
 * Availability is honest by construction:
 *
 *   - a metric whose source record does not exist is `UNKNOWN`, never estimated;
 *   - provider/model identity comes only from a stored §13.2a observation (`REPORTED`); a profile
 *     name is never promoted to a model identity;
 *   - usage/cost are `UNKNOWN` until a backend reports them — wall-clock and price tables are not
 *     an estimator here;
 *   - stage durations derive from transition timestamps only when those parse as instants.
 *
 * §24.1: `FailureAttributionV1` rides beside the lifecycle code and replaces nothing. It is
 * derived only where the mapping is deterministic; everything else is `UNKNOWN`, and no dashboard
 * may re-bucket UNKNOWN into a "closest" domain.
 */

import type { PlatformStore } from "../store/platform-store.ts";
import type { TaskContractV1Body } from "../contract/types.ts";

export type Availability<T> =
  | { readonly kind: "REPORTED"; readonly value: T }
  | { readonly kind: "UNKNOWN" };

export const UNKNOWN = { kind: "UNKNOWN" } as const;

/** §24.1 — diagnostic attribution beside (never instead of) the lifecycle code. */
export interface FailureAttributionV1 {
  readonly domain:
    | "PROVIDER_AVAILABILITY"
    | "PROVIDER_AUTH_CONFIG"
    | "RUNTIME_INFRASTRUCTURE"
    | "WORKFLOW_INFRASTRUCTURE"
    | "VERIFICATION_INFRASTRUCTURE"
    | "REPOSITORY_INFRASTRUCTURE"
    | "MODEL_TASK"
    | "MODEL_PROTOCOL"
    | "CONTRACT_OR_AUTHORITY"
    | "HUMAN_PENDING"
    | "UNKNOWN";
  readonly detail_code: string;
  readonly source_ref: string;
  readonly reporter: "BACKEND" | "PLATFORM" | "VERIFIER" | "AUDITOR" | "HUMAN";
  readonly retryable: Availability<boolean>;
}

export interface MeasurementPacketV1 {
  readonly attempt_key: string;
  readonly task_contract_hash: Availability<string>;
  readonly role_bindings: Availability<{
    readonly actor_profile: string;
    readonly pipeline_id: string;
    readonly verification_profile: string;
  }>;
  /** Actual provider/model identity — REPORTED only from a stored §13.2a observation. */
  readonly actual_provider: Availability<string>;
  readonly actual_model: Availability<string>;
  readonly stage_durations_ms: Availability<Readonly<Record<string, number>>>;
  readonly rework_count: number;
  readonly audit_rounds: number;
  /** I-TD8 makes this a definition, not a guess: decisions opened about this task. */
  readonly human_handoffs: number;
  /** Actual human actions: resolved decisions. Deliberately not the same metric as handoffs. */
  readonly human_interventions: number;
  readonly usage: Availability<never>;
  readonly cost: Availability<never>;
  readonly final_outcome: {
    readonly attempt_state: string;
    readonly task_state: string;
    readonly reason: string | null;
  };
  readonly failure_attribution: FailureAttributionV1 | null;
}

/** Builds the §5.12 attempt-level aggregate. Pure derivation; writes nothing. */
export function measurementPacket(store: PlatformStore, attempt_key: string): MeasurementPacketV1 {
  const attempt = store.attempts.require(attempt_key);
  const task = store.tasks.require(attempt.task_key);
  const contractHash = store.contracts.hashOf(attempt.contract_snapshot_id);
  const contract = store.contracts.get(attempt.contract_snapshot_id);
  const body = contract?.body as unknown as TaskContractV1Body | undefined;

  const decisions = store.pendingDecisions.forSubject(task.task_key);
  const audits = store.auditRecords.forAttempt(attempt_key);

  return {
    attempt_key,
    task_contract_hash:
      contractHash === undefined ? UNKNOWN : { kind: "REPORTED", value: contractHash },
    role_bindings:
      body === undefined
        ? UNKNOWN
        : {
            kind: "REPORTED",
            value: {
              actor_profile: task.actor_profile ?? "",
              pipeline_id: body.pipeline_id,
              verification_profile: body.verification_profile,
            },
          },
    actual_provider: storedObservationField(store, attempt_key, "provider"),
    actual_model: storedObservationField(store, attempt_key, "model"),
    stage_durations_ms: stageDurations(store, attempt_key),
    rework_count: attempt.rework_count,
    audit_rounds: audits.length,
    human_handoffs: decisions.length,
    human_interventions: decisions.filter((record) => record.body.status === "RESOLVED").length,
    usage: UNKNOWN,
    cost: UNKNOWN,
    final_outcome: {
      attempt_state: attempt.state,
      task_state: task.platform_state,
      reason: attempt.state_reason?.code ?? task.state_reason?.code ?? null,
    },
    failure_attribution: attribution(attempt.state_reason?.code ?? task.state_reason?.code ?? null, attempt_key),
  };
}

/** Reads a §13.2a observation field out of the attempt's durable turn-result projection, if any. */
function storedObservationField(
  store: PlatformStore,
  attempt_key: string,
  field: "provider" | "model",
): Availability<string> {
  const rows = store.adapterMetadata
    .forEntity(attempt_key)
    .filter((row) => row.adapter_id === "runtime" && row.key.startsWith("actor_turn_result:"));
  for (const row of rows.reverse()) {
    const observation = (row.value as { execution_observation?: Record<string, unknown> })
      .execution_observation;
    const entry = (observation?.["actual"] as Record<string, unknown> | undefined)?.[field] as
      | { availability?: string; value?: string }
      | undefined;
    if (entry?.availability === "REPORTED" && typeof entry.value === "string") {
      return { kind: "REPORTED", value: entry.value };
    }
  }
  return UNKNOWN;
}

/** Durations from `state_transition` timestamps — only when the store clock parses as instants. */
function stageDurations(
  store: PlatformStore,
  attempt_key: string,
): Availability<Readonly<Record<string, number>>> {
  const transitions = store.decisions
    .read()
    .filter(
      (entry) =>
        entry.kind === "state_transition" &&
        (entry.payload as { primary_entity_key?: string }).primary_entity_key === attempt_key,
    );
  if (transitions.length < 2) return UNKNOWN;

  const durations: Record<string, number> = {};
  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1]!;
    const current = transitions[index]!;
    const from = Date.parse(previous.ts);
    const to = Date.parse(current.ts);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return UNKNOWN;
    const stage = (previous.payload as { attempt?: { to?: string } }).attempt?.to;
    if (typeof stage !== "string") continue;
    durations[stage] = (durations[stage] ?? 0) + (to - from);
  }
  return Object.keys(durations).length === 0 ? UNKNOWN : { kind: "REPORTED", value: durations };
}

/** §24.1 — only deterministic mappings; everything else stays UNKNOWN, never re-bucketed. */
function attribution(reason: string | null, attempt_key: string): FailureAttributionV1 | null {
  if (reason === null) return null;
  const source_ref = `attempt:${attempt_key}`;
  const base = { detail_code: reason, source_ref, retryable: UNKNOWN } as const;
  if (reason === "VERIFICATION_INFRA") {
    return { ...base, domain: "VERIFICATION_INFRASTRUCTURE", reporter: "PLATFORM" };
  }
  if (reason === "AUDIT_INVALID" || reason === "AUDIT_UNUSABLE") {
    return { ...base, domain: "MODEL_PROTOCOL", reporter: "PLATFORM" };
  }
  if (reason.startsWith("BLOCKED_BY_DECISION:") || reason === "AUDIT_HUMAN_REQUIRED") {
    return { ...base, domain: "HUMAN_PENDING", reporter: "PLATFORM" };
  }
  if (reason === "CONTRACT_DRIFT" || reason === "SELECTION_STALE") {
    return { ...base, domain: "CONTRACT_OR_AUTHORITY", reporter: "PLATFORM" };
  }
  return { ...base, domain: "UNKNOWN", reporter: "PLATFORM" };
}

/**
 * §5.14 (Operator-evidence amendment) — evaluation input completeness for one sample.
 *
 * `PRESENT` is never claimed from mere Store existence: it requires operation-bound provenance
 * that the role actually received (or could read) the context in that turn. The current Backend
 * records no such delivery observation, so the honest derivation is `UNKNOWN` everywhere the
 * proof is missing — and a sample whose completeness is UNKNOWN must not be pooled with a
 * COMPLETE cohort.
 */
export interface EvaluationInputContextV1 {
  readonly role_input_context_identity: Availability<string>;
  readonly required_context_manifest_ref: string;
  readonly contract_context: "PRESENT" | "ABSENT" | "UNKNOWN";
  readonly acceptance_context: "PRESENT" | "ABSENT" | "UNKNOWN";
  readonly authority_boundary_context: "PRESENT" | "ABSENT" | "UNKNOWN";
  readonly input_completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  readonly provenance_refs: readonly string[];
}

/** Derives the honest input-context statement for one attempt's Actor sample. */
export function evaluationInputContext(
  store: PlatformStore,
  attempt_key: string,
): EvaluationInputContextV1 {
  const attempt = store.attempts.require(attempt_key);
  const contract = store.contracts.get(attempt.contract_snapshot_id);
  // The contract exists in the Store — but §5.14 forbids promoting that to PRESENT without
  // operation-bound delivery provenance, which Backend v1 does not record. UNKNOWN it is.
  void contract;
  return {
    role_input_context_identity: UNKNOWN,
    required_context_manifest_ref: "platform/task-contract@v1",
    contract_context: "UNKNOWN",
    acceptance_context: "UNKNOWN",
    authority_boundary_context: "UNKNOWN",
    input_completeness: "UNKNOWN",
    provenance_refs: [`attempt:${attempt_key}`],
  };
}
