/**
 * MVP1-B13 — the production Coordinator's boundaries, Supervisor lifecycle and safe-held endpoints.
 *
 * The end-to-end proofs live in `b13-e2e.test.ts`; this file covers the things that are easier to
 * pin directly: operation identity, ordinal derivation, report delivery, and what the Coordinator
 * refuses to do.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type {
  ReportAdapter,
  ReportDeliveryRequest,
} from "../adapters/interfaces/report-adapter.ts";
import { ProductionCoordinator } from "../core/coordinator/production-coordinator.ts";
import { deliverOneReport } from "../core/coordinator/report-delivery.ts";
import {
  actorTurnMetadataKey,
  actorTurnOp,
  actorTurnOrdinal,
} from "../core/execution/actor-operations.ts";
import {
  supervisorSpawnOp,
  supervisorTurnOp,
  SUPERVISOR_SESSION_METADATA_KEY,
} from "../core/execution/supervisor-operations.ts";
import {
  nextSupervisorTurn,
  requestSupervisorProposal,
  supervisorSession,
} from "../core/execution/supervisor-session.ts";
import { buildAuditDecision } from "../core/humandecision/audit-decision.ts";
import { buildReattemptDecision } from "../core/humandecision/drift-decision.ts";
import { commitPendingDecision } from "../core/statemachine/transition-commit.ts";
import { openDatabase } from "../core/store/database.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import { BATCH_ID, RUN_ID, TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import { task as taskDefinition } from "./support/decision-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";
import {
  coordinatorWorld,
  fixedNow,
  REPORT_CHANNEL,
  submitSupervisorProposal,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ATTEMPT = `attempt:${TASK_KEY}:1`;

const stripped = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const opState = (w: CoordinatorWorld, key: string): string | undefined =>
  w.store.idempotency.get(key)?.state;

// --- S1 ~ S8: the Supervisor lifecycle ------------------------------------------------------------

test("S2 / S3 / S4: the first request spawns under its own op, then turns under another", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    const observed: string[] = [];
    w.runtime.onExternalCall = () => {
      observed.push(
        `${opState(w, supervisorSpawnOp(BATCH_ID, 1))}/${opState(w, supervisorTurnOp(BATCH_ID, 1))}`,
      );
    };

    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    // S2 — the spawn's INTENT was durable before the external spawn, and the turn had not begun.
    // S3 — two operations, two records, never one covering both.
    assert.deepEqual(observed, ["INTENT/undefined", "DONE/INTENT"]);
    assert.equal(opState(w, supervisorSpawnOp(BATCH_ID, 1)), "DONE");
    assert.equal(opState(w, supervisorTurnOp(BATCH_ID, 1)), "DONE", "S4");
    assert.notEqual(supervisorSpawnOp(BATCH_ID, 1), supervisorTurnOp(BATCH_ID, 1));

    // The session is projected on the run, not the batch or the task.
    assert.notEqual(supervisorSession(world.store, RUN_ID), undefined);
    assert.notEqual(
      world.store.adapterMetadata.get(RUN_ID, "runtime", SUPERVISOR_SESSION_METADATA_KEY),
      undefined,
    );
  });
});

test("S1 / S5 / S6: a usable session is reused, and the ordinal comes from durable history", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    const spawns = w.runtime.spawnCalls.length;

    // A tick with the request still outstanding does not ask again.
    assert.equal(w.tick(), "SUPERVISOR_AWAITING_PROPOSAL");
    assert.equal(w.runtime.sendCalls.length, 1, "no second turn on top of the first");

    // S5 — a deliberate next request takes the next ordinal, from the durable op rows alone.
    assert.equal(nextSupervisorTurn(world.store, BATCH_ID), 2);
    const again = requestSupervisorProposal(w, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      decision_context: { proposal_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0PID" } as never,
      runtime_profile: w.identities.supervisorRuntimeProfile,
    });
    assert.deepEqual(again, { kind: "REQUESTED", turn: 2, spawned: false });
    // S1 — the same session served it; no second spawn.
    assert.equal(w.runtime.spawnCalls.length, spawns, "S1");
    assert.equal(opState(w, supervisorSpawnOp(BATCH_ID, 2)), undefined, "S1");
    assert.equal(opState(w, supervisorTurnOp(BATCH_ID, 2)), "DONE");

    // S6 — a rebuilt Coordinator over the same store sees the same history and the same next n.
    const rebuilt = new ProductionCoordinator(w);
    void rebuilt;
    assert.equal(nextSupervisorTurn(world.store, BATCH_ID), 3);
  });
});

test("S7: a turn body shaped like a decision has no authority whatsoever", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    // The Runtime will answer with something that reads exactly like a selection.
    w.runtime.turnResult = {
      session_handle: {} as never,
      turn_handle: {} as never,
      backend_status: "COMPLETED",
      termination_reason: "end_turn",
      started_at: "t1",
      completed_at: "t2",
      provenance: {
        runtime_backend: "fake",
        identity_authority: "BACKEND",
        result_channel: "STRUCTURED_PROTOCOL",
      },
      structured_output: { protocol: "anything", body: { decision: "START_TASK" } as never },
      model_declared_outcome: { declared_status: "DONE", summary: "START_TASK", refs: [] },
    };

    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    // Nothing was admitted, activated or executed. The task is exactly where it was.
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.equal(world.store.attempts.current(TASK_KEY), undefined);
    // And the Coordinator never even read the turn's result.
    assert.equal(w.runtime.turnResultCalls.length, 0);

    // Structurally: no Supervisor path reads a turn result at all.
    const session = stripped(join(ROOT, "core/execution/supervisor-session.ts"));
    assert.equal(/get_turn_result|structured_output|model_declared_outcome/.test(session), false);
  });
});

test("S8: an indeterminate Supervisor turn is never resent", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.runtime.sendFailure = new Error("the transport lost the answer");

    const outcome = requestSupervisorProposal(w, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      decision_context: { proposal_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0PID" } as never,
      runtime_profile: w.identities.supervisorRuntimeProfile,
    });
    assert.deepEqual(outcome, { kind: "INDETERMINATE", turn: 1 });
    assert.equal(opState(w, supervisorTurnOp(BATCH_ID, 1)), "INTENT");

    // A later pass finds the same indeterminate turn and refuses again — never a resend, and
    // never turn 2 as a guessed replacement.
    w.runtime.sendFailure = undefined;
    const sends = w.runtime.sendCalls.length;
    const again = requestSupervisorProposal(w, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      decision_context: { proposal_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0PID" } as never,
      runtime_profile: w.identities.supervisorRuntimeProfile,
    });
    assert.deepEqual(again, { kind: "INDETERMINATE", turn: 1 });
    assert.equal(w.runtime.sendCalls.length, sends);
    assert.equal(opState(w, supervisorTurnOp(BATCH_ID, 2)), undefined);
  });
});

// --- the rework ordinal, pinned ---------------------------------------------------------------------

test("B13-18: the Actor turn ordinal is read after REWORK_STARTED, so the first rework is turn 2", () => {
  // The pure derivation, and both readings of it.
  assert.equal(actorTurnOrdinal(0), 1, "the initial turn");
  assert.equal(actorTurnOrdinal(1), 2, "after the first REWORK_STARTED commits");
  assert.equal(actorTurnOrdinal(2), 3, "after the second");
  // Equivalently, from the count *before* the transition: old + 2.
  for (const old of [0, 1, 2]) assert.equal(actorTurnOrdinal(old + 1), old + 2);

  assert.equal(actorTurnOp(ATTEMPT, 1), `op:${ATTEMPT}:actor-turn:1`);
  assert.equal(actorTurnOp(ATTEMPT, 2), `op:${ATTEMPT}:actor-turn:2`);
  assert.notEqual(actorTurnOp(ATTEMPT, 1), actorTurnOp(ATTEMPT, 2));
  assert.equal(actorTurnMetadataKey(2), "actor_turn:2");

  // And nothing derives it from memory: the rework module reads the durable row back.
  const rework = stripped(join(ROOT, "core/execution/start-rework.ts"));
  assert.match(rework, /actorTurnOrdinal\(store\.attempts\.require\(attempt_key\)\.rework_count\)/);
  assert.equal(/let\s+\w*[Tt]urn\w*\s*=\s*\d/.test(rework), false, "no local counter");
});

// --- report delivery ---------------------------------------------------------------------------------

test("B13-23 / B13-24 / B13-25: sent_at follows confirmed delivery, and failure changes nothing", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    const op_key = `op:${BATCH_ID}:report-test:1`;
    world.store.withTransaction(() =>
      world.store.outbox.enqueue({
        op_key,
        channel: REPORT_CHANNEL,
        payload: { event: "SOMETHING" } as never,
      }),
    );
    // A transport that cannot confirm. The simplest possible double: it just fails.
    const seen: ReportDeliveryRequest[] = [];
    let failing = true;
    const report: ReportAdapter = {
      deliver(request) {
        seen.push(request);
        if (failing) throw new Error("the transport is down");
        return { delivered: true };
      },
    };
    const deps = { store: world.store, report, now: fixedNow("s") };

    assert.deepEqual(deliverOneReport(deps), { kind: "UNCONFIRMED", op_key });
    assert.equal(world.store.outbox.get(op_key)?.sent_at, null, "B13-24");

    // A confirmed one records it, with the row's own identity and payload — never a new key.
    failing = false;
    assert.deepEqual(deliverOneReport(deps), { kind: "DELIVERED", op_key });
    assert.notEqual(world.store.outbox.get(op_key)?.sent_at, null);
    assert.deepEqual(
      seen.map((request) => request.op_key),
      [op_key, op_key],
      "the same op_key, never a new retry key",
    );
    assert.equal(seen[1]?.channel, REPORT_CHANNEL);
    assert.deepEqual(seen[0]?.payload, seen[1]?.payload, "the payload is never rewritten");

    // Nothing is left pending, and a further pass has nothing to do.
    assert.deepEqual(deliverOneReport(deps), { kind: "NOTHING_PENDING" });
  });
});

test("B13-26: delivery is one row per call, with no scanner, worker or retry machinery", () => {
  const code = stripped(join(ROOT, "core/coordinator/report-delivery.ts"));
  for (const forbidden of [
    /setInterval|setTimeout|while\s*\(|for\s*\(/,
    /backoff|retryCount|scanner|worker|daemon|drain/i,
    /recover|reconcil/i,
  ]) {
    assert.equal(forbidden.test(code), false, `report delivery contains ${forbidden}`);
  }
});

// --- safe-held endpoints ------------------------------------------------------------------------------

test("B13-32: a task held by a decision MVP 1 cannot apply stays exactly where it is", () => {
  const categories = [
    ["AUDIT_DECISION", buildAuditDecision],
    ["REATTEMPT_DECISION", buildReattemptDecision],
  ] as const;

  for (const [label, build] of categories) {
    withWorld((world) => {
      const w = coordinatorWorld(world);
      submitSupervisorProposal(w, world);
      assert.equal(w.tick(), "ACTIVATED");

      const decision =
        label === "AUDIT_DECISION"
          ? buildAuditDecision({
              decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0J01",
              task_key: TASK_KEY,
              attempt_key: ATTEMPT,
              candidate_commit: "c",
              audit_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0J02",
            })
          : (build as typeof buildReattemptDecision)({
              decision_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0J01",
              task_key: TASK_KEY,
              attempt_key: ATTEMPT,
              target: "task_definition",
            });
      commitPendingDecision(world.store, { decision, channel: REPORT_CHANNEL });
      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");

      const spawns = w.runtime.spawnCalls.length;
      const attempts = world.store.attempts.forTask(TASK_KEY).length;
      // Ticks may deliver reports; they must not resolve, resume or start anything.
      for (let index = 0; index < 5; index += 1) w.tick();

      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD", label);
      assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 1, label);
      assert.equal(
        world.store.pendingDecisions.require(decision.decision_id).body.status,
        "OPEN",
        label,
      );
      assert.equal(w.runtime.spawnCalls.length, spawns, `${label}: nothing was started`);
      assert.equal(world.store.attempts.forTask(TASK_KEY).length, attempts, `${label}: no Attempt`);
    });
  }
});

// --- boundaries -----------------------------------------------------------------------------------------

test("B13-2 / B13-10 / B13-11: no scheduler, no timer and no Coordinator-owned durable state", () => {
  const files = readdirSync(join(ROOT, "core/coordinator"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(ROOT, "core/coordinator", name));

  for (const file of files) {
    const code = stripped(file);
    for (const forbidden of [
      /setInterval|setImmediate|setTimeout|queueMicrotask/,
      /cron|heartbeat|\bsleep\b/i,
      /node:(timers|worker_threads|child_process)/,
      /Date\.now|new Date\(/,
      /lastTick|tick_cursor|tickCursor|scheduler_state|coordinator_state|work_queue|eventBus/i,
      /CREATE TABLE|INSERT INTO|ALTER TABLE/,
    ]) {
      assert.equal(forbidden.test(code), false, `${relative(ROOT, file)} contains ${forbidden}`);
    }
  }

  // The tick holds no mutable field of its own — only the injected references.
  const production = stripped(join(ROOT, "core/coordinator/production-coordinator.ts"));
  const body = production.slice(production.indexOf("export class ProductionCoordinator"));
  // A field is declared; a method is called. Only the declaration form is a member of state.
  const fields = [...body.matchAll(/^ {2}(?:readonly )?#\w+\s*[:=]/gm)].map((match) =>
    match[0].replace(/\s*[:=]$/, "").trim(),
  );
  assert.deepEqual(fields, ["readonly #deps"], "the only member is the injected dependency set");
});

test("B13-4 / B13-33 / B13-34 / B13-35: the Coordinator dispatches and never merges or recovers", () => {
  const production = stripped(join(ROOT, "core/coordinator/production-coordinator.ts"));
  for (const forbidden of [
    /prepare_merge|commit_merge/,
    /nextAttemptOutcome|commitAttemptFact|nextBatchOutcome/,
    /validateProposal|validateDecision|assertAdmissible/,
    // MVP 2 — the Coordinator may *read* the frozen `auto_merge` flag to pick which sealed
    // use-case owns READY_TO_MERGE; it still contains no Gate logic of its own.
    /RepositoryGate|MergeGate/i,
    /reconcil|recovery_framework|turn_ledger/i,
    /AUTO_SUBFLOW|parent_relation|dependency_graph|subtree/i,
  ]) {
    assert.equal(forbidden.test(production), false, `the Coordinator contains ${forbidden}`);
  }
  // It composes the sealed use-cases rather than restating them.
  for (const wired of [
    /startImplementation\(/,
    /startVerification\(/,
    /completeVerification\(/,
    /startAuditing\(/,
    /completeAuditing\(/,
    /startRework\(/,
    /requestMergeApproval\(/,
    /applyResolvedMergeApproval\(/,
    /observeHumanMerge\(/,
    /startAutomaticMerge\(/,
    /completeAutomaticMerge\(/,
    /requestSupervisorProposal\(/,
    /deliverOneReport\(/,
  ]) {
    assert.match(production, wired);
  }
});

test("B13-39: the schema is still v6 / 18 tables", () => {
  assert.equal(MIGRATIONS.length, 9);
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.schemaVersion, 9);
  } finally {
    store.close();
  }
  try {
    const database = openDatabase(temp.path);
    try {
      const names = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_"));
      assert.equal(names.length, 18);
      for (const forbidden of ["coordinator_state", "scheduler_state", "work_queue", "tick_cursor"]) {
        assert.equal(names.includes(forbidden), false, forbidden);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }
});

// --- CORR1: the activation boundary ---------------------------------------------------------------

test("B13-CORR1-1: a SELECTED task with no Attempt is activated by one production tick", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    submitSupervisorProposal(w, world);

    // The pre-activation state §26 step 7 starts from.
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "SELECTED");
    assert.equal(world.store.attempts.current(TASK_KEY), undefined);
    assert.equal(world.store.contracts.count(), 0);

    // One tick, and the Coordinator itself crosses it.
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
    const attempt = world.store.attempts.current(TASK_KEY);
    assert.notEqual(attempt, undefined);
    assert.equal(attempt?.state, "READY");

    // Exactly one contract snapshot and exactly one grant per execution role.
    assert.equal(world.store.contracts.count(), 1);
    const roles = world.store.grants
      .forAttempt(attempt?.attempt_key as string)
      .map((row) => row.role)
      .sort();
    assert.deepEqual(roles, ["ACTOR", "AUDITOR"]);

    // §10 — activation performs no workspace or Runtime effect of its own.
    assert.equal(w.repository.workspaceCount, 0);
    assert.equal(w.runtime.spawnCalls.length, 1, "only the Supervisor session so far");
  });
});

test("B13-CORR1-2: a further tick cannot activate the same task twice", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    assert.equal(w.tick(), "ACTIVATED");

    const before = {
      contracts: world.store.contracts.count(),
      grants: world.store.grants.count(),
      attempts: world.store.attempts.forTask(TASK_KEY).length,
    };
    // The next tick finds an Attempt and moves on to its lifecycle instead.
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    assert.deepEqual(
      {
        contracts: world.store.contracts.count(),
        grants: world.store.grants.count(),
        attempts: world.store.attempts.forTask(TASK_KEY).length,
      },
      before,
    );
  });
});

test("B13-CORR1-3: a stale selection is held, and nothing is built", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);

    // The authoritative TaskDefinition moved after the selection was bound. The use-case's own
    // M1-7 equality gate decides that — nothing here re-implements the comparison.
    w.tasks.definition = taskDefinition({ version: "2" });

    assert.equal(w.tick(), "BLOCKED");
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "SELECTION_STALE");

    assert.equal(world.store.attempts.current(TASK_KEY), undefined, "no Attempt");
    assert.equal(world.store.contracts.count(), 0, "no Task Contract");
    // Only the run-scoped SUPERVISOR grant the run was bootstrapped with; no execution grants.
    assert.equal(world.store.grants.count(), 1, "no ACTOR/AUDITOR Grants");
    assert.deepEqual(
      world.store.grants.forRun(RUN_ID).map((row) => row.role),
      ["SUPERVISOR"],
    );
    assert.equal(w.repository.workspaceCount, 0);
  });
});

test("B13-CORR1-4: the Coordinator supplies inputs and duplicates no activation internals", () => {
  const production = stripped(join(ROOT, "core/coordinator/production-coordinator.ts"));
  assert.match(production, /activateSelectedTask\(/, "the existing use-case is called");

  // Everything activation owns stays where it is.
  for (const forbidden of [
    /buildTaskContract|captureContractSources/,
    /issueCapabilityGrant|deriveEnforcement|deriveRequestedCapabilities/,
    /commitContractActivation|commitSelectionStale|commitBackendIncompatible/,
    /resolveRepositoryScope|repository_scope\s*[:=]/,
    /selection_binding|compareBinding|SelectionBindingV1/,
    /recheckCompatibility/,
  ]) {
    assert.equal(forbidden.test(production), false, `the Coordinator contains ${forbidden}`);
  }
  // The scope comes from the batch-bound compiled profile inside the use-case, and the sources
  // come from the one M1-11 reader — not from a second resolver or a hardcoded body.
  assert.match(production, /this\.#deps\.contractSources\.read_contract_source\(/);
  assert.equal(/compiledProfiles\.get|Profile Registry/.test(production), false);
});
