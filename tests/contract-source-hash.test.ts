/**
 * B1-AC5 — structured envelope hash vs Contract Source raw-byte hash are separate
 * APIs on separate paths, and the raw path performs no canonical JSON normalization
 * (TD §6 items 4–5, §10.2).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { hashContractSourceBytes } from "../core/contract/source-hash.ts";
import { canonicalEnvelopeBytes, hashEnvelope, makeEnvelope } from "../core/schemas/envelope.ts";
import { isDigest } from "../core/schemas/digest.ts";
import * as schemas from "../core/schemas/index.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

test("B1-AC5: the two hashing paths are distinct exported APIs", () => {
  assert.equal(typeof hashContractSourceBytes, "function");
  assert.equal(typeof hashEnvelope, "function");
  assert.notEqual(hashContractSourceBytes as unknown, hashEnvelope as unknown);
  // The Core schema barrel must not expose the raw-source path.
  assert.equal("hashContractSourceBytes" in schemas, false);
});

test("B1-AC5: Contract Source hashing accepts bytes only, never a structured object", () => {
  assert.throws(
    () => hashContractSourceBytes({ label: "sample" } as unknown as Uint8Array),
    TypeError,
  );
  assert.throws(() => hashContractSourceBytes("text" as unknown as Uint8Array), TypeError);
});

test("B1-AC5: newline differences in a source file change the content hash", () => {
  const lf = hashContractSourceBytes(utf8("line one\nline two\n"));
  const crlf = hashContractSourceBytes(utf8("line one\r\nline two\r\n"));
  const noTrailing = hashContractSourceBytes(utf8("line one\nline two"));

  assert.ok(isDigest(lf));
  assert.notEqual(lf, crlf);
  assert.notEqual(lf, noTrailing);
});

test("B1-AC5: encoding differences of the same text change the content hash", () => {
  const withBom = hashContractSourceBytes(utf8("\ufeffsample"));
  const withoutBom = hashContractSourceBytes(utf8("sample"));
  const utf16 = hashContractSourceBytes(new Uint8Array([0x73, 0x00, 0x61, 0x00]));

  assert.notEqual(withBom, withoutBom);
  assert.notEqual(utf16, hashContractSourceBytes(utf8("sa")));
});

test("B1-AC5: the raw path applies no canonical JSON normalization", () => {
  // Same logical JSON document, different byte layout: identical structured hash,
  // different Contract Source hash.
  const documentA = '{"b":1,"a":2}';
  const documentB = '{\n  "a": 2,\n  "b": 1\n}\n';

  assert.notEqual(hashContractSourceBytes(utf8(documentA)), hashContractSourceBytes(utf8(documentB)));
  assert.equal(
    hashEnvelope(makeEnvelope("platform/example-record", 1, JSON.parse(documentA))),
    hashEnvelope(makeEnvelope("platform/example-record", 1, JSON.parse(documentB))),
  );
});

test("B1-AC5: the raw path hashes exactly the bytes it is given", () => {
  const envelope = makeEnvelope("platform/example-record", 1, { label: "sample" });
  const canonical = canonicalEnvelopeBytes(envelope);

  // Only when the file bytes happen to be exactly the canonical bytes do the two agree;
  // that coincidence is the sole overlap, and it is not a shared code path.
  assert.equal(hashContractSourceBytes(canonical), hashEnvelope(envelope));
  assert.notEqual(
    hashContractSourceBytes(utf8(new TextDecoder().decode(canonical) + "\n")),
    hashEnvelope(envelope),
  );
});
