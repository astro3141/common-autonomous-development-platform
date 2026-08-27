/**
 * Capability model validation failures.
 *
 * These reasons are local to this module. Only three failure meanings are authoritative outside
 * it — `MANIFEST_SET_INVALID` (TD §12.2a), `POLICY_BACKEND_INCOMPATIBLE` (V10, a later batch) and
 * `CAPABILITY_BOUNDARY_CHANGED` (TD §12.6) — and the mapping to them belongs to the callers that
 * own those transitions.
 */

export type CapabilityErrorReason =
  /** Manifest envelope or body violates the v1 schema. */
  | "MANIFEST_INVALID"
  /** The four-component set is missing, duplicated or mis-kinded (TD §12.2a). */
  | "MANIFEST_SET_INVALID"
  /** Grant construction input violates the v1 schema. */
  | "GRANT_INVALID";

export class CapabilityError extends Error {
  readonly reason: CapabilityErrorReason;
  /** Where the failure is, e.g. `/capability_enforcement/shell.execute/allow`. */
  readonly path: string;

  constructor(reason: CapabilityErrorReason, path: string, detail: string) {
    super(`${reason} at ${path === "" ? "/" : path}: ${detail}`);
    this.name = "CapabilityError";
    this.reason = reason;
    this.path = path;
  }
}

export function manifestError(path: string, detail: string): CapabilityError {
  return new CapabilityError("MANIFEST_INVALID", path, detail);
}

export function grantError(path: string, detail: string): CapabilityError {
  return new CapabilityError("GRANT_INVALID", path, detail);
}
