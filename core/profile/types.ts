/**
 * Profile / Execution Policy / Compiled Profile v1 contracts (TD §7.1a–§7.7).
 *
 * Vocabularies are the fixed ones the TD already owns — nothing here invents a value.
 */

import type { CanonicalObject, CanonicalValue } from "../schemas/canonical-json.ts";
import {
  CAPABILITY_NAMES,
  ENFORCEMENT_ASSURANCES,
  type CapabilityName,
  type EnforcementAssurance,
} from "../schemas/capability-vocabulary.ts";

export { CAPABILITY_NAMES, ENFORCEMENT_ASSURANCES };
export type { CapabilityName, EnforcementAssurance };

// --- fixed vocabularies -----------------------------------------------------------

/** TD §7.1a — Core-fixed generic disposition. classification *names* stay project-owned. */
export type ExecutionDisposition = "AUTO_EXECUTE" | "AUTO_SUBFLOW" | "HOLD_HUMAN";
export const EXECUTION_DISPOSITIONS: readonly ExecutionDisposition[] = [
  "AUTO_EXECUTE",
  "AUTO_SUBFLOW",
  "HOLD_HUMAN",
];

/** TD §7.1a — Core lifecycle template steps. No pipeline DSL, no branching. */
export type PipelineStep =
  | "ACTOR"
  | "VERIFY"
  | "AUDITOR"
  | "MERGE_GATE"
  | "RESUME_PARENT"
  | "HUMAN_GATE";
export const PIPELINE_STEPS: readonly PipelineStep[] = [
  "ACTOR",
  "VERIFY",
  "AUDITOR",
  "MERGE_GATE",
  "RESUME_PARENT",
  "HUMAN_GATE",
];

/** TD §7.1b / Spec §8 — canonical (uppercase only; no case normalization is performed). */
export type RemotePushMode = "DENY" | "PLATFORM_MANAGED_ONLY" | "FEATURE_BRANCH_ONLY";
export const REMOTE_PUSH_MODES: readonly RemotePushMode[] = [
  "DENY",
  "PLATFORM_MANAGED_ONLY",
  "FEATURE_BRANCH_ONLY",
];

/** TD §9.1 Supervisor Proposal decision vocabulary, reused by `human_gate_policy`. */
export type DecisionType =
  | "START_TASK"
  | "REQUEST_REWORK"
  | "PROPOSE_MERGE"
  | "HOLD_TASK"
  | "DEFER_TASK"
  | "START_SUBFLOW"
  | "RESUME_PARENT"
  | "CLOSE_BATCH";
export const DECISION_TYPES: readonly DecisionType[] = [
  "START_TASK",
  "REQUEST_REWORK",
  "PROPOSE_MERGE",
  "HOLD_TASK",
  "DEFER_TASK",
  "START_SUBFLOW",
  "RESUME_PARENT",
  "CLOSE_BATCH",
];

/** TD §15.2 — evidence assurance levels, reused by `verification_policy`. */
export type AssuranceLevel =
  | "REEXECUTED"
  | "ARTIFACT_VERIFIED"
  | "LOG_VERIFIED"
  | "WORKER_REPORTED"
  | "INFERRED";
export const ASSURANCE_LEVELS: readonly AssuranceLevel[] = [
  "REEXECUTED",
  "ARTIFACT_VERIFIED",
  "LOG_VERIFIED",
  "WORKER_REPORTED",
  "INFERRED",
];

/** TD §11.1 — drift action vocabulary (v1, fixed). */
export type DriftAction =
  | "CONTINUE_SNAPSHOT"
  | "REEVALUATE_AT_BOUNDARY"
  | "INVALIDATE_AT_BOUNDARY"
  | "HOLD_AT_BOUNDARY";
export const DRIFT_ACTIONS: readonly DriftAction[] = [
  "CONTINUE_SNAPSHOT",
  "REEVALUATE_AT_BOUNDARY",
  "INVALIDATE_AT_BOUNDARY",
  "HOLD_AT_BOUNDARY",
];

/** TD §11.2 — the seven drift targets. `capability_requirements` is the canonical name (§7.1b). */
export type DriftTarget =
  | "project_profile"
  | "execution_policy"
  | "task_definition"
  | "contract_source"
  | "canonical_head"
  | "verification_profile"
  | "capability_requirements";
export const DRIFT_TARGETS: readonly DriftTarget[] = [
  "project_profile",
  "execution_policy",
  "task_definition",
  "contract_source",
  "canonical_head",
  "verification_profile",
  "capability_requirements",
];

/** TD §11.2 defaults — the only implicit defaults the compiler is allowed to apply. */
export const DRIFT_POLICY_DEFAULTS: Readonly<Record<DriftTarget, DriftRule>> = {
  project_profile: { action: "CONTINUE_SNAPSHOT" },
  execution_policy: { action: "REEVALUATE_AT_BOUNDARY" },
  task_definition: { action: "INVALIDATE_AT_BOUNDARY" },
  contract_source: { action: "CONTINUE_SNAPSHOT" },
  canonical_head: { action: "HOLD_AT_BOUNDARY", boundary: "MERGE_ONLY" },
  verification_profile: { action: "CONTINUE_SNAPSHOT" },
  capability_requirements: { action: "REEVALUATE_AT_BOUNDARY" },
};

export type DriftBoundary = "MERGE_ONLY";

export interface DriftRule {
  readonly action: DriftAction;
  readonly boundary?: DriftBoundary;
}

/** TD §7.1b — v1 defines exactly one recovery field. */
export type CapabilityDowngradeAction = "HOLD" | "PAUSE";

// --- Project Profile v1 (TD §7.1a) -------------------------------------------------

export interface AdapterConfigured {
  readonly adapter: string;
  readonly config: CanonicalObject;
}

export interface TaskSourceEntry extends AdapterConfigured {
  readonly id: string;
  /**
   * §7.1e (D24, prospective MVP 3) — the one TaskSource-bound child materializer. Present only in
   * a v3 Project Profile; a project semantic declaration, never automation authority and never a
   * Model-selectable field. Absent = the materialisation feature is unavailable.
   */
  readonly child_materializer?: AdapterConfigured;
}

export interface ContractSourceEntry {
  readonly path: string;
}

export interface ClassificationEntry {
  readonly default_execution_policy: ExecutionDisposition;
}

export interface RoleEntry {
  readonly runtime_profile: string;
  readonly config: CanonicalObject;
}

export interface PipelineEntry {
  readonly steps: readonly PipelineStep[];
  /**
   * TD §7.1a/§7.3 S4a (M1-10) — which declared role the Auditor runs under.
   *
   * Present exactly when `steps` contains `AUDITOR`, and then it must name a key of
   * `roles`. There is no default, no naming convention and no fallback: the Auditor's
   * runtime profile has no other authority, so absence is a compile error rather than
   * something a later layer guesses at.
   */
  readonly auditor_profile?: string;
}

/**
 * TD §7.1a (M1-6) / §10.1 — the exact repository mutation scope body.
 *
 * The Project Profile is the declaration authority, so the type lives here and the Task Contract
 * re-exports it: one declaration, and the Contract freezes exactly what the Profile declared.
 */
export interface RepositoryScopeV1 {
  /** Generic arrays: order-sensitive, never sorted or deduplicated (M0-13). */
  readonly allowed_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
}

export const REPOSITORY_SCOPE_FIELDS: readonly string[] = ["allowed_paths", "forbidden_paths"];

export interface ProjectProfileV1Body {
  readonly id: string;
  readonly version: number;
  readonly repository: AdapterConfigured;
  readonly task_sources: readonly TaskSourceEntry[];
  readonly contract_sources: readonly ContractSourceEntry[];
  readonly classifications: Readonly<Record<string, ClassificationEntry>>;
  readonly roles: Readonly<Record<string, RoleEntry>>;
  readonly pipelines: Readonly<Record<string, PipelineEntry>>;
  readonly verification_profiles: Readonly<Record<string, AdapterConfigured>>;
  /** TD §7.1a (M1-6) — the declaration authority for repository mutation scope. */
  readonly repository_scopes: Readonly<Record<string, RepositoryScopeV1>>;
  readonly hooks: Readonly<Record<string, AdapterConfigured>>;
  /**
   * TD §7.1d (v2, PROSPECTIVE) — the Supervisor's role binding. Present exactly when the document
   * is `platform/project-profile` schema_version 2; a v1 body never carries it.
   */
  readonly supervisor_profile?: string;
}

export const PROJECT_PROFILE_TOP_LEVEL: readonly (keyof ProjectProfileV1Body)[] = [
  "id",
  "version",
  "repository",
  "task_sources",
  "contract_sources",
  "classifications",
  "roles",
  "pipelines",
  "verification_profiles",
  "repository_scopes",
  "hooks",
];

/** TD §7.1d — the v2 body is the v1 body plus exactly one required field. */
export const PROJECT_PROFILE_TOP_LEVEL_V2: readonly string[] = [
  ...PROJECT_PROFILE_TOP_LEVEL,
  "supervisor_profile",
];

// --- Execution Policy v1 (TD §7.1b) ------------------------------------------------

export interface BatchPolicy {
  readonly max_tasks: number;
  readonly max_rework: number;
  readonly concurrency: number;
}

export interface RepositoryPolicy {
  readonly remote_push: RemotePushMode;
  readonly direct_canonical_write: boolean;
  readonly allow_force_push: boolean;
  readonly allow_tag_change: boolean;
  readonly allow_git_clean: boolean;
  readonly allow_reset_hard: boolean;
}

export interface HumanGatePolicy {
  readonly required_decisions: readonly DecisionType[];
}

export interface VerificationRequirement {
  readonly accepted_assurance: readonly AssuranceLevel[];
}

export interface VerificationPolicy {
  readonly required_verification: Readonly<Record<string, VerificationRequirement>>;
}

export interface CapabilityRequirement {
  readonly accepted: readonly EnforcementAssurance[];
}

export type CapabilityRequirements = Readonly<
  Record<string, Readonly<Partial<Record<CapabilityName, CapabilityRequirement>>>>
>;

export interface RecoveryPolicy {
  readonly capability_downgrade: CapabilityDowngradeAction;
}

export interface ExecutionPolicyV1Body {
  readonly id: string;
  readonly version: number;
  readonly classification_policy: Readonly<Record<string, ExecutionDisposition>>;
  readonly auto_merge: boolean;
  readonly allow_auto_subflow: boolean;
  readonly batch_policy: BatchPolicy;
  readonly repository_policy: RepositoryPolicy;
  readonly human_gate_policy: HumanGatePolicy;
  readonly verification_policy: VerificationPolicy;
  readonly capability_requirements: CapabilityRequirements;
  readonly contract_drift_policy: Readonly<Record<DriftTarget, DriftRule>>;
  readonly recovery_policy: RecoveryPolicy;
}

export const EXECUTION_POLICY_TOP_LEVEL: readonly (keyof ExecutionPolicyV1Body)[] = [
  "id",
  "version",
  "classification_policy",
  "auto_merge",
  "allow_auto_subflow",
  "batch_policy",
  "repository_policy",
  "human_gate_policy",
  "verification_policy",
  "capability_requirements",
  "contract_drift_policy",
  "recovery_policy",
];

/** TD §12.2/§12.3 — the operation whose requirements gate `auto_merge`. */
export const MERGE_OPERATION_ID = "automatic_merge";

// --- Approved Overrides v1 (TD §7.1c) ----------------------------------------------

export interface ApprovedOverride {
  readonly field_path: string;
  readonly value: CanonicalValue;
  readonly approval_ref?: string;
  readonly approval_hash?: string;
}

export interface ApprovedOverridesV1Body {
  readonly items: readonly ApprovedOverride[];
}

/** TD §7.2 rule 7 — the minimum projection the compiler needs from an approval record. */
export interface ApprovalBindingView {
  readonly ref: string;
  readonly status: string;
  readonly field_path: string;
  readonly approved_value: CanonicalValue;
  readonly record_hash: string;
}

export type ApprovalLookup = (ref: string) => ApprovalBindingView | undefined;

// --- Compiled Profile v1 (TD §7.7) -------------------------------------------------

export interface CompiledComponentRef {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
}

export interface CompiledProfileV1Body {
  readonly project_profile: CompiledComponentRef;
  readonly execution_policy: CompiledComponentRef;
  readonly approved_overrides: { readonly hash: string };
  readonly compiled_version: number;
  readonly merge_rules_version: number;
  readonly effective: {
    readonly project: ProjectProfileV1Body;
    readonly policy: ExecutionPolicyV1Body;
  };
}

// --- the current-profile read seam (TD §11.4, M1-11) --------------------------------

/**
 * One authoritative read of a versioned Profile component: the component ref that says *which*
 * component this is, and the already-normalized body.
 *
 * Both are needed and neither is redundant. The ref alone cannot answer a sub-body question
 * (`verification_profiles[…]`, `capability_requirements`, the current pipeline and roles); the body
 * alone cannot say which component moved, so a difference could not be attributed.
 */
export interface ProfileComponentRead<Body> {
  readonly ref: CompiledComponentRef;
  readonly body: Body;
}

/**
 * The current Project Profile / Execution Policy, as they are *now*.
 *
 * Exactly two calls. There is deliberately no `get(path)`, no pointer syntax and no untyped bag:
 * the only things any reader needs are these two versioned bodies, and a general query surface
 * would make this seam a data source rather than an authority.
 *
 * What it returns is an **observation**. It never replaces the Attempt-bound Compiled Profile, is
 * never written into an Attempt, and grants nothing (TD §11.3 — no silent migration).
 */
export interface ProfileSource {
  current_project_profile(): ProfileComponentRead<ProjectProfileV1Body>;
  current_execution_policy(): ProfileComponentRead<ExecutionPolicyV1Body>;
}

export const COMPILED_VERSION = 1;
export const MERGE_RULES_VERSION = 1;

export const PROJECT_PROFILE_SCHEMA = "platform/project-profile";
export const EXECUTION_POLICY_SCHEMA = "platform/execution-policy";
export const APPROVED_OVERRIDES_SCHEMA = "platform/approved-overrides";
export const COMPILED_PROFILE_SCHEMA = "platform/compiled-profile";
