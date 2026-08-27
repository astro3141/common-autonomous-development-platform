/**
 * Contract-build-local failures.
 *
 * Local reasons only. Mapping to the Platform taxonomy (`CONTRACT_BUILD_ERROR`, §24) and the
 * transition that follows belong to the Coordinator batch.
 */

export type ContractErrorReason =
  /** A build input violates the v1 schema. */
  | "CONTRACT_INVALID"
  /** Supplied contract source bytes do not match the Profile-declared source list. */
  | "CONTRACT_SOURCE_MISMATCH";

export class ContractError extends Error {
  readonly reason: ContractErrorReason;
  readonly path: string;

  constructor(reason: ContractErrorReason, path: string, detail: string) {
    super(`${reason} at ${path === "" ? "/" : path}: ${detail}`);
    this.name = "ContractError";
    this.reason = reason;
    this.path = path;
  }
}

export function contractError(path: string, detail: string): ContractError {
  return new ContractError("CONTRACT_INVALID", path, detail);
}
