/**
 * Authoritative fact assembly for one decision (TD §5.6, §9.2, §19.3, §26 step 5).
 *
 * The Decision Validator is a pure function of already-observed facts, so *something* has to do
 * the observing. That is this module, and its whole job is:
 *
 *     authoritative owners → typed read models → DecisionValidationInput
 *
 * Each fact comes from the one component that owns it and is read **fresh** at submission time:
 * the TaskDefinition from the TaskSource, the canonical head from the RepositoryAdapter, the
 * Compiled Profile and the batch counts from the durable Store. Nothing is served from a cached
 * projection, because an approval or a Proposal may be arbitrarily old (Spec §50) and a stale
 * fact would silently turn a gate into a rubber stamp.
 *
 * There is no fact registry, no authority registry and no world-state object: the result is the
 * existing `DecisionValidationInput` and nothing else.
 */

import { validateManifestSet, type ManifestSetInput } from "../capability/manifest-set.ts";
import { activeSupervisorProposalAllocation } from "../decision/decision-log.ts";
import { validateProposal } from "../decision/proposal.ts";
import { DecisionError } from "../decision/errors.ts";
import type { DecisionValidationInput } from "../decision/validator.ts";
import type {
  ChildMaterializationBatchViewV1,
  ChildMaterializationCapabilityViewV1,
  ChildMaterializationParentViewV1,
  ProposalV1,
  SelectionAdmissionKind,
  SubflowChildMaterializationProposalV1,
  SubflowParentValidationView,
  SubflowSelectionProposalV1,
  TaskBearingProposalV1,
  TaskLookupView,
} from "../decision/types.ts";
import { isReattemptRequired, SELECTION_STALE, subflowChildOf } from "../statemachine/types.ts";
import { taskKey as buildTaskKey } from "../schemas/identifiers.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type {
  BatchRow,
  PlatformRunRow,
  SelectionBindingV1,
  TaskRow,
} from "../store/domain-types.ts";
import { TaskSourceError } from "../tasksource/errors.ts";
import { normalizeTaskDefinition } from "../tasksource/task-definition.ts";
import type { TaskDefinition, TaskDependency, TaskSourceV1 } from "../tasksource/types.ts";
import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import { AdmissionError } from "./errors.ts";
import { materializationBatchFacts } from "../materialization/materialize-child.ts";

/** The authoritative owners one submission reads from. Every one is an interface, not a class. */
export interface DecisionAuthorities {
  readonly store: PlatformStore;
  readonly taskSource: TaskSourceV1;
  readonly repository: RepositoryAdapter;
  /** Component manifests as configured; `validateManifestSet` runs before the validator (§12.2a). */
  readonly manifests: ManifestSetInput;
}

/** Routing context. Exactly three members — none of them belongs in the Proposal body (§9.1). */
export interface SubmissionContext {
  readonly run_id: string;
  readonly batch_id: string;
  /** Structured Supervisor input, unvalidated: V1 is the validator's step, not ours. */
  readonly proposal: unknown;
}

export interface AssembledDecision {
  readonly input: DecisionValidationInput;
  /**
   * TD §19.3a (M1-7) — the authoritative facts this decision was judged against, ready to become
   * the durable `SelectionBindingV1`. Built from the Platform's own fresh observations, never by
   * copying `Proposal.expected`, and `task_version`/`task_definition_hash` always come from the
   * one normalized TaskDefinition observation V2/V3 used.
   */
  readonly selection_basis: SelectionBindingV1 | null;
  /** TD §9.2e (M1-7) — derived from durable task state; never a Proposal field. */
  readonly admission_kind: SelectionAdmissionKind;
  /** `null` when the Proposal is structurally invalid and V1 will reject it. */
  readonly proposal: ProposalV1 | null;
  readonly run: PlatformRunRow;
  readonly batch: BatchRow;
  readonly task_key: string | null;
  readonly durable_task: TaskRow | null;
  /**
   * Fresh direct dependencies of a selection (TD §8.4: "MVP 1에서 dependency는 … admission 직전의
   * fresh guard에만 쓰인다"). Observed and handed to the caller; never persisted, cached, or
   * walked transitively.
   */
  readonly dependencies: readonly TaskDependency[];
}

/** Variants whose `expected` carries a `base_head`, so V8 applies (§9.1). */
const REPOSITORY_SENSITIVE: readonly ProposalV1["variant"][] = [
  "TASK_SELECTION",
  "SUBFLOW_SELECTION",
  "REPOSITORY_SENSITIVE_TASK_CONTROL",
];

export function assembleDecisionInput(
  authorities: DecisionAuthorities,
  context: SubmissionContext,
): AssembledDecision {
  const { store } = authorities;
  const { run, batch } = resolveTarget(store, context);

  // §7 — the profile the validator judges against is the batch's own durable snapshot, never a
  // body the Proposal supplied. The Proposal may only *assert* a hash, which V4 then compares.
  const compiled_profile = store.batchView.compiledProfileFor(batch.batch_id);
  const compiled_profile_hash = batch.compiled_profile_hash;

  const proposal = parseProposal(context.proposal);
  if (proposal === null) {
    // Nothing else can be assembled without a task_ref; V1 rejects and the run stops there.
    return {
      input: { proposal: context.proposal, compiled_profile, compiled_profile_hash },
      proposal: null,
      run,
      batch,
      task_key: null,
      durable_task: null,
      dependencies: [],
      selection_basis: null,
      admission_kind: "INITIAL_ADMISSION",
    };
  }

  const manifests = validateManifestSet(authorities.manifests);
  let task_key: string | null = null;
  let durable_task: TaskRow | null = null;
  let task: TaskLookupView | undefined;
  let dependencies: readonly TaskDependency[] = [];
  let definition: TaskDefinition | null = null;

  if (isTaskBearing(proposal)) {
    const membership = resolveDurableTask(store, run, batch, proposal);
    task_key = membership.task_key;
    durable_task = membership.task;
    task = lookupTask(authorities.taskSource, proposal, membership.task);
    definition = task.status === "FOUND" ? task.task : null;

    if (proposal.decision === "START_TASK" || proposal.decision === "START_SUBFLOW") {
      // TD §19.3 pre: "dependency 미차단". The read is fresh and required; what makes a direct
      // HARD dependency *blocking* is not defined by the TD or the state machine, so this batch
      // observes and reports it rather than inventing an admission rule (see the batch report).
      dependencies = authorities.taskSource.get_dependencies(proposal.task_ref);
    }
  }

  // §8.4a/§19.3a — one canonical read serves both V8 and the selection basis.
  const canonical_head = REPOSITORY_SENSITIVE.includes(proposal.variant)
    ? authorities.repository.snapshot_canonical().head
    : null;
  const admission_kind = admissionKindFor(durable_task);

  // D23 — the active turn's durable Platform allocation. Absent → V1 rejects at /proposal_id:
  // a Proposal that no active Supervisor turn asked for is not repaired into acceptance.
  const allocation = activeSupervisorProposalAllocation(store.decisions, batch.batch_id);

  const input: DecisionValidationInput = {
    proposal: context.proposal,
    compiled_profile,
    compiled_profile_hash,
    manifests,
    admission_kind,
    ...(allocation === undefined
      ? {}
      : { proposal_identity: { proposal_id: allocation.proposal_id } }),
    ...(task === undefined ? {} : { task }),
    ...(canonical_head === null ? {} : { repository: { canonical_head } }),
    ...(proposal.variant === "TASK_SELECTION" || proposal.variant === "SUBFLOW_SELECTION"
      ? { batch: store.batchView.project(batch.batch_id) }
      : {}),
    // §9.2f — the fresh parent/child read-models an E submission carries into V2/V3/V11.
    ...(proposal.variant === "SUBFLOW_SELECTION" && task_key !== null && durable_task !== null
      ? {
          subflow_parent: subflowParentView(store, proposal),
          subflow_child: {
            task_key,
            batch_id: durable_task.batch_id,
            has_parent_relation: durable_task.parent_task_key !== null,
            materialization_binding:
              durable_task.materialization_binding === null
                ? null
                : {
                    parent_task_key: durable_task.materialization_binding.parent_task_key,
                    child_definition_hash: durable_task.materialization_binding.child_definition_hash,
                  },
          },
        }
      : {}),
    // §9.2g — an A selection over a bound materialised child must be refused; the binding fact
    // travels with the same child context shape.
    ...(proposal.variant === "TASK_SELECTION" && task_key !== null && durable_task !== null
      ? {
          subflow_child: {
            task_key,
            batch_id: durable_task.batch_id,
            has_parent_relation: durable_task.parent_task_key !== null,
            materialization_binding:
              durable_task.materialization_binding === null
                ? null
                : {
                    parent_task_key: durable_task.materialization_binding.parent_task_key,
                    child_definition_hash: durable_task.materialization_binding.child_definition_hash,
                  },
          },
        }
      : {}),
    // §9.2g (D24) — the F read models: fresh parent basis, v3 capability, recovery/reservation.
    ...(proposal.variant === "SUBFLOW_CHILD_MATERIALIZATION"
      ? {
          materialization_parent: materializationParentView(authorities, proposal),
          materialization_capability: materializationCapability(compiled_profile),
          materialization_batch: {
            ...materializationBatchView(store, run, batch.batch_id),
            parent_admitted:
              store.tasks.get(proposal.parent.task_key)?.admitted_at != null,
          },
        }
      : {}),
  };

  const selection_basis =
    definition === null || canonical_head === null
      ? null
      : {
          task_version: definition.version,
          task_definition_hash: definition.definition_hash,
          base_head: canonical_head,
        };

  return {
    input,
    proposal,
    run,
    batch,
    task_key,
    durable_task,
    dependencies,
    selection_basis,
    admission_kind,
  };
}

/**
 * §9.2f — the exact fresh parent read-model, from durable owners only. A missing parent row is a
 * real `NOT_FOUND`; a *corrupt* relation (a cycle in the durable `parent_task_key` chain) is an
 * operational failure before the validator runs, with zero side effects.
 */
function subflowParentView(
  store: PlatformStore,
  proposal: SubflowSelectionProposalV1,
): SubflowParentValidationView {
  const parent = store.tasks.get(proposal.parent.task_key);
  if (parent === undefined) return { status: "NOT_FOUND" };

  const attempt = store.attempts.current(parent.task_key);
  const ancestors: string[] = [];
  for (
    let cursor = parent.parent_task_key;
    cursor !== null;
    cursor = store.tasks.require(cursor).parent_task_key
  ) {
    if (cursor === parent.task_key || ancestors.includes(cursor)) {
      throw new AdmissionError(
        "SUBMISSION_CONTEXT_INVALID",
        "/parent/task_key",
        `${parent.task_key} sits on a cyclic durable parent chain; refusing to validate against it`,
      );
    }
    ancestors.push(cursor);
  }

  return {
    status: "FOUND",
    task_key: parent.task_key,
    batch_id: parent.batch_id,
    platform_state: parent.platform_state,
    current_attempt_key: attempt?.attempt_key ?? null,
    current_attempt_state: attempt?.state ?? null,
    current_task_contract_hash:
      attempt === undefined ? null : (store.contracts.hashOf(attempt.contract_snapshot_id) as string),
    ancestor_task_keys: ancestors,
    current_suspension_child_task_key:
      parent.platform_state === "SUSPENDED"
        ? (subflowChildOf(parent.state_reason?.code) ?? null)
        : null,
    has_open_blocker: store.pendingDecisions.openFor(parent.task_key).length > 0,
    has_recovery_conflict:
      parent.state_reason?.code === "RECOVERY_CONFLICT" ||
      attempt?.state_reason?.code === "RECOVERY_CONFLICT",
  };
}

/**
 * §9.2g (D24) — the F Proposal's fresh parent view: durable row + current Attempt/Contract from
 * the Store, and (for a DISCOVERED parent) the fresh normalized TaskSource basis. A missing row
 * is a real NOT_FOUND; an unreadable source stays an operational failure of the submission.
 */
function materializationParentView(
  authorities: DecisionAuthorities,
  proposal: SubflowChildMaterializationProposalV1,
): ChildMaterializationParentViewV1 {
  const { store } = authorities;
  const parent = store.tasks.get(proposal.parent.task_key);
  if (parent === undefined) return { status: "NOT_FOUND" };
  const attempt = store.attempts.current(parent.task_key);

  // One coherent fresh TaskSource basis for the parent's external identity (D23 discipline).
  let raw;
  try {
    raw = authorities.taskSource.get_task(parent.external_task_ref);
  } catch (error) {
    if (error instanceof TaskSourceError && error.reason === "TASK_NOT_FOUND") {
      return { status: "NOT_FOUND" };
    }
    throw error;
  }
  const definition = normalizeTaskDefinition(
    {
      task_ref: raw.task_ref,
      version: raw.version,
      ...(raw.definition_hash === undefined ? {} : { definition_hash: raw.definition_hash }),
      body: raw.body,
    },
    "/materialization_parent",
  );
  if (definition.task_ref !== parent.external_task_ref) {
    throw new AdmissionError(
      "TASK_IDENTITY_MISMATCH",
      "/materialization_parent",
      `the source returned ${definition.task_ref} for ${parent.external_task_ref}`,
    );
  }

  return {
    status: "FOUND",
    task_key: parent.task_key,
    batch_id: parent.batch_id,
    platform_state: parent.platform_state,
    task_ref: parent.external_task_ref,
    task_version: definition.version,
    task_definition_hash: definition.definition_hash,
    current_attempt_key: attempt?.attempt_key ?? null,
    current_attempt_state: attempt?.state ?? null,
    current_task_contract_hash:
      attempt === undefined ? null : (store.contracts.hashOf(attempt.contract_snapshot_id) as string),
    has_open_blocker: store.pendingDecisions.openFor(parent.task_key).length > 0,
    has_recovery_conflict:
      parent.state_reason?.code === "RECOVERY_CONFLICT" ||
      attempt?.state_reason?.code === "RECOVERY_CONFLICT",
  };
}

/** §9.2g — the batch-bound Compiled Profile v3 capability; never a raw adapter probe. */
function materializationCapability(
  compiled_profile: ReturnType<PlatformStore["batchView"]["compiledProfileFor"]>,
): ChildMaterializationCapabilityViewV1 {
  const entries = compiled_profile.effective.project.task_sources.filter(
    (entry) => entry.child_materializer !== undefined,
  );
  if (entries.length !== 1 || compiled_profile.effective.project.task_sources.length !== 1) {
    return { available: false };
  }
  const entry = entries[0]!;
  return {
    available: true,
    task_source_id: entry.id,
    materializer_adapter: entry.child_materializer!.adapter,
  };
}

/** §9.2g — recovery/reservation facts from durable exact state, never adapter absence. */
function materializationBatchView(
  store: PlatformStore,
  run: PlatformRunRow,
  batch_id: string,
): ChildMaterializationBatchViewV1 {
  const batch = store.batches.require(batch_id);
  const facts = materializationBatchFacts(store, batch_id);
  return {
    run_status: store.runs.require(run.run_id).status,
    batch_status: batch.status,
    has_unresolved_unknown_materialization: facts.has_unresolved_unknown_materialization,
    admitted_task_count: store.batchView.project(batch_id).admitted_task_count,
    unadmitted_materialized_child_count: facts.unadmitted_materialized_child_count,
    parent_admitted: false, // refined by the caller-context below
    admission_closed: batch.admission_closed,
  };
}

/**
 * §9.2e (M1-7) + §17.4 — a task held by `SELECTION_STALE` or `REATTEMPT_REQUIRED:<decision_id>`
 * with an admission marker and no live attempt is reselecting; anything else is an initial
 * admission. Read off durable state, never proposed.
 */
function admissionKindFor(task: TaskRow | null): SelectionAdmissionKind {
  if (task === null) return "INITIAL_ADMISSION";
  const reentry =
    task.platform_state === "HELD" &&
    (task.state_reason?.code === SELECTION_STALE || isReattemptRequired(task.state_reason?.code));
  return reentry && task.admitted_at !== null ? "RESELECTION" : "INITIAL_ADMISSION";
}

// --- context ------------------------------------------------------------------------

function resolveTarget(
  store: PlatformStore,
  context: SubmissionContext,
): { run: PlatformRunRow; batch: BatchRow } {
  const run = store.runs.require(context.run_id);
  const batch = store.batches.require(context.batch_id);

  if (batch.run_id !== context.run_id) {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/batch_id",
      `${batch.batch_id} belongs to ${batch.run_id}, not ${context.run_id}`,
    );
  }
  // Eligibility from the existing run/batch state contract only — no batch scheduler, no
  // `current_batch` column, no selection policy. `admission_closed` is deliberately not read
  // here: it is the state machine's commit-time guard (§19.3a), not a submission precondition.
  if (run.status !== "RUNNING") {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/run_id",
      `run ${run.run_id} is ${run.status}`,
    );
  }
  if (batch.status !== "RUNNING" && batch.status !== "WAITING") {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/batch_id",
      `batch ${batch.batch_id} is ${batch.status}`,
    );
  }
  return { run, batch };
}

/** V1 is the validator's job; this only decides whether more facts *can* be gathered. */
function parseProposal(proposal: unknown): ProposalV1 | null {
  try {
    return validateProposal(proposal);
  } catch (error) {
    if (error instanceof DecisionError && error.reason === "PROPOSAL_SCHEMA_INVALID") return null;
    throw error;
  }
}

const isTaskBearing = (proposal: ProposalV1): proposal is TaskBearingProposalV1 =>
  proposal.variant !== "BATCH_CONTROL" && proposal.variant !== "SUBFLOW_CHILD_MATERIALIZATION";

/**
 * §8.4 — a Proposal may only act on a task this batch already materialized. Materializing one
 * here would let a Proposal create durable state as a side effect of proposing, so a missing row
 * fails the operation instead.
 */
function resolveDurableTask(
  store: PlatformStore,
  run: PlatformRunRow,
  batch: BatchRow,
  proposal: TaskBearingProposalV1,
): { task_key: string; task: TaskRow } {
  // §6.1 D+ — the ref is opaque and may contain ':'; the shared helper keeps it verbatim.
  const task_key = buildTaskKey(run.project_id, proposal.task_ref);
  const task = store.tasks.get(task_key);

  if (task === undefined) {
    throw new AdmissionError(
      "TASK_NOT_MATERIALIZED",
      "/proposal/task_ref",
      `${task_key} has no durable row; run a discovery pass before proposing on it`,
    );
  }
  if (task.batch_id !== batch.batch_id) {
    throw new AdmissionError(
      "SUBMISSION_CONTEXT_INVALID",
      "/proposal/task_ref",
      `${task_key} belongs to ${task.batch_id}, not ${batch.batch_id}`,
    );
  }
  if (task.external_task_ref !== proposal.task_ref) {
    throw new AdmissionError(
      "TASK_IDENTITY_MISMATCH",
      "/proposal/task_ref",
      `${task_key} was materialized from ${task.external_task_ref}`,
    );
  }
  return { task_key, task };
}

/**
 * The fresh TaskSource read (§9.2 V2/V3).
 *
 * Only a genuine "this ref does not exist" answer becomes `NOT_FOUND`. An unreadable document, a
 * malformed definition, a hash disagreement or any other adapter failure is an operational
 * failure of the submission and propagates — the validator is never called with a fabricated
 * absence, and `TASK_NOT_FOUND` never means "the source was down".
 */
function lookupTask(
  taskSource: TaskSourceV1,
  proposal: TaskBearingProposalV1,
  durable: TaskRow,
): TaskLookupView {
  let raw;
  try {
    raw = taskSource.get_task(proposal.task_ref);
  } catch (error) {
    if (error instanceof TaskSourceError && error.reason === "TASK_NOT_FOUND") {
      return { status: "NOT_FOUND" };
    }
    throw error;
  }

  // The B6 normalization boundary, reused as-is: the body is revalidated and the hash recomputed.
  const definition = normalizeTaskDefinition(
    {
      task_ref: raw.task_ref,
      version: raw.version,
      ...(raw.definition_hash === undefined ? {} : { definition_hash: raw.definition_hash }),
      body: raw.body,
    },
    "/task",
  );

  if (definition.task_ref !== proposal.task_ref || definition.task_ref !== durable.external_task_ref) {
    throw new AdmissionError(
      "TASK_IDENTITY_MISMATCH",
      "/task/task_ref",
      `the source returned ${definition.task_ref} for ${proposal.task_ref}`,
    );
  }
  return { status: "FOUND", task: definition };
}
