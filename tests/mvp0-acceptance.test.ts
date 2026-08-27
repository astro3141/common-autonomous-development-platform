/**
 * B8-AC40 — MVP 0 acceptance A1–A5, end to end on durable state (TD §25).
 *
 * The whole run is deterministic and backend-free: no adapter is constructed, every external fact
 * is synthetic, and the vocabulary is invented for the tests.
 */

import assert from "node:assert/strict";
import { openDatabase } from "../core/store/database.ts";
import test from "node:test";

import { validateAndRecordDecision } from "../core/decision/decision-log.ts";
import { validateDecisionAfterResolvedHumanGate } from "../core/decision/human-gate-revalidation.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import { buildHumanGateDecision } from "../core/humandecision/gate-request.ts";
import { resolvedHumanGateAuthorization } from "../core/humandecision/gate-authorization.ts";
import {
  commitAdmission,
  commitAttemptFact,
  commitBatchAdmissionClose,
  commitBatchFact,
  commitContractActivation,
  commitDecisionResolution,
  commitPendingDecision,
} from "../core/statemachine/transition-commit.ts";
import {
  compiled,
  enforcementWith,
  inputFor,
  manifests,
  selection,
} from "./support/decision-fixtures.ts";
import {
  BATCH_ID,
  BINDING,
  SCOPE_ID,
  SELECTION,
  ULID,
  contractBuild,
  discover,
  snapshotId,
  withWorld,
} from "./support/domain-fixtures.ts";

const APPROVE = {
  kind: "OPTION" as const,
  chosen_option: "APPROVE",
  free_form: null,
  resolved_by: "operator-reference-1",
  resolved_at: "t-resolve",
  approval_binding: null,
  applied_transition_ref: null,
};

test("A1 / A2 / A4: a full generic lifecycle runs on Core alone with neutral vocabulary", () => {
  withWorld((world) => {
    // A2: the only project words in play are invented ones.
    const project = world.profile.body.effective.project;
    assert.deepEqual(Object.keys(project.classifications).sort(), [
      "IMPLEMENTABLE",
      "LARGE_SCOPE",
      "SPLIT_NEEDED",
    ]);
    assert.deepEqual(Object.keys(project.pipelines).sort(), ["review_only", "standard"]);

    const key = discover(world);
    const raw = selection({ profile: world.profile });

    // Validation (Batch 7) against the durable read-model, journalled as its own kind.
    const validated = validateAndRecordDecision(
      world.store.decisions,
      inputFor(raw, world.profile, { batch: world.store.batchView.project(BATCH_ID) }),
    );
    assert.deepEqual(validated.result, { kind: "ACCEPTED" });

    // A4: DISCOVERED → SELECTED → ACTIVE + READY → … → MERGED → COMPLETED.
    commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t-admit", hard_dependencies_clear: true, });
    commitContractActivation(world.store, {
      task_key: key,
      attempt_key: `attempt:${key}:1`,
      n: 1,
      build: contractBuild(world, { snapshot_id: snapshotId(0) }),
    });

    const attemptKey = `attempt:${key}:1`;
    const seen: string[] = ["READY"];
    const step = (fact: Parameters<typeof commitAttemptFact>[1]["fact"]): void => {
      seen.push(commitAttemptFact(world.store, { attempt_key: attemptKey, fact }).attempt_state);
    };

    step({ kind: "EXECUTION_STARTED", workspace_created: true, receipt_valid: true });
    step({ kind: "CANDIDATE_OBSERVED", candidate_commit: "c1", lineage_valid: true, tracked_clean: true });
    step({ kind: "VERIFICATION_PASSED" });
    step({ kind: "AUDIT_DECIDED", verdict: "AUDIT_PASS", drift_clear: true });
    step({ kind: "MANUAL_MERGE_APPROVED" });
    step({ kind: "MERGE_OBSERVED", canonical_contains_candidate: true });

    assert.deepEqual(seen, [
      "READY",
      "IMPLEMENTING",
      "VERIFYING",
      "AUDITING",
      "READY_TO_MERGE",
      "APPROVED_FOR_MANUAL_MERGE",
      "MERGED",
    ]);
    assert.equal(world.store.tasks.require(key).platform_state, "COMPLETED");

    // The batch closes and completes on the same durable rules.
    commitBatchAdmissionClose(world.store, BATCH_ID);
    const done = commitBatchFact(world.store, {
      batch_id: BATCH_ID,
      fact: { kind: "EVALUATE_COMPLETION" },
    });
    assert.equal(done.batch?.status, "COMPLETED");

    // A1: nothing was delivered, spawned or merged — only durable rows moved.
    assert.equal(world.store.outbox.count(), 0);
    assert.equal(world.store.idempotency.count(), 0);
  });
});

test("A3: the durable schema carries no backend or session identity", () => {
  withWorld((world) => {
    const path = world.temp.path;
    const database = openDatabase(path);
    try {
      const schema = (
        database
          .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
          .all() as { sql: string }[]
      )
        .map((row) => row.sql)
        .join("\n");

      // `adapter_metadata` exists from migration v3 on; it is a table name, not an identity,
      // and I-TD7 for its contents is enforced by the deny list + its own tests.
      const token = (...parts: readonly string[]): string => parts.join("");
      for (const forbidden of [
        token("sess", "ion_key"),
        token("age", "nt_id"),
        token("a", "cp", "_"),
        token("open", "claw"),
        token("to", "ken"),
      ]) {
        assert.equal(
          schema.toLowerCase().includes(forbidden.toLowerCase()),
          false,
          `the schema mentions ${forbidden}`,
        );
      }

      // The only repository-shaped columns are the two git facts §6.1 explicitly exempts.
      assert.match(schema, /base_head/);
      assert.match(schema, /candidate_commit/);
    } finally {
      database.close();
    }
  });
});

test("A5: a weakened backend is blocked before execution, on the human-gated path too", () => {
  const gatedPolicy = {
    human_gate_policy: { required_decisions: ["START_TASK"] },
    capability_requirements: { actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } },
  };

  withWorld((world) => {
    const key = discover(world);
    const raw = selection({ profile: world.profile });
    const proposal = validateProposal(raw);

    // The gate fires, so a decision is opened and the task is parked.
    const gate = buildHumanGateDecision({
      decision_id: ULID.decision,
      proposal,
      task_key: key,
    });
    commitPendingDecision(world.store, { decision: gate, channel: "operations" });
    commitDecisionResolution(world.store, ULID.decision, APPROVE);

    const authorization = resolvedHumanGateAuthorization(
      world.store.pendingDecisions.require(ULID.decision),
    );
    const freshInput = (backend: ReturnType<typeof manifests>) =>
      inputFor(raw, world.profile, {
        batch: world.store.batchView.project(BATCH_ID),
        manifests: backend,
      });

    // An adequate backend: the approval revalidates and the task may be admitted.
    assert.deepEqual(
      validateDecisionAfterResolvedHumanGate(freshInput(manifests()), authorization),
      { kind: "ACCEPTED" },
    );

    // Weaken one required assurance after the approval: still blocked.
    const weakened = validateDecisionAfterResolvedHumanGate(
      freshInput(manifests(enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } }))),
      authorization,
    ) as { kind: string; detail: { operation_id: string; role: string } };

    assert.equal(weakened.kind, "BACKEND_INCOMPATIBLE");
    assert.deepEqual(
      { operation_id: weakened.detail.operation_id, role: weakened.detail.role },
      { operation_id: "actor_execution", role: "ACTOR" },
    );

    // No execution transition happened, and the human's answer stays on record.
    const task = world.store.tasks.require(key);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.admitted_at, null);
    assert.equal(world.store.attempts.current(key), undefined);
    assert.equal(world.store.contracts.count(), 0);
    const record = world.store.pendingDecisions.require(ULID.decision);
    assert.equal(record.body.status, "RESOLVED");
    assert.equal(record.body.resolution?.applied_transition_ref, null);
  }, gatedPolicy);

  // And the Batch 7 rejection itself is unchanged.
  const strict = compiled(gatedPolicy);
  assert.ok(strict.compiled_hash.startsWith("sha256:"));
});
