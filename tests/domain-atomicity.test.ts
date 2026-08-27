/**
 * B8-AC26 ~ B8-AC29 — the transition transaction: pending decision + hold + outbox + journal
 * commit together, the journal kinds stay separate, and timestamps keep their authorities.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateAndRecordDecision } from "../core/decision/decision-log.ts";
import type { CanonicalValue } from "../core/schemas/canonical-json.ts";
import { StoreError } from "../core/store/errors.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import {
  commitAdmission,
  commitAttemptFact,
  commitContractActivation,
  commitPendingDecision,
  commitTaskDiscovery,
} from "../core/statemachine/transition-commit.ts";
import { DECISION_VALIDATION_LOG_KIND } from "../core/decision/decision-log.ts";
import { inputFor, selection } from "./support/decision-fixtures.ts";
import {
  BATCH_ID,
  BINDING,
  PROJECT,
  SCOPE_ID,
  SELECTION,
  TASK_KEY,
  ULID,
  contractBuild,
  discover,
  gateDecision,
  snapshot,
  snapshotId,
  withWorld,
} from "./support/domain-fixtures.ts";

// --- pending decision atomicity --------------------------------------------------------------

test("B8-AC26: hold, decision, outbox and journal appear together", () => {
  withWorld((world) => {
    discover(world);
    const before = world.store.decisions.count();

    const result = commitPendingDecision(world.store, {
      decision: gateDecision(world),
      channel: "operations",
    });

    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, `BLOCKED_BY_DECISION:${ULID.decision}`);
    assert.equal(world.store.pendingDecisions.countByStatus("OPEN"), 1);
    assert.equal(world.store.outbox.count(), 1);
    assert.equal(world.store.decisions.count(), before + 1);

    const enqueued = world.store.outbox.get(result.op_key);
    assert.equal(enqueued?.channel, "operations");
    assert.equal(enqueued?.sent_at, null, "delivery is not Batch 8's job");
    assert.equal(result.op_key, `op:${TASK_KEY}:report-pending:${ULID.decision}`);
  });
});

test("B8-AC26: a failure anywhere leaves no half-held task and no orphan row", () => {
  withWorld((world) => {
    discover(world);
    const before = {
      decisions: world.store.decisions.count(),
      pending: world.store.pendingDecisions.count(),
      outbox: world.store.outbox.count(),
    };

    // The decision names a task that does not exist, so the whole command fails.
    assert.throws(() =>
      commitPendingDecision(world.store, {
        decision: {
          ...gateDecision(world, { task_key: `task:${PROJECT}:missing` }),
        },
        channel: "operations",
      }),
    );

    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.deepEqual(
      {
        decisions: world.store.decisions.count(),
        pending: world.store.pendingDecisions.count(),
        outbox: world.store.outbox.count(),
      },
      before,
    );
  });
});

test("B8-AC26: retrying the same decision creates no duplicate row or notification", () => {
  withWorld((world) => {
    discover(world);
    const first = commitPendingDecision(world.store, {
      decision: gateDecision(world),
      channel: "operations",
    });
    const again = commitPendingDecision(world.store, {
      decision: gateDecision(world),
      channel: "operations",
    });

    assert.equal(first.decision_id, again.decision_id);
    assert.equal(world.store.pendingDecisions.count(), 1);
    assert.equal(world.store.outbox.count(), 1);

    // A different body under the same dedup key is a conflict.
    assert.throws(
      () =>
        commitPendingDecision(world.store, {
          decision: { ...gateDecision(world), question: "Something else?" },
          channel: "operations",
        }),
      (error: unknown) => error instanceof StoreError && error.code === "PENDING_DECISION_CONFLICT",
    );
  });
});

// --- outbox identity ----------------------------------------------------------------------------

test("B8-AC26: the outbox is enqueue-only and op_key is the delivery identity", () => {
  withWorld((world) => {
    world.store.withTransaction(() =>
      world.store.outbox.enqueue({
        op_key: `op:${BATCH_ID}:report-batch:1`,
        channel: "operations",
        payload: { event: "BATCH_COMPLETE" },
      }),
    );
    // Identical re-enqueue is one logical notification.
    world.store.withTransaction(() =>
      world.store.outbox.enqueue({
        op_key: `op:${BATCH_ID}:report-batch:1`,
        channel: "operations",
        payload: { event: "BATCH_COMPLETE" },
      }),
    );
    assert.equal(world.store.outbox.count(), 1);
    assert.equal(world.store.outbox.pending().length, 1);

    const conflicts = (patch: { channel?: string; payload?: CanonicalValue }): void =>
      assert.throws(
        () =>
          world.store.withTransaction(() =>
            world.store.outbox.enqueue({
              op_key: `op:${BATCH_ID}:report-batch:1`,
              channel: patch.channel ?? "operations",
              payload: patch.payload ?? { event: "BATCH_COMPLETE" },
            }),
          ),
        (error: unknown) => error instanceof StoreError && error.code === "REPORT_OUTBOX_CONFLICT",
      );
    conflicts({ channel: "elsewhere" });
    conflicts({ payload: { event: "SOMETHING_ELSE" } });

    // The store still never *delivers*: transport belongs to the ReportAdapter (§21.1). MVP1-B13
    // added `markSent`, which records a delivery the Coordinator already had confirmed — it is a
    // confirmation record, not a transport, and there is still no send path here.
    const api = world.store.outbox as unknown as Record<string, unknown>;
    for (const forbidden of ["deliver", "send", "drain", "retry"]) {
      assert.equal(typeof api[forbidden], "undefined", forbidden);
    }
    assert.equal(typeof api["markSent"], "function");
    // And it only ever records a confirmation; it cannot invent one for a row that is not there.
    assert.throws(() => world.store.outbox.markSent("op:nothing:report-batch:1", "t9"));
  });
});

// --- journal ---------------------------------------------------------------------------------------

test("B8-AC29: validation and transition journals stay separate", () => {
  withWorld((world) => {
    const key = discover(world);
    validateAndRecordDecision(
      world.store.decisions,
      inputFor(selection({ profile: world.profile }), world.profile, {
        batch: world.store.batchView.project(BATCH_ID),
      }),
    );
    commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, });

    const kinds = world.store.decisions.read().map((entry) => entry.kind);
    assert.deepEqual([...new Set(kinds)].sort(), [
      DECISION_VALIDATION_LOG_KIND,
      STATE_TRANSITION_KIND,
    ]);
    assert.equal(kinds.filter((kind) => kind === STATE_TRANSITION_KIND).length, 2);
  });
});

test("B8-AC29: one atomic transition writes one entry carrying every state change", () => {
  withWorld((world) => {
    const key = discover(world);
    commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t", hard_dependencies_clear: true, });
    commitContractActivation(world.store, {
      task_key: key,
      attempt_key: `attempt:${key}:1`,
      n: 1,
      build: contractBuild(world, { snapshot_id: snapshotId(0) }),
    });
    const before = world.store.decisions.count();

    commitAttemptFact(world.store, {
      attempt_key: `attempt:${key}:1`,
      fact: { kind: "ATTEMPT_FAILED", reason_code: "RUNTIME_FAILED" },
    });

    assert.equal(world.store.decisions.count(), before + 1, "not split across entries");
    const entry = world.store.decisions.read().at(-1);
    assert.equal(entry?.kind, STATE_TRANSITION_KIND);
    const payload = entry?.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "attempt",
      "batch",
      "pending_decision_id",
      "primary_entity_key",
      "reason_code",
      "task",
    ]);
    assert.deepEqual(payload["task"], { from: "ACTIVE", to: "FAILED" });
    assert.deepEqual(payload["attempt"], { from: "READY", to: "FAILED" });
    assert.equal(payload["reason_code"], "RUNTIME_FAILED");
    assert.equal(payload["batch"], null);

    // The HELD/FAILED rows reference exactly this entry.
    assert.equal(world.store.tasks.require(key).state_reason?.log_seq, entry?.seq);
  });
});

test("B8-AC29: a transition reference can be built from the appended entry", () => {
  withWorld((world) => {
    const result = commitTaskDiscovery(world.store, {
      task_key: `task:${PROJECT}:Z`,
      batch_id: BATCH_ID,
      project_id: PROJECT,
      external_task_ref: "Z",
      external_snapshot: snapshot(),
    });
    assert.equal(result.transition.ref, `transition:${result.transition.seq}`);
  });
});

// --- timestamps ------------------------------------------------------------------------------------

test("B8-AC28: store clock owns created/updated; caller facts keep their own times", () => {
  withWorld((world) => {
    const key = discover(world);
    const discovered = world.store.tasks.require(key);

    // The injected counting clock makes these deterministic.
    assert.match(discovered.created_at, /^t\d{4}$/);
    assert.equal(discovered.created_at, discovered.updated_at);
    // Caller-supplied observation time is preserved verbatim.
    assert.equal(discovered.external_snapshot.observed_at, "obs-1");

    commitPendingDecision(world.store, { decision: gateDecision(world), channel: "operations" });
    world.store.pendingDecisions.resolve(ULID.decision, {
      kind: "OPTION",
      chosen_option: "APPROVE",
      free_form: null,
      resolved_by: "operator-reference-1",
      resolved_at: "2026-08-09T10:00:00Z",
      approval_binding: null,
      applied_transition_ref: null,
    });

    const record = world.store.pendingDecisions.require(ULID.decision);
    assert.equal(record.body.resolution?.resolved_at, "2026-08-09T10:00:00Z");
    assert.match(record.updated_at, /^t\d{4}$/);
  });
});
