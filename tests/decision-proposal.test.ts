/**
 * B7-AC1 ~ B7-AC5 — DecisionType v1, the four Proposal variants and strict wrapper validation
 * (TD §9.1, M0-25).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DecisionError } from "../core/decision/errors.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import {
  DECISION_TYPES,
  EXPECTED_FIELDS,
  PROPOSAL_FIELDS,
  PROPOSAL_VARIANT_BY_DECISION,
} from "../core/decision/types.ts";
import {
  batchControl,
  compiled,
  repositoryControl,
  selection,
  SUBFLOW_PARENT_INTENT,
  subflowSelection,
  task,
  taskControl,
  PROPOSAL_ID,
} from "./support/decision-fixtures.ts";

const profile = compiled();

const rejects = (input: unknown): void => {
  assert.throws(
    () => validateProposal(input),
    (error: unknown) =>
      error instanceof DecisionError && error.reason === "PROPOSAL_SCHEMA_INVALID",
  );
};

const without = (object: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};

// --- B7-AC1 vocabulary ---------------------------------------------------------------

test("B7-AC1: DecisionType v1 is exactly eight values", () => {
  assert.deepEqual(
    [...DECISION_TYPES],
    [
      "START_TASK",
      "REQUEST_REWORK",
      "PROPOSE_MERGE",
      "HOLD_TASK",
      "DEFER_TASK",
      "START_SUBFLOW",
      "RESUME_PARENT",
      "CLOSE_BATCH",
    ],
  );
  assert.deepEqual(Object.keys(PROPOSAL_VARIANT_BY_DECISION).sort(), [...DECISION_TYPES].sort());
});

test("B7-AC1: an unknown decision is rejected", () => {
  rejects({ ...selection({ profile }), decision: "MERGE_NOW" });
  rejects({ ...selection({ profile }), decision: "start_task" });
  rejects({ ...selection({ profile }), decision: 1 });
});

// --- B7-AC2 the four variants ---------------------------------------------------------

test("B7-AC2: all eight decisions parse through the four sealed variants plus subflow E", () => {
  const parsed = [
    validateProposal(selection({ profile, decision: "START_TASK" })),
    validateProposal(subflowSelection({ profile, parent: SUBFLOW_PARENT_INTENT })),
    validateProposal(repositoryControl({ profile, decision: "REQUEST_REWORK" })),
    validateProposal(repositoryControl({ profile, decision: "PROPOSE_MERGE" })),
    validateProposal(taskControl({ profile, decision: "HOLD_TASK" })),
    validateProposal(taskControl({ profile, decision: "DEFER_TASK" })),
    validateProposal(taskControl({ profile, decision: "RESUME_PARENT" })),
    validateProposal(batchControl({ profile })),
  ];

  assert.deepEqual(
    parsed.map((proposal) => proposal.decision).sort(),
    [...DECISION_TYPES].sort(),
    "every decision is represented",
  );
  assert.deepEqual(
    [...new Set(parsed.map((proposal) => proposal.variant))].sort(),
    [
      "BATCH_CONTROL",
      "REPOSITORY_SENSITIVE_TASK_CONTROL",
      "SUBFLOW_SELECTION",
      "TASK_CONTROL",
      "TASK_SELECTION",
    ],
  );
});

test("B7-AC2: each variant declares its exact field set", () => {
  assert.deepEqual(PROPOSAL_FIELDS.TASK_SELECTION, [
    "proposal_id",
    "decision",
    "task_ref",
    "classification",
    "pipeline_id",
    "actor_profile",
    "verification_profile",
    "repository_scope_id",
    "expected",
    "reason_refs",
  ]);
  assert.deepEqual(PROPOSAL_FIELDS.REPOSITORY_SENSITIVE_TASK_CONTROL, [
    "proposal_id",
    "decision",
    "task_ref",
    "expected",
    "reason_refs",
  ]);
  assert.deepEqual(PROPOSAL_FIELDS.TASK_CONTROL, [
    "proposal_id",
    "decision",
    "task_ref",
    "expected",
    "reason_refs",
  ]);
  assert.deepEqual(PROPOSAL_FIELDS.BATCH_CONTROL, [
    "proposal_id",
    "decision",
    "expected",
    "reason_refs",
  ]);

  assert.deepEqual(EXPECTED_FIELDS.TASK_SELECTION, [
    "task_version",
    "task_definition_hash",
    "base_head",
    "compiled_profile_hash",
  ]);
  assert.deepEqual(EXPECTED_FIELDS.TASK_CONTROL, [
    "task_version",
    "task_definition_hash",
    "compiled_profile_hash",
  ]);
  assert.deepEqual(EXPECTED_FIELDS.BATCH_CONTROL, ["compiled_profile_hash"]);
});

// --- B7-AC4 strict validation ---------------------------------------------------------

test("B7-AC4: every declared wrapper field is required", () => {
  for (const field of PROPOSAL_FIELDS.TASK_SELECTION) {
    rejects(without(selection({ profile }), field));
  }
  for (const field of PROPOSAL_FIELDS.BATCH_CONTROL) {
    rejects(without(batchControl({ profile }), field));
  }
});

test("B7-AC4: every declared expected field is required", () => {
  const proposal = selection({ profile });
  for (const field of EXPECTED_FIELDS.TASK_SELECTION) {
    rejects({ ...proposal, expected: without(proposal["expected"] as Record<string, unknown>, field) });
  }
});

test("B7-AC4: unknown wrapper and expected fields are rejected", () => {
  const proposal = selection({ profile });
  rejects({ ...proposal, priority: "high" });
  rejects({
    ...proposal,
    expected: { ...(proposal["expected"] as Record<string, unknown>), attempt: 2 },
  });
});

test("B7-AC4: a field belonging to another variant is unknown, not ignored", () => {
  // BatchControl never selects a task; TaskControl never carries a repository head.
  rejects({ ...batchControl({ profile }), task_ref: "T-101" });
  rejects({
    ...taskControl({ profile }),
    expected: {
      ...(taskControl({ profile })["expected"] as Record<string, unknown>),
      base_head: "head-canonical-1",
    },
  });
  rejects({ ...repositoryControl({ profile }), pipeline_id: "standard" });
});

test("B7-AC4: proposal_id must be a ULID", () => {
  rejects({ ...selection({ profile }), proposal_id: "proposal-1" });
  rejects({ ...selection({ profile }), proposal_id: "" });
  // The Crockford alphabet excludes I, L, O and U.
  rejects({ ...selection({ profile }), proposal_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0ABI" });
  assert.equal(validateProposal(selection({ profile })).proposal_id, PROPOSAL_ID);
});

test("B7-AC4: task_ref is opaque and keeps ':' verbatim; empty is rejected", () => {
  const definition = task({ task_ref: "epic:42:item:7" });
  const parsed = validateProposal(selection({ profile, definition }));
  assert.equal(parsed.variant === "TASK_SELECTION" && parsed.task_ref, "epic:42:item:7");

  rejects({ ...selection({ profile }), task_ref: "" });
  rejects({ ...selection({ profile }), task_ref: 7 });
});

test("B7-AC4: selection strings must be non-empty and nothing is coerced", () => {
  for (const field of ["classification", "pipeline_id", "actor_profile", "verification_profile"]) {
    rejects({ ...selection({ profile }), [field]: "" });
    rejects({ ...selection({ profile }), [field]: null });
  }
  for (const field of EXPECTED_FIELDS.TASK_SELECTION) {
    const proposal = selection({ profile });
    rejects({
      ...proposal,
      expected: { ...(proposal["expected"] as Record<string, unknown>), [field]: "" },
    });
  }
  // A trailing space is a different value, not something to trim away.
  const spaced = validateProposal({ ...selection({ profile }), classification: "IMPLEMENTABLE " });
  assert.equal(spaced.variant === "TASK_SELECTION" && spaced.classification, "IMPLEMENTABLE ");
});

test("B7-AC4: the proposal itself must be a plain object", () => {
  rejects(null);
  rejects([selection({ profile })]);
  rejects("START_TASK");
  rejects({ ...selection({ profile }), expected: [] });
});

// --- B7-AC5 reason_refs -----------------------------------------------------------------

test("B7-AC5: reason_refs keeps order and duplicates and may be empty", () => {
  assert.deepEqual(validateProposal(selection({ profile })).reason_refs, []);

  const refs = ["z-note", "a-note", "z-note"];
  const parsed = validateProposal({ ...selection({ profile }), reason_refs: refs });
  assert.deepEqual(parsed.reason_refs, refs, "no sorting and no deduplication");
});

test("B7-AC5: reason_refs must be an array of non-empty strings", () => {
  rejects({ ...selection({ profile }), reason_refs: "note" });
  rejects({ ...selection({ profile }), reason_refs: ["ok", ""] });
  rejects({ ...selection({ profile }), reason_refs: [1] });
});
