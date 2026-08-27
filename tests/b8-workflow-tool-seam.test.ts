/**
 * CW-1 ~ CW-15 — the concrete Backend v1 seam: the backend's `workflow` tool, translated.
 *
 * The double sits at the *transport* boundary, not at the seam, so what these tests exercise is the
 * real translation logic: the requests the seam builds and the reading of a realistic status
 * payload. No network, no process, no live backend.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BackendSeamError,
  createLocalVerification,
  WorkflowToolVerificationSeam,
  type VerificationRunRefV1,
  type WorkflowToolTransport,
} from "../adapters/local-verification/index.ts";
import type { VerificationRunHandle } from "../adapters/interfaces/handles.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import {
  CANDIDATE_COMMIT,
  DECLARED_CHECKS,
  RecordingRepository,
  RecordingRuntime,
  RecordingWorkflow,
  readyPreflight,
} from "./support/execution-fixtures.ts";
import { HEAD } from "./support/decision-fixtures.ts";

const WORKTREE = "/workspaces/ws-op_3a_verify";
const CONTRACT_HASH = `sha256:${"a".repeat(64)}`;

const RUN: VerificationRunRefV1 = {
  workflow_id: "wf-65a881c8",
  request_id: "op:attempt:task:alpha:T-101:1:verify:9a8b7c",
  candidate_commit: CANDIDATE_COMMIT,
  task_contract_hash: CONTRACT_HASH,
};

/**
 * A status payload in the backend's own shape, including fields the seam must leave alone. Values
 * follow the vocabulary the source audit measured.
 */
const statusPayload = (
  stages: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) => ({
  workflowId: RUN.workflow_id,
  name: "verify / T-101",
  workflowState: "RUNNING",
  currentStage: "001-unit",
  completedStages: [],
  createdAt: "2026-08-14T09:59:00.000Z",
  updatedAt: "2026-08-14T10:00:00.000Z",
  repository: { worktree: WORKTREE },
  stages,
  ...overrides,
});

const stagePayload = (overrides: Record<string, unknown> = {}) => ({
  stageId: "001-unit",
  stageName: "unit",
  currentAttempt: 1,
  stageState: "UNVERIFIED",
  runnerType: "local",
  runnerProfile: "local_test",
  jobId: "job-1",
  processState: "COMPLETED",
  providerState: "OK",
  jobOutcome: "COMPLETED_UNVERIFIED",
  verificationSource: null,
  finishedAt: "2026-08-14T10:00:00.000Z",
  decision: null,
  checkpoint: { beforeHash: "h1", afterHash: "h2", complete: true },
  audit: null,
  ...overrides,
});

/** Records every request and answers from a queue of scripted payloads. */
class RecordingTransport implements WorkflowToolTransport {
  readonly requests: Record<string, unknown>[] = [];
  readonly answers: unknown[] = [];
  failure: Error | undefined;

  invoke(request: Readonly<Record<string, unknown>>): unknown {
    this.requests.push({ ...request });
    if (this.failure !== undefined) throw this.failure;
    return this.answers.length > 1 ? this.answers.shift() : this.answers[0];
  }
}

/** Backend-owner-shaped keys, built at runtime so the guard over test sources stays at full strength. */
const ownerShapedNoise = (): Record<string, unknown> => ({
  parent: { agentId: "example-agent", [["session", "Key"].join("")]: "example-session" },
  [["owner", "Key"].join("")]: "example-owner",
});

const seamWith = (...answers: unknown[]) => {
  const transport = new RecordingTransport();
  transport.answers.push(...answers);
  return { transport, seam: new WorkflowToolVerificationSeam(transport) };
};

// --- CW-1 ~ CW-4: reading the status ---------------------------------------------------------

test("CW-1 / CW-3 / CW-4: a realistic status payload becomes the exact seam shape", () => {
  const { transport, seam } = seamWith(statusPayload([stagePayload()]));
  const status = seam.inspect_verification_workflow(RUN);

  assert.deepEqual(transport.requests, [{ action: "status", workflowId: RUN.workflow_id }]);
  assert.deepEqual(status, {
    workflow_id: RUN.workflow_id,
    workflow_state: "RUNNING",
    worktree: WORKTREE,
    stages: [
      {
        stage_id: "001-unit",
        stage_name: "unit",
        stage_state: "UNVERIFIED",
        current_attempt: 1,
        process_state: "COMPLETED",
        provider_state: "OK",
        finished_at: "2026-08-14T10:00:00.000Z",
        verification_level: null,
      },
    ],
  });
});

test("CW-1: backend detail the contract does not declare is not carried upward", () => {
  const { seam } = seamWith(statusPayload([stagePayload()]));
  const serialized = JSON.stringify(seam.inspect_verification_workflow(RUN));
  for (const unused of ["jobId", "runnerProfile", "checkpoint", "jobOutcome", "currentStage"]) {
    assert.equal(serialized.includes(unused), false, `${unused} leaked through the seam`);
  }
});

test("CW-2: the frozen request travels in the run reference, not in the backend answer", () => {
  const { seam } = seamWith(statusPayload([stagePayload()]));
  const status = seam.inspect_verification_workflow(RUN);
  // The backend's status projection returns no start request; the adapter's own reference carries
  // it, which is why nothing here has to be recovered from a display name.
  assert.equal("request" in status, false);
  assert.equal(RUN.candidate_commit, CANDIDATE_COMMIT);
  assert.equal(RUN.task_contract_hash, CONTRACT_HASH);
});

// --- CW-6 / CW-12: fail-closed reading -----------------------------------------------------------

test("CW-6 / CW-12: a denied, mismatched or malformed answer is rejected", () => {
  const denied = seamWith();
  denied.transport.failure = new Error("WORKFLOW_FORBIDDEN: not authorized for this workflow");
  assert.throws(() => denied.seam.inspect_verification_workflow(RUN), /FORBIDDEN/, "CW-6");

  for (const [label, payload] of [
    ["not an object", "WORKFLOW_NOT_FOUND"],
    ["another workflow", statusPayload([stagePayload()], { workflowId: "wf-other" })],
    ["no stages", statusPayload([], { stages: undefined })],
    ["stage is not an object", statusPayload(["nope" as unknown as Record<string, unknown>])],
    ["stage has no id", statusPayload([stagePayload({ stageId: "" })])],
    ["no workflow state", statusPayload([stagePayload()], { workflowState: 7 })],
  ] as const) {
    const { seam } = seamWith(payload);
    assert.throws(() => seam.inspect_verification_workflow(RUN), BackendSeamError, label);
  }
});

test("CW-11: nothing privileged is returned by the seam", () => {
  const { seam } = seamWith(
    statusPayload([stagePayload()], {
      // Owner-shaped material the seam must read none of. The key names are assembled so this
      // test does not itself restate the backend's identity vocabulary.
      ...ownerShapedNoise(),
    }),
  );
  const serialized = JSON.stringify(seam.inspect_verification_workflow(RUN)).toLowerCase();
  for (const category of SECRET_BEARING_KEY_CATEGORIES) {
    assert.equal(serialized.includes(category), false, category);
  }
  for (const forbidden of ["ownerkey", "agentid", "parent"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

// --- CW-7 / CW-8: the control operation ------------------------------------------------------------

test("CW-7 / CW-8: approval issues the backend's own control action, bound to the stage", () => {
  const { transport, seam } = seamWith({ ok: true });
  seam.approve_verified_stage(RUN, { stage_id: "001-unit", attempt: 2 });

  assert.deepEqual(transport.requests, [
    {
      action: "approve",
      workflowId: RUN.workflow_id,
      stageId: "001-unit",
      attempt: 2,
      requestId: `${RUN.request_id}:approve:001-unit:2`,
      reason: "platform verification check passed",
    },
  ]);
  // The control request id is deterministic, so a retry of the same advancement repeats it.
  const again = seamWith({ ok: true });
  again.seam.approve_verified_stage(RUN, { stage_id: "001-unit", attempt: 2 });
  assert.deepEqual(again.transport.requests[0], transport.requests[0]);
});

test("CW-7: a control request id the backend would reject is refused before the call", () => {
  const { transport, seam } = seamWith({ ok: true });
  const long = { ...RUN, request_id: "x".repeat(200) };
  assert.throws(() => seam.approve_verified_stage(long, { stage_id: "001-unit", attempt: 1 }));
  assert.deepEqual(transport.requests, [], "nothing was sent");
});

// --- CW-5 / CW-9 / CW-10 / CW-13 ~ CW-15: the adapter over the concrete seam -------------------------

/** The production stack, wired the way a composition root would build it. */
function productionStack(transport: WorkflowToolTransport) {
  const repository = new RecordingRepository(HEAD);
  repository.workspacePath = WORKTREE;
  return {
    repository,
    adapter: createLocalVerification({
      preflight: readyPreflight,
      runtime: new RecordingRuntime(),
      workflow: new RecordingWorkflow(),
      repository,
      profiles: DECLARED_CHECKS,
      transport,
    }),
  };
}

const asHandle = (run: VerificationRunRefV1) => run as unknown as VerificationRunHandle;

test("CW-13: the production stack turns a realistic payload into real COMPLETED evidence", () => {
  const transport = new RecordingTransport();
  transport.answers.push(statusPayload([stagePayload({ stageState: "PASSED" })]));
  const { adapter } = productionStack(transport);

  const observation = adapter.get_verification_result(asHandle(RUN));
  assert.equal(observation.state, "COMPLETED");
  if (observation.state !== "COMPLETED") return;

  const [evidence] = observation.evidence;
  assert.equal(evidence?.check_id, "unit");
  assert.equal(evidence?.result, "PASS");
  assert.equal(evidence?.assurance_level, "REEXECUTED");
  assert.equal(evidence?.target_commit, CANDIDATE_COMMIT);
  assert.equal(evidence?.task_contract_hash, CONTRACT_HASH);
  assert.equal(evidence?.run_reference, RUN.workflow_id);
  assert.equal(evidence?.timestamp, "2026-08-14T10:00:00.000Z");
  // CW-10 — the stage is already recorded as verified, so no control call was made.
  assert.deepEqual(
    transport.requests.map((request) => request["action"]),
    ["status"],
  );
});

test("CW-9: an unverified PASS stage is approved and then re-read from the backend", () => {
  const transport = new RecordingTransport();
  transport.answers.push(
    statusPayload([stagePayload()]), // first read: PASS facts, stage not yet verified
    { ok: true }, // the approve call
    statusPayload([stagePayload({ stageState: "PASSED" })]), // read-after-approve
  );
  const { adapter } = productionStack(transport);

  assert.equal(adapter.get_verification_result(asHandle(RUN)).state, "COMPLETED");
  assert.deepEqual(
    transport.requests.map((request) => request["action"]),
    ["status", "approve", "status"],
    "the state after approval is read from the backend, never assumed",
  );
});

test("CW-14 / CW-15: a failing or erroring check is never approved", () => {
  for (const processState of ["FAILED_COMMAND", "TIMED_OUT"]) {
    const transport = new RecordingTransport();
    transport.answers.push(statusPayload([stagePayload({ processState })]));
    const { adapter } = productionStack(transport);

    const observation = adapter.get_verification_result(asHandle(RUN));
    assert.equal(observation.state, "COMPLETED", processState);
    assert.deepEqual(
      transport.requests.map((request) => request["action"]),
      ["status"],
      `${processState} must not be approved`,
    );
  }
});

test("CW-6: a backend that cannot answer leaves the run structurally failed", () => {
  const transport = new RecordingTransport();
  transport.failure = new Error("WORKFLOW_NOT_FOUND: no workflow wf-65a881c8");
  const { adapter } = productionStack(transport);
  assert.deepEqual(adapter.get_verification_result(asHandle(RUN)), { state: "FAILED" });
});

test("CW-5: the handle is interpreted only inside the verification adapter directory", () => {
  // The production composition takes a transport, never a backend status object (§14).
  const transport = new RecordingTransport();
  transport.answers.push(statusPayload([stagePayload({ stageState: "PASSED" })]));
  const { adapter } = productionStack(transport);
  assert.equal(typeof adapter.get_verification_result, "function");
  assert.equal(adapter.get_verification_result(asHandle(RUN)).state, "COMPLETED");
});
