/**
 * B2-AC7 (uniqueness) and B2-AC8 (state safety) — TD I-TD2, §18.1, §21.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../core/store/database.ts";
import { StoreError } from "../core/store/errors.ts";
import { tempStore } from "./support/temp-store.ts";

const OP = "op:attempt:task:alpha:item-7:1:verify";

test("B2-AC7: a new op_key produces exactly one INTENT record", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const begun = store.idempotency.beginIntent(OP);
    assert.equal(begun.created, true);
    assert.equal(begun.record.state, "INTENT");
    assert.equal(begun.record.result, undefined);
    assert.equal(store.idempotency.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC7: a duplicate intent never creates a second row", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const first = store.idempotency.beginIntent(OP);
    const second = store.idempotency.beginIntent(OP);

    assert.equal(second.created, false);
    assert.deepEqual(second.record, first.record);
    assert.equal(store.idempotency.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC7: a completed op_key returns its existing record instead of a new intent", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    store.idempotency.beginIntent(OP);
    store.idempotency.markDone(OP, { effect: "recorded" });

    const again = store.idempotency.beginIntent(OP);
    assert.equal(again.created, false);
    assert.equal(again.record.state, "DONE", "an intent must not overwrite a completion");
    assert.equal(store.idempotency.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC8: INTENT to DONE and INTENT to FAILED are the defined transitions", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    store.idempotency.beginIntent("op:batch:run:X:0:a");
    const done = store.idempotency.markDone("op:batch:run:X:0:a", { code: 1 });
    assert.equal(done.state, "DONE");
    assert.deepEqual(done.result, { code: 1 });

    store.idempotency.beginIntent("op:batch:run:X:0:b");
    const failed = store.idempotency.markFailed("op:batch:run:X:0:b", { reason: "example" });
    assert.equal(failed.state, "FAILED");
    assert.deepEqual(store.idempotency.get("op:batch:run:X:0:b")?.result, { reason: "example" });
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC8: replaying the identical completion is a no-op, not a new identity", () => {
  const temp = tempStore();
  const store = temp.open({ now: () => "t-fixed" });
  try {
    store.idempotency.beginIntent(OP);
    const first = store.idempotency.markDone(OP, { effect: "recorded" });
    const replay = store.idempotency.markDone(OP, { effect: "recorded" });

    assert.deepEqual(replay, first);
    assert.equal(store.idempotency.count(), 1);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC8: undefined state rewrites fail closed", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    store.idempotency.beginIntent("op:batch:run:X:0:done");
    store.idempotency.markDone("op:batch:run:X:0:done");
    store.idempotency.beginIntent("op:batch:run:X:0:failed");
    store.idempotency.markFailed("op:batch:run:X:0:failed");

    const conflicts: ReadonlyArray<() => unknown> = [
      // DONE → FAILED
      () => store.idempotency.markFailed("op:batch:run:X:0:done"),
      // FAILED → DONE
      () => store.idempotency.markDone("op:batch:run:X:0:failed"),
      // DONE → DONE with a different result
      () => store.idempotency.markDone("op:batch:run:X:0:done", { other: true }),
    ];
    for (const [index, attempt] of conflicts.entries()) {
      assert.throws(
        attempt,
        (error: unknown) =>
          error instanceof StoreError && error.code === "IDEMPOTENCY_STATE_CONFLICT",
        `conflict ${index} should be rejected`,
      );
    }

    assert.equal(store.idempotency.get("op:batch:run:X:0:done")?.state, "DONE");
    assert.equal(store.idempotency.get("op:batch:run:X:0:failed")?.state, "FAILED");
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC8: completing an op with no recorded intent is rejected (write-ahead rule)", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.throws(
      () => store.idempotency.markDone("op:batch:run:X:0:never-begun"),
      (error: unknown) =>
        error instanceof StoreError && error.code === "IDEMPOTENCY_RECORD_MISSING",
    );
    assert.equal(store.idempotency.count(), 0);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC8: the schema itself admits no state outside INTENT/DONE/FAILED", () => {
  const temp = tempStore();
  const store = temp.open();
  store.idempotency.beginIntent(OP);
  store.close();

  const database = openDatabase(temp.path);
  try {
    assert.throws(() =>
      database.prepare("UPDATE idempotency SET state = ? WHERE op_key = ?").run("PENDING", OP),
    );
    assert.throws(() =>
      database
        .prepare("INSERT INTO idempotency (op_key, state, result_json, ts) VALUES (?, ?, NULL, ?)")
        .run("op:batch:run:X:0:z", "CANCELLED", "t0001"),
    );
    // op_key is the primary key, so a second row for the same key is impossible.
    assert.throws(() =>
      database
        .prepare("INSERT INTO idempotency (op_key, state, result_json, ts) VALUES (?, ?, NULL, ?)")
        .run(OP, "INTENT", "t0002"),
    );
  } finally {
    database.close();
    temp.dispose();
  }
});
