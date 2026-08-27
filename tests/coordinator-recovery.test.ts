/**
 * B9-AC12 ~ B9-AC18, B9-AC26 — `recover(run_id)` classifies Platform-owned durable integrity and
 * does nothing else (TD §22.4).
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Coordinator } from "../core/coordinator/coordinator.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import { commitAdmission, commitContractActivation } from "../core/statemachine/transition-commit.ts";
import { commitDecisionResolution, commitPendingDecision } from "../core/statemachine/transition-commit.ts";
import { FakeReportAdapter } from "../testdoubles/fake-report-adapter.ts";
import { FakeRepositoryAdapter } from "../testdoubles/fake-repository-adapter.ts";
import { FakeRuntimeAdapter } from "../testdoubles/fake-runtime-adapter.ts";
import { FakeVerificationAdapter } from "../testdoubles/fake-verification-adapter.ts";
import { FakeWorkflowAdapter } from "../testdoubles/fake-workflow-adapter.ts";
import type { DomainWorld } from "./support/domain-fixtures.ts";
import {
  BINDING,
  RUN_ID,
  SCOPE_ID,
  SELECTION,
  ULID,
  contractBuild,
  discover,
  gateDecision,
  seedTask,
  snapshotId,
  withWorld,
  world,
} from "./support/domain-fixtures.ts";

const coordinatorFor = (owner: DomainWorld): Coordinator =>
  new Coordinator({ store: owner.store, workflow: new FakeWorkflowAdapter() });

/** Raw connection with foreign keys left off, for building corruption fixtures only. */
const tamper = (path: string, run: (database: DatabaseSync) => void): void => {
  const database = new DatabaseSync(path);
  try {
    // Corruption fixtures must be able to break the very constraints production enforces.
    database.exec("PRAGMA foreign_keys = OFF");
    run(database);
  } finally {
    database.close();
  }
};

const durableSnapshot = (owner: DomainWorld): Record<string, number> => ({
  decisions: owner.store.decisions.count(),
  outbox: owner.store.outbox.count(),
  idempotency: owner.store.idempotency.count(),
  pending: owner.store.pendingDecisions.count(),
});

/** Admits a task and activates its contract, leaving one READY attempt with both grants. */
function activate(owner: DomainWorld, ref = "T-101"): string {
  const key = discover(owner, ref);
  commitAdmission(owner.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t-admit", hard_dependencies_clear: true, });
  commitContractActivation(owner.store, {
    task_key: key,
    attempt_key: `attempt:${key}:1`,
    n: 1,
    build: contractBuild(owner, { task_ref: ref, snapshot_id: snapshotId(0) }),
  });
  return key;
}

// --- CONSISTENT ---------------------------------------------------------------------------

test("B9-AC16 (R1): a minimal run with a valid compiled profile is CONSISTENT", () => {
  withWorld((owner) => {
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

test("B9-AC16 (R2): a run with batches and tasks but no attempt artifacts is CONSISTENT", () => {
  withWorld((owner) => {
    seedTask(owner, { ref: "A", state: "DISCOVERED" });
    seedTask(owner, { ref: "B", state: "SELECTED" });
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

test("B9-AC16 (R3): a run with a contract snapshot and both grants is CONSISTENT", () => {
  withWorld((owner) => {
    activate(owner);
    assert.equal(owner.store.contracts.count(), 1);
    assert.equal(owner.store.grants.forAttempt("attempt:task:alpha:T-101:1").length, 2);
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

test("B9-AC16 (R4): a terminal PendingDecision with a valid record hash is CONSISTENT", () => {
  withWorld((owner) => {
    discover(owner);
    commitPendingDecision(owner.store, { decision: gateDecision(owner), channel: "operations" });
    commitDecisionResolution(owner.store, ULID.decision, {
      kind: "OPTION",
      chosen_option: "APPROVE",
      free_form: null,
      resolved_by: "operator-reference-1",
      resolved_at: "t-resolve",
      approval_binding: null,
      applied_transition_ref: null,
    });

    const record = owner.store.pendingDecisions.require(ULID.decision);
    assert.equal(record.body.status, "RESOLVED");
    assert.notEqual(record.record_hash, null);
    assert.equal(coordinatorFor(owner).recover(RUN_ID), "CONSISTENT");
  });
});

// --- UNEXPLAINED ----------------------------------------------------------------------------

test("B9-AC17: an unknown run root is UNEXPLAINED", () => {
  withWorld((owner) => {
    assert.equal(
      coordinatorFor(owner).recover("run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZZ"),
      "UNEXPLAINED",
    );
  });
});

test("B9-AC17: a corrupt compiled profile is UNEXPLAINED", () => {
  const owner = world();
  const path = owner.temp.path;
  owner.store.close();
  tamper(path, (database) => {
    database
      .prepare("UPDATE compiled_profile_snapshot SET envelope_json = ?")
      .run('{"schema":"platform/compiled-profile","schema_version":1,"body":{}}');
  });

  const reopened = owner.temp.open();
  try {
    const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
    assert.equal(coordinator.recover(RUN_ID), "UNEXPLAINED");
  } finally {
    reopened.close();
    owner.temp.dispose();
  }
});

test("B9-AC17: a missing or corrupt contract snapshot is UNEXPLAINED", () => {
  for (const corruption of ["delete", "tamper"] as const) {
    const owner = world();
    activate(owner);
    const path = owner.temp.path;
    owner.store.close();

    tamper(path, (database) => {
      if (corruption === "delete") {
        database.prepare("DELETE FROM task_contract_snapshot").run();
      } else {
        database
          .prepare("UPDATE task_contract_snapshot SET envelope_json = ?")
          .run('{"schema":"platform/task-contract","schema_version":1,"body":{}}');
      }
    });

    const reopened = owner.temp.open();
    try {
      const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
      assert.equal(coordinator.recover(RUN_ID), "UNEXPLAINED", corruption);
    } finally {
      reopened.close();
      owner.temp.dispose();
    }
  }
});

test("B9-AC17: a missing or corrupt capability grant is UNEXPLAINED", () => {
  for (const corruption of ["delete", "tamper"] as const) {
    const owner = world();
    activate(owner);
    const path = owner.temp.path;
    owner.store.close();

    tamper(path, (database) => {
      if (corruption === "delete") {
        database.prepare("DELETE FROM capability_grant WHERE role = 'AUDITOR'").run();
      } else {
        database
          .prepare("UPDATE capability_grant SET envelope_json = ? WHERE role = 'ACTOR'")
          .run('{"schema":"platform/capability-grant","schema_version":1,"body":{}}');
      }
    });

    const reopened = owner.temp.open();
    try {
      const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
      assert.equal(coordinator.recover(RUN_ID), "UNEXPLAINED", corruption);
    } finally {
      reopened.close();
      owner.temp.dispose();
    }
  }
});

test("B9-AC17: a corrupt terminal PendingDecision is UNEXPLAINED", () => {
  const owner = world();
  discover(owner);
  commitPendingDecision(owner.store, { decision: gateDecision(owner), channel: "operations" });
  commitDecisionResolution(owner.store, ULID.decision, {
    kind: "OPTION",
    chosen_option: "APPROVE",
    free_form: null,
    resolved_by: "operator-reference-1",
    resolved_at: "t-resolve",
    approval_binding: null,
    applied_transition_ref: null,
  });
  const path = owner.temp.path;
  owner.store.close();

  tamper(path, (database) => {
    database
      .prepare("UPDATE pending_human_decision SET record_hash = ?")
      .run(`sha256:${"0".repeat(64)}`);
  });

  const reopened = owner.temp.open();
  try {
    const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
    assert.equal(coordinator.recover(RUN_ID), "UNEXPLAINED");
  } finally {
    reopened.close();
    owner.temp.dispose();
  }
});

test("B9-AC17: a broken relational reference is UNEXPLAINED", () => {
  const owner = world();
  activate(owner);
  const path = owner.temp.path;
  owner.store.close();

  // The batch points at a compiled profile that no longer exists.
  tamper(path, (database) => {
    database
      .prepare("UPDATE batch SET compiled_profile_hash = ?")
      .run(`sha256:${"1".repeat(64)}`);
  });

  const reopened = owner.temp.open();
  try {
    const coordinator = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
    assert.equal(coordinator.recover(RUN_ID), "UNEXPLAINED");
  } finally {
    reopened.close();
    owner.temp.dispose();
  }
});

test("B9-AC17: an unexpected error is not disguised as UNEXPLAINED", () => {
  withWorld((owner) => {
    const broken = {
      ...owner.store,
      runs: {
        get() {
          throw new TypeError("a programming bug, not a corrupt record");
        },
      },
    } as unknown as typeof owner.store;

    const coordinator = new Coordinator({ store: broken, workflow: new FakeWorkflowAdapter() });
    assert.throws(() => coordinator.recover(RUN_ID), TypeError);
  });
});

// --- EXPLAINABLE reserved ---------------------------------------------------------------------

test("B9-AC18: no MVP 0 path produces EXPLAINABLE", () => {
  const results: string[] = [];

  withWorld((owner) => {
    activate(owner);
    const coordinator = coordinatorFor(owner);
    results.push(coordinator.recover(RUN_ID));
    results.push(coordinator.recover("run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZZ"));
  });

  assert.deepEqual([...new Set(results)].sort(), ["CONSISTENT", "UNEXPLAINED"]);
  assert.equal(results.includes("EXPLAINABLE"), false);

  // And there is no seam that injects an external observation to manufacture it.
  const surface = Object.getOwnPropertyNames(Coordinator.prototype);
  assert.deepEqual(surface.sort(), ["constructor", "observe", "recover", "tickOnce"]);
});

// --- side effects / restart ----------------------------------------------------------------------

test("B9-AC14 / B9-AC15: recover queries no adapter and mutates nothing", () => {
  withWorld((owner) => {
    activate(owner);
    const workflow = new FakeWorkflowAdapter();
    const runtime = new FakeRuntimeAdapter();
    const repository = new FakeRepositoryAdapter();
    const verification = new FakeVerificationAdapter();
    const report = new FakeReportAdapter();

    const before = durableSnapshot(owner);
    const coordinator = new Coordinator({ store: owner.store, workflow });

    assert.equal(coordinator.recover(RUN_ID), "CONSISTENT");
    assert.equal(coordinator.recover("run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZZ"), "UNEXPLAINED");

    assert.deepEqual(durableSnapshot(owner), before, "no durable write, not even on UNEXPLAINED");
    for (const adapter of [workflow, runtime, repository, verification, report]) {
      assert.deepEqual(adapter.calls, []);
    }
    // UNEXPLAINED did not pause anything by itself.
    assert.equal(owner.store.runs.require(RUN_ID).status, "RUNNING");
    assert.equal(owner.store.batches.forRun(RUN_ID)[0]?.status, "RUNNING");
  });
});

test("B9-AC26: a new Coordinator over the same store returns the same classification", () => {
  const owner = world();
  activate(owner);
  const first = coordinatorFor(owner);
  assert.equal(first.recover(RUN_ID), "CONSISTENT");

  // Drop the Coordinator *and* the connection, then start over.
  owner.store.close();
  const reopened = owner.temp.open();
  try {
    const second = new Coordinator({ store: reopened, workflow: new FakeWorkflowAdapter() });
    assert.equal(second.recover(RUN_ID), "CONSISTENT");
    assert.equal(
      reopened.schemaVersion,
      MIGRATIONS.length,
      "the Coordinator introduced no migration of its own",
    );
  } finally {
    reopened.close();
    owner.temp.dispose();
  }
});
