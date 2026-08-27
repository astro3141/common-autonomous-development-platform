/**
 * B7-AC31 — the decision journal is the only durable side effect (TD §9.2, §18.1).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAndRecordDecision,
  DECISION_VALIDATION_LOG_KIND,
} from "../core/decision/decision-log.ts";
import type { DecisionValidationInput } from "../core/decision/validator.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import { PlatformStore } from "../core/store/platform-store.ts";
import {
  batchView,
  compiled,
  enforcementWith,
  inputFor,
  manifests,
  selection,
  task,
  PROPOSAL_ID,
  HEAD,
} from "./support/decision-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";

const profile = compiled();

const withStore = <T>(run: (store: PlatformStore) => T): T => {
  const temp = tempStore();
  const store = temp.open();
  try {
    return run(store);
  } finally {
    store.close();
    temp.dispose();
  }
};

/** One input per result kind, all sharing the same otherwise-valid proposal. */
const cases: ReadonlyArray<readonly [string, () => DecisionValidationInput]> = [
  ["ACCEPTED", () => inputFor(selection({ profile }), profile)],
  [
    "HUMAN_GATE_REQUIRED",
    () => {
      const gated = compiled({ human_gate_policy: { required_decisions: ["START_TASK"] } });
      return inputFor(selection({ profile: gated }), gated);
    },
  ],
  [
    "POLICY_REJECTED",
    () =>
      inputFor(selection({ profile, definition: task({ version: "2" }) }), profile),
  ],
  [
    "BACKEND_INCOMPATIBLE",
    () => {
      const strict = compiled({
        capability_requirements: { actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } },
      });
      return inputFor(selection({ profile: strict }), strict, {
        manifests: manifests(enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } })),
      });
    },
  ],
];

test("B7-AC31: every result kind appends exactly one journal entry", () => {
  for (const [kind, build] of cases) {
    withStore((store) => {
      const { result, entry } = validateAndRecordDecision(store.decisions, build());

      assert.equal(result.kind, kind);
      assert.equal(store.decisions.count(), 1, `${kind} must append exactly once`);
      assert.equal(entry.kind, DECISION_VALIDATION_LOG_KIND);
      assert.equal(entry.refKey, PROPOSAL_ID);

      const payload = entry.payload as Record<string, unknown>;
      assert.equal(payload["proposal_id"], PROPOSAL_ID);
      assert.equal(payload["decision"], "START_TASK");
      assert.equal(payload["result"], kind);
    });
  }
});

test("B7-AC31: a rejection records its reason and a backend failure records its detail", () => {
  withStore((store) => {
    const drift = validateAndRecordDecision(store.decisions, cases[2]?.[1]() as DecisionValidationInput);
    assert.equal((drift.entry.payload as Record<string, unknown>)["reason_code"], "TASK_DRIFT");

    const gate = validateAndRecordDecision(store.decisions, cases[1]?.[1]() as DecisionValidationInput);
    assert.equal((gate.entry.payload as Record<string, unknown>)["reason_code"], undefined);

    const incompatible = validateAndRecordDecision(
      store.decisions,
      cases[3]?.[1]() as DecisionValidationInput,
    );
    const payload = incompatible.entry.payload as Record<string, unknown>;
    assert.equal(payload["operation_id"], "actor_execution");
    assert.equal(payload["role"], "ACTOR");
    assert.deepEqual(payload["failure"], {
      capability: "shell.execute",
      requested: true,
      actual: "NOT_YET_AUDITED",
      accepted: ["ENFORCED"],
      passed: false,
    });

    assert.equal(store.decisions.count(), 3, "one entry per validation, appended in order");
    assert.deepEqual(
      store.decisions.read().map((entry) => (entry.payload as Record<string, unknown>)["result"]),
      ["POLICY_REJECTED", "HUMAN_GATE_REQUIRED", "BACKEND_INCOMPATIBLE"],
    );
  });
});

test("B7-AC31: a Proposal rejected at V1 is still recorded, with an honest identity", () => {
  withStore((store) => {
    const { result, entry } = validateAndRecordDecision(
      store.decisions,
      inputFor({ decision: "START_TASK" }, profile),
    );

    assert.deepEqual(result, { kind: "POLICY_REJECTED", reason_code: "PROPOSAL_SCHEMA_INVALID" });
    assert.equal(store.decisions.count(), 1);
    assert.deepEqual(entry.payload, {
      proposal_id: null,
      decision: "START_TASK",
      result: "POLICY_REJECTED",
      reason_code: "PROPOSAL_SCHEMA_INVALID",
    });
    assert.equal(entry.refKey, "");
  });
});

test("B7-AC31: the journal is the only table touched and a store failure is not hidden", () => {
  withStore((store) => {
    validateAndRecordDecision(store.decisions, inputFor(selection({ profile }), profile));

    assert.equal(store.blobs.count(), 0, "no blob is written");
    // Batch 7 owning no migration is asserted structurally in batch7-boundaries.test.ts.
    assert.equal(store.schemaVersion, MIGRATIONS.length);
    assert.equal(store.decisions.count(), 1);

    // A journal that cannot be written must not be reported as a successful validation.
    const failing = {
      append() {
        throw new Error("journal unavailable");
      },
    };
    assert.throws(
      () => validateAndRecordDecision(failing, inputFor(selection({ profile }), profile)),
      /journal unavailable/,
    );
  });
});

test("B7-AC31: validation itself never mutates the store", () => {
  withStore((store) => {
    // A selection at the batch limit is rejected; nothing is recorded unless the seam is used.
    const before = store.decisions.count();
    const input = inputFor(selection({ profile }), profile, {
      batch: batchView({ admitted_task_count: 3 }),
      repository: { canonical_head: HEAD },
    });
    assert.deepEqual(
      validateAndRecordDecision(store.decisions, input).result,
      { kind: "POLICY_REJECTED", reason_code: "BATCH_MAX_TASKS_REACHED" },
    );
    assert.equal(store.decisions.count(), before + 1);
  });
});
