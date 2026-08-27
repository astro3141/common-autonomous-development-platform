/**
 * MVP1-B7 (corrected per M1-9) — `Attempt IMPLEMENTING → Attempt VERIFYING`.
 *
 * Core's only verification dependency is the `VerificationAdapter`. Everything the original B7
 * suite proved about turn authority, candidate authority, ordering, atomicity and the crash
 * windows is preserved; what changed is that the backend seam is generic, so `BLOCKED` — not a
 * preflight verdict — is what stops the transition, and the durable projection is a
 * `VerificationRunHandle` rather than a workflow handle.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startVerification } from "../core/execution/start-verification.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  CANDIDATE_COMMIT,
  implementingWorld,
  type VerificationWorld,
} from "./support/execution-fixtures.ts";

const start = (w: VerificationWorld) => startVerification(w, { attempt_key: w.attempt_key });

const verifyOp = (attempt: string): string => `op:${attempt}:verify:${CANDIDATE_COMMIT}`;

const opState = (store: PlatformStore, opKey: string): string | undefined =>
  store.idempotency.get(opKey)?.state;

const runRef = (store: PlatformStore, attempt: string) =>
  store.adapterMetadata.get(attempt, "verification", "run")?.value;

/** How many times Core asked the verification backend to start. */
const startCalls = (w: VerificationWorld): number =>
  w.verification.calls.filter((call) => call.method === "start_verification").length;

// --- the success path -------------------------------------------------------------------------

test("B7-1 / B7-18: a COMPLETED turn with a valid candidate reaches VERIFYING", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    const result = start(w);

    assert.equal(result.kind, "VERIFYING");
    assert.equal(result.kind === "VERIFYING" ? result.candidate_commit : "", CANDIDATE_COMMIT);
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");

    // B7-6 / B7C-15 — the candidate the repository reported is what became durable.
    assert.equal(world.store.attempts.require(w.attempt_key).candidate_commit, CANDIDATE_COMMIT);
    assert.equal(opState(world.store, verifyOp(w.attempt_key)), "DONE");
    assert.equal(w.verification.runCount, 1);
  });
});

test("B7-19 / B7C-23: entering VERIFYING creates no evidence and collects no result", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    start(w);

    assert.equal(world.store.verificationEvidence.count(), 0, "requested, not passed");
    assert.equal(world.store.auditRecords.count(), 0);
    assert.equal(world.store.pendingDecisions.count(), 0);
    assert.equal(world.store.outbox.count(), 0);
    assert.equal(startCalls(w), 1);
    assert.equal(
      w.verification.calls.some((call) => call.method === "get_verification_result"),
      false,
      "B7 stops at VERIFYING and never observes the run",
    );
  });
});

// --- the model has no authority ----------------------------------------------------------------

test("B7-2 / B7C-22: a model that declares DONE cannot move the attempt on its own", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    // The scripted turn already declares DONE. Take the candidate away and nothing else changes.
    w.repository.candidate = null;

    const result = start(w);
    assert.equal(result.kind, "CANDIDATE_REJECTED");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "REWORKING");
    assert.equal(world.store.attempts.require(w.attempt_key).candidate_commit, null);
    assert.equal(w.verification.runCount, 0);
  });
});

test("B7-2: a non-COMPLETED turn is not overridden by a candidate that happens to exist", () => {
  for (const status of ["CANCELLED", "TIMEOUT", "RUNTIME_ERROR", "SESSION_LOST"] as const) {
    withWorld((world) => {
      const w = implementingWorld(world);
      w.runtime.turnResult = { ...w.runtime.turnResult!, backend_status: status };

      assert.deepEqual(start(w), { kind: "TURN_NOT_COMPLETED", backend_status: status });
      // Nothing at all is written: this transition has no opinion about those states.
      assert.equal(world.store.attempts.require(w.attempt_key).state, "IMPLEMENTING");
      assert.equal(world.store.idempotency.count(), 3, "only B6's three operations");
      assert.equal(w.verification.runCount, 0);
      assert.deepEqual(w.repository.calls.filter((c) => c === "inspect_candidate"), []);
    });
  }
});

// --- candidate guards ---------------------------------------------------------------------------

test("B7-3 / B7-4 / B7-5: each candidate guard reworks and starts no verification", () => {
  const cases = [
    ["ABSENT", (w: VerificationWorld) => (w.repository.candidate = null)],
    ["LINEAGE", (w: VerificationWorld) => (w.repository.lineageValid = false)],
    ["TRACKED_CLEAN", (w: VerificationWorld) => (w.repository.trackedClean = false)],
  ] as const;

  for (const [reason, break_] of cases) {
    withWorld((world) => {
      const w = implementingWorld(world);
      break_(w);

      const result = start(w);
      assert.equal(result.kind, "CANDIDATE_REJECTED", reason);
      assert.equal(result.kind === "CANDIDATE_REJECTED" ? result.reason : "", reason);
      assert.equal(world.store.attempts.require(w.attempt_key).state, "REWORKING");
      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
      assert.equal(w.verification.runCount, 0, "no run for a rejected candidate");
      assert.equal(startCalls(w), 0);
      assert.equal(opState(world.store, verifyOp(w.attempt_key)), undefined);
    });
  }
});

test("B7-3: an exhausted rework budget parks the task instead of reworking again", () => {
  withWorld(
    (world) => {
      const w = implementingWorld(world);
      w.repository.candidate = null;

      const result = start(w);
      assert.equal(result.kind, "CANDIDATE_REJECTED");
      // max_rework is 0 in this world, so the attempt stays put and the task is held.
      assert.equal(world.store.attempts.require(w.attempt_key).state, "IMPLEMENTING");
      const task = world.store.tasks.require(TASK_KEY);
      assert.equal(task.platform_state, "HELD");
      assert.equal(task.state_reason?.code, "REWORK_LIMIT");
    },
    { batch_policy: { max_tasks: 3, max_rework: 0, concurrency: 2 } },
  );
});

// --- BLOCKED: the backend authoritatively started nothing ---------------------------------------

test("B7C-9 / B7C-11: a BLOCKED verification leaves IMPLEMENTING and starts nothing", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    w.verification.blocked = true;
    const before = world.store.decisions.read().length;

    assert.deepEqual(start(w), { kind: "VERIFICATION_BLOCKED", attempt_key: w.attempt_key });

    assert.equal(world.store.attempts.require(w.attempt_key).state, "IMPLEMENTING");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
    assert.equal(w.verification.runCount, 0, "B7C-11");
    assert.equal(runRef(world.store, w.attempt_key), undefined);
    // candidate_commit belongs to the transition, so it is not promoted on its own.
    assert.equal(world.store.attempts.require(w.attempt_key).candidate_commit, null);
    assert.equal(world.store.decisions.read().length, before, "no transition, no hold");
    assert.equal(world.store.pendingDecisions.count(), 0);
  });
});

test("B7C-10 / B7C-12: the intent survives BLOCKED and the same op key later starts", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    w.verification.blocked = true;
    assert.equal(start(w).kind, "VERIFICATION_BLOCKED");

    // M1-9 — BLOCKED is an authoritative *absence*, so the write-ahead intent is correct as it
    // stands. It is never deleted or failed just to reach a zero row count.
    assert.equal(opState(world.store, verifyOp(w.attempt_key)), "INTENT", "B7C-10");
    assert.equal(world.store.idempotency.count(), 4, "B6's three plus this one");

    // Blocked again: still no effect, still the same operation.
    assert.equal(start(w).kind, "VERIFICATION_BLOCKED");
    assert.equal(w.verification.runCount, 0);
    assert.equal(opState(world.store, verifyOp(w.attempt_key)), "INTENT");

    // Backend becomes ready: the same op key starts, with no second candidate observation.
    w.verification.blocked = false;
    assert.equal(start(w).kind, "VERIFYING", "B7C-12");
    assert.equal(world.store.idempotency.count(), 4, "no second op key");
    assert.equal(w.verification.runCount, 1);
  });
});

// --- what Core does not do ------------------------------------------------------------------------

test("B7C-5 / B7C-24: Core acquires no controller and persists nothing owner-shaped", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    start(w);

    // The controller belongs below the VerificationAdapter boundary now (M1-9).
    assert.equal(w.runtime.controllerAcquisitions, 0, "B7C-5");

    const durable = JSON.stringify([
      world.store.adapterMetadata.forEntity(w.attempt_key),
      world.store.idempotency.get(verifyOp(w.attempt_key)),
      world.store.decisions.read(),
    ]);
    for (const category of SECRET_BEARING_KEY_CATEGORIES) {
      assert.equal(durable.toLowerCase().includes(category), false, category);
    }
    for (const forbidden of ["ownerKey", "owner_key", "parent", "workflow"]) {
      assert.equal(durable.includes(forbidden), false, forbidden);
    }
  });
});

// --- identity and binding --------------------------------------------------------------------------

test("B7C-3 / B7C-6 / B7C-7: one identity binds the op, the request and the attempt", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    start(w);

    const op_key = verifyOp(w.attempt_key);
    assert.equal(opState(world.store, op_key), "DONE");

    const call = w.verification.calls.find((entry) => entry.method === "start_verification");
    const [context, profile, snapshot, contract, candidate] = call?.args ?? [];
    assert.deepEqual(context, { op_key }, "the Platform op key is the operation identity");
    assert.deepEqual(Object.keys(context as object), ["op_key"], "exactly one field");
    assert.equal(candidate, CANDIDATE_COMMIT, "B7C-6");
    assert.equal(world.store.attempts.require(w.attempt_key).candidate_commit, CANDIDATE_COMMIT);

    // The frozen contract and its declared profile are what the backend is given — never anything
    // the Actor produced, and never the mutable Profile Registry.
    const attempt = world.store.attempts.require(w.attempt_key);
    const stored = world.store.contracts.get(attempt.contract_snapshot_id);
    assert.deepEqual(contract, stored, "the frozen Task Contract snapshot");
    assert.equal(profile, (stored?.body as { verification_profile?: string }).verification_profile);
    assert.deepEqual(snapshot, { ref: w.repository.ref, head: w.repository.head });
  });
});

test("B7C-21: a candidate that moved after an intent was written fails closed", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    // An intent exists for one candidate; the workspace now reports a different one.
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(`op:${w.attempt_key}:verify:0000000000000000`);
    });

    assert.throws(() => start(w), /different candidate/);
    assert.equal(w.verification.runCount, 0, "no run under a rebound candidate");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "IMPLEMENTING");
  });
});

// --- ordering, boundary and atomicity ----------------------------------------------------------------

test("B7C-7 / B7C-8: the intent is durable before the start, which runs outside every transaction", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    let intentAtStart: string | undefined;
    let probed = 0;
    w.verification.onStart = () => {
      intentAtStart = opState(world.store, verifyOp(w.attempt_key));
      // A nested transaction would throw if the caller still held the single writer.
      world.store.withTransaction(() => {
        probed += 1;
      });
    };

    assert.equal(start(w).kind, "VERIFYING");
    assert.equal(intentAtStart, "INTENT", "B7C-7");
    assert.equal(probed, 1, "B7C-8");
  });
});

test("B7C-13 / B7C-15: the run handle, the completion and the transition commit together", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    const before = world.store.decisions.read().length;
    start(w);

    assert.deepEqual(runRef(world.store, w.attempt_key), { verification_run: "run-1" }, "B7C-13");
    const transitions = world.store.decisions
      .read()
      .slice(before)
      .filter((entry) => entry.kind === STATE_TRANSITION_KIND);
    assert.equal(transitions.length, 1);
    const payload = transitions[0]?.payload as unknown as { attempt: { from: string; to: string } };
    assert.deepEqual(payload.attempt, { from: "IMPLEMENTING", to: "VERIFYING" });
  });
});

test("B7C-16: a rejected durable write rolls the whole transition back", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    // A handle the §6 data model cannot express: the closing transaction must fail as a whole.
    w.verification.runValue = () => ({ started: () => true });

    assert.throws(() => start(w));
    assert.equal(world.store.attempts.require(w.attempt_key).state, "IMPLEMENTING");
    assert.equal(world.store.attempts.require(w.attempt_key).candidate_commit, null);
    assert.equal(opState(world.store, verifyOp(w.attempt_key)), "INTENT");
    assert.equal(runRef(world.store, w.attempt_key), undefined);
    assert.equal(w.verification.runCount, 1, "the external run exists and must be reacquired");
  });
});

// --- crash windows V1–V5 -----------------------------------------------------------------------------

test("B7-20 (V1/V2): an intent with no start yet is completed by a plain retry", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(verifyOp(w.attempt_key));
    });

    assert.equal(start(w).kind, "VERIFYING");
    assert.equal(w.verification.runCount, 1);
    assert.equal(startCalls(w), 1);
  });
});

test("B7C-17 / B7C-19 (V3): a run that never persisted is reacquired, not repeated", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    w.verification.failAfterStart = new Error("crash after the run exists");

    assert.throws(() => start(w));
    assert.equal(w.verification.runCount, 1);
    assert.equal(opState(world.store, verifyOp(w.attempt_key)), "INTENT");

    w.verification.failAfterStart = undefined;
    assert.equal(start(w).kind, "VERIFYING");

    // Same op key + same material re-acquired: still exactly one logical run.
    assert.equal(w.verification.runCount, 1, "B7C-19");
    assert.deepEqual(runRef(world.store, w.attempt_key), { verification_run: "run-1" });
  });
});

test("B7C-18 (V4): a durable run handle without its DONE reconciles without a second start", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    const op_key = verifyOp(w.attempt_key);
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(op_key);
      world.store.adapterMetadata.put({
        entity_key: w.attempt_key,
        adapter_id: "verification",
        key: "run",
        value: { verification_run: "run-recovered" } as CanonicalObject,
      });
    });

    assert.equal(start(w).kind, "VERIFYING");
    assert.equal(opState(world.store, op_key), "DONE");
    assert.equal(startCalls(w), 0, "reconciled, never restarted");
    assert.equal(w.verification.runCount, 0);
    assert.deepEqual(runRef(world.store, w.attempt_key), { verification_run: "run-recovered" });
    assert.equal(world.store.attempts.require(w.attempt_key).candidate_commit, CANDIDATE_COMMIT);
  });
});

test("B7C-19 (V5): a finished transition cannot be entered twice", () => {
  withWorld((world) => {
    const w = implementingWorld(world);
    assert.equal(start(w).kind, "VERIFYING");
    assert.throws(() => start(w), /requires IMPLEMENTING, not VERIFYING/);
    assert.equal(w.verification.runCount, 1);
    assert.equal(startCalls(w), 1);
  });
});
