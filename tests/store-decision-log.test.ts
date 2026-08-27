/**
 * B2-AC6 — append-only decision history (TD §18.1, §18.2).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CanonicalizationError } from "../core/schemas/errors.ts";
import { DecisionLog } from "../core/store/decision-log.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("B2-AC6: seq is monotonic and append order is preserved", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const refs = ["a", "b", "c", "d"];
    const appended = refs.map((refKey) =>
      store.decisions.append({ kind: "example", refKey, payload: { ref: refKey } }),
    );

    assert.deepEqual(
      appended.map((entry) => entry.seq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      store.decisions.read().map((entry) => entry.refKey),
      refs,
    );

    const seqs = store.decisions.read().map((entry) => entry.seq);
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok((seqs[index] as number) > (seqs[index - 1] as number), "seq must increase");
    }
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC6: seq keeps increasing across reopen and does not reuse values", () => {
  const temp = tempStore();
  const first = temp.open();
  first.decisions.append({ kind: "example", refKey: "a", payload: null });
  first.decisions.append({ kind: "example", refKey: "b", payload: null });
  first.close();

  const second = temp.open();
  try {
    const next = second.decisions.append({ kind: "example", refKey: "c", payload: null });
    assert.equal(next.seq, 3);
    assert.deepEqual(
      second.decisions.read().map((entry) => entry.seq),
      [1, 2, 3],
    );
  } finally {
    second.close();
    temp.dispose();
  }
});

test("B2-AC6: kind and ref_key stay generic strings and payloads round-trip", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const payload = { nested: { list: [1, 2, 3], flag: true }, note: null, label: "x" };
    const appended = store.decisions.append({ kind: "any-kind", refKey: "any:ref", payload });

    const [entry] = store.decisions.read();
    assert.equal(entry?.kind, "any-kind");
    assert.equal(entry?.refKey, "any:ref");
    assert.deepEqual(entry?.payload, payload);
    assert.deepEqual(appended.payload, payload);
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC6: payloads must satisfy the Batch 1 canonical JSON contract", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.throws(
      () => store.decisions.append({ kind: "example", refKey: "r", payload: { ratio: 0.5 } }),
      (error: unknown) =>
        error instanceof CanonicalizationError && error.code === "FLOAT_NOT_ALLOWED",
    );
    assert.equal(store.decisions.count(), 0, "a rejected payload must not be appended");
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC6: the domain API exposes no mutation or deletion path", () => {
  const methods = Object.getOwnPropertyNames(DecisionLog.prototype).filter(
    (name) => name !== "constructor",
  );
  assert.deepEqual(methods.sort(), ["append", "count", "read"]);

  const source = readFileSync(join(ROOT, "core/store/decision-log.ts"), "utf8");
  assert.equal(/UPDATE\s+decision_log|DELETE\s+FROM\s+decision_log/i.test(source), false);
});
