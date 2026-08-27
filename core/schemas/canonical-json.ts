/**
 * Restricted JSON data model + deterministic canonical serialization.
 *
 * TD §6 (Q1) decision:
 *  - allowed types: object / array / string / integer / boolean / null. **float 금지.**
 *  - canonical form: RFC 8785 (JCS) subset — UTF-8, object keys sorted ascending by
 *    code point, no insignificant whitespace, integers in minimal decimal notation.
 *
 * This module is a pure primitive: no I/O, no time, no randomness.
 */

import { CanonicalizationError } from "./errors.ts";

/** A value expressible in the restricted JSON data model of TD §6. */
export type CanonicalValue =
  | null
  | boolean
  | number // integers only — see assertInteger
  | string
  | readonly CanonicalValue[]
  | CanonicalObject;

export interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}

/**
 * Serializes a value to its canonical JSON text (TD §6 item 2).
 * Throws {@link CanonicalizationError} for anything outside the restricted model.
 */
export function canonicalize(value: unknown): string {
  return writeValue(value, "", new Set<object>());
}

/** Canonical JSON text of {@link canonicalize} encoded as UTF-8 bytes — the hash input. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function writeValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return writeNumber(value, path);
    case "string":
      return writeString(value, path);
    case "object":
      break;
    default:
      throw new CanonicalizationError(
        "UNSUPPORTED_TYPE",
        path,
        `type "${typeof value}" is not part of the restricted JSON data model`,
      );
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new CanonicalizationError("CYCLE", path, "reference cycle");
  }
  ancestors.add(object);
  try {
    if (Array.isArray(object)) return writeArray(object, path, ancestors);
    return writeObject(object, path, ancestors);
  } finally {
    ancestors.delete(object);
  }
}

function writeArray(value: readonly unknown[], path: string, ancestors: Set<object>): string {
  const items = value.map((item, index) => writeValue(item, `${path}/${index}`, ancestors));
  return `[${items.join(",")}]`;
}

function writeObject(value: object, path: string, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError(
      "UNSUPPORTED_TYPE",
      path,
      `only plain objects are canonicalizable, got ${value.constructor?.name ?? "exotic object"}`,
    );
  }

  const keys = Object.keys(value);
  for (const key of keys) assertEncodable(key, `${path}/${key}`, "object key");
  keys.sort(compareCodePoints);

  const members = keys.map((key) => {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) {
      // JSON.stringify silently drops these; silent alteration is forbidden by TD §6.
      throw new CanonicalizationError(
        "UNSUPPORTED_TYPE",
        `${path}/${key}`,
        "undefined member (values are never silently dropped)",
      );
    }
    return `${writeString(key, `${path}/${key}`)}:${writeValue(member, `${path}/${key}`, ancestors)}`;
  });
  return `{${members.join(",")}}`;
}

function writeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError("NON_FINITE_NUMBER", path, `${value} is not a finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new CanonicalizationError(
      "FLOAT_NOT_ALLOWED",
      path,
      `${value} is not an integer; represent fractional values as strings`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalizationError(
      "UNSAFE_INTEGER",
      path,
      `${value} is outside the exactly representable integer range`,
    );
  }
  // Safe integers stringify to minimal decimal notation with no exponent; -0 renders as "0".
  return String(value);
}

const SHORT_ESCAPES = new Map<number, string>([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

function writeString(value: string, path: string): string {
  assertEncodable(value, path, "string");

  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    const short = SHORT_ESCAPES.get(code);
    if (short !== undefined) {
      out += short;
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/** Rejects unpaired surrogates: those have no UTF-8 encoding (TD §6: 비-UTF8 입력 거부). */
function assertEncodable(value: string, path: string, what: string): void {
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new CanonicalizationError(
        "LONE_SURROGATE",
        path,
        `${what} contains unpaired surrogate U+${code.toString(16).toUpperCase()} and is not UTF-8 encodable`,
      );
    }
  }
}

/**
 * Ascending comparison by Unicode code point (TD §6 item 2).
 *
 * JavaScript's default string comparison orders by UTF-16 code unit, which places
 * astral characters before U+E000–U+FFFF. Code point order is compared explicitly.
 */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const l = (left[index] as string).codePointAt(0) as number;
    const r = (right[index] as string).codePointAt(0) as number;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}
