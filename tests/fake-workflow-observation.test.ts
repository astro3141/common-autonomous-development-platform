/**
 * B3-AC6 (dynamic half) — observation placement: `status(handle)` is the adapter primitive and
 * returns the normalized WorkflowObservation. The Coordinator-side `observe()` is out of scope for
 * this batch, so only the placement contract is proven here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowHandle, WorkflowSpec, WorkflowControllerHandle } from "../adapters/interfaces/handles.ts";
import type { WorkflowObservation } from "../adapters/interfaces/workflow-adapter.ts";
import { FakeWorkflowAdapter } from "../testdoubles/fake-workflow-adapter.ts";

const opaque = <T>(label: string): T => ({ label }) as unknown as T;

const observation = (state: string, attempt: number): WorkflowObservation => ({
  state,
  stage: "verification",
  attempt,
  refs: { run: "r-1" },
});

test("B3-AC6: status() returns scripted observations in order", () => {
  const workflow = new FakeWorkflowAdapter();
  const handle = opaque<WorkflowHandle>("handle");
  const scripted = [observation("RUNNING", 1), observation("RUNNING", 2), observation("DONE", 2)];
  workflow.observations.push(...scripted);

  const polled = [workflow.status(handle), workflow.status(handle), workflow.status(handle)];

  assert.deepEqual(polled, scripted);
  assert.deepEqual(
    workflow.calls.map((call) => call.method),
    ["status", "status", "status"],
  );
  assert.deepEqual(workflow.calls[0]?.args, [handle]);
});

test("B3-AC6: the observation carries the normalized TD §14.2 fields", () => {
  const workflow = new FakeWorkflowAdapter();
  workflow.observations.push({ state: "DONE", stage: "verification", attempt: 2, terminal: true, refs: {} });

  const result = workflow.status(opaque<WorkflowHandle>("handle"));

  assert.deepEqual(Object.keys(result).sort(), ["attempt", "refs", "stage", "state", "terminal"]);
  assert.equal(result.terminal, true);
});

test("B3-AC6: the fake exposes no observe() and no event or callback machinery", () => {
  const workflow = new FakeWorkflowAdapter();
  const surface = [
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(workflow) as object),
    ...Object.keys(workflow),
  ];

  assert.equal(surface.includes("observe"), false);
  assert.equal(
    surface.some((name) => /^(on|subscribe|unsubscribe|emit|addListener|watch)/.test(name)),
    false,
    `unexpected event machinery in ${surface.join(", ")}`,
  );
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(workflow) as object)
      .filter((name) => name !== "constructor")
      .sort(),
    ["audit_decide", "cancel", "recover", "resume", "start", "status"],
  );
});

test("B3-AC6: trusted-context calls take the controller handle Core received from the Runtime", () => {
  const workflow = new FakeWorkflowAdapter();
  const controller = opaque<WorkflowControllerHandle>("controller");
  const handle = opaque<WorkflowHandle>("handle");
  workflow.handles.push(handle);

  workflow.start(controller, opaque<WorkflowSpec>("spec"));
  workflow.audit_decide(controller, handle, "AUDIT_PASS", []);

  assert.equal(workflow.calls[0]?.args[0], controller);
  assert.equal(workflow.calls[1]?.args[0], controller);
  assert.equal(workflow.calls[1]?.args[1], handle);
});

test("M0-8: ownership-resolving operations take the workflow handle alone", () => {
  const workflow = new FakeWorkflowAdapter();
  const handle = opaque<WorkflowHandle>("handle");
  workflow.observations.push(observation("RUNNING", 1));

  workflow.status(handle);
  workflow.resume(handle);
  workflow.cancel(handle);
  workflow.recover(handle);

  for (const call of workflow.calls) {
    assert.deepEqual(call.args, [handle], `${call.method} must receive only the workflow handle`);
  }
  assert.deepEqual(
    workflow.calls.map((call) => call.method),
    ["status", "resume", "cancel", "recover"],
  );
});
