/**
 * Core contract primitive errors.
 *
 * TD §6 failure behavior: 정규화 불가 입력은 실행 전 명시적으로 거부한다.
 * "가까운 값"으로 보정하지 않는다. 상위 계층(Profile Compiler / Contract 빌더)이
 * 이 오류를 PROFILE_COMPILE_ERROR / CONTRACT_BUILD_ERROR로 승격한다.
 */

/** Base class for deterministic Core contract primitive failures. */
export class ContractPrimitiveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export type CanonicalizationErrorCode =
  /** A number was not an integer (TD §6: float 금지). */
  | "FLOAT_NOT_ALLOWED"
  /** NaN / Infinity / -Infinity. */
  | "NON_FINITE_NUMBER"
  /** Integer outside the exactly representable range. */
  | "UNSAFE_INTEGER"
  /** Value outside the restricted JSON data model. */
  | "UNSUPPORTED_TYPE"
  /** String or key that cannot be encoded as UTF-8 (unpaired surrogate). */
  | "LONE_SURROGATE"
  /** Reference cycle in the value graph. */
  | "CYCLE"
  /** Envelope shape violation (TD §6 item 4). */
  | "INVALID_ENVELOPE";

/** Raised when a value cannot be represented in the restricted JSON data model. */
export class CanonicalizationError extends ContractPrimitiveError {
  /** JSON-pointer-like location of the offending value, e.g. `/body/limits/0`. */
  readonly path: string;

  constructor(code: CanonicalizationErrorCode, path: string, detail: string) {
    super(code, `${code} at ${path === "" ? "/" : path}: ${detail}`);
    this.path = path;
  }
}

/** Raised when a generic identifier (TD §6.1) is malformed. */
export class IdentifierError extends ContractPrimitiveError {
  constructor(detail: string) {
    super("INVALID_IDENTIFIER", detail);
  }
}
