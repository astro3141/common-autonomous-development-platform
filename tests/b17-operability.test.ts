/**
 * v1.5 operability contracts (TD §5.11–§5.14, §7.1d, §13.2a, §24.1; D20/D21).
 *
 * Read-only derivations with per-field honesty, an evidence-bound Finding chain, and a
 * regression for the sealed-source defect the operability work uncovered: the current-turn
 * observation in `IMPLEMENTING → VERIFYING`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnosticPacket,
  listFindings,
  measurementPacket,
  recordFinding,
  buildRoutingRecommendations,
  unsupersededFindingFor,
  FindingError,
} from "../core/operability/index.ts";
import { compileProfile } from "../core/profile/compiler.ts";
import { AUDITOR_VERDICT_PROTOCOL } from "./support/execution-fixtures.ts";
import { BATCH_ID, PROJECT, RUN_ID, TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  auditorVerdict,
  auditorTurnResult,
  evidenceItem,
  REQUIRED_CHECK,
} from "./support/execution-fixtures.ts";
import { validProjectProfile, validExecutionPolicy, noOverrides } from "./support/profile-fixtures.ts";
import {
  actorProduced,
  coordinatorWorld,
  submitSupervisorProposal,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";

const CANDIDATE = "9a8b7c6d5e4f30211203344556677889900aabbc";
const SINGLE = { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } };

function driveToAuditing(world: Parameters<Parameters<typeof withWorld>[0]>[0]): CoordinatorWorld {
  const w = coordinatorWorld(world);
  assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
  submitSupervisorProposal(w, world);
  assert.equal(w.tick(), "ACTIVATED");
  assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
  actorProduced(w, CANDIDATE, 1);
  assert.equal(w.tick(), "VERIFICATION_STARTED");
  const attempt = w.store.attempts.current(TASK_KEY)!;
  const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
  w.verification.completeWith([
    evidenceItem({ check_id: REQUIRED_CHECK, target_commit: CANDIDATE, task_contract_hash: hash }),
  ]);
  assert.equal(w.tick(), "AUDIT_STARTED");
  return w;
}

// --- §7.1d ProjectProfileV2 ----------------------------------------------------------------------

test("OP-1: a v2 Project Profile freezes the Supervisor binding; a bad reference refuses to compile", () => {
  const v2 = { ...validProjectProfile(), supervisor_profile: "implementation" };
  const compiled = compileProfile({
    projectProfile: v2,
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: noOverrides(),
  });
  assert.equal(compiled.body.compiled_version, 2);
  assert.equal(compiled.envelope.schema_version, 2);
  assert.equal(
    (compiled.body.effective.project as { supervisor_profile?: string }).supervisor_profile,
    "implementation",
  );

  // The same document under v1 hashing would be a different artifact: version is bound in.
  const v1 = compileProfile({
    projectProfile: validProjectProfile(),
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: noOverrides(),
  });
  assert.notEqual(compiled.compiled_hash, v1.compiled_hash);
  assert.equal(v1.body.compiled_version, 1);

  assert.throws(() =>
    compileProfile({
      projectProfile: { ...validProjectProfile(), supervisor_profile: "no-such-role" },
      executionPolicy: validExecutionPolicy(),
      approvedOverrides: noOverrides(),
    }),
  );
});

// --- §5.11 diagnostics ---------------------------------------------------------------------------

test("OP-2: the diagnostic packet carries provenance per field and survives a dead authority", () => {
  withWorld((world) => {
    const w = driveToAuditing(world);
    const attempt = w.store.attempts.current(TASK_KEY)!;

    const packet = diagnosticPacket({ store: w.store }, attempt.attempt_key);
    assert.equal(packet.state.availability, "AVAILABLE");
    if (packet.state.availability === "AVAILABLE") {
      assert.equal((packet.state.value as { state: string }).state, "AUDITING");
      assert.equal(packet.state.freshness, "durable_projection");
    }
    assert.equal(packet.next_owner.availability, "AVAILABLE");
    if (packet.next_owner.availability === "AVAILABLE") {
      assert.equal(packet.next_owner.value.owner, "COORDINATOR");
    }
    assert.equal(packet.evidence.availability, "AVAILABLE");
    // No repository authority was supplied: the field is UNAVAILABLE, the packet is not (§5.11).
    assert.equal(packet.repository.availability, "UNAVAILABLE");
  }, SINGLE);
});

test("OP-3: I-TD8 — a blocked task names HUMAN and the exact decision as its next owner", () => {
  withWorld((world) => {
    const w = driveToAuditing(world);
    const attempt = w.store.attempts.current(TASK_KEY)!;
    const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
    const review = {
      candidate_commit: CANDIDATE,
      task_contract_hash: hash,
      evidence_ids: w.store.verificationEvidence
        .forAttempt(attempt.attempt_key)
        .filter((row) => row.target_commit === CANDIDATE)
        .map((row) => row.evidence_id),
    };
    const handle = w.store.adapterMetadata
      .forEntity(attempt.attempt_key)
      .find((row) => row.key.startsWith("auditor_turn-1:") && row.key.endsWith(CANDIDATE));
    w.runtime.turnResults.set(
      JSON.stringify(handle?.value),
      auditorTurnResult({ body: auditorVerdict(review), protocol: AUDITOR_VERDICT_PROTOCOL }),
    );
    w.verification.settlement = { kind: "SETTLED" };
    assert.equal(w.tick(), "AUDIT_COMPLETED");
    assert.equal(w.tick(), "MERGE_APPROVAL_OPENED");

    const packet = diagnosticPacket({ store: w.store }, TASK_KEY);
    assert.equal(packet.next_owner.availability, "AVAILABLE");
    if (packet.next_owner.availability === "AVAILABLE") {
      assert.equal(packet.next_owner.value.owner, "HUMAN");
      const open = w.store.pendingDecisions.openFor(TASK_KEY)[0]!.body.decision_id;
      assert.match(packet.next_owner.value.detail, new RegExp(open));
    }
  }, SINGLE);
});

// --- §5.12 measurement ---------------------------------------------------------------------------

test("OP-4: measurement attributes to the frozen contract and answers UNKNOWN honestly", () => {
  withWorld((world) => {
    const w = driveToAuditing(world);
    const attempt = w.store.attempts.current(TASK_KEY)!;
    const packet = measurementPacket(w.store, attempt.attempt_key);

    assert.equal(packet.task_contract_hash.kind, "REPORTED");
    assert.equal(packet.role_bindings.kind, "REPORTED");
    if (packet.role_bindings.kind === "REPORTED") {
      assert.equal(packet.role_bindings.value.actor_profile, "implementation");
      assert.equal(packet.role_bindings.value.pipeline_id, "standard");
    }
    // The fixture backend reports no provider/model/usage/cost — UNKNOWN, never inferred.
    assert.equal(packet.actual_provider.kind, "UNKNOWN");
    assert.equal(packet.actual_model.kind, "UNKNOWN");
    assert.equal(packet.usage.kind, "UNKNOWN");
    assert.equal(packet.cost.kind, "UNKNOWN");
    // The fixture clock does not parse as instants: durations are UNKNOWN, not fabricated.
    assert.equal(packet.stage_durations_ms.kind, "UNKNOWN");
    assert.equal(packet.rework_count, 0);
    assert.equal(packet.human_handoffs, 0);
  }, SINGLE);
});

// --- §5.13 findings ------------------------------------------------------------------------------

test("OP-5: a Finding binds to resolvable evidence, replays idempotently and supersedes explicitly", () => {
  withWorld((world) => {
    const w = driveToAuditing(world);
    const attempt = w.store.attempts.current(TASK_KEY)!;
    const evidence = w.store.verificationEvidence.forAttempt(attempt.attempt_key)[0]!;

    const finding = {
      finding_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0FD1",
      subject_ref: attempt.attempt_key,
      classification: "BUG" as const,
      summary: "the collector drops the last line",
      evidence_refs: [`evidence:${evidence.evidence_id}`, attempt.attempt_key.replace(/^/, "")],
      observation_refs: [],
      discovered_at: "2026-08-21T10:00:00Z",
      classifier: "HUMAN" as const,
      classifier_ref: "operator@example",
      escaped_from: null,
      supersedes_finding_ref: null,
    };
    // One unresolvable ref refuses the whole record, fail-closed.
    assert.throws(
      () =>
        recordFinding(w.store, { ...finding, evidence_refs: ["evidence:no-such-evidence"] }),
      FindingError,
    );

    const valid = { ...finding, evidence_refs: [`evidence:${evidence.evidence_id}`] };
    const first = recordFinding(w.store, valid);
    assert.equal(first.replayed, false);
    const replay = recordFinding(w.store, valid);
    assert.equal(replay.replayed, true);
    assert.equal(replay.finding_hash, first.finding_hash);

    // A different body under the same id is a conflict — corrections are new records.
    assert.throws(
      () => recordFinding(w.store, { ...valid, summary: "different" }),
      FindingError,
    );

    const successor = recordFinding(w.store, {
      ...valid,
      finding_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0FD2",
      summary: "the collector drops the last line (narrowed)",
      supersedes_finding_ref: valid.finding_id,
    });
    assert.equal(successor.replayed, false);

    assert.equal(listFindings(w.store).length, 2);
    const current = unsupersededFindingFor(w.store, attempt.attempt_key, "BUG");
    assert.equal(current?.body.finding_id, "01JQ8ZK5T7RC9V2W4X6Y8Z0FD2");

    // Recording changed no lifecycle state whatsoever.
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "AUDITING");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
  }, SINGLE);
});

// --- §5.14 routing recommendation ----------------------------------------------------------------

test("OP-6: routing recommendations are read-only evidence with honest UNKNOWNs", () => {
  withWorld((world) => {
    const w = driveToAuditing(world);
    const before = w.store.decisions.count();
    const recommendations = buildRoutingRecommendations(w.store, {
      run_id: RUN_ID,
      generated_at: "2026-08-21T11:00:00Z",
    });
    // The only attempt is non-terminal — no comparable sample, and nothing invented.
    assert.equal(recommendations.length, 0);
    assert.equal(w.store.decisions.count(), before, "nothing was written");
    void BATCH_ID;
    void PROJECT;
  }, SINGLE);
});

// --- the regression the operability work uncovered ------------------------------------------------

test("OP-7 (regression): after a rework, IMPLEMENTING→VERIFYING waits for the *current* turn", () => {
  withWorld((world) => {
    const w = driveToAuditing(world);
    const attempt = w.store.attempts.current(TASK_KEY)!;
    const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;

    // The Auditor demands a fix: the attempt reworks, and actor-turn:2 begins.
    const review = {
      candidate_commit: CANDIDATE,
      task_contract_hash: hash,
      evidence_ids: w.store.verificationEvidence
        .forAttempt(attempt.attempt_key)
        .filter((row) => row.target_commit === CANDIDATE)
        .map((row) => row.evidence_id),
    };
    const handle = w.store.adapterMetadata
      .forEntity(attempt.attempt_key)
      .find((row) => row.key.startsWith("auditor_turn-1:") && row.key.endsWith(CANDIDATE));
    w.runtime.turnResults.set(
      JSON.stringify(handle?.value),
      auditorTurnResult({
        body: auditorVerdict(review, { verdict: "FIX_REQUIRED" }),
        protocol: AUDITOR_VERDICT_PROTOCOL,
      }),
    );
    w.verification.settlement = { kind: "SETTLED" };
    assert.equal(w.tick(), "AUDIT_COMPLETED");
    assert.equal(w.tick(), "REWORK_STARTED");
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "IMPLEMENTING");

    // Turn 1 is long terminal; turn 2 is still running. Before the fix, the stale turn-1 result
    // drove the transition. Now the tick must refuse to advance — the unobservable current turn
    // fails the tick without touching durable state.
    assert.throws(() => w.tick(), /no scripted turn result/);
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "IMPLEMENTING");
    assert.equal(w.store.attempts.current(TASK_KEY)?.candidate_commit, CANDIDATE, "unchanged");

    // Turn 2 completes; the transition proceeds on the current turn's own terminal fact.
    actorProduced(w, "1122334455667788990011223344556677889900", 2);
    assert.equal(w.tick(), "VERIFICATION_STARTED");
  }, SINGLE);
});

test("OP-8: the improvement loop projects a Finding through the outbox and re-enters only via admission", async () => {
  const { projectFindingToOutbox } = await import("../core/operability/index.ts");
  const { deliverOneReport } = await import("../core/coordinator/report-delivery.ts");
  const { FakeReportAdapter } = await import("../testdoubles/fake-report-adapter.ts");
  await withWorld(async (world) => {
    const w = driveToAuditing(world);
    const attempt = w.store.attempts.current(TASK_KEY)!;
    const evidence = w.store.verificationEvidence.forAttempt(attempt.attempt_key)[0]!;

    const recorded = recordFinding(w.store, {
      finding_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0FD9",
      subject_ref: attempt.attempt_key,
      classification: "IMPLEMENTATION_GAP",
      summary: "the check misses the boundary case",
      evidence_refs: [`evidence:${evidence.evidence_id}`],
      observation_refs: [],
      discovered_at: "2026-08-21T12:00:00Z",
      classifier: "AUDITOR",
      classifier_ref: "auditor-session",
      escaped_from: null,
      supersedes_finding_ref: null,
    });

    // Projection is the Report Outbox, idempotent by op_key; the route is configuration.
    const projected = projectFindingToOutbox(w.store, recorded.finding_id, "issues");
    assert.equal(projected.enqueued, true);
    assert.deepEqual(projectFindingToOutbox(w.store, recorded.finding_id, "issues"), {
      op_key: projected.op_key,
      enqueued: false,
    });

    const report = new FakeReportAdapter();
    report.results.push({ delivered: true });
    // Drain until the finding notification goes out (other rows may precede it).
    for (let i = 0; i < 10; i += 1) {
      report.results.push({ delivered: true });
      const outcome = deliverOneReport({ store: w.store, report, now: () => "t" });
      if (outcome.kind === "NOTHING_PENDING") break;
    }
    assert.equal(
      report.calls.some((call) =>
        JSON.stringify(call.args).includes(recorded.finding_id),
      ),
      true,
      "the projection was delivered as one idempotent notification",
    );

    // The projection changed no lifecycle state: re-execution needs the ordinary admission path.
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "AUDITING");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
  }, SINGLE);
});
