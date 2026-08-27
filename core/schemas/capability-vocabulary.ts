/**
 * Fixed capability vocabularies (TD §12.1, §12.2 / Spec §26).
 *
 * Types only plus their runtime value lists — no capability logic lives here. The Broker, the
 * Manifest loader and the compatibility calculation belong to a later batch. `adapters/interfaces`
 * re-exports these so both the adapter boundary and Core validate against one source of truth.
 */

/** TD §12.1 — the fixed v1 capability vocabulary. Not subdivided further. */
export type CapabilityName =
  | "repository.read"
  | "repository.feature_write"
  | "repository.canonical_write"
  | "repository.merge"
  | "repository.create_workspace"
  | "shell.execute"
  | "runtime.spawn_child"
  | "remote.feature_push"
  | "remote.canonical_push"
  | "remote.create_pr"
  | "destructive.git_clean"
  | "destructive.reset_hard";

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "repository.read",
  "repository.feature_write",
  "repository.canonical_write",
  "repository.merge",
  "repository.create_workspace",
  "shell.execute",
  "runtime.spawn_child",
  "remote.feature_push",
  "remote.canonical_push",
  "remote.create_pr",
  "destructive.git_clean",
  "destructive.reset_hard",
];

/** TD §12.2 / Spec §26 — declared enforcement assurance. No linear ordering is implied. */
export type EnforcementAssurance =
  | "ENFORCED"
  | "AVAILABLE_WITH_REDUCED_ASSURANCE"
  | "UNENFORCEABLE_CAPABILITY_BOUNDARY"
  | "NOT_YET_AUDITED";

export const ENFORCEMENT_ASSURANCES: readonly EnforcementAssurance[] = [
  "ENFORCED",
  "AVAILABLE_WITH_REDUCED_ASSURANCE",
  "UNENFORCEABLE_CAPABILITY_BOUNDARY",
  "NOT_YET_AUDITED",
];
