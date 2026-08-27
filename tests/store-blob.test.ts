/**
 * B2-AC5 — content-addressed raw-byte fidelity (TD §10.2, §18.1), reusing the Batch 1
 * Contract Source hash as the only address authority.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { hashContractSourceBytes } from "../core/contract/source-hash.ts";
import { openDatabase } from "../core/store/database.ts";
import { StoreError } from "../core/store/errors.ts";
import { tempStore } from "./support/temp-store.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

test("B2-AC5: the address is the Batch 1 Contract Source hash of the exact bytes", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const bytes = utf8("line one\nline two\n");
    assert.equal(store.blobs.put(bytes), hashContractSourceBytes(bytes));
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC5: bytes round-trip exactly, including binary content", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const cases: ReadonlyArray<Uint8Array> = [
      utf8("plain"),
      new Uint8Array([]),
      new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x00]),
      new Uint8Array(Array.from({ length: 512 }, (_, index) => index % 256)),
    ];
    for (const bytes of cases) {
      const hash = store.blobs.put(bytes);
      assert.deepEqual(store.blobs.get(hash), bytes);
    }
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC5: newline, trailing-newline and BOM differences are distinct blobs", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const variants = [
      utf8("line one\nline two\n"),
      utf8("line one\r\nline two\r\n"),
      utf8("line one\nline two"),
      utf8("\ufeffline one\nline two\n"),
    ];
    const hashes = variants.map((bytes) => store.blobs.put(bytes));

    assert.equal(new Set(hashes).size, variants.length, "each variant needs its own address");
    assert.equal(store.blobs.count(), variants.length);
    for (const [index, hash] of hashes.entries()) {
      assert.deepEqual(store.blobs.get(hash), variants[index]);
    }
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC5: re-inserting identical bytes yields one logical blob", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const bytes = utf8("contract source");
    const first = store.blobs.put(bytes);
    const second = store.blobs.put(new Uint8Array(bytes)); // distinct object, same content

    assert.equal(first, second);
    assert.equal(store.blobs.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC5: a missing address reads as missing, and callers cannot supply an address", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.blobs.get(`sha256:${"0".repeat(64)}`), undefined);
    assert.equal(store.blobs.has(`sha256:${"0".repeat(64)}`), false);
    // put() takes bytes only — there is no parameter through which a caller could assert a hash.
    assert.equal(store.blobs.put.length, 1);
    assert.throws(() => store.blobs.put("text" as unknown as Uint8Array), TypeError);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC5: corrupted content is not silently overwritten", () => {
  const temp = tempStore();
  const bytes = utf8("original");
  const hash = hashContractSourceBytes(bytes);

  const store = temp.open();
  store.blobs.put(bytes);
  store.close();

  // Simulate on-disk corruption: the row's bytes no longer match its address.
  const database = openDatabase(temp.path);
  database.prepare("UPDATE blob SET bytes = ? WHERE content_hash = ?").run(utf8("tampered"), hash);
  database.close();

  const reopened = temp.open();
  try {
    assert.throws(
      () => reopened.blobs.put(bytes),
      (error: unknown) => error instanceof StoreError && error.code === "BLOB_CONTENT_MISMATCH",
    );
    assert.deepEqual(reopened.blobs.get(hash), utf8("tampered"), "the store must not repair it");
  } finally {
    reopened.close();
    temp.dispose();
  }
});
