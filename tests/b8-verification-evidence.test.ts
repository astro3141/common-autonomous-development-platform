/**
 * EV-1 ~ EV-30 — Backend v1 execution facts → `VerificationEvidence` (MVP1-B8).
 *
 * Every assertion here is about the *adapter*: what it derives from the OS child's outcome, what it
 * refuses to derive, and what it never reads. Core is not involved and no lifecycle moves.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { VerificationEvidence } from "../adapters/interfaces/verification-adapter.ts";
import type { VerificationRunHandle } from "../adapters/interfaces/handles.ts";
import { LOCAL_VERIFICATION_EXECUTOR_IDENTITY } from "../adapters/local-verification/index.ts";
import type { BackendStageStatus } from "../adapters/local-verification/index.ts";
import { isUlid } from "../core/schemas/identifiers.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import {
  backendStage,
  backendStatus,
  CANDIDATE_COMMIT,
  localVerification,
  type LocalVerificationWorld,
} from "./support/execution-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACT_HASH = `sha256:${"a".repeat(64)}`;
const WORKTREE = "/workspaces/ws-op_3a_verify";

/**
 * The run reference the adapter minted at start: the backend's workflow id plus the request
 * material it froze. Core holds it opaquely; the adapter reads its own values back from it.
 */
const runRef = (overrides: Partial<Record<string, string>> = {}) =>
  ({
    workflow_id: "wf-1",
    request_id: "op:verify",
    candidate_commit: CANDIDATE_COMMIT,
    task_contract_hash: CONTRACT_HASH,
    ...overrides,
  }) as unknown as VerificationRunHandle;

const RUN = runRef();

/** A world whose repository re-acquires exactly the worktree the backend reports. */
function world(stages: readonly BackendStageStatus[], overrides = {}): LocalVerificationWorld {
  const backend = localVerification();
  backend.repository.workspacePath = WORKTREE;
  backend.backend.status = backendStatus(stages, overrides);
  return backend;
}

const observe = (w: LocalVerificationWorld, run: VerificationRunHandle = RUN) =>
  w.adapter.get_verification_result(run);

const evidenceOf = (
  w: LocalVerificationWorld,
  run: VerificationRunHandle = RUN,
): readonly VerificationEvidence[] => {
  const observation = observe(w, run);
  assert.equal(observation.state, "COMPLETED");
  return observation.state === "COMPLETED" ? observation.evidence : [];
};

const unit = (overrides: Partial<BackendStageStatus> = {}) =>
  backendStage({ stage_name: "unit", ...overrides });

// --- EV-1 ~ EV-7: the result mapping -------------------------------------------------------------

test("EV-1: a check that has not finished leaves the run RUNNING", () => {
  for (const process_state of [null, "QUEUED", "RUNNING"]) {
    const w = world([unit({ process_state })]);
    assert.deepEqual(observe(w), { state: "RUNNING" });
    assert.deepEqual(w.backend.approvals, [], "nothing is approved while a check is unfinished");
  }
});

test("EV-2 / EV-8: a clean exit is PASS evidence at REEXECUTED", () => {
  const w = world([unit({ process_state: "COMPLETED", provider_state: "OK" })]);
  const [evidence] = evidenceOf(w);
  assert.equal(evidence?.result, "PASS");
  assert.equal(evidence?.assurance_level, "REEXECUTED", "EV-8");
});

test("EV-3 / EV-6: a non-zero exit is FAIL evidence, and the run is COMPLETED", () => {
  const w = world([unit({ process_state: "FAILED_COMMAND" })]);
  const observation = observe(w);
  // EV-6 — an ordinary failing test is a verification answer, not an infrastructure failure.
  assert.equal(observation.state, "COMPLETED");
  assert.equal(observation.state === "COMPLETED" ? observation.evidence[0]?.result : "", "FAIL");
});

test("EV-4 / EV-5: timeout, interruption and loss are ERROR evidence", () => {
  for (const process_state of ["TIMED_OUT", "INTERRUPTED", "LOST"]) {
    const w = world([unit({ process_state })]);
    assert.equal(evidenceOf(w)[0]?.result, "ERROR", process_state);
  }
});

test("EV-4: a provider failure on a clean exit is ERROR, never PASS", () => {
  for (const provider_state of ["ERROR_UNCLASSIFIED", "BLOCKED_QUOTA", "AUTH_FAILED"]) {
    const w = world([unit({ process_state: "COMPLETED", provider_state })]);
    assert.equal(evidenceOf(w)[0]?.result, "ERROR", provider_state);
  }
});

test("EV-7: an unusable or unresolvable backend run is a run-level FAILED", () => {
  // A cancelled check has no verification meaning.
  assert.deepEqual(observe(world([unit({ process_state: "CANCELLED" })])), { state: "FAILED" });
  // So does a state this mapping does not know.
  assert.deepEqual(observe(world([unit({ process_state: "WHAT_IS_THIS" })])), { state: "FAILED" });
  // No worktree, no stages, no terminal timestamp: all structurally unusable.
  assert.deepEqual(observe(world([unit()], { worktree: null })), { state: "FAILED" });
  assert.deepEqual(observe(world([])), { state: "FAILED" });
  assert.deepEqual(observe(world([unit({ finished_at: null })])), { state: "FAILED" });
});

// --- EV-9 ~ EV-10: what is never used ------------------------------------------------------------

test("EV-9: the backend's own verification level cannot set Platform assurance", () => {
  for (const verification_level of ["WORKER_REPORTED", "INFERRED", "LOG_VERIFIED"]) {
    const w = world([unit({ verification_level })]);
    assert.equal(evidenceOf(w)[0]?.assurance_level, "REEXECUTED", verification_level);
  }
});

test("EV-10: the check id is the stage name the adapter set, and duplicates fail closed", () => {
  const w = world([unit(), backendStage({ stage_name: "lint" })]);
  assert.deepEqual(
    evidenceOf(w).map((item) => item.check_id),
    ["unit", "lint"],
  );

  // An ambiguous mapping is never resolved by order or by command text.
  const ambiguous = world([unit(), backendStage({ stage_name: "unit", stage_id: "st-2" })]);
  assert.deepEqual(observe(ambiguous), { state: "FAILED" });
  const unnamed = world([unit({ stage_name: "" })]);
  assert.deepEqual(observe(unnamed), { state: "FAILED" });
});

// --- EV-11 ~ EV-15: provenance --------------------------------------------------------------------

test("EV-11: evidence is withheld unless the checks ran in this run's own workspace", () => {
  const w = world([unit()]);
  w.repository.workspacePath = "/workspaces/somewhere-else";
  assert.deepEqual(observe(w), { state: "FAILED" }, "a diverged execution location proves nothing");

  const unresolvable = world([unit()]);
  unresolvable.repository.failWorkspace = new Error("cannot reacquire");
  assert.deepEqual(observe(unresolvable), { state: "FAILED" });
});

test("EV-12 / EV-13 / EV-14: binding, reference and producer identity", () => {
  const w = world([unit()]);
  const [evidence] = evidenceOf(w);

  assert.equal(evidence?.target_commit, CANDIDATE_COMMIT);
  assert.equal(evidence?.task_contract_hash, CONTRACT_HASH, "EV-12");
  assert.equal(evidence?.run_reference, "wf-1", "EV-13");
  assert.equal(evidence?.executor_identity, LOCAL_VERIFICATION_EXECUTOR_IDENTITY, "EV-14");
  assert.equal(
    LOCAL_VERIFICATION_EXECUTOR_IDENTITY,
    "platform-verifier@local-verification-adapter:1",
  );

  // EV-13 — nothing privileged and nothing owner-shaped travels in the evidence.
  const serialized = JSON.stringify(evidence).toLowerCase();
  for (const category of SECRET_BEARING_KEY_CATEGORIES) {
    assert.equal(serialized.includes(category), false, category);
  }
  for (const forbidden of ["ownerkey", "controller", "agentid", "parent"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("EV-15: the timestamp is the backend's terminal record, not a clock read", () => {
  const w = world([unit({ finished_at: "2026-08-14T11:22:33.000Z" })]);
  assert.equal(evidenceOf(w)[0]?.timestamp, "2026-08-14T11:22:33.000Z");
});

// --- EV-16 ~ EV-20: identity and digests ------------------------------------------------------------

test("EV-16 / EV-30: two observations of the same terminal check are identical", () => {
  const w = world([unit(), backendStage({ stage_name: "lint" })]);
  w.backend.onApprove = () => {
    w.backend.status = backendStatus([
      unit({ stage_state: "PASSED" }),
      backendStage({ stage_name: "lint", stage_state: "PASSED" }),
    ]);
  };

  const first = evidenceOf(w);
  const second = evidenceOf(w);
  assert.deepEqual(second, first, "EV-30: byte-equivalent on re-observation");
  assert.equal(first.every((item) => isUlid(item.evidence_id)), true, "well-formed ULIDs");
});

test("EV-17 / EV-18: identity changes with the check, the run and the candidate", () => {
  const base = evidenceOf(world([unit(), backendStage({ stage_name: "lint" })]));
  assert.notEqual(base[0]?.evidence_id, base[1]?.evidence_id, "EV-17");

  const otherRun = evidenceOf(
    world([unit()], { workflow_id: "wf-2" }),
    runRef({ workflow_id: "wf-2" }),
  );
  assert.notEqual(otherRun[0]?.evidence_id, base[0]?.evidence_id, "EV-18: run");

  const otherCandidate = evidenceOf(world([unit()]), runRef({ candidate_commit: "0".repeat(40) }));
  assert.notEqual(otherCandidate[0]?.evidence_id, base[0]?.evidence_id, "EV-18: candidate");

  const otherContract = evidenceOf(
    world([unit()]),
    runRef({ task_contract_hash: `sha256:${"b".repeat(64)}` }),
  );
  assert.notEqual(otherContract[0]?.evidence_id, base[0]?.evidence_id, "EV-18: contract");
});

test("EV-19 / EV-20: no digest is manufactured", () => {
  const [evidence] = evidenceOf(world([unit()]));
  assert.equal(evidence?.artifact_digest, undefined, "EV-19");
  assert.equal(evidence?.log_digest, undefined, "EV-20");
  assert.deepEqual(Object.keys(evidence ?? {}).sort(), [
    "assurance_level",
    "check_id",
    "evidence_id",
    "executor_identity",
    "result",
    "run_reference",
    "target_commit",
    "task_contract_hash",
    "timestamp",
  ]);
});

// --- EV-21 ~ EV-29: stage progression ---------------------------------------------------------------

test("EV-21 / EV-24: a stage is approved only after PASS, and only once", () => {
  const w = world([unit(), backendStage({ stage_name: "lint" })]);
  w.backend.onApprove = (stage_id) => {
    assert.equal(stage_id, "st-unit", "EV-21: the passing stage, after its result was established");
    w.backend.status = backendStatus([
      unit({ stage_state: "PASSED" }),
      backendStage({ stage_name: "lint", stage_state: "PASSED" }),
    ]);
  };

  assert.equal(observe(w).state, "COMPLETED");
  assert.deepEqual(w.backend.approvals, ["st-unit"]);

  // EV-24 — a crash between the approval and its observation: the stage is already recorded as
  // verified, so a second pass reconstructs the same evidence and approves nothing again.
  const before = w.backend.approvals.length;
  assert.equal(observe(w).state, "COMPLETED");
  assert.equal(w.backend.approvals.length, before, "no duplicate advancement");
});

test("EV-22 / EV-23 / EV-27 / EV-28: a failing check stops the walk and nothing is synthesized", () => {
  for (const process_state of ["FAILED_COMMAND", "TIMED_OUT"]) {
    const w = world([unit({ process_state }), backendStage({ stage_name: "lint" })]);
    const evidence = evidenceOf(w);

    assert.deepEqual(w.backend.approvals, [], "EV-22/EV-23: a non-PASS stage is never approved");
    assert.deepEqual(
      evidence.map((item) => item.check_id),
      ["unit"],
      "EV-27: only the evidence actually observed",
    );
    assert.equal(evidence.length, 1, "EV-28: the later check is not synthesized");
    assert.notEqual(evidence[0]?.result, "PASS");
  }
});

test("EV-29: an all-PASS multi-check run reaches COMPLETED with every check", () => {
  const w = world([unit(), backendStage({ stage_name: "lint" })]);
  const advanced: string[] = [];
  w.backend.onApprove = (stage_id) => {
    advanced.push(stage_id);
    w.backend.status = backendStatus([
      unit({ stage_state: "PASSED" }),
      backendStage({ stage_name: "lint", stage_state: advanced.length > 1 ? "PASSED" : "UNVERIFIED" }),
    ]);
  };

  const evidence = evidenceOf(w);
  assert.deepEqual(
    evidence.map((item) => `${item.check_id}:${item.result}`),
    ["unit:PASS", "lint:PASS"],
  );
  assert.deepEqual(w.backend.approvals, ["st-unit", "st-lint"]);
});

test("EV-1: a run whose next check is still queued stays RUNNING mid-pipeline", () => {
  const w = world([unit(), backendStage({ stage_name: "lint", process_state: "QUEUED" })]);
  w.backend.onApprove = () => {
    w.backend.status = backendStatus([
      unit({ stage_state: "PASSED" }),
      backendStage({ stage_name: "lint", process_state: "RUNNING" }),
    ]);
  };
  assert.deepEqual(observe(w), { state: "RUNNING" });
});

// --- EV-25 / EV-26 and §29: the backend's progression marker stays backend-internal -----------------

test("EV-25 / EV-26 / §29: no Core code reads the backend's progression marker", () => {
  const term = (...parts: readonly string[]): RegExp => new RegExp(parts.join(""), "i");
  const core = readdirSync(join(ROOT, "core"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(ROOT, "core", entry.name))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "core", entry.name, name)),
    );

  for (const file of core) {
    const content = readFileSync(file, "utf8");
    for (const pattern of [
      term("MANUAL", "_APPROVAL"),
      term("verification", "Source"),
      term("process", "State"),
      term("provider", "State"),
      term("stage", "Id"),
      term("\\bjob", "Id\\b"),
      term("durable", "[-_ ]?", "jobs"),
    ]) {
      assert.equal(pattern.test(content), false, `${relative(ROOT, file)} matches ${pattern}`);
    }
  }
});

test("EV-26: the adapter derives assurance from execution, never from a progression marker", () => {
  const code = readFileSync(
    join(ROOT, "adapters/local-verification/evidence.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // The only inputs to a verdict are the process and provider outcomes.
  assert.equal(/verification_level|stage_state/.test(code), false);
  assert.match(code, /process_state/);
});

// --- §24: nothing in this batch reaches the Core lifecycle -------------------------------------------

test("§24 / §25 + B9 §25/§26: evidence work is one module, and no module does Auditor work", () => {
  // Scoped to the lifecycle modules: the evidence *store* and the policy *schema* legitimately name
  // these terms elsewhere in Core; what B8 must not do is wire them into a transition.
  // MVP1-B9 owns verification *completion*, so observing the run and persisting evidence now
  // legitimately live in one module. Everywhere else in the execution path they stay absent, and
  // the Auditor lifecycle stays absent from all of it.
  // B9 owns completion; the gate evaluator is shared with B10 by construction (M1-10 §11).
  const EVIDENCE_MODULES = [
    "core/execution/complete-verification.ts",
    "core/execution/verification-gate.ts",
    // MVP1-B10 recomputes eligibility from the stored rows; it reads them and writes none.
    "core/execution/start-auditing.ts",
    // M1-13 — the review context reads the evidence *identities* it hands the Auditor, in the
    // store's own order. It reads them and writes none.
    "core/execution/auditor-review.ts",
    // MVP1-B11 binds the returned verdict back to those same rows. Reads only.
    "core/execution/complete-auditing.ts",
    // MVP1-B12 reads the settled audit record the merge approval is bound to. Reads only.
    "core/execution/human-merge.ts",
    // MVP 2 — the Repository Gate recomputes the verification gate from the immutable rows
    // (§14.4 precondition). Reads only, writes none.
    "core/execution/automatic-merge.ts",
  ];
  /** MVP1-B11 writes them; MVP1-B12 and the MVP 2 Gate read the one their merge is bound to. */
  const AUDIT_RECORD_READERS = [
    "core/execution/complete-auditing.ts",
    "core/execution/human-merge.ts",
    "core/execution/automatic-merge.ts",
    // §17.4 (D22) — the AUDIT_DECISION mapping row re-reads the settled record its question was
    // opened on ("the audit evidence still binds to this exact cycle"). Reads only, writes none.
    "core/execution/apply-resolved-decision.ts",
  ];
  const execution = readdirSync(join(ROOT, "core/execution"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(ROOT, "core/execution", name));
  assert.ok(execution.length >= 4);

  for (const file of execution) {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const completionOnly = EVIDENCE_MODULES.includes(relative(ROOT, file));
    for (const forbidden of [
      /get_verification_result/,
      /verificationEvidence/,
      /binding_valid/,
      /accepted_assurance/,
    ]) {
      if (completionOnly) continue;
      assert.equal(forbidden.test(code), false, `${relative(ROOT, file)} contains ${forbidden}`);
    }
    // MVP1-B10 owns the Auditor *launch*; every other execution module stays clear of it, and
    // even B10 must not reach the audit *decision* surface.
    //
    // M1-11 narrows this by exactly one ownership: §11.4's `REEVALUATE_AT_BOUNDARY` asks whether
    // the *remaining Auditor stage* is still permitted, so the drift read model and its assembler
    // legitimately name the boundary and the `AUDITOR` pipeline step. They launch nothing — the
    // decision surface below stays forbidden to them, unconditionally, like everyone else.
    const AUDITOR_STAGE_MODULES = [
      "core/execution/start-auditing.ts",
      // MVP1-B11 owns the Auditor *decision*: it names the boundary it evaluates and the role it
      // is about. The decision surface below stays forbidden to it like everyone else.
      "core/execution/complete-auditing.ts",
      "core/execution/auditor-review.ts",
      "core/execution/drift-observation.ts",
      "core/execution/assemble-drift-observation.ts",
      "core/execution/stage-boundary-drift.ts",
      // §17.4 (D22) — the resolved-decision application names AUDITING only as the exact allowed
      // source state of the AUDIT_DECISION mapping row. It launches nothing and reads no verdict;
      // the decision surface below stays forbidden to it like everyone else.
      "core/execution/apply-resolved-decision.ts",
    ];
    const namesAuditorStage = AUDITOR_STAGE_MODULES.includes(relative(ROOT, file));
    for (const forbidden of [/AUDITING/, /"AUDITOR"/]) {
      if (namesAuditorStage) continue;
      assert.equal(forbidden.test(code), false, `${relative(ROOT, file)} contains ${forbidden}`);
    }
    // M1-13 — audit-cycle *identity* is one module's job and performs nothing; the module that
    // actually spawns is still the only other one allowed to name the spawn operation.
    const IDENTITY_MODULE = "core/execution/audit-operations.ts";
    if (
      relative(ROOT, file) !== "core/execution/start-auditing.ts" &&
      relative(ROOT, file) !== IDENTITY_MODULE
    ) {
      assert.equal(/audit-spawn/.test(code), false, `${relative(ROOT, file)} contains audit-spawn`);
    }
    // The identity module constructs the key; MVP1-B11 is the one module that performs it.
    const DECISION_MODULES = [IDENTITY_MODULE, "core/execution/complete-auditing.ts"];
    if (!DECISION_MODULES.includes(relative(ROOT, file))) {
      assert.equal(
        /audit-decision/.test(code),
        false,
        `${relative(ROOT, file)} contains audit-decision`,
      );
    }
    // Only the completion module ever *writes* evidence.
    if (relative(ROOT, file) !== "core/execution/complete-verification.ts") {
      assert.equal(/verificationEvidence\.put/.test(code), false, `${relative(ROOT, file)} writes evidence`);
    }
    // The audit *decision surface* stays out of every execution module without exception —
    // B11 has not happened, so no module settles a gate, validates a verdict or writes a record.
    // (`get_turn_result` is deliberately not here: B7 observes the *Actor* turn with it.)
    // MVP1-B11 is the one module that may validate a verdict, settle a gate through the
    // VerificationAdapter, and write an audit record. `audit_decide` stays forbidden everywhere.
    const AUDIT_DECISION_MODULE = "core/execution/complete-auditing.ts";
    assert.equal(/audit_decide/.test(code), false, `${relative(ROOT, file)} contains audit_decide`);
    // Settling a gate and validating a verdict stay with the one module that owns the decision.
    if (relative(ROOT, file) !== AUDIT_DECISION_MODULE) {
      for (const forbidden of [/settle_audit/, /validateAuditorVerdict/]) {
        assert.equal(forbidden.test(code), false, `${relative(ROOT, file)} contains ${forbidden}`);
      }
    }
    // MVP1-B12 *reads* the settled record its merge approval is bound to, and writes none.
    if (!AUDIT_RECORD_READERS.includes(relative(ROOT, file))) {
      assert.equal(/auditRecords/.test(code), false, `${relative(ROOT, file)} reaches audit records`);
    }
    assert.equal(
      /auditRecords\.put/.test(code),
      relative(ROOT, file) === AUDIT_DECISION_MODULE,
      `${relative(ROOT, file)} writes audit records`,
    );
  }
});
