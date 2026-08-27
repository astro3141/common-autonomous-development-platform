/**
 * B3-AC2 (five fakes), B3-AC8 (verification contract), B3-AC10 (script exhaustion fail-closed),
 * B3-AC11 (call recording determinism).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  CandidateInspection,
  FeatureWorkspace,
  MergeCommit,
  MergePreparation,
  RepositoryCanonicalSnapshot,
  RepositoryDiff,
} from "../adapters/interfaces/repository-adapter.ts";
import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeSessionStatus,
  RuntimeTurnHandle,
  TaskContractSnapshot,
  VerificationProfile,
  WorkflowControllerHandle,
  WorkflowHandle,
  WorkflowSpec,
} from "../adapters/interfaces/handles.ts";
import type { RuntimeTurnResult } from "../adapters/interfaces/runtime-adapter.ts";
import type { VerificationEvidence } from "../adapters/interfaces/verification-adapter.ts";
import {
  FakeReportAdapter,
  FakeRepositoryAdapter,
  FakeRuntimeAdapter,
  FakeVerificationAdapter,
  FakeWorkflowAdapter,
  TestDoubleError,
} from "../testdoubles/index.ts";

/** Opaque values carry no structure, so tests mint them as unmarked objects. */
const opaque = <T>(label: string): T => ({ label }) as unknown as T;

test("B3-AC2: one deterministic fake exists per interface", () => {
  const fakes = [
    new FakeRuntimeAdapter(),
    new FakeWorkflowAdapter(),
    new FakeRepositoryAdapter(),
    new FakeVerificationAdapter(),
    new FakeReportAdapter(),
  ];
  assert.equal(fakes.length, 5);
  for (const fake of fakes) {
    assert.deepEqual(fake.calls, [], "a fresh fake records no calls");
  }
});

test("B3-AC11: the runtime fake records method, arguments and order", () => {
  const runtime = new FakeRuntimeAdapter();
  const session = opaque<RuntimeSessionHandle>("session");
  const turn = opaque<RuntimeTurnHandle>("turn");
  const controller = opaque<WorkflowControllerHandle>("controller");
  const status = opaque<RuntimeSessionStatus>("status");
  const turnResult = {
    session_handle: session,
    turn_handle: turn,
    backend_status: "COMPLETED",
    termination_reason: "example",
    started_at: "t1",
    completed_at: "t2",
    provenance: {
      runtime_backend: "fake",
      identity_authority: "BACKEND",
      result_channel: "RUNTIME_RESULT_CHANNEL",
    },
  } satisfies RuntimeTurnResult;

  runtime.sessions.push({ session_handle: session });
  runtime.turns.push(turn);
  runtime.turnResults.push(turnResult);
  runtime.sessionStatuses.push(status);
  runtime.controllers.push(controller);

  const grant = opaque<CapabilityGrant>("grant");
  const profile = opaque<RuntimeProfile>("profile");

  assert.equal(
    runtime.spawn_session({ op_key: "op:a:actor_spawn" }, "actor", profile, "/workspace", { seed: 1 }, grant)
      .session_handle,
    session,
  );
  assert.equal(runtime.send_turn({ op_key: "op:a:actor_first_turn" }, session, "do the thing"), turn);
  assert.equal(runtime.get_turn_result(turn), turnResult);
  assert.equal(runtime.get_session_status(session), status);
  assert.equal(runtime.acquire_workflow_controller(), controller);
  runtime.cancel_session(session);
  runtime.close_session(session);

  assert.deepEqual(
    runtime.calls.map((call) => call.method),
    [
      "spawn_session",
      "send_turn",
      "get_turn_result",
      "get_session_status",
      "acquire_workflow_controller",
      "cancel_session",
      "close_session",
    ],
  );
  // M1-8 — the operation identity leads, ahead of every semantic argument.
  assert.deepEqual(runtime.calls[0]?.args, [
    { op_key: "op:a:actor_spawn" },
    "actor",
    profile,
    "/workspace",
    { seed: 1 },
    grant,
  ]);
  assert.deepEqual(runtime.calls[1]?.args, [
    { op_key: "op:a:actor_first_turn" },
    session,
    "do the thing",
  ]);
});

test("B3-AC11: repository fake records every fact call in order", () => {
  const repository = new FakeRepositoryAdapter();
  const snapshot: RepositoryCanonicalSnapshot = { ref: "refs/heads/trunk", head: "0f1e2d" };
  const workspace: FeatureWorkspace = { path: "/w", base_head: "0f1e2d", branch: "ws" };
  const preparation: MergePreparation = {
    canonical_ref: "refs/heads/trunk",
    canonical_head: "0f1e2d",
    candidate_commit: "9a8b7c",
    fast_forwardable: true,
  };
  repository.snapshots.push(snapshot);
  repository.workspaces.push(workspace);
  repository.inspections.push({
    present: true,
    candidate_commit: "9a8b7c",
    base_head: "0f1e2d",
  } satisfies CandidateInspection);
  repository.diffs.push({
    from: "0f1e2d",
    to: "9a8b7c",
    changed_paths: ["src/a.ts"],
    patch: "",
  } satisfies RepositoryDiff);
  repository.trackedCleanFacts.push(true);
  repository.expectedFilesFacts.push(false);
  repository.lineageFacts.push(true);
  repository.canonicalHeadFacts.push(true);
  repository.mergePreparations.push(preparation);
  repository.mergeCommits.push({
    canonical_ref: "refs/heads/trunk",
    canonical_head: "9a8b7c",
    candidate_commit: "9a8b7c",
  } satisfies MergeCommit);

  repository.snapshot_canonical();
  repository.create_feature_workspace({ base_head: "0f1e2d", op_key: "op:a:workspace" });
  repository.inspect_candidate(workspace);
  repository.get_diff({ from: "0f1e2d", to: "9a8b7c" });
  assert.equal(repository.verify_tracked_clean(), true);
  assert.equal(
    repository.verify_expected_files({ from: "0f1e2d", to: "9a8b7c", allowed_paths: ["src"] }),
    false,
  );
  assert.equal(repository.verify_lineage("0f1e2d", "9a8b7c"), true);
  assert.equal(repository.verify_canonical_head("0f1e2d"), true);
  repository.prepare_merge({ candidate_commit: "9a8b7c", expected_canonical_head: "0f1e2d" });
  repository.commit_merge(preparation);

  assert.deepEqual(
    repository.calls.map((call) => call.method),
    [
      "snapshot_canonical",
      "create_feature_workspace",
      "inspect_candidate",
      "get_diff",
      "verify_tracked_clean",
      "verify_expected_files",
      "verify_lineage",
      "verify_canonical_head",
      "prepare_merge",
      "commit_merge",
    ],
  );
  assert.deepEqual(repository.calls[1]?.args, [{ base_head: "0f1e2d", op_key: "op:a:workspace" }]);
  // TD §14.3 M1-4 — the fake records which direction the lineage question was asked in.
  assert.deepEqual(repository.calls[6]?.args, ["0f1e2d", "9a8b7c"]);
});

test("B3-AC8: the verification fake starts and observes a run, and runs nothing", () => {
  const verification = new FakeVerificationAdapter();
  const evidence: VerificationEvidence[] = [
    {
      evidence_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0ABC",
      check_id: "unit",
      result: "PASS",
      assurance_level: "REEXECUTED",
      target_commit: "0f1e2d",
      task_contract_hash: `sha256:${"0".repeat(64)}`,
      executor_identity: "platform-verifier@example",
      timestamp: "t1",
    },
  ];
  // M1-9 — the v1 surface is start/observe; evidence arrives from an observation, never as the
  // return of a start, and the fake executes nothing to produce it.
  const started = verification.start_verification(
    { op_key: "op:a:verify:9a8b7c" },
    opaque<VerificationProfile>("profile"),
    opaque<RepositoryCanonicalSnapshot>("snapshot"),
    opaque<TaskContractSnapshot>("contract"),
    "9a8b7c",
  );
  assert.equal(started.kind, "STARTED");
  assert.equal(verification.runCount, 1);

  verification.completeWith(evidence);
  const observed = verification.get_verification_result(
    started.kind === "STARTED" ? started.run_handle : opaque("run"),
  );
  assert.deepEqual(observed, { state: "COMPLETED", evidence });
  assert.deepEqual(
    verification.calls.map((call) => call.method),
    ["start_verification", "get_verification_result"],
  );
});

test("B3-AC10: an exhausted script fails closed instead of inventing a success", () => {
  const runtime = new FakeRuntimeAdapter();
  const workflow = new FakeWorkflowAdapter();
  const repository = new FakeRepositoryAdapter();
  const report = new FakeReportAdapter();

  const exhausted: ReadonlyArray<readonly [string, () => unknown]> = [
    ["spawn_session", () => runtime.spawn_session({ op_key: "op:a:actor_spawn" }, "actor", opaque("p"), "/w", {}, opaque("g"))],
    ["get_turn_result", () => runtime.get_turn_result(opaque<RuntimeTurnHandle>("turn"))],
    ["start", () => workflow.start(opaque("controller"), opaque<WorkflowSpec>("spec"))],
    ["status", () => workflow.status(opaque<WorkflowHandle>("handle"))],
    ["snapshot_canonical", () => repository.snapshot_canonical()],
    ["verify_lineage", () => repository.verify_lineage("0f1e2d", "9a8b7c")],
    ["deliver", () => report.deliver({ op_key: "op:batch:run:X:0:r", channel: "c", payload: null })],
  ];

  for (const [method, call] of exhausted) {
    assert.throws(
      call,
      (error: unknown) =>
        error instanceof TestDoubleError && error.message.includes(`${method}()`),
      `${method} should fail closed when its script is empty`,
    );
  }
});

test("B3-AC10: a failed call is still recorded, keeping the call log complete", () => {
  const workflow = new FakeWorkflowAdapter();
  assert.throws(() => workflow.status(opaque<WorkflowHandle>("handle")), TestDoubleError);
  assert.deepEqual(
    workflow.calls.map((call) => call.method),
    ["status"],
  );
});
