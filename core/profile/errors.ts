/**
 * Profile compilation failure (TD §6 failure behavior, §7.2, §7.3).
 *
 * One error type with a small reason code — the documents use a single `COMPILE_ERROR` family, so
 * no taxonomy is invented here. Nothing is ever coerced, defaulted or silently corrected: every
 * failure below rejects before a Compiled Profile exists.
 */

export type CompileErrorReason =
  /** A value violates the v1 schema (missing, unknown, wrong type, out of domain). */
  | "SCHEMA_INVALID"
  /** A value is duplicated where the schema requires uniqueness. */
  | "DUPLICATE"
  /** Cross-document consistency failed (§7.3 S1–S12). */
  | "EFFECTIVE_INVALID"
  /** An override targets a path outside the v1 whitelist (§7.1c). */
  | "OVERRIDE_NOT_ALLOWED"
  /** An override would change nothing (§7.2 rule 5). */
  | "OVERRIDE_NO_OP"
  /** An override's privilege direction cannot be determined (§7.2 rule 6). */
  | "OVERRIDE_INCOMPARABLE"
  /** approval metadata is present/absent contrary to the override's direction (§7.2 rule 6). */
  | "OVERRIDE_APPROVAL_SHAPE"
  /** The authority binding for a privilege-expanding override failed (§7.2 rule 6). */
  | "APPROVAL_BINDING_INVALID";

export class ProfileCompileError extends Error {
  readonly code = "COMPILE_ERROR" as const;
  readonly reason: CompileErrorReason;
  /** Where the failure is, e.g. `/task_sources/1/id` or `override:auto_merge`. */
  readonly path: string;

  constructor(reason: CompileErrorReason, path: string, detail: string) {
    super(`COMPILE_ERROR[${reason}] at ${path === "" ? "/" : path}: ${detail}`);
    this.name = "ProfileCompileError";
    this.reason = reason;
    this.path = path;
  }
}

export function schemaError(path: string, detail: string): ProfileCompileError {
  return new ProfileCompileError("SCHEMA_INVALID", path, detail);
}
