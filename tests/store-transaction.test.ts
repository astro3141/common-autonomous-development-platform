/**
 * B2-AC4 — transaction atomicity (TD §18.2: one state transition = one transaction).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { StoreError } from "../core/store/errors.ts";
import { tempStore } from "./support/temp-store.ts";

test("B2-AC4: a successful transaction commits every write together", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    store.withTransaction(() => {
      store.decisions.append({ kind: "example", refKey: "ref-1", payload: { step: 1 } });
      store.idempotency.beginIntent("op:example:1");
      store.blobs.put(new Uint8Array([1, 2, 3]));
    });

    assert.equal(store.decisions.count(), 1);
    assert.equal(store.idempotency.count(), 1);
    assert.equal(store.blobs.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC4: a throwing transaction leaves no partial state", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const boom = new Error("transition aborted");
    assert.throws(
      () =>
        store.withTransaction(() => {
          store.decisions.append({ kind: "example", refKey: "ref-1", payload: { step: 1 } });
          store.idempotency.beginIntent("op:example:1");
          store.blobs.put(new Uint8Array([1, 2, 3]));
          throw boom;
        }),
      (error: unknown) => error === boom,
    );

    assert.equal(store.decisions.count(), 0);
    assert.equal(store.idempotency.count(), 0);
    assert.equal(store.blobs.count(), 0);
    assert.equal(store.idempotency.get("op:example:1"), undefined);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC4: a rolled back transaction does not affect earlier committed ones", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    store.withTransaction(() => {
      store.decisions.append({ kind: "example", refKey: "kept", payload: null });
    });
    assert.throws(() =>
      store.withTransaction(() => {
        store.decisions.append({ kind: "example", refKey: "discarded", payload: null });
        throw new Error("abort");
      }),
    );

    assert.deepEqual(
      store.decisions.read().map((entry) => entry.refKey),
      ["kept"],
    );
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC4: the store recovers for the next transaction after a rollback", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.throws(() =>
      store.withTransaction(() => {
        throw new Error("abort");
      }),
    );
    store.withTransaction(() => {
      store.decisions.append({ kind: "example", refKey: "after", payload: null });
    });
    assert.equal(store.decisions.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("nested transactions are rejected rather than emulated", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.throws(
      () =>
        store.withTransaction(() => {
          store.withTransaction(() => undefined);
        }),
      (error: unknown) => error instanceof StoreError && error.code === "NESTED_TRANSACTION",
    );
    // The outer transaction was rolled back, so the writer is usable again.
    store.withTransaction(() => {
      store.decisions.append({ kind: "example", refKey: "after", payload: null });
    });
    assert.equal(store.decisions.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});
