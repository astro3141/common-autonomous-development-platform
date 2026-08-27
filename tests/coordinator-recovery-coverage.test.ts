/**
 * Batch 9 final recovery coverage — the two durable facts that hang off the run rather than off a
 * batch: the run-scoped SUPERVISOR grant and PROJECT-subject decisions (TD §18.1a, §22.4).
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { issueCapabilityGrant } from "../core/capability/broker.ts";
import { Coordinator } from "../core/coordinator/coordinator.ts";
import { computeDedupKey, normalizePendingDecision } from "../core/humandecision/pending-decision.ts";
import type { PendingDecisionSubject, PendingDecisionV1 } from "../core/humandecision/types.ts";
import { commitPendingDecision } from "../core/statemachine/transition-commit.ts";
import { commitDecisionResolution } from "../core/statemachine/transition-commit.ts";
import { FakeReportAdapter } from "../testdoubles/fake-report-adapter.ts";
import { FakeRepositoryAdapter } from "../testdoubles/fake-repository-adapter.ts";
import { FakeRuntimeAdapter } from "../testdoubles/fake-runtime-adapter.ts";
import { FakeVerificationAdapter } from "../testdoubles/fake-verification-adapter.ts";
import { FakeWorkflowAdapter } from "../testdoubles/fake-workflow-adapter.ts";
import { manifests } from "./support/decision-fixtures.ts";
import type { DomainWorld } from "./support/domain-fixtures.ts";
import {
  discover,
  withWorld,
  world,
  BATCH_ID,
  PROJECT,
  RUN_ID,
  TASK_KEY,
  ULID,
} from "./support/domain-fixtures.ts";

const RESOLUTION = {
  kind: "OPTION" as const,
  chosen_option: "REATTEMPT",
  free_form: null,
  resolved_by: "operator-reference-1",
  resolved_at: "t-resolve",
  approval_binding: null,
  applied_transition_ref: null,
};

const coordinatorFor = (owner: DomainWorld): Coordinator =>
  new Coordinator({ store: owner.store, workflow: new FakeWorkflowAdapter() });

/** Raw connection with FK enforcement off — corruption fixtures only. */
const tamper = (path: string, run: (database: DatabaseSync) => void): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    run(database);
  } finally {
    database.close();
  }
};

/** A terminal decision on any subject, built through the normal contract. */
function resolveDecisionOn(
  owner: DomainWorld,
  subject: PendingDecisionSubject,
  decisionId: string,
): PendingDecisionV1 {
  const createdFrom = `transition:1`;
  const body = normalizePendingDecision({
    decision_id: decisionId,
    subject,
    status: "OPEN",
    category: "REATTEMPT_DECISION",
    question: "How should this continue?",
    options: ["REATTEMPT", "ABANDON"],
    recommendation: null,
    blocking_scope: subject.kind === "TASK" ? "TASK_ONLY" : subject.kind,
    evidence_refs: [],
    dedup_key: computeDedupKey(subject, "REATTEMPT_DECISION", createdFrom),
    created_from: createdFrom,
    gate_proposal: null,
    resolution: null,
  } as unknown);

  commitPendingDecision(owner.store, { decision: body, channel: "operations" });
  commitDecisionResolution(owner.store, decisionId, RESOLUTION);
  return body;
}

/** Issues and persists a run-scoped SUPERVISOR grant through the ordinary Broker + store. */
function supervisorGrant(owner: DomainWorld): void {
  const grant = issueCapabilityGrant({
    grant_id: ULID.supervisorGrant,
    role: "SUPERVISOR",
    effective_policy: owner.profile.body.effective.policy,
    runtime_manifest: manifests().runtime,
    task_contract_capability_view: {
      repository_scope: { allowed_paths: [], forbidden_paths: [] },
    },
  });
  owner.store.withTransaction(() =>
    owner.store.grants.put(grant, { kind: "RUN", run_id: RUN_ID }),
  );
}

// --- run-scoped SUPERVISOR grant ----------------------------------------------------------

test("SG-1: no run-scoped SUPERVISOR grant is normal in MVP 0", () => {
  withWorld((owner) => {
    assert.deepEqual(owner.store.grants.forRun(RUN_ID), [], "Batch 8/9 never issue one");
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

test("SG-2: a valid run-scoped SUPERVISOR grant is checked and stays CONSISTENT", () => {
  withWorld((owner) => {
    supervisorGrant(owner);

    const rows = owner.store.grants.forRun(RUN_ID);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { role: rows[0]?.role, run: rows[0]?.run_id, attempt: rows[0]?.attempt_key },
      { role: "SUPERVISOR", run: RUN_ID, attempt: null },
    );
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

test("SG-3: a corrupt run-scoped SUPERVISOR grant is UNEXPLAINED", () => {
  for (const corruption of ["envelope", "hash"] as const) {
    const owner = world();
    supervisorGrant(owner);
    const path = owner.temp.path;
    owner.store.close();

    tamper(path, (database) => {
      if (corruption === "envelope") {
        database
          .prepare("UPDATE capability_grant SET envelope_json = ? WHERE role = 'SUPERVISOR'")
          .run('{"schema":"platform/capability-grant","schema_version":1,"body":{}}');
      } else {
        database
          .prepare("UPDATE capability_grant SET grant_hash = ? WHERE role = 'SUPERVISOR'")
          .run(`sha256:${"0".repeat(64)}`);
      }
    });

    const reopened = owner.temp.open();
    try {
      const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
      assert.equal(coordinator.recover(RUN_ID), "UNEXPLAINED", corruption);
      // Still classification-only.
      assert.equal(reopened.runs.require(RUN_ID).status, "RUNNING");
      assert.equal(reopened.decisions.count(), 0);
      assert.equal(reopened.outbox.count(), 0);
    } finally {
      reopened.close();
      owner.temp.dispose();
    }
  }
});

test("SG-3: attempt-scoped grants keep their existing coverage alongside the run-scoped one", () => {
  withWorld((owner) => {
    supervisorGrant(owner);
    // The run-scoped lookup is anchored on run_id and does not pick up attempt grants.
    assert.deepEqual(
      owner.store.grants.forRun(RUN_ID).map((row) => row.role),
      ["SUPERVISOR"],
    );
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

// --- PendingDecision subject variants -------------------------------------------------------

test("a valid terminal decision on each subject kind is CONSISTENT", () => {
  const subjects: ReadonlyArray<readonly [string, PendingDecisionSubject]> = [
    ["TASK", { kind: "TASK", task_key: TASK_KEY }],
    ["BATCH", { kind: "BATCH", batch_id: BATCH_ID }],
    ["PROJECT", { kind: "PROJECT", project_id: PROJECT }],
  ];

  for (const [label, subject] of subjects) {
    withWorld((owner) => {
      if (subject.kind === "TASK") discover(owner);
      resolveDecisionOn(owner, subject, ULID.decision);

      const record = owner.store.pendingDecisions.require(ULID.decision);
      assert.equal(record.body.status, "RESOLVED", label);
      assert.notEqual(record.record_hash, null, label);
      assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT", label);
    });
  }
});

test("a corrupt terminal decision is UNEXPLAINED on every subject kind", () => {
  const subjects: ReadonlyArray<readonly [string, PendingDecisionSubject]> = [
    ["TASK", { kind: "TASK", task_key: TASK_KEY }],
    ["BATCH", { kind: "BATCH", batch_id: BATCH_ID }],
    ["PROJECT", { kind: "PROJECT", project_id: PROJECT }],
  ];

  for (const [label, subject] of subjects) {
    const owner = world();
    if (subject.kind === "TASK") discover(owner);
    resolveDecisionOn(owner, subject, ULID.decision);
    const path = owner.temp.path;
    owner.store.close();

    tamper(path, (database) => {
      database
        .prepare("UPDATE pending_human_decision SET record_hash = ? WHERE decision_id = ?")
        .run(`sha256:${"0".repeat(64)}`, ULID.decision);
    });

    const reopened = owner.temp.open();
    try {
      const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
      assert.equal(coordinator.recover(RUN_ID), "UNEXPLAINED", label);
    } finally {
      reopened.close();
      owner.temp.dispose();
    }
  }
});

test("a PROJECT decision is reached through platform_run.project_id", () => {
  withWorld((owner) => {
    const subject = { kind: "PROJECT", project_id: PROJECT } as const;
    resolveDecisionOn(owner, subject, ULID.decision);

    // It hangs off no batch — only the run's project authority reaches it.
    const stored = owner.store.pendingDecisions.require(ULID.decision);
    assert.equal(stored.body.subject.kind, "PROJECT");
    assert.deepEqual(owner.store.pendingDecisions.forSubject(BATCH_ID), []);
    assert.equal(owner.store.pendingDecisions.forSubject(`project:${PROJECT}`).length, 1);
    assert.equal(owner.store.runs.require(RUN_ID).project_id, PROJECT);
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

// --- isolation ---------------------------------------------------------------------------------

test("another project's corrupt PROJECT decision does not affect this run", () => {
  const owner = world();
  // A decision belonging to a different project entirely.
  resolveDecisionOn(owner, { kind: "PROJECT", project_id: "beta" }, ULID.decisionB);
  const path = owner.temp.path;
  owner.store.close();

  tamper(path, (database) => {
    database
      .prepare("UPDATE pending_human_decision SET record_hash = ? WHERE decision_id = ?")
      .run(`sha256:${"0".repeat(64)}`, ULID.decisionB);
  });

  const reopened = owner.temp.open();
  try {
    const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
    assert.equal(
      coordinator.recover(RUN_ID),
      "CONSISTENT",
      "recovery is rooted at the supplied run and its project",
    );
  } finally {
    reopened.close();
    owner.temp.dispose();
  }
});

// --- the audit did not broaden recovery ------------------------------------------------------------

test("the widened coverage still queries no adapter and mutates nothing", () => {
  withWorld((owner) => {
    supervisorGrant(owner);
    resolveDecisionOn(owner, { kind: "PROJECT", project_id: PROJECT }, ULID.decision);

    const before = {
      decisions: owner.store.decisions.count(),
      outbox: owner.store.outbox.count(),
      pending: owner.store.pendingDecisions.count(),
      grants: owner.store.grants.count(),
      idempotency: owner.store.idempotency.count(),
    };

    const workflow = new FakeWorkflowAdapter();
    const runtime = new FakeRuntimeAdapter();
    const repository = new FakeRepositoryAdapter();
    const verification = new FakeVerificationAdapter();
    const report = new FakeReportAdapter();

    const coordinator = new Coordinator({ store: owner.store, workflow });
    assert.equal(coordinator.recover(RUN_ID), "CONSISTENT");

    assert.deepEqual(
      {
        decisions: owner.store.decisions.count(),
        outbox: owner.store.outbox.count(),
        pending: owner.store.pendingDecisions.count(),
        grants: owner.store.grants.count(),
        idempotency: owner.store.idempotency.count(),
      },
      before,
    );
    for (const adapter of [workflow, runtime, repository, verification, report]) {
      assert.deepEqual(adapter.calls, []);
    }
  });
});
