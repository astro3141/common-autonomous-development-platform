/**
 * Neutral Supervisor Proposal / Decision Validator fixtures.
 *
 * Invented vocabulary only — `IMPLEMENTABLE`, `standard`, `T-101` — so no project or backend name
 * ever reaches the decision tests.
 */

import { validateManifestSet } from "../../core/capability/manifest-set.ts";
import type { BackendManifestSet, EnforcementAssurance } from "../../core/capability/types.ts";
import { compileProfile, type CompileResult } from "../../core/profile/compiler.ts";
import { CAPABILITY_NAMES } from "../../core/schemas/capability-vocabulary.ts";
import { normalizeTaskDefinition } from "../../core/tasksource/task-definition.ts";
import type { TaskDefinition } from "../../core/tasksource/types.ts";
import type {
  DecisionValidationBatchView,
  TaskLookupView,
} from "../../core/decision/types.ts";
import type { DecisionValidationInput } from "../../core/decision/validator.ts";
import { componentManifest, runtimeManifest } from "./capability-fixtures.ts";

export const PROPOSAL_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0AAA";
export const HEAD = "head-canonical-1";

type Directional = { allow: EnforcementAssurance; deny: EnforcementAssurance };

/** Every capability enforced in both directions, with named exceptions. */
export const enforcementWith = (
  overrides: Readonly<Record<string, Partial<Directional>>> = {},
): Record<string, Directional> => {
  const map: Record<string, Directional> = {};
  for (const capability of CAPABILITY_NAMES) {
    map[capability] = { allow: "ENFORCED", deny: "ENFORCED", ...overrides[capability] };
  }
  return map;
};

export const manifests = (
  capability_enforcement: Record<string, Directional> = enforcementWith(),
  runtimeOverrides: Record<string, unknown> = {},
): BackendManifestSet =>
  validateManifestSet({
    runtime: runtimeManifest({ capability_enforcement, ...runtimeOverrides }),
    workflow: componentManifest("WORKFLOW"),
    repository: componentManifest("REPOSITORY"),
    verification: componentManifest("VERIFICATION"),
  });

export const projectProfile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "alpha",
  version: 1,
  repository: { adapter: "example-repository", config: { location: "workspace/alpha" } },
  task_sources: [{ id: "primary", adapter: "example-source", config: { paths: ["plan.md"] } }],
  contract_sources: [{ path: "SPEC.md" }],
  classifications: {
    IMPLEMENTABLE: { default_execution_policy: "AUTO_EXECUTE" },
    LARGE_SCOPE: { default_execution_policy: "HOLD_HUMAN" },
    SPLIT_NEEDED: { default_execution_policy: "AUTO_SUBFLOW" },
  },
  roles: {
    implementation: { runtime_profile: "standard", config: {} },
    review: { runtime_profile: "read-only", config: {} },
  },
  pipelines: {
    // M1-10 — an auditing pipeline declares which role its Auditor runs under.
    standard: { steps: ["ACTOR", "VERIFY", "AUDITOR", "MERGE_GATE"], auditor_profile: "review" },
    review_only: { steps: ["VERIFY", "AUDITOR"], auditor_profile: "review" },
    // §19.5.2 — the foundation shape: terminal-success is RESUME_PARENT, never a merge.
    foundation: { steps: ["ACTOR", "VERIFY", "AUDITOR", "RESUME_PARENT"], auditor_profile: "review" },
  },
  verification_profiles: { full: { adapter: "example-verifier", config: {} } },
  // M1-6 — the Project Profile is the declaration authority for repository mutation scope.
  repository_scopes: {
    collector: { allowed_paths: ["src", "docs"], forbidden_paths: ["src/vendor"] },
    docs_only: { allowed_paths: ["docs"], forbidden_paths: [] },
  },
  hooks: {},
  ...overrides,
});

export const executionPolicy = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "guarded",
  version: 1,
  classification_policy: {},
  auto_merge: false,
  allow_auto_subflow: true,
  batch_policy: { max_tasks: 3, max_rework: 2, concurrency: 2 },
  repository_policy: {
    remote_push: "FEATURE_BRANCH_ONLY",
    direct_canonical_write: false,
    allow_force_push: false,
    allow_tag_change: false,
    allow_git_clean: false,
    allow_reset_hard: false,
  },
  human_gate_policy: { required_decisions: [] },
  verification_policy: { required_verification: { unit: { accepted_assurance: ["REEXECUTED"] } } },
  capability_requirements: {},
  contract_drift_policy: { canonical_head: { action: "HOLD_AT_BOUNDARY", boundary: "MERGE_ONLY" } },
  recovery_policy: { capability_downgrade: "HOLD" },
  ...overrides,
});

export const compiled = (
  policyOverrides: Record<string, unknown> = {},
  projectOverrides: Record<string, unknown> = {},
): CompileResult =>
  compileProfile({
    projectProfile: projectProfile(projectOverrides),
    executionPolicy: executionPolicy(policyOverrides),
    approvedOverrides: { items: [] },
  });

export const task = (overrides: { task_ref?: string; version?: string } = {}): TaskDefinition =>
  normalizeTaskDefinition({
    task_ref: overrides.task_ref ?? "T-101",
    version: overrides.version ?? "1",
    body: {
      title: "Collector script cleanup",
      description: "Free-form description text.",
      references: ["docs/DESIGN.md#collector"],
      acceptance_notes: ["Existing output remains byte-identical."],
    },
  });

export const found = (definition: TaskDefinition = task()): TaskLookupView => ({
  status: "FOUND",
  task: definition,
});

export const batchView = (
  overrides: Partial<DecisionValidationBatchView> = {},
): DecisionValidationBatchView => ({
  admitted_task_count: 0,
  active_task_count: 0,
  active_writable_candidate_count: 0,
  ...overrides,
});

// --- proposals ----------------------------------------------------------------------

interface ProposalOptions {
  readonly decision?: string;
  readonly classification?: string;
  readonly pipeline_id?: string;
  readonly base_head?: string;
  readonly profile: CompileResult;
  readonly definition?: TaskDefinition;
  readonly repository_scope_id?: string;
}

const freshness = (options: ProposalOptions): Record<string, unknown> => {
  const definition = options.definition ?? task();
  return {
    task_version: definition.version,
    task_definition_hash: definition.definition_hash,
    compiled_profile_hash: options.profile.compiled_hash,
  };
};

export const selection = (options: ProposalOptions): Record<string, unknown> => ({
  proposal_id: PROPOSAL_ID,
  decision: options.decision ?? "START_TASK",
  task_ref: (options.definition ?? task()).task_ref,
  classification: options.classification ?? "IMPLEMENTABLE",
  pipeline_id: options.pipeline_id ?? "standard",
  actor_profile: "implementation",
  verification_profile: "full",
  repository_scope_id: options.repository_scope_id ?? "collector",
  expected: { ...freshness(options), base_head: options.base_head ?? HEAD },
  reason_refs: [],
});

/** §9.1 E — a subflow selection with an explicit parent intent (D22). */
export const subflowSelection = (
  options: ProposalOptions & {
    readonly parent: {
      readonly task_key: string;
      readonly attempt_key: string;
      readonly task_contract_hash: string;
      readonly attempt_state: string;
    };
  },
): Record<string, unknown> => ({
  proposal_id: PROPOSAL_ID,
  decision: "START_SUBFLOW",
  task_ref: (options.definition ?? task()).task_ref,
  classification: options.classification ?? "IMPLEMENTABLE",
  pipeline_id: options.pipeline_id ?? "standard",
  actor_profile: "implementation",
  verification_profile: "full",
  repository_scope_id: options.repository_scope_id ?? "collector",
  parent: options.parent,
  expected: { ...freshness(options), base_head: options.base_head ?? HEAD },
  reason_refs: [],
});

export const repositoryControl = (options: ProposalOptions): Record<string, unknown> => ({
  proposal_id: PROPOSAL_ID,
  decision: options.decision ?? "PROPOSE_MERGE",
  task_ref: (options.definition ?? task()).task_ref,
  expected: { ...freshness(options), base_head: options.base_head ?? HEAD },
  reason_refs: [],
});

export const taskControl = (options: ProposalOptions): Record<string, unknown> => ({
  proposal_id: PROPOSAL_ID,
  decision: options.decision ?? "HOLD_TASK",
  task_ref: (options.definition ?? task()).task_ref,
  expected: freshness(options),
  reason_refs: [],
});

export const batchControl = (options: ProposalOptions): Record<string, unknown> => ({
  proposal_id: PROPOSAL_ID,
  decision: "CLOSE_BATCH",
  expected: { compiled_profile_hash: options.profile.compiled_hash },
  reason_refs: [],
});

/** A complete, passing input; individual tests replace one part at a time. */
/** A coherent §9.2f parent intent + fresh view pair for validator-level E tests. */
export const SUBFLOW_PARENT_INTENT = {
  task_key: "task:alpha:P-1",
  attempt_key: "attempt:task:alpha:P-1:1",
  task_contract_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  attempt_state: "VERIFYING",
} as const;

export const subflowParentView = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: "FOUND",
  task_key: SUBFLOW_PARENT_INTENT.task_key,
  batch_id: "batch:alpha:1",
  platform_state: "ACTIVE",
  current_attempt_key: SUBFLOW_PARENT_INTENT.attempt_key,
  current_attempt_state: SUBFLOW_PARENT_INTENT.attempt_state,
  current_task_contract_hash: SUBFLOW_PARENT_INTENT.task_contract_hash,
  ancestor_task_keys: [],
  current_suspension_child_task_key: null,
  has_open_blocker: false,
  has_recovery_conflict: false,
  ...overrides,
});

export const subflowChildContext = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  task_key: "task:alpha:C-1",
  batch_id: "batch:alpha:1",
  has_parent_relation: false,
  ...overrides,
});

export const inputFor = (
  proposal: unknown,
  profile: CompileResult,
  overrides: Partial<DecisionValidationInput> = {},
): DecisionValidationInput => ({
  proposal,
  compiled_profile: profile.body,
  compiled_profile_hash: profile.compiled_hash,
  task: found(),
  repository: { canonical_head: HEAD },
  manifests: manifests(),
  batch: batchView(),
  ...overrides,
});
