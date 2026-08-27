/**
 * M0-7 — the RuntimeAdapter boundary can carry a CapabilityEnforcementReceipt out of
 * `spawn_session` (TD §12.6, §13.1).
 *
 * These tests prove *representation* only. Receipt content validation, the Manifest and the V10
 * policy check belong to the Capability/Coordinator batch, and the fake performs none of them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { CapabilityEnforcementReceipt } from "../adapters/interfaces/capability.ts";
import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
} from "../adapters/interfaces/handles.ts";
import type { RuntimeSpawnResult } from "../adapters/interfaces/runtime-adapter.ts";
import { FakeRuntimeAdapter, TestDoubleError } from "../testdoubles/index.ts";

const opaque = <T>(label: string): T => ({ label }) as unknown as T;

const receiptFor = (session: RuntimeSessionHandle): CapabilityEnforcementReceipt => ({
  receipt_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0ABC",
  grant_hash: `sha256:${"1".repeat(64)}`,
  backend_manifest_hash: `sha256:${"2".repeat(64)}`,
  session_handle: session,
  applied: {
    "repository.feature_write": "AVAILABLE_WITH_REDUCED_ASSURANCE",
    "repository.canonical_write": "UNENFORCEABLE_CAPABILITY_BOUNDARY",
    "shell.execute": "NOT_YET_AUDITED",
  },
  applied_means: ["boundary-a", "boundary-b", "boundary-c"],
  issued_at: "t1",
});

const spawn = (runtime: FakeRuntimeAdapter): RuntimeSpawnResult =>
  runtime.spawn_session(
    { op_key: "op:att-1:actor_spawn" },
    "actor",
    opaque<RuntimeProfile>("profile"),
    "/workspace",
    { seed: 1 },
    opaque<CapabilityGrant>("grant"),
  );

test("R1: a receipt-supported spawn delivers handle and receipt together", () => {
  const runtime = new FakeRuntimeAdapter();
  const session = opaque<RuntimeSessionHandle>("session");
  const receipt = receiptFor(session);
  runtime.sessions.push({ session_handle: session, enforcement_receipt: receipt });

  const result = spawn(runtime);

  assert.equal(result.session_handle, session);
  assert.equal(result.enforcement_receipt, receipt);
  assert.deepEqual(
    runtime.calls.map((call) => call.method),
    ["spawn_session"],
  );
});

test("R2: the receipt's session_handle binds to the very handle the spawn returned", () => {
  const runtime = new FakeRuntimeAdapter();
  const session = opaque<RuntimeSessionHandle>("session");
  runtime.sessions.push({ session_handle: session, enforcement_receipt: receiptFor(session) });

  const result = spawn(runtime);

  assert.equal(result.enforcement_receipt?.session_handle, result.session_handle);
});

test("R2: a mismatched binding is representable, so a caller can detect and fail closed", () => {
  const runtime = new FakeRuntimeAdapter();
  const session = opaque<RuntimeSessionHandle>("session");
  const other = opaque<RuntimeSessionHandle>("other-session");
  runtime.sessions.push({ session_handle: session, enforcement_receipt: receiptFor(other) });

  const result = spawn(runtime);

  // The fake does not judge this — it only shows the boundary can express the mismatch that
  // TD §12.6 requires the Coordinator to reject before send_turn.
  assert.notEqual(result.enforcement_receipt?.session_handle, result.session_handle);
});

test("R3: a spawn without a receipt is just an absent field — no unsupported variant", () => {
  const runtime = new FakeRuntimeAdapter();
  const session = opaque<RuntimeSessionHandle>("session");
  runtime.sessions.push({ session_handle: session });

  const result = spawn(runtime);

  assert.equal(result.session_handle, session);
  assert.equal(result.enforcement_receipt, undefined);
  assert.deepEqual(Object.keys(result), ["session_handle"]);
});

test("R3: the fake performs no manifest or policy validation of its own", () => {
  const runtime = new FakeRuntimeAdapter();
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(runtime) as object);

  assert.deepEqual(surface.filter((name) => name !== "constructor").sort(), [
    "acquire_workflow_controller",
    "cancel_session",
    "close_session",
    "get_session_status",
    "get_turn_result",
    "send_turn",
    "spawn_session",
  ]);
  assert.equal(
    surface.some((name) => /manifest|policy|validate|receipt/i.test(name)),
    false,
  );
});

test("M0-7: spawn keeps the existing call recording and fail-closed script behaviour", () => {
  const runtime = new FakeRuntimeAdapter();

  assert.throws(() => spawn(runtime), TestDoubleError);
  assert.deepEqual(runtime.calls.map((call) => call.method), ["spawn_session"]);
  assert.deepEqual(runtime.calls[0]?.args[0], { op_key: "op:att-1:actor_spawn" });
  assert.deepEqual(runtime.calls[0]?.args[1], "actor");

  const first = opaque<RuntimeSessionHandle>("first");
  const second = opaque<RuntimeSessionHandle>("second");
  runtime.sessions.push(
    { session_handle: first, enforcement_receipt: receiptFor(first) },
    { session_handle: second },
  );

  assert.equal(spawn(runtime).session_handle, first);
  assert.equal(spawn(runtime).enforcement_receipt, undefined);
  assert.equal(runtime.calls.length, 3);
});
