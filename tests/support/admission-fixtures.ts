/**
 * Neutral fixtures for the production admission front half.
 *
 * The authorities are hand-written stubs against the real interfaces — no production adapter and
 * no fake framework — so a test can move one fact at a time and watch which V-step notices.
 */

import type { ManifestSetInput } from "../../core/capability/manifest-set.ts";
import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type {
  CandidateInspection,
  CreateFeatureWorkspaceRequestV1,
  ExpectedFilesRequest,
  FeatureWorkspace,
  MergeCommit,
  MergePreparation,
  MergeRequest,
  RepositoryCanonicalSnapshot,
  RepositoryDiff,
  RepositoryRange,
} from "../../adapters/interfaces/repository-adapter.ts";
import { TaskSourceError } from "../../core/tasksource/errors.ts";
import type {
  ExternalTaskState,
  TaskCandidate,
  TaskDefinition,
  TaskDependency,
  TaskDiscoveryContextV1,
  TaskSourceV1,
} from "../../core/tasksource/types.ts";
import type { DecisionAuthorities } from "../../core/admission/fact-assembly.ts";
import { componentManifest, runtimeManifest } from "./capability-fixtures.ts";
import { enforcementWith, HEAD, task } from "./decision-fixtures.ts";
import type { EnforcementAssurance } from "../../core/capability/types.ts";
import type { DomainWorld } from "./domain-fixtures.ts";

export const DECISION_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0C01";
export const REPORT_CHANNEL = "example-channel";

/** Raw component manifests; `validateManifestSet` runs inside the assembler. */
export const manifestSetInput = (
  overrides: Readonly<
    Record<string, Partial<{ allow: EnforcementAssurance; deny: EnforcementAssurance }>>
  > = {},
): ManifestSetInput => ({
  runtime: runtimeManifest({ capability_enforcement: enforcementWith(overrides) }),
  workflow: componentManifest("WORKFLOW"),
  repository: componentManifest("REPOSITORY"),
  verification: componentManifest("VERIFICATION"),
});

/**
 * A TaskSource that answers from a single definition, with a switch for each way a real one can
 * fail. Every call is recorded so the freshness of a read can be asserted directly.
 */
export class StubTaskSource implements TaskSourceV1 {
  readonly calls: string[] = [];
  definition: TaskDefinition;
  dependencies: readonly TaskDependency[] = [];
  /** Per-ref external state for dependency targets; unlisted refs answer `READY`. */
  readonly externalStates: Record<string, ExternalTaskState> = {};
  /** When set, `get_task` fails this way instead of answering. */
  failure: TaskSourceError | Error | undefined;
  /** When set, `get_task_state` fails this way instead of answering. */
  stateFailure: TaskSourceError | Error | undefined;

  constructor(definition: TaskDefinition = task()) {
    this.definition = definition;
  }

  discover_tasks(_context: TaskDiscoveryContextV1): readonly TaskCandidate[] {
    this.calls.push("discover_tasks");
    return [];
  }

  get_task(task_ref: string): TaskDefinition {
    this.calls.push(`get_task:${task_ref}`);
    if (this.failure !== undefined) throw this.failure;
    return this.definition;
  }

  get_dependencies(task_ref: string): readonly TaskDependency[] {
    this.calls.push(`get_dependencies:${task_ref}`);
    return this.dependencies;
  }

  get_task_state(task_ref: string): ExternalTaskState {
    this.calls.push(`get_task_state:${task_ref}`);
    if (this.stateFailure !== undefined) throw this.stateFailure;
    return this.externalStates[task_ref] ?? "READY";
  }
}

/**
 * A repository whose canonical head a test can move. Only `snapshot_canonical` is exercised by
 * the front half; every other primitive throws so an accidental use is loud.
 */
export class StubRepository implements RepositoryAdapter {
  readonly calls: string[] = [];
  head: string;

  constructor(head: string = HEAD) {
    this.head = head;
  }

  snapshot_canonical(): RepositoryCanonicalSnapshot {
    this.calls.push("snapshot_canonical");
    return { ref: "refs/heads/trunk", head: this.head };
  }

  verify_canonical_head(expected_head: string): boolean {
    this.calls.push("verify_canonical_head");
    return this.head === expected_head;
  }

  create_feature_workspace(_request: CreateFeatureWorkspaceRequestV1): FeatureWorkspace {
    throw this.#unexpected("create_feature_workspace");
  }
  inspect_candidate(_workspace: FeatureWorkspace): CandidateInspection {
    throw this.#unexpected("inspect_candidate");
  }
  get_diff(_range: RepositoryRange): RepositoryDiff {
    throw this.#unexpected("get_diff");
  }
  verify_tracked_clean(_workspace?: FeatureWorkspace): boolean {
    throw this.#unexpected("verify_tracked_clean");
  }
  verify_expected_files(_request: ExpectedFilesRequest): boolean {
    throw this.#unexpected("verify_expected_files");
  }
  verify_lineage(_ancestor: string, _descendant: string): boolean {
    throw this.#unexpected("verify_lineage");
  }
  prepare_merge(_request: MergeRequest): MergePreparation {
    throw this.#unexpected("prepare_merge");
  }
  commit_merge(_preparation: MergePreparation): MergeCommit {
    throw this.#unexpected("commit_merge");
  }

  #unexpected(method: string): Error {
    this.calls.push(method);
    return new Error(`the admission front half must not call ${method}`);
  }
}

export interface AdmissionWorld extends DecisionAuthorities {
  readonly taskSource: StubTaskSource;
  readonly repository: StubRepository;
}

export const authoritiesFor = (
  world: DomainWorld,
  overrides: Partial<{
    taskSource: StubTaskSource;
    repository: StubRepository;
    manifests: ManifestSetInput;
  }> = {},
): AdmissionWorld => ({
  store: world.store,
  taskSource: overrides.taskSource ?? new StubTaskSource(),
  repository: overrides.repository ?? new StubRepository(),
  manifests: overrides.manifests ?? manifestSetInput(),
});
