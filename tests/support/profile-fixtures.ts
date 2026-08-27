/**
 * Neutral profile/policy fixtures.
 *
 * The vocabulary is invented for the tests: no project or backend names appear, so the
 * independence guard keeps passing.
 */

export const validProjectProfile = (): Record<string, unknown> => ({
  id: "alpha",
  version: 1,
  repository: { adapter: "example-repository", config: { location: "workspace/alpha" } },
  task_sources: [{ id: "primary", adapter: "example-source", config: { paths: ["plan.md"] } }],
  contract_sources: [{ path: "SPEC.md" }, { path: "DESIGN.md" }],
  classifications: {
    ROUTINE_ITEM: { default_execution_policy: "AUTO_EXECUTE" },
    LARGE_ITEM: { default_execution_policy: "HOLD_HUMAN" },
  },
  roles: {
    implementation: { runtime_profile: "standard", config: { note: "example" } },
    review: { runtime_profile: "read-only", config: {} },
  },
  pipelines: {
    // M1-10 — an auditing pipeline declares which role its Auditor runs under.
    standard: { steps: ["ACTOR", "VERIFY", "AUDITOR", "MERGE_GATE"], auditor_profile: "review" },
  },
  verification_profiles: {
    full: { adapter: "example-verifier", config: { checks: ["unit"] } },
  },
  // M1-6 — explicit scope declaration; there is deliberately no implicit default.
  repository_scopes: {
    collector: { allowed_paths: ["src", "docs"], forbidden_paths: ["src/vendor"] },
  },
  hooks: {
    on_batch_close: { adapter: "example-hook", config: {} },
  },
});

export const validExecutionPolicy = (): Record<string, unknown> => ({
  id: "guarded",
  version: 1,
  classification_policy: { LARGE_ITEM: "AUTO_SUBFLOW" },
  auto_merge: false,
  allow_auto_subflow: true,
  batch_policy: { max_tasks: 3, max_rework: 2, concurrency: 1 },
  repository_policy: {
    remote_push: "FEATURE_BRANCH_ONLY",
    direct_canonical_write: false,
    allow_force_push: false,
    allow_tag_change: false,
    allow_git_clean: false,
    allow_reset_hard: false,
  },
  human_gate_policy: { required_decisions: ["PROPOSE_MERGE", "HOLD_TASK"] },
  verification_policy: {
    required_verification: { unit: { accepted_assurance: ["REEXECUTED"] } },
  },
  capability_requirements: {
    automatic_merge: { "repository.merge": { accepted: ["ENFORCED"] } },
  },
  contract_drift_policy: {
    canonical_head: { action: "HOLD_AT_BOUNDARY", boundary: "MERGE_ONLY" },
  },
  recovery_policy: { capability_downgrade: "HOLD" },
});

export const noOverrides = (): Record<string, unknown> => ({ items: [] });

/** A policy that already satisfies every auto_merge safety rule. */
export const autoMergePolicy = (): Record<string, unknown> => ({
  ...validExecutionPolicy(),
  auto_merge: true,
});
