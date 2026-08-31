/**
 * B8-AC17 ~ B8-AC22 — PendingHumanDecision v1: exact body, subject-generic dedup, Human Gate
 * construction, the resolution union and the terminal record hash (TD §17.1 – §17.2a).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildHumanGateDecision, HUMAN_GATE_OPTIONS } from "../core/humandecision/gate-request.ts";
import { HumanDecisionError } from "../core/humandecision/errors.ts";
import {
  closePendingDecision,
  computeDedupKey,
  hashPendingDecision,
  normalizePendingDecision,
  resolvePendingDecision,
  subjectKey,
} from "../core/humandecision/pending-decision.ts";
import {
  BLOCKING_SCOPES,
  PENDING_DECISION_CATEGORIES,
  PENDING_DECISION_FIELDS,
  PENDING_DECISION_STATUSES,
  type PendingDecisionV1,
} from "../core/humandecision/types.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import { batchControl, selection,
  SUBFLOW_PARENT_INTENT,
  subflowSelection, taskControl } from "./support/decision-fixtures.ts";
import {
  gateDecision,
  proposalFor,
  withWorld,
  BATCH_ID,
  PROJECT,
  TASK_KEY,
  ULID,
} from "./support/domain-fixtures.ts";

const invalid = (error: unknown): boolean =>
  error instanceof HumanDecisionError && error.reason === "DECISION_INVALID";

const rebuild = (body: PendingDecisionV1, patch: Record<string, unknown>): unknown => ({
  ...body,
  ...patch,
});

// --- exact schema -------------------------------------------------------------------------

test("B8-AC17: the body has exactly thirteen fields and the four fixed vocabularies", () => {
  assert.deepEqual([...PENDING_DECISION_FIELDS], [
    "decision_id",
    "subject",
    "status",
    "category",
    "question",
    "options",
    "recommendation",
    "blocking_scope",
    "evidence_refs",
    "dedup_key",
    "created_from",
    "gate_proposal",
    "resolution",
  ]);
  assert.deepEqual([...PENDING_DECISION_STATUSES], ["OPEN", "RESOLVED", "CANCELLED", "STALE"]);
  assert.deepEqual([...PENDING_DECISION_CATEGORIES], [
    "HUMAN_GATE_APPROVAL",
    "MERGE_APPROVAL",
    "REATTEMPT_DECISION",
    "CONTRACT_DECISION",
    "RECOVERY_DECISION",
    // M1-13 — a validated Auditor HUMAN_REQUIRED; no existing category owned that semantic.
    "AUDIT_DECISION",
  ]);
  assert.deepEqual([...BLOCKING_SCOPES], [
    "TASK_ONLY",
    "DEPENDENCY_SUBTREE",
    "BATCH",
    "PROJECT",
  ]);
});

test("B8-AC17: unknown fields, unknown categories and missing fields are rejected", () => {
  withWorld((world) => {
    const body = gateDecision(world);
    assert.throws(() => normalizePendingDecision(rebuild(body, { severity: "high" })), invalid);
    assert.throws(() => normalizePendingDecision(rebuild(body, { category: "OTHER" })), invalid);
    assert.throws(() => normalizePendingDecision(rebuild(body, { status: "PENDING" })), invalid);
    assert.throws(() => normalizePendingDecision(rebuild(body, { decision_id: "id-1" })), invalid);

    for (const field of PENDING_DECISION_FIELDS) {
      const partial = { ...body } as Record<string, unknown>;
      delete partial[field];
      assert.throws(() => normalizePendingDecision(partial), invalid);
    }
  });
});

test("B8-AC17: presentation fields follow their own rules", () => {
  withWorld((world) => {
    const body = gateDecision(world);
    assert.throws(() => normalizePendingDecision(rebuild(body, { question: "" })), invalid);
    assert.throws(() => normalizePendingDecision(rebuild(body, { options: [] })), invalid);
    // Options carry identity, so duplicates are rejected…
    assert.throws(
      () => normalizePendingDecision(rebuild(body, { options: ["APPROVE", "APPROVE"] })),
      invalid,
    );
    // …while evidence refs keep order and allow duplicates.
    const refs = ["e-2", "e-1", "e-2"];
    assert.deepEqual(
      normalizePendingDecision(rebuild(body, { evidence_refs: refs })).evidence_refs,
      refs,
    );
    assert.equal(normalizePendingDecision(rebuild(body, { recommendation: null })).recommendation, null);
    assert.throws(() => normalizePendingDecision(rebuild(body, { evidence_refs: [""] })), invalid);
  });
});

test("B8-AC22: only HUMAN_GATE_APPROVAL carries a Proposal copy", () => {
  withWorld((world) => {
    const gate = gateDecision(world);
    assert.notEqual(gate.gate_proposal, null);
    assert.throws(() => normalizePendingDecision(rebuild(gate, { gate_proposal: null })), invalid);

    const merge = normalizePendingDecision({
      ...gate,
      category: "MERGE_APPROVAL",
      gate_proposal: null,
      dedup_key: computeDedupKey(gate.subject, "MERGE_APPROVAL", gate.created_from),
    } as unknown);
    assert.equal(merge.gate_proposal, null);

    assert.throws(
      () =>
        normalizePendingDecision({
          ...merge,
          gate_proposal: gate.gate_proposal,
        } as unknown),
      invalid,
    );
  });
});

// --- subject / dedup -------------------------------------------------------------------------

test("B8-AC18: subject and blocking scope must agree, and no placeholder identity exists", () => {
  withWorld((world) => {
    const body = gateDecision(world);
    const batchSubject = { kind: "BATCH", batch_id: BATCH_ID } as const;

    // A batch-scoped decision on a BATCH subject is fine; TASK_ONLY on it is not.
    const batchGate = buildHumanGateDecision({
      decision_id: ULID.decisionB,
      proposal: validateProposal(batchControl({ profile: world.profile })),
      batch_id: BATCH_ID,
    });
    assert.deepEqual(batchGate.subject, batchSubject);
    assert.equal(batchGate.blocking_scope, "BATCH");

    assert.throws(
      () => normalizePendingDecision(rebuild(batchGate, { blocking_scope: "TASK_ONLY" })),
      invalid,
    );
    // A PROJECT subject cannot be narrowed to a task scope either.
    assert.throws(
      () =>
        normalizePendingDecision(
          rebuild(body, { subject: { kind: "PROJECT", project_id: PROJECT } }),
        ),
      invalid,
    );
  });
});

test("B8-AC18: dedup keys stay injective across subject kinds and colon-bearing refs", () => {
  withWorld((world) => {
    const colonRef = `task:${PROJECT}:epic:42:item:7`;
    const keys = new Set<string>();
    const subjects = [
      { kind: "TASK", task_key: TASK_KEY },
      { kind: "TASK", task_key: colonRef },
      { kind: "BATCH", batch_id: BATCH_ID },
      { kind: "PROJECT", project_id: PROJECT },
    ] as const;

    for (const subject of subjects) {
      for (const category of PENDING_DECISION_CATEGORIES) {
        for (const from of ["proposal:a", "proposal:b"]) {
          keys.add(computeDedupKey(subject, category, from));
        }
      }
    }
    assert.equal(keys.size, subjects.length * PENDING_DECISION_CATEGORIES.length * 2);

    // The subject component keeps its own leading token, which is what makes it injective.
    assert.equal(subjectKey({ kind: "PROJECT", project_id: PROJECT }), `project:${PROJECT}`);
    assert.equal(subjectKey({ kind: "BATCH", batch_id: BATCH_ID }), BATCH_ID);

    // A forged dedup_key that does not match its own context is rejected.
    const body = gateDecision(world);
    assert.throws(() => normalizePendingDecision(rebuild(body, { dedup_key: "pd:x:y:z" })), invalid);
  });
});

// --- Human Gate construction --------------------------------------------------------------------

test("B8-AC22: gate construction is deterministic for every gated Proposal shape", () => {
  withWorld((world) => {
    const cases = [
      { proposal: proposalFor(world), task_key: TASK_KEY },
      {
        proposal: validateProposal(
          subflowSelection({
            profile: world.profile,
            classification: "SPLIT_NEEDED",
            parent: SUBFLOW_PARENT_INTENT,
          }),
        ),
        task_key: TASK_KEY,
      },
      { proposal: validateProposal(batchControl({ profile: world.profile })), batch_id: BATCH_ID },
    ];

    for (const input of cases) {
      const built = buildHumanGateDecision({ decision_id: ULID.decision, ...input });
      assert.equal(built.category, "HUMAN_GATE_APPROVAL");
      assert.deepEqual([...built.options], [...HUMAN_GATE_OPTIONS]);
      assert.deepEqual([...built.options], ["APPROVE", "REJECT"]);
      assert.equal(built.recommendation, null);
      assert.equal(built.created_from, `proposal:${input.proposal.proposal_id}`);
      assert.deepEqual(built.gate_proposal, input.proposal, "the exact normalized copy is bound");
      assert.equal(
        built.subject.kind,
        input.proposal.variant === "BATCH_CONTROL" ? "BATCH" : "TASK",
      );

      // Byte-identical for identical input.
      const again = buildHumanGateDecision({ decision_id: ULID.decision, ...input });
      assert.deepEqual(again, built);
      assert.equal(hashPendingDecision(again), hashPendingDecision(built));
    }
  });
});

test("B8-AC22: a taskless gate never borrows a task key, and a task gate needs one", () => {
  withWorld((world) => {
    assert.throws(() =>
      buildHumanGateDecision({
        decision_id: ULID.decision,
        proposal: validateProposal(batchControl({ profile: world.profile })),
      }),
    );
    assert.throws(() =>
      buildHumanGateDecision({
        decision_id: ULID.decision,
        proposal: validateProposal(taskControl({ profile: world.profile })),
      }),
    );
  });
});

test("B8-AC22: the Proposal is still not a standalone artifact", () => {
  withWorld((world) => {
    const built = gateDecision(world);
    const text = JSON.stringify(built);
    for (const forbidden of ["proposal_hash", "platform/supervisor-proposal"]) {
      assert.equal(text.includes(forbidden), false);
    }
    // The copy is bound by the decision's own hash instead.
    const other = { ...built, gate_proposal: proposalFor(world, { reason_refs: ["x"] }) };
    assert.notEqual(hashPendingDecision(normalizePendingDecision(other)), hashPendingDecision(built));
  });
});

// --- resolution / record hash ------------------------------------------------------------------------

test("B8-AC17: the resolution union is exclusive and options are checked", () => {
  withWorld((world) => {
    const body = gateDecision(world);
    const base = {
      kind: "OPTION" as const,
      chosen_option: "APPROVE",
      free_form: null,
      resolved_by: "operator-reference-1",
      resolved_at: "t-resolve",
      approval_binding: null,
      applied_transition_ref: null,
    };

    const resolved = resolvePendingDecision(body, base);
    assert.equal(resolved.body.status, "RESOLVED");
    assert.equal(resolved.body.resolution?.chosen_option, "APPROVE");

    const fails = (patch: Record<string, unknown>): void =>
      assert.throws(
        () => resolvePendingDecision(body, { ...base, ...patch } as never),
        invalid,
      );
    fails({ chosen_option: "MAYBE" });
    fails({ chosen_option: null });
    fails({ free_form: "notes" });
    fails({ resolved_by: "" });
    fails({ kind: "FREE_FORM", chosen_option: "APPROVE" });
    fails({ applied_transition_ref: "APPROVE_START" });

    // FREE_FORM is the mirror image.
    const free = resolvePendingDecision(body, {
      ...base,
      kind: "FREE_FORM",
      chosen_option: null,
      free_form: "let it wait",
    });
    assert.equal(free.body.resolution?.free_form, "let it wait");
  });
});

test("B8-AC19: an OPEN record has no hash and a terminal record has a stable one", () => {
  withWorld((world) => {
    const body = gateDecision(world);
    assert.equal(body.status, "OPEN");
    assert.equal(body.resolution, null);
    assert.throws(() => normalizePendingDecision(rebuild(body, { resolution: {} })), invalid);

    const terminal = closePendingDecision(body, "STALE");
    assert.equal(terminal.body.status, "STALE");
    assert.equal(terminal.record_hash, hashPendingDecision(terminal.body));
    assert.match(terminal.record_hash, /^sha256:[0-9a-f]{64}$/);

    // Terminal records never move again — not even RESOLVED → STALE.
    assert.throws(
      () => closePendingDecision(terminal.body, "CANCELLED"),
      (error: unknown) =>
        error instanceof HumanDecisionError && error.reason === "DECISION_STATUS_CONFLICT",
    );
  });
});
