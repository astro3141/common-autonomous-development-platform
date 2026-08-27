/**
 * MVP1-B9 — verification completion and the evidence gate.
 *
 * VEC-1…VEC-6 (crash windows), BG-1…BG-6 (binding), VP-1…VP-10 (policy) and the four endpoints.
 * The attempt never leaves `VERIFYING` on success: that is the whole point of the batch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { completeVerification } from "../core/execution/complete-verification.ts";
import type { VerificationEvidence } from "../adapters/interfaces/verification-adapter.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  CANDIDATE_COMMIT,
  evidenceItem,
  verifyingWorld,
  type CompletionWorld,
} from "./support/execution-fixtures.ts";

/** The decision fixture's policy requires exactly `unit`, accepting `REEXECUTED`. */
const REQUIRED_CHECK = "unit";

const complete = (w: CompletionWorld) => completeVerification(w, { attempt_key: w.attempt_key });

/** Scripts a terminal observation whose items are already bound to this attempt. */
function scriptCompleted(
  w: CompletionWorld,
  items: ReadonlyArray<Partial<VerificationEvidence> & { readonly check_id: string }>,
): void {
  w.verification.completeWith(
    items.map((item) => evidenceItem({ task_contract_hash: w.task_contract_hash, ...item })),
  );
}

const rows = (store: PlatformStore, attempt_key: string) =>
  store.verificationEvidence.forAttempt(attempt_key);

const state = (w: CompletionWorld) => ({
  attempt: w.store.attempts.require(w.attempt_key).state,
  task: w.store.tasks.require(TASK_KEY).platform_state,
});

// --- endpoints -------------------------------------------------------------------------------

test("VEC-1 / RUNNING endpoint: a run in progress changes nothing", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    const before = world.store.decisions.read().length;

    assert.deepEqual(complete(w), { kind: "RUNNING", attempt_key: w.attempt_key });
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" });
    assert.equal(world.store.verificationEvidence.count(), 0);
    assert.equal(world.store.decisions.read().length, before, "no transition");

    // VEC-1 — a retry is equally inert.
    assert.equal(complete(w).kind, "RUNNING");
    assert.equal(world.store.verificationEvidence.count(), 0);
  });
});

test("COMPLETED + gate PASS endpoint: evidence is durable and the attempt stays VERIFYING", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK }]);

    const result = complete(w);
    assert.equal(result.kind, "GATE_PASSED");
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" }, "no transition on success");

    const stored = rows(world.store, w.attempt_key);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.binding_valid, true);
    assert.equal(stored[0]?.check_id, REQUIRED_CHECK);

    // §25/§26 — no Auditor work of any kind.
    assert.equal(
      world.store.idempotency.keysWithPrefix(`op:${w.attempt_key}:audit-spawn`).length,
      0,
      "audit-spawn INTENT count is 0",
    );
    assert.equal(world.store.adapterMetadata.get(w.attempt_key, "runtime", "auditor_session"), undefined);
  });
});

test("§22: a satisfied gate writes no durable marker of its own", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK }]);
    const beforeOps = world.store.idempotency.count();
    const beforeMetadata = world.store.adapterMetadata.count();

    assert.equal(complete(w).kind, "GATE_PASSED");

    assert.equal(world.store.idempotency.count(), beforeOps, "no verification-pass operation");
    assert.equal(world.store.adapterMetadata.count(), beforeMetadata, "no passed projection");
    for (const row of world.store.adapterMetadata.forEntity(w.attempt_key)) {
      assert.equal(/pass|gate|verified/i.test(row.key), false, `${row.key} looks like a gate marker`);
    }
    // VEC-6 — eligibility is recomputable from the durable evidence alone.
    assert.equal(rows(world.store, w.attempt_key)[0]?.binding_valid, true);
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" });
  });
});

test("COMPLETED + gate FAIL endpoint: evidence persists and the attempt reworks", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK, result: "FAIL" }]);

    const result = complete(w);
    assert.equal(result.kind, "GATE_FAILED");
    assert.deepEqual(
      result.kind === "GATE_FAILED" ? result.unsatisfied : {},
      { [REQUIRED_CHECK]: "NOT_PASS" },
    );
    assert.deepEqual(state(w), { attempt: "REWORKING", task: "ACTIVE" });
    assert.equal(rows(world.store, w.attempt_key).length, 1, "the failing evidence is kept");
  });
});

test("VEC-5: an exhausted rework budget holds the task instead of reworking", () => {
  withWorld(
    (world) => {
      const w = verifyingWorld(world);
      scriptCompleted(w, [{ check_id: REQUIRED_CHECK, result: "FAIL" }]);

      assert.equal(complete(w).kind, "GATE_FAILED");
      assert.equal(w.store.attempts.require(w.attempt_key).state, "VERIFYING");
      const task = world.store.tasks.require(TASK_KEY);
      assert.equal(task.platform_state, "HELD");
      assert.equal(task.state_reason?.code, "REWORK_LIMIT");

      // A retry cannot apply a second, inconsistent transition: the task is no longer ACTIVE.
      assert.throws(() => complete(w), /not ACTIVE/);
    },
    { batch_policy: { max_tasks: 3, max_rework: 0, concurrency: 2 } },
  );
});

test("FAILED endpoint: a failed run takes the existing infrastructure path", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    w.verification.observation = { state: "FAILED" };

    const result = complete(w);
    assert.equal(result.kind, "VERIFICATION_INFRA");
    assert.equal(w.store.attempts.require(w.attempt_key).state, "VERIFYING", "the attempt stays put");
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "VERIFICATION_INFRA");
    // §5 — no evidence is invented to represent a run-level failure.
    assert.equal(world.store.verificationEvidence.count(), 0);
  });
});

// --- BG: binding ------------------------------------------------------------------------------

test("BG-1: the exact candidate and contract bind", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK }]);
    assert.equal(complete(w).kind, "GATE_PASSED");
    assert.equal(rows(world.store, w.attempt_key)[0]?.binding_valid, true);
  });
});

test("BG-2 / BG-3 / BG-4 / BG-6: unbound evidence is stored and satisfies nothing", () => {
  const cases = [
    ["BG-2", { target_commit: "0".repeat(40) }],
    ["BG-3", { task_contract_hash: `sha256:${"b".repeat(64)}` }],
    ["BG-4", { target_commit: "0".repeat(40), task_contract_hash: `sha256:${"b".repeat(64)}` }],
  ] as const;

  for (const [label, broken] of cases) {
    withWorld((world) => {
      const w = verifyingWorld(world);
      scriptCompleted(w, [{ check_id: REQUIRED_CHECK, ...broken }]);

      const result = complete(w);
      assert.equal(result.kind, "GATE_FAILED", label);
      assert.deepEqual(
        result.kind === "GATE_FAILED" ? result.unsatisfied : {},
        { [REQUIRED_CHECK]: "BINDING_INVALID" },
        "BG-6",
      );
      // §19 — the backend's evidence is not discarded or edited to make it fit.
      const stored = rows(world.store, w.attempt_key);
      assert.equal(stored.length, 1, label);
      assert.equal(stored[0]?.binding_valid, false);
    });
  }
});

test("BG-2: a repository that no longer shows the candidate leaves everything unbound", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    // The attempt's candidate is authoritative; a workspace that moved cannot be silently adopted.
    w.repository.candidate = "1".repeat(40);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK }]);

    assert.equal(complete(w).kind, "GATE_FAILED");
    assert.equal(rows(world.store, w.attempt_key)[0]?.binding_valid, false);
    assert.equal(
      world.store.attempts.require(w.attempt_key).candidate_commit,
      CANDIDATE_COMMIT,
      "the attempt was not rebound",
    );
  });
});

test("BG-5: a verifier cannot supply binding authority", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    // Even if a backend puts something binding-shaped in the item, the envelope has no such field
    // and the stored verdict is the Coordinator's own.
    scriptCompleted(w, [
      { check_id: REQUIRED_CHECK, target_commit: "0".repeat(40) } as never,
    ]);
    assert.equal(complete(w).kind, "GATE_FAILED");
    assert.equal(rows(world.store, w.attempt_key)[0]?.binding_valid, false);

    const envelope = world.store.verificationEvidence.envelope(
      rows(world.store, w.attempt_key)[0]?.evidence_id as string,
    );
    assert.equal("binding_valid" in (envelope as object), false, "not part of the evidence body");
  });
});

// --- VP: policy -------------------------------------------------------------------------------

test("VP-1: a bound PASS with an accepted assurance satisfies the gate", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK, assurance_level: "REEXECUTED" }]);
    assert.equal(complete(w).kind, "GATE_PASSED");
  });
});

test("VP-2 / VP-8 / VP-9: assurance is set membership, with no ranking", () => {
  for (const assurance_level of ["WORKER_REPORTED", "INFERRED", "LOG_VERIFIED", "ARTIFACT_VERIFIED"] as const) {
    withWorld((world) => {
      const w = verifyingWorld(world);
      scriptCompleted(w, [{ check_id: REQUIRED_CHECK, assurance_level }]);
      const result = complete(w);
      assert.equal(result.kind, "GATE_FAILED", assurance_level);
      assert.deepEqual(
        result.kind === "GATE_FAILED" ? result.unsatisfied : {},
        { [REQUIRED_CHECK]: "ASSURANCE_NOT_ACCEPTED" },
      );
    });
  }

  // VP-8 — the same level satisfies when the frozen policy actually lists it.
  withWorld(
    (world) => {
      const w = verifyingWorld(world);
      scriptCompleted(w, [{ check_id: REQUIRED_CHECK, assurance_level: "WORKER_REPORTED" }]);
      assert.equal(complete(w).kind, "GATE_PASSED");
    },
    {
      verification_policy: {
        required_verification: {
          [REQUIRED_CHECK]: { accepted_assurance: ["WORKER_REPORTED", "REEXECUTED"] },
        },
      },
    },
  );
});

test("VP-3 / VP-4: a failing or erroring required check never satisfies the gate", () => {
  for (const result of ["FAIL", "ERROR"] as const) {
    withWorld((world) => {
      const w = verifyingWorld(world);
      scriptCompleted(w, [{ check_id: REQUIRED_CHECK, result }]);
      const outcome = complete(w);
      assert.equal(outcome.kind, "GATE_FAILED", result);
      assert.deepEqual(
        outcome.kind === "GATE_FAILED" ? outcome.unsatisfied : {},
        { [REQUIRED_CHECK]: "NOT_PASS" },
      );
      assert.equal(rows(world.store, w.attempt_key).length, 1, "kept for history");
    });
  }
});

test("VP-5: a required check with no evidence is missing, and nothing is synthesized", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: "some-other-check" }]);

    const result = complete(w);
    assert.deepEqual(
      result.kind === "GATE_FAILED" ? result.unsatisfied : {},
      { [REQUIRED_CHECK]: "MISSING" },
    );
    // The unrelated evidence is still stored; nothing was invented for the required check.
    const stored = rows(world.store, w.attempt_key);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.check_id, "some-other-check");
  });
});

test("VP-6 / VP-7: every required check must satisfy, not just one", () => {
  const policy = {
    verification_policy: {
      required_verification: {
        unit: { accepted_assurance: ["REEXECUTED"] },
        lint: { accepted_assurance: ["REEXECUTED"] },
      },
    },
  };

  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: "unit" }, { check_id: "lint" }]);
    assert.equal(complete(w).kind, "GATE_PASSED", "VP-6");
    assert.equal(rows(world.store, w.attempt_key).length, 2);
  }, policy);

  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: "unit" }, { check_id: "lint", result: "FAIL" }]);
    const result = complete(w);
    assert.deepEqual(
      result.kind === "GATE_FAILED" ? result.unsatisfied : {},
      { lint: "NOT_PASS" },
      "VP-7",
    );
  }, policy);
});

test("§14: two items claiming one required check are ambiguous, not resolved", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [
      { check_id: REQUIRED_CHECK, evidence_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA1" },
      { check_id: REQUIRED_CHECK, evidence_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA2", result: "FAIL" },
    ]);

    const result = complete(w);
    assert.deepEqual(
      result.kind === "GATE_FAILED" ? result.unsatisfied : {},
      { [REQUIRED_CHECK]: "AMBIGUOUS" },
      "neither first nor last wins",
    );
    assert.equal(rows(world.store, w.attempt_key).length, 2, "both are kept");
  });
});

test("VP-10: a later Registry policy change cannot alter this attempt's evaluation", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK, assurance_level: "WORKER_REPORTED" }]);

    // The batch is bound to its own compiled snapshot; nothing consults a live registry, so a
    // weaker policy published now is invisible here.
    assert.equal(complete(w).kind, "GATE_FAILED");
    const compiled = world.store.batchView.compiledProfileFor(
      world.store.tasks.require(TASK_KEY).batch_id,
    );
    assert.deepEqual(
      compiled.effective.policy.verification_policy.required_verification[REQUIRED_CHECK]
        ?.accepted_assurance,
      ["REEXECUTED"],
    );
  });
});

// --- VEC: crash and retry ------------------------------------------------------------------------

test("VEC-2 / VEC-3: re-polling a terminal run persists exactly one logical evidence set", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK }]);

    assert.equal(complete(w).kind, "GATE_PASSED");
    assert.equal(rows(world.store, w.attempt_key).length, 1);

    // The same deterministic evidence comes back; the immutable store replays it.
    assert.equal(complete(w).kind, "GATE_PASSED");
    assert.equal(rows(world.store, w.attempt_key).length, 1, "duplicate rows 0");
    assert.equal(world.store.verificationEvidence.count(), 1);
  });
});

test("VEC-4 / §13: a conflicting body fails closed and persists nothing from that observation", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK }]);
    assert.equal(complete(w).kind, "GATE_PASSED");

    // Same identity, different immutable content.
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK, result: "FAIL" }]);
    assert.throws(() => complete(w));

    const stored = rows(world.store, w.attempt_key);
    assert.equal(stored.length, 1, "the original row is untouched");
    assert.equal(stored[0]?.result, "PASS");
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" }, "no transition either");
  });
});

test("§13: a malformed item in the set leaves nothing partially persisted", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [
      { check_id: "unit" },
      { check_id: "lint", evidence_id: "not-a-ulid" },
    ]);

    assert.throws(() => complete(w));
    assert.equal(world.store.verificationEvidence.count(), 0, "the whole set rolled back");
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" });
  });
});

// --- preconditions -------------------------------------------------------------------------------

test("§2: an attempt that is not VERIFYING, or has no run, fails closed", () => {
  withWorld((world) => {
    const w = verifyingWorld(world);
    scriptCompleted(w, [{ check_id: REQUIRED_CHECK, result: "FAIL" }]);
    assert.equal(complete(w).kind, "GATE_FAILED");
    // Now REWORKING.
    assert.throws(() => complete(w), /requires VERIFYING, not REWORKING/);
  });
});
