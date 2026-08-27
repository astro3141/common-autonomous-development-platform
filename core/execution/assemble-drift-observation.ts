/**
 * Authoritative fact assembly for one stage boundary (TD §11.4, M1-11).
 *
 * The same shape as `core/admission/fact-assembly.ts`, for the same reason: the §11 evaluator is
 * pure, so something has to do the observing, and that job belongs to the execution use-case
 * boundary rather than to the evaluator.
 *
 *     authoritative owners → DriftObservationV1 → evaluateStageBoundaryDrift
 *
 * Every frozen value comes from durable Attempt-bound state — the Task Contract, the Attempt's
 * own Compiled Profile, the immutable Auditor CapabilityGrant, `attempt.base_head`. Nothing frozen
 * is repaired, defaulted or re-read from a live registry.
 *
 * Every current value comes from the one component that owns it and is read fresh. Two failure
 * modes are kept apart with some care: a source that answers "this is gone" is `ABSENT` and
 * therefore drift, while a source that cannot answer at all is `UNAVAILABLE`. Collapsing the
 * second into the first would turn an outage into a contract change; collapsing it into "no
 * difference" would turn it into permission to proceed.
 *
 * No Backend Capability Manifest is read here, fresh or historical. The capability basis is
 * already frozen in the grant, and Backend change belongs to §12.6/§22.2/RA-4.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import { evaluateFrozenEnforcementRequirements } from "../capability/compatibility.ts";
import type { CapabilityGrantV1Body } from "../capability/types.ts";
import { hashContractSourceBytes } from "../contract/source-hash.ts";
import type {
  ContractSourceReader,
  ContractSourceRef,
  TaskContractV1Body,
} from "../contract/types.ts";
import { AUDITOR_EXECUTION_OPERATION } from "../decision/types.ts";
import type {
  AdapterConfigured,
  CompiledProfileV1Body,
  ExecutionPolicyV1Body,
  ProfileComponentRead,
  ProfileSource,
  ProjectProfileV1Body,
} from "../profile/types.ts";
import type { TaskAttemptRow } from "../store/domain-types.ts";
import { normalizeTaskDefinition } from "../tasksource/task-definition.ts";
import { TaskSourceError } from "../tasksource/errors.ts";
import type { TaskSourceV1 } from "../tasksource/types.ts";
import { ExecutionStartError } from "./start-implementation.ts";
import {
  ABSENT,
  observed,
  UNAVAILABLE,
  type AuditorStageFacts,
  type DriftCurrentState,
  type DriftFrozenState,
  type DriftObservationV1,
  type Observation,
  type StageBoundary,
  type TaskDefinitionFacts,
} from "./drift-observation.ts";

/** The authoritative owners one boundary reads from. Every one is an interface. */
export interface DriftAuthorities {
  readonly repository: RepositoryAdapter;
  readonly profiles: ProfileSource;
  readonly taskSource: TaskSourceV1;
  readonly contractSources: ContractSourceReader;
}

export interface DriftAssemblyInput {
  readonly boundary: StageBoundary;
  readonly attempt: TaskAttemptRow;
  readonly contract: TaskContractV1Body;
  /** The Attempt-bound Compiled Profile — the frozen side, and the frozen drift policy. */
  readonly compiled: CompiledProfileV1Body;
  /** The already-validated, contract-bound Auditor grant (TD §11.4 capability basis). */
  readonly auditor_grant: CapabilityGrantV1Body;
}

export function assembleDriftObservation(
  authorities: DriftAuthorities,
  input: DriftAssemblyInput,
): DriftObservationV1 {
  const frozen = freeze(input);

  // One read each; both sub-body targets and all three REEVALUATE facts are answered from them,
  // so a component is never read twice and cannot answer two questions differently.
  const project = read(() => authorities.profiles.current_project_profile());
  const policy = read(() => authorities.profiles.current_execution_policy());

  const current: DriftCurrentState = {
    project_profile: map(project, (read) => read.ref),
    execution_policy: map(policy, (read) => read.ref),
    task_definition: currentTaskDefinition(authorities.taskSource, input.contract),
    contract_sources: currentContractSources(authorities.contractSources, frozen.contract_sources),
    canonical_head: read(() => authorities.repository.snapshot_canonical().head),
    verification_profile: subEntry(
      project,
      (body) => body.verification_profiles[input.contract.verification_profile],
    ),
    capability_requirements: map(policy, (read) => read.body.capability_requirements),
    auditor_stage: auditorStage(project, policy, input),
  };

  return { boundary: input.boundary, frozen, current, policy: frozenPolicy(input) };
}

// --- the frozen side ------------------------------------------------------------------------

function freeze(input: DriftAssemblyInput): DriftFrozenState {
  const { compiled, contract, attempt, auditor_grant } = input;
  const verification_profile =
    compiled.effective.project.verification_profiles[contract.verification_profile];
  if (verification_profile === undefined) {
    // The contract was built against this profile, so its absence from the Attempt's own frozen
    // Compiled Profile is durable incoherence, not an observation about the world.
    throw new ExecutionStartError(
      `the frozen profile declares no verification profile ${contract.verification_profile}`,
    );
  }

  return {
    project_profile: compiled.project_profile,
    execution_policy: compiled.execution_policy,
    task: {
      ref: contract.task.ref,
      version: contract.task.version,
      definition_hash: contract.task.definition_hash,
    },
    contract_sources: contract.contract_sources,
    base_head: attempt.base_head,
    verification_profile,
    capability_requirements: compiled.effective.policy.capability_requirements,
    auditor_capability: {
      source_runtime_manifest_hash: auditor_grant.source_runtime_manifest_hash,
      requested: auditor_grant.requested,
      enforcement: auditor_grant.enforcement,
    },
  };
}

const frozenPolicy = (input: DriftAssemblyInput) =>
  input.compiled.effective.policy.contract_drift_policy;

// --- the current side -----------------------------------------------------------------------

/**
 * TD §11.4 — the TaskSource is the authority for the current definition. A genuine "this ref does
 * not exist" is `ABSENT`; every other adapter failure is an operational one and stays
 * `UNAVAILABLE`, so an unreachable source can never look like a deleted task.
 */
function currentTaskDefinition(
  taskSource: TaskSourceV1,
  contract: TaskContractV1Body,
): Observation<TaskDefinitionFacts> {
  let raw;
  try {
    raw = taskSource.get_task(contract.task.ref);
  } catch (error) {
    if (error instanceof TaskSourceError && error.reason === "TASK_NOT_FOUND") return ABSENT;
    return UNAVAILABLE;
  }
  try {
    // The same normalization boundary admission uses: the hash is recomputed, never accepted.
    const definition = normalizeTaskDefinition(
      {
        task_ref: raw.task_ref,
        version: raw.version,
        ...(raw.definition_hash === undefined ? {} : { definition_hash: raw.definition_hash }),
        body: raw.body,
      },
      "/task",
    );
    return observed({
      version: definition.version,
      definition_hash: definition.definition_hash,
    });
  } catch {
    // The source answered, but not with something that can be compared. That is not evidence of
    // a definition change, so it is not reported as one.
    return UNAVAILABLE;
  }
}

/**
 * Raw bytes, hashed with the §10.2 raw SHA-256 — no normalization, no modification time. The
 * declared order is the frozen order, so the comparison stays positional.
 */
function currentContractSources(
  reader: ContractSourceReader,
  frozen: readonly ContractSourceRef[],
): Observation<readonly ContractSourceRef[]> {
  const current: ContractSourceRef[] = [];
  for (const source of frozen) {
    let read;
    try {
      read = reader.read_contract_source(source.path);
    } catch {
      return UNAVAILABLE;
    }
    // A declared source that is no longer there is an observation, and the set has changed.
    if (read.kind === "ABSENT") return ABSENT;
    current.push({ path: source.path, content_hash: hashContractSourceBytes(read.bytes) });
  }
  return observed(current);
}

/**
 * TD §11.4 A/B/C — derived from the *current* bodies and the *frozen* grant. Nothing current is
 * adopted: the runtime profile the current Profile would give the Auditor is deliberately not
 * read, because using it would be an expansion injected into a running Attempt.
 */
function auditorStage(
  project: Observation<ProfileComponentRead<ProjectProfileV1Body>>,
  policy: Observation<ProfileComponentRead<ExecutionPolicyV1Body>>,
  input: DriftAssemblyInput,
): Observation<AuditorStageFacts> {
  if (project.status !== "OBSERVED" || policy.status !== "OBSERVED") return UNAVAILABLE;

  const pipeline = project.value.body.pipelines[input.contract.pipeline_id];
  // The pipeline this contract names is gone — observed, not unreadable.
  if (pipeline === undefined) return ABSENT;

  const auditor_profile = pipeline.auditor_profile;
  const requirement = policy.value.body.capability_requirements[AUDITOR_EXECUTION_OPERATION];

  return observed({
    has_auditor: pipeline.steps.includes("AUDITOR"),
    auditor_profile_declared:
      auditor_profile !== undefined && project.value.body.roles[auditor_profile] !== undefined,
    // C — exact accepted-set membership against the frozen grant's own enforcement. No ranking,
    // no minimum level, and an operation the current policy does not constrain is compatible.
    requirement_met: evaluateFrozenEnforcementRequirements(
      input.auditor_grant.requested,
      input.auditor_grant.enforcement,
      requirement ?? {},
    ).compatible,
  });
}

// --- observation helpers ---------------------------------------------------------------------

/** An authoritative read that either produced a value or could not be performed. */
function read<Value>(perform: () => Value): Observation<Value> {
  try {
    return observed(perform());
  } catch {
    return UNAVAILABLE;
  }
}

function map<From, To>(
  observation: Observation<From>,
  project: (value: From) => To,
): Observation<To> {
  return observation.status === "OBSERVED" ? observed(project(observation.value)) : observation;
}

/** A selected entry inside a body that *was* read: missing means gone, not unreadable. */
function subEntry(
  observation: Observation<ProfileComponentRead<ProjectProfileV1Body>>,
  select: (body: ProjectProfileV1Body) => AdapterConfigured | undefined,
): Observation<AdapterConfigured> {
  if (observation.status !== "OBSERVED") return observation;
  const entry = select(observation.value.body);
  return entry === undefined ? ABSENT : observed(entry);
}
