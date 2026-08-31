/**
 * Deterministic contracts of the production Backend v1 adapters (IG-2 / IG-3).
 *
 * These are the generic semantics the TD closed — operation identity, fail-closed conflicts,
 * result-channel arming order, controller checks — proven at the adapter boundary with scripted
 * seams. Live backend execution is explicitly not here: it is deferred backend validation behind
 * RA-4 (PREFLIGHT Stage 2: deterministic tests only).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BackendRuntimeAdapter,
  BackendWorkflowAdapter,
  BackendWorkflowAdapterError,
  RuntimeOperationConflict,
  TurnNotObservable,
} from "../adapters/backend-v1/index.ts";
import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeTurnHandle,
  WorkflowControllerHandle,
  WorkflowSpec,
} from "../adapters/interfaces/handles.ts";
import {
  AUDITOR_VERDICT_PROTOCOL,
  RuntimeResultChannel,
  ResultChannelConflict,
} from "../adapters/runtime-result-channel/index.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import { ScriptedGateway } from "./support/deployment-fixtures.ts";

const GRANT = { grant: "g" } as unknown as CapabilityGrant;
const PROFILE = "actor-agent" as unknown as RuntimeProfile;

function runtimeWorld() {
  const root = mkdtempSync(join(tmpdir(), "adp-channel-"));
  const gateway = new ScriptedGateway();
  const channel = new RuntimeResultChannel(root);
  const adapter = new BackendRuntimeAdapter({ gateway, channel });
  return {
    root,
    gateway,
    channel,
    adapter,
    spawn: (op: string, cwd = "/work") =>
      adapter.spawn_session({ op_key: op }, "ACTOR", PROFILE, cwd, {} as CanonicalObject, GRANT),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("RTA-1: same-op spawn re-acquires the same logical session; different material conflicts", () => {
  const w = runtimeWorld();
  try {
    const first = w.spawn("op:a:actor-spawn");
    const again = w.spawn("op:a:actor-spawn");
    assert.deepEqual(again.session_handle, first.session_handle);
    assert.equal(w.gateway.ensures.length, 1, "the backend was asked once");
    assert.throws(() => w.spawn("op:a:actor-spawn", "/other"), RuntimeOperationConflict);
  } finally {
    w.dispose();
  }
});

test("RTA-2: a conforming spawn result carries no receipt (receipt_supported=false)", () => {
  const w = runtimeWorld();
  try {
    assert.equal(w.spawn("op:a:actor-spawn").enforcement_receipt, undefined);
  } finally {
    w.dispose();
  }
});

test("RTA-3: the result slot is armed before the backend turn starts, with the turn's own identity", () => {
  const w = runtimeWorld();
  try {
    const spawned = w.spawn("op:a:actor-spawn");
    w.adapter.send_turn({ op_key: "op:a:actor-turn:1" }, spawned.session_handle, "do it");
    const turn = w.gateway.turns[0];
    assert.equal(turn?.request_id, "op:a:actor-turn:1", "op_key is the backend requestId");
    // The slot was armed for exactly that turn: a submission lands and nothing else can claim it.
    const ref = `${turn!.session.agent_id}:${turn!.session.session_id}`;
    const submitted = w.channel.submit(ref, AUDITOR_VERDICT_PROTOCOL, { verdict: "AUDIT_PASS", findings: [], reviewed: { candidate_commit: "c", task_contract_hash: "sha256:" + "a".repeat(64), evidence_ids: [] } });
    assert.equal((submitted as { accepted?: boolean }).accepted, true);
  } finally {
    w.dispose();
  }
});

test("RTA-4: a running turn has no fabricated terminal result", () => {
  const w = runtimeWorld();
  try {
    const spawned = w.spawn("op:a:actor-spawn");
    const handle = w.adapter.send_turn({ op_key: "op:a:actor-turn:1" }, spawned.session_handle, "x");
    assert.throws(() => w.adapter.get_turn_result(handle), TurnNotObservable);
  } finally {
    w.dispose();
  }
});

test("RTA-5: a terminal turn returns the envelope; channel content rides as structured output", () => {
  const w = runtimeWorld();
  try {
    const spawned = w.spawn("op:a:actor-spawn");
    const handle = w.adapter.send_turn({ op_key: "op:a:t:1" }, spawned.session_handle, "x");
    const turn = w.gateway.turns[0]!;
    const ref = `${turn.session.agent_id}:${turn.session.session_id}`;

    // No submission → TURN_TEXT provenance, no structured output.
    w.gateway.complete(turn.session, turn.request_id);
    const bare = w.adapter.get_turn_result(handle);
    assert.equal(bare.backend_status, "COMPLETED");
    assert.equal(bare.provenance.result_channel, "TURN_TEXT");
    assert.equal(bare.provenance.identity_authority, "BACKEND");
    assert.equal(bare.structured_output, undefined);

    // With a submission → RUNTIME_RESULT_CHANNEL provenance and the exact body. The channel
    // accepts exactly the auditor-verdict protocol (RA-2b); anything else stays TURN_TEXT.
    const verdict = {
      verdict: "AUDIT_PASS",
      findings: [],
      reviewed: {
        candidate_commit: "c",
        task_contract_hash: `sha256:${"a".repeat(64)}`,
        evidence_ids: [],
      },
    };
    const submitted = w.channel.submit(ref, AUDITOR_VERDICT_PROTOCOL, verdict);
    assert.equal((submitted as { accepted?: boolean }).accepted, true);
    const collected = w.adapter.get_turn_result(handle);
    assert.equal(collected.provenance.result_channel, "RUNTIME_RESULT_CHANNEL");
    assert.equal(collected.structured_output?.protocol, AUDITOR_VERDICT_PROTOCOL);
  } finally {
    w.dispose();
  }
});

test("RTA-6: a new turn on the same session retires the previous slot; an unknown slot fails closed", () => {
  const w = runtimeWorld();
  try {
    const spawned = w.spawn("op:a:actor-spawn");
    w.adapter.send_turn({ op_key: "op:a:t:1" }, spawned.session_handle, "one");
    // Same session, next turn: the previous slot is retired, arming succeeds.
    w.adapter.send_turn({ op_key: "op:a:t:2" }, spawned.session_handle, "two");
    assert.equal(w.gateway.turns.length, 2);

    // A *fresh adapter* over the same channel does not know the armed turn — arming a different
    // turn now fails closed instead of guessing which slot to destroy (I-TD12).
    const second = new BackendRuntimeAdapter({ gateway: w.gateway, channel: w.channel });
    assert.throws(
      () => second.send_turn({ op_key: "op:a:t:3" }, spawned.session_handle, "three"),
      ResultChannelConflict,
    );
    assert.equal(w.gateway.turns.length, 2, "no backend turn started for the refused arm");
  } finally {
    w.dispose();
  }
});

// --- workflow adapter ---------------------------------------------------------------------------

class ScriptedTransport {
  readonly invocations: Record<string, unknown>[] = [];
  answers: unknown[] = [];
  invoke(request: Readonly<Record<string, unknown>>): unknown {
    this.invocations.push({ ...request });
    if (this.answers.length === 0) throw new Error("no scripted answer");
    return this.answers.shift();
  }
}

const CONTROLLER = {
  controller_agent_id: "platform-controller",
  controller_session_id: "managed",
} as unknown as WorkflowControllerHandle;

function workflowWorld() {
  const transport = new ScriptedTransport();
  const adapter = new BackendWorkflowAdapter({
    transport,
    controller_binding: () =>
      ({
        controller_agent_id: "platform-controller",
        controller_session_id: "managed",
      }) as unknown as CanonicalObject,
  });
  return { transport, adapter };
}

test("WFA-1: start maps to the tool, records the association and returns the workflow handle", () => {
  const { transport, adapter } = workflowWorld();
  transport.answers = [{ workflowId: "wf-1" }];
  const handle = adapter.start(CONTROLLER, { request_id: "op:x:verify:c" } as unknown as WorkflowSpec);
  assert.deepEqual(handle, { workflow_id: "wf-1" });
  assert.equal(transport.invocations[0]?.["action"], "start");
  assert.equal(transport.invocations[0]?.["requestId"], "op:x:verify:c");
});

test("WFA-2: a controller the transport does not speak as is refused before any backend call", () => {
  const { transport, adapter } = workflowWorld();
  const wrong = { controller_agent_id: "someone-else" } as unknown as WorkflowControllerHandle;
  assert.throws(
    () => adapter.start(wrong, { request_id: "r" } as unknown as WorkflowSpec),
    BackendWorkflowAdapterError,
  );
  assert.equal(transport.invocations.length, 0, "fail-closed before the wire");
});

test("WFA-3: status normalizes the backend projection and answers for the right workflow only", () => {
  const { transport, adapter } = workflowWorld();
  transport.answers = [{ workflowId: "wf-1" }];
  const handle = adapter.start(CONTROLLER, { request_id: "r" } as unknown as WorkflowSpec);

  transport.answers = [
    {
      workflowId: "wf-1",
      workflowState: "RUNNING",
      stages: [
        { stageId: "s1", stageName: "unit", stageState: "RUNNING", currentAttempt: 2 },
      ],
    },
  ];
  const observation = adapter.status(handle);
  assert.equal(observation.state, "RUNNING");
  assert.equal(observation.stage, "unit");
  assert.equal(observation.attempt, 2);
  assert.equal(observation.terminal, false);
  assert.deepEqual(observation.refs, { workflow_id: "wf-1" });

  transport.answers = [{ workflowId: "wf-OTHER", workflowState: "RUNNING", stages: [] }];
  assert.throws(() => adapter.status(handle), BackendWorkflowAdapterError);
});

test("WFA-4: audit_decide carries the verdict and evidence through the tool", () => {
  const { transport, adapter } = workflowWorld();
  transport.answers = [{ workflowId: "wf-1" }];
  const handle = adapter.start(CONTROLLER, { request_id: "r" } as unknown as WorkflowSpec);
  transport.answers = [{ ok: true }];
  adapter.audit_decide(CONTROLLER, handle, "PASS", [
    {
      evidence_id: "e1",
      check_id: "unit",
      result: "PASS",
      assurance_level: "REEXECUTED",
      target_commit: "c",
      task_contract_hash: `sha256:${"a".repeat(64)}`,
      executor_identity: "verifier",
      timestamp: "t",
    },
  ]);
  const call = transport.invocations.at(-1);
  assert.equal(call?.["action"], "audit_decide");
  assert.equal(call?.["verdict"], "PASS");
  assert.equal((call?.["evidence"] as unknown[]).length, 1);
});

test("WFA-5: a transport failure is fail-closed, never a fabricated answer", () => {
  const { transport, adapter } = workflowWorld();
  transport.answers = [{ workflowId: "wf-1" }];
  const handle = adapter.start(CONTROLLER, { request_id: "r" } as unknown as WorkflowSpec);
  assert.throws(() => adapter.status(handle), /no scripted answer/);
});
