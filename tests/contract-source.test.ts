/**
 * B6-AC22 ~ B6-AC25 — Contract Source raw-byte capture, Profile-declared binding and the
 * caller-owned transaction boundary (TD §10.2, M0-22).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { captureContractSources } from "../core/contract/contract-source.ts";
import { ContractError } from "../core/contract/errors.ts";
import { hashContractSourceBytes } from "../core/contract/source-hash.ts";
import { tempStore } from "./support/temp-store.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const withStore = <T>(run: (store: ReturnType<ReturnType<typeof tempStore>["open"]>) => T): T => {
  const temp = tempStore();
  const store = temp.open();
  try {
    return run(store);
  } finally {
    store.close();
    temp.dispose();
  }
};

const failsWith = (reason: string, run: () => unknown): void => {
  assert.throws(run, (error: unknown) => error instanceof ContractError && error.reason === reason);
};

test("B6-AC22: bytes go to the Batch 2 BlobStore and the hash is the Batch 1 raw hash", () => {
  withStore((store) => {
    const bytes = utf8("line one\nline two\n");
    const captured = captureContractSources(["SPEC.md"], [{ path: "SPEC.md", bytes }], store.blobs);

    assert.deepEqual(captured, [{ path: "SPEC.md", content_hash: hashContractSourceBytes(bytes) }]);
    assert.deepEqual(store.blobs.get(captured[0]?.content_hash as string), bytes);
  });
});

test("B6-AC22: byte-level differences stay visible and identical bytes dedup", () => {
  withStore((store) => {
    const variants: ReadonlyArray<readonly [string, Uint8Array]> = [
      ["a.md", utf8("line\n")],
      ["b.md", utf8("line\r\n")],
      ["c.md", utf8("line")],
      ["d.md", utf8("﻿line\n")],
    ];
    const captured = captureContractSources(
      variants.map(([path]) => path),
      variants.map(([path, bytes]) => ({ path, bytes })),
      store.blobs,
    );

    const hashes = captured.map((entry) => entry.content_hash);
    assert.equal(new Set(hashes).size, 4, "newline/BOM/trailing differences must differ");

    // Two declared paths with identical bytes share one blob row.
    const same = utf8("shared");
    captureContractSources(
      ["x.md", "y.md"],
      [
        { path: "x.md", bytes: same },
        { path: "y.md", bytes: new Uint8Array(same) },
      ],
      store.blobs,
    );
    assert.equal(store.blobs.count(), 5);
  });
});

test("B6-AC24: output follows the Profile-declared order, not the input order", () => {
  withStore((store) => {
    const declared = ["SPEC.md", "DESIGN.md", "NOTES.md"];
    const captured = captureContractSources(
      declared,
      [
        { path: "NOTES.md", bytes: utf8("n") },
        { path: "SPEC.md", bytes: utf8("s") },
        { path: "DESIGN.md", bytes: utf8("d") },
      ],
      store.blobs,
    );

    assert.deepEqual(captured.map((entry) => entry.path), declared);
  });
});

test("B6-AC24: missing, extra and duplicate sources fail closed", () => {
  withStore((store) => {
    failsWith("CONTRACT_SOURCE_MISMATCH", () =>
      captureContractSources(["SPEC.md", "DESIGN.md"], [{ path: "SPEC.md", bytes: utf8("s") }], store.blobs),
    );
    failsWith("CONTRACT_SOURCE_MISMATCH", () =>
      captureContractSources(
        ["SPEC.md"],
        [
          { path: "SPEC.md", bytes: utf8("s") },
          { path: "EXTRA.md", bytes: utf8("e") },
        ],
        store.blobs,
      ),
    );
    failsWith("CONTRACT_SOURCE_MISMATCH", () =>
      captureContractSources(
        ["SPEC.md"],
        [
          { path: "SPEC.md", bytes: utf8("s") },
          { path: "SPEC.md", bytes: utf8("s2") },
        ],
        store.blobs,
      ),
    );
    failsWith("CONTRACT_SOURCE_MISMATCH", () =>
      captureContractSources(["SPEC.md"], [{ path: "SPEC.md", bytes: "text" as never }], store.blobs),
    );
  });
});

test("B6-AC23: captured refs carry only path and content_hash", () => {
  withStore((store) => {
    const [captured] = captureContractSources(
      ["SPEC.md"],
      [{ path: "SPEC.md", bytes: utf8("s") }],
      store.blobs,
    );
    assert.deepEqual(Object.keys(captured as object).sort(), ["content_hash", "path"]);
    assert.equal(JSON.stringify(captured).includes("storage_ref"), false);
  });
});

test("B6-AC22: capture runs inside a caller-owned transaction and rolls back with it", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const bytes = utf8("rolled back");
    assert.throws(() =>
      store.withTransaction(() => {
        captureContractSources(["SPEC.md"], [{ path: "SPEC.md", bytes }], store.blobs);
        // A later failure in the same transition must undo the blob write too.
        throw new Error("build failed after source capture");
      }),
    );

    assert.equal(store.blobs.count(), 0);
    assert.equal(store.blobs.get(hashContractSourceBytes(bytes)), undefined);

    // The same capture commits normally when the caller's transaction succeeds.
    store.withTransaction(() => {
      captureContractSources(["SPEC.md"], [{ path: "SPEC.md", bytes }], store.blobs);
    });
    assert.equal(store.blobs.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});
