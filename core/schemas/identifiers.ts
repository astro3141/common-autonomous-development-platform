/**
 * Generic identifier constructors (TD §6.1).
 *
 *   run_id      = run:<ulid>
 *   batch_id    = batch:<run_id>:<n>
 *   task_key    = task:<project_id>:<external_task_ref>
 *   attempt_key = attempt:<task_key>:<n>
 *   op_key      = op:<attempt_key|batch_id>:<operation>[:<qualifier>]
 *
 * TD §6.1 constraint: backend-native references (workflow ids, PR numbers, …) are
 * **never** part of a generic identifier — they live in `adapter_metadata`. Accordingly
 * no constructor here takes a backend reference, and none generates identity itself:
 * the ULID is supplied by the caller so identifier construction stays deterministic.
 *
 * **D+ positional injectivity (TD §6.1 composition rule).** Composition is injective over
 * the logical component tuple, achieved with no codec, escaping or surrogate:
 *
 *  - `external_task_ref` is an adapter-scoped opaque string. Core neither interprets it nor
 *    constrains its domain — `:` is allowed. In `task_key` it is everything after the first
 *    structural separator that follows `project_id`.
 *  - Core/Profile-owned structural boundary components carry the minimum grammar that fixes
 *    those separators: `project_id` has no `:`; `<n>` is a decimal terminal component;
 *    `operation` is non-empty, has no `:` and is not a pure decimal token; an optional
 *    `qualifier` is a single segment with no `:`.
 *  - Decoding is not a Core requirement, so no parse/decode API exists here.
 */

import { IdentifierError } from "./errors.ts";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // Crockford base32, 26 chars, uppercase
const RUN_ID = /^run:[0-9A-HJKMNP-TV-Z]{26}$/;

/** True for a canonical ULID. Shared so ULID grammar has one definition. */
export function isUlid(value: string): boolean {
  return typeof value === "string" && ULID.test(value);
}

/** `run:<ulid>` */
export function runId(ulid: string): string {
  if (typeof ulid !== "string" || !ULID.test(ulid)) {
    throw new IdentifierError(`invalid ULID: ${JSON.stringify(ulid)}`);
  }
  return `run:${ulid}`;
}

/** `batch:<run_id>:<n>` */
export function batchId(run: string, n: number): string {
  assertRunId(run);
  assertOrdinal(n, "batch ordinal");
  return `batch:${run}:${n}`;
}

/**
 * `task:<project_id>:<external_task_ref>` — the external ref is assigned by a TaskSource and
 * stays opaque: it may contain `:` and Core imposes no charset on it. `project_id` carries the
 * only structural grammar needed, which fixes the separator that ends it.
 */
export function taskKey(projectId: string, externalTaskRef: string): string {
  assertStructuralSegment(projectId, "project_id");
  assertOpaque(externalTaskRef, "external_task_ref");
  return `task:${projectId}:${externalTaskRef}`;
}

/** `attempt:<task_key>:<n>` */
export function attemptKey(task: string, n: number): string {
  assertPrefixed(task, "task:", "task_key");
  assertOrdinal(n, "attempt ordinal");
  return `attempt:${task}:${n}`;
}

/** `op:<attempt_key|batch_id>:<operation>[:<qualifier>]` (TD §21 idempotency key). */
export function opKey(scope: string, operation: string, qualifier?: string): string {
  if (!scope.startsWith("attempt:") && !scope.startsWith("batch:")) {
    throw new IdentifierError(
      `op_key scope must be an attempt_key or a batch_id, got ${JSON.stringify(scope)}`,
    );
  }
  assertOperation(operation);
  if (qualifier === undefined) return `op:${scope}:${operation}`;
  assertStructuralSegment(qualifier, "qualifier");
  return `op:${scope}:${operation}:${qualifier}`;
}

function assertRunId(value: string): void {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw new IdentifierError(`invalid run_id: ${JSON.stringify(value)}`);
  }
}

function assertPrefixed(value: string, prefix: string, what: string): void {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length) {
    throw new IdentifierError(`invalid ${what}: ${JSON.stringify(value)}`);
  }
}

function assertOrdinal(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IdentifierError(`${what} must be a non-negative integer, got ${String(value)}`);
  }
}

/**
 * An adapter-scoped opaque component. Core does not interpret it and does not constrain its
 * domain (TD §6.1 / §8.1) — only the runtime type is checked.
 */
function assertOpaque(value: string, what: string): void {
  if (typeof value !== "string") {
    throw new IdentifierError(`${what} must be a string`);
  }
}

/**
 * A Core/Profile-owned structural boundary component: it must not contain the namespace
 * separator, because that is what keeps the surrounding composition injective (TD §6.1 D+).
 */
function assertStructuralSegment(value: string, what: string): void {
  if (typeof value !== "string") {
    throw new IdentifierError(`${what} must be a string`);
  }
  if (value.includes(":")) {
    throw new IdentifierError(`${what} must not contain ":" (structural separator)`);
  }
}

/**
 * `operation` additionally must be non-empty and must not be a pure decimal token: a decimal
 * operation could be absorbed as an attempt/batch ordinal, collapsing two distinct op tuples
 * onto one string (TD §6.1 D+).
 */
function assertOperation(value: string): void {
  assertStructuralSegment(value, "operation");
  if (value.length === 0) {
    throw new IdentifierError("operation must be a non-empty string");
  }
  if (/^[0-9]+$/.test(value)) {
    throw new IdentifierError(
      `operation must not be a pure decimal token, got ${JSON.stringify(value)}`,
    );
  }
}
