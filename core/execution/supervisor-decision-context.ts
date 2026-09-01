/**
 * SupervisorDecisionContextV1/V2 — the exact model-facing projection of one Supervisor turn's
 * authoritative basis (TD §13.4 D23; §13.4 MVP 3 context v2, D24).
 *
 * This is a narrow typed DTO for exactly one producer — `SupervisorProposalV1` — not a generic
 * DecisionContext/FactRegistry/Prompt framework. Every field is a projection of an authoritative
 * owner read **fresh for this turn**:
 *
 *   compiled_profile   the batch-bound immutable Compiled Profile snapshot (never the registry)
 *   candidates         one coherent fresh TaskSource basis per ref (discover + get_task +
 *                      get_dependencies; one external-state observation, never two mixed)
 *   current_state      the durable Platform batch/task/attempt projection at assembly time
 *   repository         the fresh RepositoryAdapter canonical head
 *   open_decisions     OPEN PendingHumanDecision records scoped to this run/batch/tasks
 *   proposal_id        the Platform allocation the model must echo unchanged (D23)
 *
 * The context is Model *input*, never a second authority (I-TD3): V3/V8 revalidate against fresh
 * authoritative facts at submission, not against this snapshot. A required read that fails, an
 * identity mismatch, or a partial candidate assembly throws — the turn is not sent with a
 * repaired or truncated context, and stale durable `external_snapshot` never fills TaskSource
 * gaps.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type { RepositoryValidationView } from "../decision/types.ts";
import type { DecisionValidationBatchView } from "../decision/types.ts";
import type { PendingDecisionV1 } from "../humandecision/types.ts";
import { subjectKey } from "../humandecision/pending-decision.ts";
import type {
  AttemptState,
  BatchState,
  SelectionBindingV1,
  TaskState,
} from "../store/domain-types.ts";
import { isTerminalTask } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { normalizeTaskDefinition } from "../tasksource/task-definition.ts";
import type {
  ExternalTaskState,
  TaskDefinition,
  TaskDependency,
  TaskSourceV1,
} from "../tasksource/types.ts";
import { ExecutionStartError } from "./start-implementation.ts";

export interface SupervisorCompiledProfileDecisionViewV1 {
  readonly hash: string;
  /** `effective.policy.classification_policy` exact map. */
  readonly classifications: Readonly<Record<string, string>>;
  /** `effective.project.pipelines` exact map. */
  readonly pipelines: Readonly<Record<string, unknown>>;
  /** `effective.project.roles` exact map; v1 carries no role-type filter. */
  readonly actor_profiles: Readonly<Record<string, unknown>>;
  readonly verification_profiles: Readonly<Record<string, unknown>>;
  readonly repository_scopes: Readonly<Record<string, unknown>>;
}

export interface SupervisorTaskDecisionViewV1 {
  readonly task_ref: string;
  readonly external_state: ExternalTaskState;
  readonly task_definition: TaskDefinition;
  readonly dependencies: readonly TaskDependency[];
}

export interface SupervisorPlatformTaskStateViewV1 {
  readonly task_key: string;
  readonly task_ref: string;
  readonly platform_state: TaskState;
  readonly selection: {
    readonly classification: string;
    readonly pipeline_id: string;
    readonly actor_profile: string;
    readonly verification_profile: string;
    readonly repository_scope_id: string;
    readonly selection_binding: SelectionBindingV1;
  } | null;
  readonly state_reason: { readonly code: string; readonly log_seq: number } | null;
  readonly current_attempt: {
    readonly attempt_key: string;
    readonly n: number;
    readonly state: AttemptState;
    readonly task_contract_hash: string;
    readonly base_head: string;
    readonly candidate_commit: string | null;
    readonly rework_count: number;
    readonly state_reason: { readonly code: string; readonly log_seq: number } | null;
  } | null;
}

export interface SupervisorCurrentStateViewV1 {
  readonly batch: {
    readonly status: BatchState;
    readonly admission_closed: boolean;
    readonly validation: DecisionValidationBatchView;
  };
  readonly tasks: readonly SupervisorPlatformTaskStateViewV1[];
}

export interface SupervisorDecisionContextV1 {
  readonly run_id: string;
  readonly batch_id: string;
  /** Platform allocated before the Runtime turn; the model echoes it unchanged (D23). */
  readonly proposal_id: string;
  readonly compiled_profile: SupervisorCompiledProfileDecisionViewV1;
  readonly candidates: readonly SupervisorTaskDecisionViewV1[];
  readonly current_state: SupervisorCurrentStateViewV1;
  readonly repository: RepositoryValidationView;
  readonly open_decisions: readonly PendingDecisionV1[];
}

/**
 * §13.4 MVP 3 (D24) — the one required additive field of context v2, projected read-only from the
 * immutable materialisation snapshots + idempotency + task binding. `phase` is not a durable
 * lifecycle state and `remaining_task_capacity` is a §9.2g reservation projection, not authority.
 */
export interface SupervisorSubflowMaterializationViewV1 {
  readonly available: boolean;
  readonly remaining_task_capacity: number;
  readonly operations: readonly {
    readonly materialization_id: string;
    readonly parent_task_key: string;
    readonly child_definition_hash: string;
    readonly phase: "INTENT" | "COMMITTED_NOT_OBSERVED" | "OBSERVED";
    readonly task_ref: string | null;
  }[];
}

export interface SupervisorDecisionContextV2 extends SupervisorDecisionContextV1 {
  readonly subflow_materialization: SupervisorSubflowMaterializationViewV1;
}

export interface SupervisorContextAuthorities {
  readonly store: PlatformStore;
  readonly taskSource: TaskSourceV1;
  readonly repository: RepositoryAdapter;
}

export interface SupervisorContextCommand {
  readonly run_id: string;
  readonly batch_id: string;
  /** The pre-turn Platform allocation (existing caller-supplied ULID seam, §17.1). */
  readonly proposal_id: string;
  /** Caller-supplied observation time for the fresh discovery pass; no Core clock. */
  readonly observed_at: string;
}

/**
 * Assembles the exact V1 context for one turn, or throws. A thrown assembly means the Supervisor
 * turn is not sent at all — there is no partial or repaired context.
 */
export function assembleSupervisorDecisionContext(
  authorities: SupervisorContextAuthorities,
  command: SupervisorContextCommand,
): SupervisorDecisionContextV1 {
  const { store, taskSource } = authorities;
  const batch = store.batches.require(command.batch_id);
  if (batch.run_id !== command.run_id) {
    throw new ExecutionStartError(`${command.batch_id} belongs to ${batch.run_id}, not ${command.run_id}`);
  }
  const compiled = store.batchView.compiledProfileFor(command.batch_id);

  // --- candidates: one coherent fresh TaskSource basis per ref -------------------------------
  // The ref set is the union of this turn's fresh discovery and the batch's current non-terminal
  // durable refs; a ref appearing in both is one candidate. Where fresh discovery already
  // provided the external state, that single observation is used (§8.4) — get_task_state is not
  // called a second time to mix two external-state observations.
  const discovered = taskSource.discover_tasks({ observed_at: command.observed_at });
  const discoveredState = new Map<string, ExternalTaskState>();
  for (const candidate of discovered) {
    if (typeof candidate.task_ref !== "string" || candidate.task_ref.length === 0) {
      throw new ExecutionStartError("discovery returned a candidate without a task_ref");
    }
    discoveredState.set(candidate.task_ref, candidate.external_state);
  }
  const durableTasks = store.tasks.inBatch(command.batch_id);
  const refs = new Set<string>(discoveredState.keys());
  for (const task of durableTasks) {
    if (!isTerminalTask(task.platform_state)) refs.add(task.external_task_ref);
  }

  const candidates: SupervisorTaskDecisionViewV1[] = [];
  for (const ref of [...refs].sort()) {
    const raw = taskSource.get_task(ref);
    const definition = normalizeTaskDefinition(
      {
        task_ref: raw.task_ref,
        version: raw.version,
        ...(raw.definition_hash === undefined ? {} : { definition_hash: raw.definition_hash }),
        body: raw.body,
      },
      `/candidates/${ref}`,
    );
    if (definition.task_ref !== ref) {
      throw new ExecutionStartError(`the source returned ${definition.task_ref} for ${ref}`);
    }
    const dependencies = taskSource.get_dependencies(ref);
    const external_state = discoveredState.get(ref) ?? taskSource.get_task_state(ref);
    candidates.push({ task_ref: ref, external_state, task_definition: definition, dependencies });
  }

  // --- current durable state ------------------------------------------------------------------
  const tasks: SupervisorPlatformTaskStateViewV1[] = durableTasks.map((task) => {
    const selected =
      task.classification !== null ||
      task.pipeline_id !== null ||
      task.actor_profile !== null ||
      task.verification_profile !== null;
    let selection: SupervisorPlatformTaskStateViewV1["selection"] = null;
    if (selected) {
      if (
        task.classification === null ||
        task.pipeline_id === null ||
        task.actor_profile === null ||
        task.verification_profile === null ||
        task.repository_scope_id === null ||
        task.selection_binding === null
      ) {
        // An admitted task with a partial selection is not repaired into a "normal" context.
        throw new ExecutionStartError(`${task.task_key} has a partial durable selection`);
      }
      selection = {
        classification: task.classification,
        pipeline_id: task.pipeline_id,
        actor_profile: task.actor_profile,
        verification_profile: task.verification_profile,
        repository_scope_id: task.repository_scope_id,
        selection_binding: task.selection_binding,
      };
    }

    const attempt = store.attempts.current(task.task_key);
    let current_attempt: SupervisorPlatformTaskStateViewV1["current_attempt"] = null;
    if (attempt !== undefined) {
      const task_contract_hash = store.contracts.hashOf(attempt.contract_snapshot_id);
      if (typeof task_contract_hash !== "string" || task_contract_hash.length === 0) {
        throw new ExecutionStartError(`${attempt.attempt_key} has no projectable Task Contract hash`);
      }
      current_attempt = {
        attempt_key: attempt.attempt_key,
        n: attempt.n,
        state: attempt.state,
        task_contract_hash,
        base_head: attempt.base_head,
        candidate_commit: attempt.candidate_commit,
        rework_count: attempt.rework_count,
        state_reason: attempt.state_reason ?? null,
      };
    }

    return {
      task_key: task.task_key,
      task_ref: task.external_task_ref,
      platform_state: task.platform_state,
      selection,
      state_reason: task.state_reason ?? null,
      current_attempt,
    };
  });

  // --- open decisions: OPEN records scoped to this run's project/batch/tasks ------------------
  const run = store.runs.require(command.run_id);
  const open: PendingDecisionV1[] = [];
  const seen = new Set<string>();
  const collect = (subject: string): void => {
    for (const record of store.pendingDecisions.openFor(subject)) {
      if (seen.has(record.body.decision_id)) continue;
      seen.add(record.body.decision_id);
      open.push(record.body);
    }
  };
  collect(subjectKey({ kind: "PROJECT", project_id: run.project_id }));
  collect(command.batch_id);
  for (const task of durableTasks) collect(task.task_key);

  const effective = compiled.effective;
  return {
    run_id: command.run_id,
    batch_id: command.batch_id,
    proposal_id: command.proposal_id,
    compiled_profile: {
      hash: batch.compiled_profile_hash,
      classifications: effective.policy.classification_policy as Readonly<Record<string, string>>,
      pipelines: effective.project.pipelines as Readonly<Record<string, unknown>>,
      actor_profiles: effective.project.roles as Readonly<Record<string, unknown>>,
      verification_profiles: effective.project.verification_profiles as Readonly<
        Record<string, unknown>
      >,
      repository_scopes: effective.project.repository_scopes as Readonly<Record<string, unknown>>,
    },
    candidates,
    current_state: {
      batch: {
        status: batch.status,
        admission_closed: batch.admission_closed,
        validation: store.batchView.project(command.batch_id),
      },
      tasks,
    },
    repository: { canonical_head: authorities.repository.snapshot_canonical().head },
    open_decisions: open,
  };
}
