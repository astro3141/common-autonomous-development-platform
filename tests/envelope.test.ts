/**
 * B1-AC1 (hash determinism) and B1-AC2 (semantic difference changes hash) — TD §6 items 3–4.
 *
 * Fixtures use a neutral, invented vocabulary only.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalizationError } from "../core/schemas/errors.ts";
import { isDigest } from "../core/schemas/digest.ts";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  makeEnvelope,
  type SchemaEnvelope,
} from "../core/schemas/envelope.ts";

const SCHEMA = "platform/example-record";

const BODY = {
  label: "sample",
  limits: { max_items: 3, allow_empty: false },
  tags: ["one", "two"],
  note: null,
} as const;

/**
 * Pinned so a canonicalization regression cannot be hidden by recomputing both sides.
 * Cross-checked against an independent SHA-256 of the canonical text
 * `{"body":{"label":"sample","limits":{"allow_empty":false,"max_items":3},"note":null,`
 * `"tags":["one","two"]},"schema":"platform/example-record","schema_version":1}`.
 */
const PINNED_BODY_DIGEST = "sha256:a660d3eb72c87b40a56ba99ecc9a73de1980d30b6b1ba22d423f68cb1de5b3c5";

test("B1-AC1: envelope hash is independent of key insertion order", () => {
  const a = makeEnvelope(SCHEMA, 1, {
    label: "sample",
    limits: { max_items: 3, allow_empty: false },
    tags: ["one", "two"],
    note: null,
  });
  const b = { body: { note: null, tags: ["one", "two"], limits: { allow_empty: false, max_items: 3 }, label: "sample" }, schema_version: 1, schema: SCHEMA } as SchemaEnvelope;

  assert.equal(hashEnvelope(a), hashEnvelope(b));
  assert.equal(canonicalizeEnvelope(a), canonicalizeEnvelope(b));
});

test("B1-AC1: envelope hash is a pinned, restart-stable value", () => {
  const digest = hashEnvelope(makeEnvelope(SCHEMA, 1, BODY));
  assert.ok(isDigest(digest));
  assert.equal(digest, PINNED_BODY_DIGEST);
});

test("B1-AC1: the envelope itself is part of the hashed canonical bytes", () => {
  const envelope = makeEnvelope(SCHEMA, 1, { label: "sample" });
  assert.equal(
    canonicalizeEnvelope(envelope),
    '{"body":{"label":"sample"},"schema":"platform/example-record","schema_version":1}',
  );
});

test("B1-AC2: a body value change changes the hash", () => {
  const base = hashEnvelope(makeEnvelope(SCHEMA, 1, BODY));
  const changedScalar = hashEnvelope(
    makeEnvelope(SCHEMA, 1, { ...BODY, limits: { max_items: 4, allow_empty: false } }),
  );
  const changedArray = hashEnvelope(makeEnvelope(SCHEMA, 1, { ...BODY, tags: ["two", "one"] }));
  const droppedMember = hashEnvelope(makeEnvelope(SCHEMA, 1, { label: BODY.label }));

  assert.notEqual(base, changedScalar);
  assert.notEqual(base, changedArray);
  assert.notEqual(base, droppedMember);
});

test("B1-AC2: a schema change changes the hash", () => {
  assert.notEqual(
    hashEnvelope(makeEnvelope(SCHEMA, 1, BODY)),
    hashEnvelope(makeEnvelope("platform/other-record", 1, BODY)),
  );
});

test("B1-AC2: a schema_version change changes the hash", () => {
  assert.notEqual(
    hashEnvelope(makeEnvelope(SCHEMA, 1, BODY)),
    hashEnvelope(makeEnvelope(SCHEMA, 2, BODY)),
  );
});

test("B1-AC2: type change with equal textual value changes the hash", () => {
  assert.notEqual(
    hashEnvelope(makeEnvelope(SCHEMA, 1, { count: 1 })),
    hashEnvelope(makeEnvelope(SCHEMA, 1, { count: "1" })),
  );
});

test("envelope shape violations are rejected", () => {
  const cases: ReadonlyArray<unknown> = [
    { schema: "", schema_version: 1, body: {} },
    { schema: SCHEMA, schema_version: 0, body: {} },
    { schema: SCHEMA, schema_version: 1.5, body: {} },
    { schema: SCHEMA, schema_version: 1, body: [] },
    { schema: SCHEMA, schema_version: 1, body: null },
    { schema: SCHEMA, schema_version: 1, body: {}, extra: 1 },
  ];
  for (const value of cases) {
    assert.throws(
      () => hashEnvelope(value as SchemaEnvelope),
      (error: unknown) =>
        error instanceof CanonicalizationError && error.code === "INVALID_ENVELOPE",
      `expected rejection for ${JSON.stringify(value)}`,
    );
  }
});

test("a float anywhere in the body is rejected before hashing", () => {
  assert.throws(
    () => hashEnvelope(makeEnvelope(SCHEMA, 1, { ratio: 0.5 })),
    (error: unknown) =>
      error instanceof CanonicalizationError && error.code === "FLOAT_NOT_ALLOWED",
  );
});
