/**
 * B2-AC9 — the write-ahead intent foundation (TD I-TD2, §21).
 *
 * No external side effect is performed anywhere in this batch. What is proven here is the
 * durable shape around the effect boundary:
 *
 *   BEGIN → append decision_log + insert idempotency INTENT → COMMIT
 *   --- external side effect boundary belongs to a later batch ---
 *   complete/fail the durable record
 */

import assert from "node:assert/strict";
import test from "node:test";

import { tempStore } from "./support/temp-store.ts";

const OP = "op:attempt:task:alpha:item-7:1:actor-spawn";

test("B2-AC9: the intent transaction commits the journal entry and the INTENT together", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    store.withTransaction(() => {
      store.decisions.append({ kind: "transition", refKey: OP, payload: { intent: true } });
      store.idempotency.beginIntent(OP);
    });

    assert.equal(store.decisions.count(), 1);
    assert.equal(store.idempotency.get(OP)?.state, "INTENT");
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC9: a failure after the INTENT insert leaves neither record behind", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.throws(() =>
      store.withTransaction(() => {
        store.decisions.append({ kind: "transition", refKey: OP, payload: { intent: true } });
        store.idempotency.beginIntent(OP);
        throw new Error("transition aborted before the side effect boundary");
      }),
    );

    assert.equal(store.decisions.count(), 0, "no journal entry may survive");
    assert.equal(store.idempotency.get(OP), undefined, "no INTENT may survive");
    assert.equal(store.idempotency.count(), 0);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC9: a committed INTENT is recoverable by op_key after close and reopen", () => {
  const temp = tempStore();

  const before = temp.open();
  before.withTransaction(() => {
    before.decisions.append({ kind: "transition", refKey: OP, payload: { intent: true } });
    before.idempotency.beginIntent(OP);
  });
  before.close();

  const after = temp.open();
  try {
    const recovered = after.idempotency.get(OP);
    assert.equal(recovered?.state, "INTENT");
    assert.equal(recovered?.opKey, OP);
    assert.equal(recovered?.result, undefined);

    // Restart continues from the same record: no second row, no new identity.
    const resumed = after.idempotency.beginIntent(OP);
    assert.equal(resumed.created, false);
    assert.equal(after.idempotency.count(), 1);

    // The later batch that owns the effect resolves the record; the store only records it.
    after.idempotency.markDone(OP, { observed: "example" });
    assert.equal(after.idempotency.get(OP)?.state, "DONE");
  } finally {
    after.close();
    temp.dispose();
  }
});

test("B2-AC9: a completion survives close and reopen with its result intact", () => {
  const temp = tempStore();

  const before = temp.open();
  before.withTransaction(() => {
    before.idempotency.beginIntent(OP);
  });
  before.idempotency.markDone(OP, { observed: { count: 2 }, note: null });
  before.close();

  const after = temp.open();
  try {
    const record = after.idempotency.get(OP);
    assert.equal(record?.state, "DONE");
    assert.deepEqual(record?.result, { observed: { count: 2 }, note: null });
  } finally {
    after.close();
    temp.dispose();
  }
});
