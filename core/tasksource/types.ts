/**
 * Generic TaskSource contracts (TD §8.1, M0-24).
 *
 * The required surface is exactly four read operations. `update_task_projection` is an optional
 * future extension point, not part of v1 — no placeholder or no-op method is declared here.
 */

/** TD §8.1 — external lifecycle state as the TaskSource sees it. Not Platform task state (§8.3). */
export type ExternalTaskState =
  | "TODO"
  | "READY"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "CLOSED"
  | "UNKNOWN";

export const EXTERNAL_TASK_STATES: readonly ExternalTaskState[] = [
  "TODO",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "CLOSED",
  "UNKNOWN",
];

export type DependencyKind = "HARD" | "SOFT";
export const DEPENDENCY_KINDS: readonly DependencyKind[] = ["HARD", "SOFT"];

/**
 * TD §8.1/M0-24 — the only discovery input. `observed_at` exists so the caller controls the
 * observation time; adapters never read a clock or a file mtime for it.
 */
export interface TaskDiscoveryContextV1 {
  readonly observed_at: string;
}

export interface TaskCandidate {
  /** Adapter-scoped opaque ref; Core does not interpret its internal syntax (§6.1 D+). */
  readonly task_ref: string;
  readonly title: string;
  readonly summary: string;
  readonly external_state: ExternalTaskState;
  /** Always `context.observed_at` — observation metadata, never part of any hash. */
  readonly discovered_at: string;
}

/** TD §8.1a — the exact hashed body. Unknown fields are rejected. */
export interface TaskDefinitionBodyV1 {
  readonly title: string;
  readonly description: string;
  /** Generic array: order-sensitive, never deduplicated or sorted (M0-13). */
  readonly references: readonly string[];
  readonly acceptance_notes: readonly string[];
}

export const TASK_DEFINITION_BODY_FIELDS: readonly string[] = [
  "title",
  "description",
  "references",
  "acceptance_notes",
];

export interface TaskDefinition {
  readonly task_ref: string;
  /** Adapter provenance/change label — deliberately outside the definition hash (§8.1a). */
  readonly version: string;
  readonly definition_hash: string;
  readonly body: TaskDefinitionBodyV1;
}

/** What an adapter may hand to the normalization boundary before validation. */
export interface RawTaskDefinition {
  readonly task_ref: string;
  readonly version: string;
  /** Optional; when present it must equal the recomputed Platform hash (§8.1a). */
  readonly definition_hash?: string;
  readonly body: unknown;
}

export interface TaskDependency {
  readonly task_ref: string;
  readonly depends_on_ref: string;
  readonly kind: DependencyKind;
}

/** TD §8.1 / M0-24 — required callable surface, exactly four read operations. */
export interface TaskSourceV1 {
  discover_tasks(context: TaskDiscoveryContextV1): readonly TaskCandidate[];
  get_task(task_ref: string): TaskDefinition;
  get_dependencies(task_ref: string): readonly TaskDependency[];
  get_task_state(task_ref: string): ExternalTaskState;
}

export const TASK_DEFINITION_SCHEMA = "platform/task-definition";
