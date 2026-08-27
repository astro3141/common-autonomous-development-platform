/**
 * B1-AC1 (canonical determinism), B1-AC3 (invalid number rejection),
 * B1-AC4 (canonical output) — TD §6.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBytes,
  canonicalize,
  compareCodePoints,
} from "../core/schemas/canonical-json.ts";
import { CanonicalizationError } from "../core/schemas/errors.ts";

// --- B1-AC1: key insertion order must not change canonical bytes ----------------

test("B1-AC1: key insertion order does not change canonical output", () => {
  const a = {
    zeta: 1,
    alpha: { second: [1, 2, 3], first: true },
    middle: null,
  };
  const b = {
    middle: null,
    alpha: { first: true, second: [1, 2, 3] },
    zeta: 1,
  };

  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(
    canonicalize(a),
    '{"alpha":{"first":true,"second":[1,2,3]},"middle":null,"zeta":1}',
  );
});

test("B1-AC1: array order is significant", () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test("B1-AC1: object keys sort ascending by code point, not by UTF-16 code unit", () => {
  // U+FFFD (65533) precedes U+1D11E (119070) by code point, but the surrogate pair
  // D834 DD1E precedes FFFD by UTF-16 code unit — the naive comparison is wrong here.
  const value = { "\u{1D11E}": 1, "�": 2, A: 3, a: 4 };
  assert.equal(canonicalize(value), '{"A":3,"a":4,"�":2,"\u{1D11E}":1}');

  assert.ok(compareCodePoints("�", "\u{1D11E}") < 0);
  assert.ok("�" > "\u{1D11E}"); // the behaviour we must not rely on
});

test("B1-AC1: canonical bytes are UTF-8", () => {
  const bytes = canonicalBytes({ "ké": "ü" });
  assert.deepEqual(
    bytes,
    new Uint8Array([
      0x7b, 0x22, 0x6b, 0xc3, 0xa9, 0x22, 0x3a, 0x22, 0xc3, 0xbc, 0x22, 0x7d,
    ]),
  );
});

// --- B1-AC3: invalid numbers are rejected, never coerced ------------------------

test("B1-AC3: floats are rejected without rounding or stringification", () => {
  for (const value of [1.5, -0.1, 3.14159, 1 / 3]) {
    assert.throws(
      () => canonicalize({ value }),
      (error: unknown) => {
        assert.ok(error instanceof CanonicalizationError);
        assert.equal(error.code, "FLOAT_NOT_ALLOWED");
        assert.equal(error.path, "/value");
        return true;
      },
      `expected ${value} to be rejected`,
    );
  }
});

test("B1-AC3: non-finite and non-representable integers are rejected", () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [Number.NaN, "NON_FINITE_NUMBER"],
    [Number.POSITIVE_INFINITY, "NON_FINITE_NUMBER"],
    [Number.NEGATIVE_INFINITY, "NON_FINITE_NUMBER"],
    [2 ** 53, "UNSAFE_INTEGER"],
    [1e21, "UNSAFE_INTEGER"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => canonicalize({ value }),
      (error: unknown) => error instanceof CanonicalizationError && error.code === code,
      `expected ${String(value)} → ${code}`,
    );
  }
});

test("B1-AC3: values outside the restricted data model are rejected", () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [undefined, "UNSUPPORTED_TYPE"],
    [10n, "UNSUPPORTED_TYPE"],
    [Symbol("s"), "UNSUPPORTED_TYPE"],
    [() => 1, "UNSUPPORTED_TYPE"],
    [new Date(0), "UNSUPPORTED_TYPE"],
    [new Map(), "UNSUPPORTED_TYPE"],
    ["\uD834", "LONE_SURROGATE"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => canonicalize({ value }),
      (error: unknown) => error instanceof CanonicalizationError && error.code === code,
      `expected ${String(value?.toString?.() ?? value)} → ${code}`,
    );
  }
});

test("B1-AC3: reference cycles are rejected instead of overflowing", () => {
  const value: Record<string, unknown> = {};
  value["self"] = value;
  assert.throws(
    () => canonicalize(value),
    (error: unknown) => error instanceof CanonicalizationError && error.code === "CYCLE",
  );
});

// --- B1-AC4: canonical output shape --------------------------------------------

test("B1-AC4: output carries no insignificant whitespace", () => {
  const text = canonicalize({
    b: [1, { d: 2, c: 3 }],
    a: "x",
  });
  assert.equal(text, '{"a":"x","b":[1,{"c":3,"d":2}]}');
  assert.equal(/\s/.test(text), false);
});

test("B1-AC4: whitespace inside string values is preserved verbatim", () => {
  assert.equal(canonicalize({ a: " two words\t" }), '{"a":" two words\\t"}');
});

test("B1-AC4: integers use minimal decimal notation", () => {
  assert.equal(canonicalize([0, -0, 1, -1, 1000, 9007199254740991]), "[0,0,1,-1,1000,9007199254740991]");
});

test("B1-AC4: string escaping follows the JCS subset", () => {
  const input = "\u0000\b\t\n\u000b\f\r\"\\\u00e9";
  assert.equal(canonicalize(input), '"\\u0000\\b\\t\\n\\u000b\\f\\r\\"\\\\\u00e9"');
});

test("B1-AC4: top-level scalars canonicalize", () => {
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(true), "true");
  assert.equal(canonicalize(false), "false");
  assert.equal(canonicalize(-7), "-7");
  assert.equal(canonicalize("x"), '"x"');
  assert.equal(canonicalize([]), "[]");
  assert.equal(canonicalize({}), "{}");
});
