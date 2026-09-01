/**
 * M1-13b — the Auditor prerequisites: per-cycle review binding, multi-cycle operation identity,
 * the audit failure vocabulary, the `AUDIT_DECISION` category, and audit settlement behind the
 * VerificationAdapter.
 *
 * BC (the B10 binding correction), C1–C20 (the close-out). No Auditor verdict is collected here
 * and no audit lifecycle runs: this pass fixes contracts and proves them, nothing more.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openDatabase } from "../core/store/database.ts";
import {
  auditDecisionOp,
  auditorTurn1Op,
  auditorTurn2Op,
  auditorTurnMetadataKey,
  auditSpawnOp,
} from "../core/execution/audit-operations.ts";
import { startAuditing } from "../core/execution/start-auditing.ts";
import {
  auditDecisionCause,
  auditDecisionRemainsValid,
  buildAuditDecision,
  AUDIT_DECISION_OPTIONS,
} from "../core/humandecision/audit-decision.ts";
import { PENDING_DECISION_CATEGORIES } from "../core/humandecision/types.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import { TRANSITION_REASON_CODES, isReasonCode } from "../core/statemachine/types.ts";
import { commitPendingDecision } from "../core/statemachine/transition-commit.ts";
import { opKey } from "../core/schemas/identifiers.ts";
import type { VerificationRunHandle } from "../adapters/interfaces/handles.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  auditingWorld,
  CANDIDATE_COMMIT,
  DRIFT_CHANNEL,
  DRIFT_DECISION_ID,
  localVerification,
  PROFILE_DOCUMENTS,
  type LocalVerificationWorld,
} from "./support/execution-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ATTEMPT = "attempt:task:alpha:T-101:1";
const OTHER_CANDIDATE = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736";
const AUDIT_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0E01";

const stripped = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const start = (w: ReturnType<typeof auditingWorld>) =>
  startAuditing(w, {
    attempt_key: w.attempt_key,
    decision_id: DRIFT_DECISION_ID,
    report_channel: DRIFT_CHANNEL,
  });

const instruction = (w: ReturnType<typeof auditingWorld>): string =>
  w.runtime.sendCalls.at(-1)?.instruction ?? "";

// --- BC1 ~ BC5 / C1: the Auditor is told what `reviewed.*` must be ------------------------------

test("BC1 / BC2 / BC3 / C1: the review turn carries candidate, contract hash and ordered evidence", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");

    const attempt = world.store.attempts.require(w.attempt_key);
    const contract_hash = world.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
    const evidence = world.store.verificationEvidence.forAttempt(w.attempt_key);
    assert.ok(evidence.length > 0, "the cycle has evidence to be bound to");

    const text = instruction(w);
    assert.match(text, new RegExp(attempt.candidate_commit as string), "BC1");
    assert.match(text, new RegExp(contract_hash), "BC2");
    // BC3 — in the store's own order, joined verbatim: not sorted, not deduplicated.
    assert.match(text, new RegExp(evidence.map((row) => row.evidence_id).join(", ")), "BC3");
    // And it says which fields those three values are for, so a conforming Auditor can bind.
    assert.match(text, /reviewed\.candidate_commit/);
    assert.match(text, /reviewed\.task_contract_hash/);
    assert.match(text, /reviewed\.evidence_ids/);
  });
});

test("BC4 / BC5 / C2: the three values are Platform-authoritative and ordered exactly", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    // BC5 — the current mutable Profile documents move; the binding values cannot follow them.
    const MOVED = "current-profile-marker-that-must-not-appear";
    w.current.put(PROFILE_DOCUMENTS.project_profile_path, {
      ...world.inputs.project,
      version: 2,
      roles: {
        implementation: { runtime_profile: MOVED, config: {} },
        review: { runtime_profile: MOVED, config: {} },
      },
    });
    assert.equal(start(w).kind, "AUDITING");

    const attempt = world.store.attempts.require(w.attempt_key);
    const text = instruction(w);
    assert.match(text, new RegExp(attempt.candidate_commit as string), "BC4");
    assert.equal(text.includes(MOVED), false, "BC5: no current Profile value reached the Auditor");

    // C2 — the sequence is the store's own `ORDER BY evidence_id`, which is restart-stable, and
    // the instruction repeats it positionally rather than as a set.
    const ids = world.store.verificationEvidence
      .forAttempt(w.attempt_key)
      .map((row) => row.evidence_id);
    assert.deepEqual([...ids].sort(), [...ids], "the store's order is already deterministic");
    assert.match(text, new RegExp(ids.join(", ")));
  });
});

// --- BC6 ~ BC9 / C3 ~ C5: multi-cycle operation identity ---------------------------------------

test("BC7 / BC8 / C3 / C4: every candidate-bound operation is qualified by its candidate", () => {
  assert.equal(auditorTurn1Op(ATTEMPT, CANDIDATE_COMMIT), `op:${ATTEMPT}:auditor-turn-1:${CANDIDATE_COMMIT}`);
  assert.equal(auditorTurn2Op(ATTEMPT, CANDIDATE_COMMIT), `op:${ATTEMPT}:auditor-turn-2:${CANDIDATE_COMMIT}`, "BC7");
  assert.equal(auditDecisionOp(ATTEMPT, CANDIDATE_COMMIT), `op:${ATTEMPT}:audit-decision:${CANDIDATE_COMMIT}`);

  // BC8 / C3 — a later candidate collides with nothing the previous one owns.
  const first = [auditorTurn1Op, auditorTurn2Op, auditDecisionOp].map((build) =>
    build(ATTEMPT, CANDIDATE_COMMIT),
  );
  const later = [auditorTurn1Op, auditorTurn2Op, auditDecisionOp].map((build) =>
    build(ATTEMPT, OTHER_CANDIDATE),
  );
  assert.equal(new Set([...first, ...later]).size, 6);

  // C4 — turn-2 is the only retry a candidate has; there is no constructor for a third.
  const identity = stripped(join(ROOT, "core/execution/audit-operations.ts"));
  assert.equal(/auditor-turn-3/.test(identity), false);
  assert.equal((identity.match(/auditor-turn-\d/g) ?? []).length, 2);

  // The §6.1 grammar accepts each of them: one operation token, one qualifier segment.
  assert.equal(opKey(ATTEMPT, "auditor-turn-1", CANDIDATE_COMMIT), first[0]);
  assert.equal(opKey(ATTEMPT, "audit-decision", OTHER_CANDIDATE), later[2]);
});

test("BC9 / C5: the Auditor session stays one operation for the whole Attempt", () => {
  assert.equal(auditSpawnOp(ATTEMPT), `op:${ATTEMPT}:audit-spawn`);
  // No candidate anywhere in it: a rework changes what is reviewed, not who reviews.
  assert.equal(auditSpawnOp(ATTEMPT).includes(CANDIDATE_COMMIT), false);
  const identity = stripped(join(ROOT, "core/execution/audit-operations.ts"));
  assert.match(identity, /audit-spawn/);
  assert.equal(/audit-spawn:\$\{/.test(identity), false, "the spawn takes no qualifier");
});

test("BC6: a later candidate's cycle reuses the contract but not the candidate binding", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");

    const attempt = world.store.attempts.require(w.attempt_key);
    const contract_hash = world.store.contracts.hashOf(attempt.contract_snapshot_id) as string;

    // The durable turn projection is per candidate, so the next cycle writes beside it, not over.
    assert.notEqual(
      world.store.adapterMetadata.get(
        w.attempt_key,
        "runtime",
        auditorTurnMetadataKey(attempt.candidate_commit as string),
      ),
      undefined,
    );
    assert.equal(
      world.store.adapterMetadata.get(
        w.attempt_key,
        "runtime",
        auditorTurnMetadataKey(OTHER_CANDIDATE),
      ),
      undefined,
    );
    // The immutable contract is the same one either way.
    assert.match(instruction(w), new RegExp(contract_hash));
  });
});

test("BC10: this correction collects no Auditor verdict and settles nothing", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const before = w.runtime.turnResultCalls.length;
    assert.equal(start(w).kind, "AUDITING");

    assert.equal(w.runtime.turnResultCalls.length, before, "get_turn_result was never called");
    assert.equal(world.store.auditRecords.count(), 0);
    assert.equal(
      world.store.idempotency.keysWithPrefix(`op:${w.attempt_key}:audit-decision`).length,
      0,
    );
    assert.equal(
      world.store.idempotency.keysWithPrefix(`op:${w.attempt_key}:auditor-turn-2`).length,
      0,
    );
  });
});

// --- C6 ~ C8: the vocabularies ------------------------------------------------------------------

test("C6 / C7: AUDIT_UNUSABLE and AUDIT_GATE_UNAVAILABLE are accepted reasons", () => {
  for (const code of ["AUDIT_UNUSABLE", "AUDIT_GATE_UNAVAILABLE"]) {
    assert.equal(TRANSITION_REASON_CODES.includes(code as never), true, code);
    assert.equal(isReasonCode(code), true, code);
  }
  // And they stay distinct from the retryable observation they follow.
  assert.equal(TRANSITION_REASON_CODES.includes("AUDIT_INVALID"), true);
  assert.equal(new Set(TRANSITION_REASON_CODES).size, TRANSITION_REASON_CODES.length);
});

test("C8: AUDIT_DECISION is a Core-fixed category", () => {
  assert.equal(PENDING_DECISION_CATEGORIES.includes("AUDIT_DECISION"), true);
  assert.equal(new Set(PENDING_DECISION_CATEGORIES).size, PENDING_DECISION_CATEGORIES.length);
});

// --- C9 / C10: the migration --------------------------------------------------------------------

test("C9 / C10: v5 rows survive the v6 rebuild, and the table count is unchanged", () => {
  const temp = tempStore();
  try {
    // A database that only ever saw v1–v5, with a decision written under the old vocabulary.
    const old = temp.open({ migrations: MIGRATIONS.slice(0, 5) });
    assert.equal(old.schemaVersion, 5);
    const before = (() => {
      const database = openDatabase(temp.path);
      try {
        database
          .prepare(
            `INSERT INTO pending_human_decision
               (decision_id, dedup_key, subject_kind, subject_ref, status, category,
                blocking_scope, envelope_json, record_hash, created_at, updated_at)
             VALUES ('01JQ8ZK5T7RC9V2W4X6Y8Z0E09', 'pd:legacy', 'TASK', 'task:alpha:T-9', 'OPEN',
                     'CONTRACT_DECISION', 'TASK_ONLY', '{"legacy":true}', NULL, 't1', 't1')`,
          )
          .run();
        return database
          .prepare("SELECT * FROM pending_human_decision ORDER BY decision_id")
          .all() as Record<string, unknown>[];
      } finally {
        database.close();
      }
    })();
    old.close();

    const upgraded = temp.open();
    assert.equal(upgraded.schemaVersion, 8);
    upgraded.close();

    const database = openDatabase(temp.path);
    try {
      // C9 — every row, every column, byte for byte.
      const after = database
        .prepare("SELECT * FROM pending_human_decision ORDER BY decision_id")
        .all() as Record<string, unknown>[];
      assert.deepEqual(after, before);

      // C10 — one table rebuilt, none added, none left behind.
      const names = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_"));
      assert.equal(names.length, 17);
      assert.equal(names.includes("pending_human_decision"), true);
      assert.equal(names.includes("pending_human_decision_v6"), false);

      // The widened vocabulary really is in the rebuilt constraint.
      const sql = (
        database
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'pending_human_decision'")
          .get() as { sql: string }
      ).sql;
      assert.match(sql, /AUDIT_DECISION/);
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }
});

// --- C11 / C12: what an AUDIT_DECISION means ----------------------------------------------------

const auditDecision = (overrides: Partial<Parameters<typeof buildAuditDecision>[0]> = {}) =>
  buildAuditDecision({
    decision_id: DRIFT_DECISION_ID,
    task_key: TASK_KEY,
    attempt_key: ATTEMPT,
    candidate_commit: CANDIDATE_COMMIT,
    audit_id: AUDIT_ID,
    ...overrides,
  });

test("C11: an AUDIT_DECISION blocks exactly its task, through the existing §17.2 convention", () => {
  withWorld((world) => {
    // A real ACTIVE task with a real Attempt, so the hold is the ordinary §17.2 one.
    const w = auditingWorld(world);
    const decision = auditDecision({ attempt_key: w.attempt_key });
    assert.equal(decision.category, "AUDIT_DECISION");
    assert.equal(decision.blocking_scope, "TASK_ONLY");
    assert.deepEqual(decision.subject, { kind: "TASK", task_key: TASK_KEY });
    assert.equal(decision.recommendation, null);
    assert.equal(decision.gate_proposal, null);
    assert.deepEqual(decision.evidence_refs, [AUDIT_ID]);
    assert.deepEqual(auditDecisionCause(decision), {
      attempt_key: w.attempt_key,
      candidate_commit: CANDIDATE_COMMIT,
    });

    // It stores and blocks like every other task-scoped decision.
    const opened = commitPendingDecision(world.store, { decision, channel: DRIFT_CHANNEL });
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, `BLOCKED_BY_DECISION:${opened.decision_id}`);
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 1);
  });
});

test("C12: no option turns HUMAN_REQUIRED into a pass", () => {
  assert.deepEqual(AUDIT_DECISION_OPTIONS, ["REQUEST_REWORK", "ABANDON"]);
  const rendered = JSON.stringify(auditDecision()).toUpperCase();
  for (const forbidden of [
    "AUDIT_PASS",
    "ACCEPT_AUDIT_HOLD",
    "FORCE_PASS",
    "CONTINUE_WITHOUT_AUDIT",
    "ACCEPT_AS_PASS",
    "APPROVE",
  ]) {
    assert.equal(rendered.includes(forbidden), false, forbidden);
  }
  // The same holds in the module itself, so no future option can be added by accident.
  const source = stripped(join(ROOT, "core/humandecision/audit-decision.ts"));
  assert.equal(/AUDIT_PASS|FORCE_PASS|ACCEPT_AS_PASS/.test(source), false);
});

test("the AUDIT_DECISION STALE basis is the audit cycle it was opened for", () => {
  const valid = {
    source_attempt_state: "AUDITING",
    current_candidate_commit: CANDIDATE_COMMIT,
    newer_attempt_exists: false,
    task_terminal: false,
  } as const;
  assert.equal(auditDecisionRemainsValid(CANDIDATE_COMMIT, valid), true);

  // A rework produced a new candidate: the question was about the old one.
  assert.equal(
    auditDecisionRemainsValid(CANDIDATE_COMMIT, {
      ...valid,
      current_candidate_commit: OTHER_CANDIDATE,
    }),
    false,
  );
  for (const superseded of [
    { ...valid, newer_attempt_exists: true },
    { ...valid, task_terminal: true },
    { ...valid, source_attempt_state: undefined },
    { ...valid, source_attempt_state: "REWORKING" } as const,
    { ...valid, source_attempt_state: "READY_TO_MERGE" } as const,
  ]) {
    assert.equal(auditDecisionRemainsValid(CANDIDATE_COMMIT, superseded), false);
  }
});

// --- C13 / C14: what Core may see of the settlement path ---------------------------------------

test("C13 / C14: Core never obtains a workflow handle, a controller, or the run's internals", () => {
  const coreFiles = readdirSync(join(ROOT, "core"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(ROOT, "core", entry.name))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "core", entry.name, name)),
    );

  for (const file of coreFiles) {
    const code = stripped(file);
    for (const forbidden of [
      /WorkflowControllerHandle/,
      /acquire_workflow_controller/,
      /audit_decide/,
      /VerificationRunRefV1/,
      /workflow_id/,
      /as unknown as WorkflowHandle/,
    ]) {
      assert.equal(forbidden.test(code), false, `${relative(ROOT, file)} matches ${forbidden}`);
    }
  }

  // The settlement contract itself hands Core nothing but its own opaque handle.
  const contract = stripped(join(ROOT, "adapters/interfaces/verification-adapter.ts"));
  const settle = contract.slice(contract.indexOf("settle_audit("));
  const signature = settle.slice(0, settle.indexOf("): AuditSettlementResult"));
  assert.match(signature, /run_handle: VerificationRunHandle/);
  assert.equal(/WorkflowHandle|WorkflowControllerHandle/.test(signature), false);
});

// --- C15 ~ C19: the Backend v1 settlement -------------------------------------------------------

const RUN = {
  workflow_id: "wf-1",
  request_id: "op:verify",
  candidate_commit: CANDIDATE_COMMIT,
  task_contract_hash: `sha256:${"a".repeat(64)}`,
} as unknown as VerificationRunHandle;

const settle = (
  w: LocalVerificationWorld,
  verdict: "AUDIT_PASS" | "FIX_REQUIRED" | "HUMAN_REQUIRED" = "AUDIT_PASS",
) => w.adapter.settle_audit({ op_key: `op:${ATTEMPT}:audit-decision:${CANDIDATE_COMMIT}` }, RUN, verdict, []);

test("C15: the Platform verdict is mapped to the backend's own vocabulary inside the adapter", () => {
  for (const [verdict, expected] of [
    ["AUDIT_PASS", "PASS"],
    ["FIX_REQUIRED", "FAIL"],
    ["HUMAN_REQUIRED", "BLOCKED"],
  ] as const) {
    const w = localVerification();
    w.backend.gate = { settled: false, verdict: null };
    w.backend.onApprove = undefined;
    // The gate settles with whatever the adapter asked for.
    const seam = w.backend;
    const original = seam.inspect_audit_gate.bind(seam);
    let calls = 0;
    (seam as unknown as { inspect_audit_gate: unknown }).inspect_audit_gate = (run: never) => {
      calls += 1;
      if (calls > 1) seam.gate = { settled: true, verdict: expected };
      return original(run);
    };

    assert.deepEqual(settle(w, verdict), { kind: "SETTLED" });
    assert.deepEqual(
      w.workflow.auditDecisions.map((entry) => entry.verdict),
      [expected],
      verdict,
    );
  }

  // No Platform verdict ever reaches the backend, and no backend value ever comes back as one.
  const adapter = stripped(join(ROOT, "adapters/local-verification/local-verification-adapter.ts"));
  assert.match(adapter, /AUDIT_PASS: "PASS"/);
  assert.match(adapter, /HUMAN_REQUIRED: "BLOCKED"/);
});

test("C16 / C17: SETTLED requires an authoritative re-observation, and is restart-safe", () => {
  // C16 — the call returning is not settlement: an unsettled gate afterwards is UNAVAILABLE.
  const silent = localVerification();
  silent.backend.gate = { settled: false, verdict: null };
  assert.deepEqual(settle(silent), { kind: "UNAVAILABLE" });
  assert.equal(silent.workflow.auditDecisions.length, 1, "it did act, then refused to claim");
  assert.equal(silent.backend.gateReads.length, 2, "observe before, observe after");

  // C17 — a restarted pass over an already-settled gate observes and makes no second effect.
  const restarted = localVerification();
  restarted.backend.gate = { settled: true, verdict: "PASS" };
  assert.deepEqual(settle(restarted), { kind: "SETTLED" });
  assert.deepEqual(restarted.workflow.auditDecisions, [], "AD3: never a blind retry");
  assert.equal(restarted.backend.gateReads.length, 1);

  // A call that threw may still have applied; the re-observation decides, not the exception.
  const lost = localVerification();
  lost.backend.gate = { settled: false, verdict: null };
  lost.workflow.auditFailure = new Error("transport lost the answer");
  const seam = lost.backend;
  const original = seam.inspect_audit_gate.bind(seam);
  let reads = 0;
  (seam as unknown as { inspect_audit_gate: unknown }).inspect_audit_gate = (run: never) => {
    reads += 1;
    if (reads > 1) seam.gate = { settled: true, verdict: "PASS" };
    return original(run);
  };
  assert.deepEqual(settle(lost), { kind: "SETTLED" });
});

test("C18: a gate settled with another decision is a CONFLICT, never an overwrite", () => {
  const w = localVerification();
  w.backend.gate = { settled: true, verdict: "FAIL" };
  assert.deepEqual(settle(w, "AUDIT_PASS"), { kind: "CONFLICT" });
  assert.deepEqual(w.workflow.auditDecisions, [], "a settled gate is never decided again");

  // A backend-native verdict the Platform does not have is a conflict too, never a fourth verdict.
  const inconclusive = localVerification();
  inconclusive.backend.gate = { settled: true, verdict: "INCONCLUSIVE" };
  assert.deepEqual(settle(inconclusive, "AUDIT_PASS"), { kind: "CONFLICT" });
});

test("C19: an unobservable gate is UNAVAILABLE, before and after the call", () => {
  const before = localVerification();
  before.backend.gateFailure = new Error("the backend cannot be reached");
  assert.deepEqual(settle(before), { kind: "UNAVAILABLE" });
  assert.deepEqual(before.workflow.auditDecisions, [], "nothing is attempted blind");

  const after = localVerification();
  after.backend.gate = { settled: false, verdict: null };
  const seam = after.backend;
  const original = seam.inspect_audit_gate.bind(seam);
  let reads = 0;
  (seam as unknown as { inspect_audit_gate: unknown }).inspect_audit_gate = (run: never) => {
    reads += 1;
    if (reads > 1) throw new Error("the backend went away after the call");
    return original(run);
  };
  assert.deepEqual(settle(after), { kind: "UNAVAILABLE" });
});

// --- C20: canonical head at this boundary --------------------------------------------------------

test("C20: canonical movement at AUDITING→READY_TO_MERGE is observation only", () => {
  const evaluator = stripped(join(ROOT, "core/execution/stage-boundary-drift.ts"));
  // MERGE_ONLY acts only where the merge is authorized, and this boundary is not one of those.
  // M1-14 added the MVP 1 human-merge boundary beside the MVP 2 automatic one; neither is this.
  assert.match(evaluator, /"READY_TO_MERGE_TO_APPROVED_FOR_MANUAL_MERGE"/);
  assert.match(evaluator, /"READY_TO_MERGE_TO_MERGING"/);
  assert.match(
    evaluator,
    /rule\.boundary === "MERGE_ONLY" && !MERGE_BOUNDARIES\.includes\(observation\.boundary\)/,
  );
  // And nothing anywhere rebases or moves a base in response.
  assert.equal(/rebase|base_head\s*=/.test(evaluator), false);
});
