/**
 * TaskSource-local failures.
 *
 * Deliberately local: the Platform-wide taxonomy (§24) is owned by the Coordinator batch, which
 * maps these into `CONTRACT_BUILD_ERROR` / `POLICY_REJECTED(TASK_DRIFT)` and friends. No global
 * error framework is introduced here.
 */

export type TaskSourceErrorReason =
  /** Adapter config violates the adapter-owned schema (§8.2). */
  | "CONFIG_INVALID"
  /** A configured document could not be read. */
  | "DOCUMENT_UNREADABLE"
  /** A task block violates the parser grammar (§8.2). */
  | "DOCUMENT_MALFORMED"
  /** The same task_ref appears twice within or across documents (§6.1 D+ injectivity). */
  | "DUPLICATE_TASK_REF"
  /** TaskDefinition body violates §8.1a. */
  | "DEFINITION_INVALID"
  /** An adapter-supplied definition_hash disagrees with the recomputed Platform hash (§8.1a). */
  | "DEFINITION_HASH_MISMATCH"
  /** A requested task_ref does not exist in the configured documents. */
  | "TASK_NOT_FOUND";

export class TaskSourceError extends Error {
  readonly reason: TaskSourceErrorReason;
  /** Where the failure is, e.g. `docs/plan.md:12` or `/body/references/0`. */
  readonly location: string;

  constructor(reason: TaskSourceErrorReason, location: string, detail: string) {
    super(`${reason} at ${location === "" ? "-" : location}: ${detail}`);
    this.name = "TaskSourceError";
    this.reason = reason;
    this.location = location;
  }
}
