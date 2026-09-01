/**
 * Multi-provider CLI agent RuntimeAdapter (#73/#49/#50 + #51) — contract controls over a
 * scripted process runner. Live verticals are the bring-up phase's job; these seal the adapter's
 * authority, identity and honesty boundaries against the measured envelopes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_CODE_PROVIDER,
  CliAgentBackendCapabilityGap,
  CliAgentRuntimeAdapter,
  CliAgentRuntimeOperationConflict,
  GROK_PROVIDER,
  SECOND_AGENT_PROVIDER,
  cliAgentPilotManifests,
  type CliAgentCommandObservation,
  type CliAgentInvocation,
  type CliAgentRuntimeAdapterConfig,
} from "../adapters/cli-agent-runtime/index.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import type { CapabilityGrant, RuntimeProfile, RuntimeSessionHandle } from "../adapters/interfaces/handles.ts";

class ScriptedRunner {
  readonly invocations: CliAgentInvocation[] = [];
  readonly answers: ((invocation: CliAgentInvocation) => Partial<CliAgentCommandObservation>)[] = [];

  run(invocation: CliAgentInvocation): CliAgentCommandObservation {
    this.invocations.push(invocation);
    // Version probes answer from a fixed table so tests only script model turns.
    if (invocation.args[0] === "--version") {
      const version =
        invocation.executable.includes("claude") ? "2.1.221 (Claude Code)"
        : invocation.executable.includes("second-agent") ? "1.1.22"
        : "grok 1.0.13 (5e9a58528b76) [stable]";
      return observation({ stdout: version });
    }
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`unscripted invocation: ${invocation.args.join(" ")}`);
    return observation(answer(invocation));
  }
}

function observation(overrides: Partial<CliAgentCommandObservation>): CliAgentCommandObservation {
  return {
    started_at: "2026-09-02T13:00:00.000Z",
    completed_at: "2026-09-02T13:00:05.000Z",
    exit_code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timed_out: false,
    error_code: null,
    ...overrides,
  };
}

const GRANT = { grant: "test" } as unknown as CapabilityGrant;
const PROFILE = (id: string): RuntimeProfile => id as unknown as RuntimeProfile;

function config(root: string, overrides: Partial<CliAgentRuntimeAdapterConfig> = {}): CliAgentRuntimeAdapterConfig {
  return {
    adapter_instance_id: "cli-agent-test-1",
    executables: {
      [CLAUDE_CODE_PROVIDER]: "/bin/claude",
      [SECOND_AGENT_PROVIDER]: "/bin/second-agent",
      [GROK_PROVIDER]: "/bin/grok",
    },
    expected_cli_versions: {
      [CLAUDE_CODE_PROVIDER]: "2.1.221",
      [SECOND_AGENT_PROVIDER]: "1.1.22",
      [GROK_PROVIDER]: "grok 1.0.13",
    },
    state_root: root,
    default_cwd: root,
    turn_timeout_seconds: 60,
    profiles: {
      "claude-actor": { provider: CLAUDE_CODE_PROVIDER, model: "claude-sonnet-5", effort: "high" },
      "claude-auditor": { provider: CLAUDE_CODE_PROVIDER, model: "claude-opus-5", effort: "max" },
      "gemini-supervisor": { provider: SECOND_AGENT_PROVIDER, model: "gemini-3.1-pro-high", effort: "low" },
      "grok-actor": { provider: GROK_PROVIDER, model: "grok-4.6-build" },
      "claude-plain": { provider: CLAUDE_CODE_PROVIDER, model: "claude-sonnet-5" },
    },
    ...overrides,
  };
}

const claudeInit = (session = "sess-claude-1") => () => ({
  stdout: JSON.stringify({
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ ready: true }),
    session_id: session,
    usage: { input_tokens: 10, output_tokens: 2 },
    modelUsage: {
      "claude-sonnet-5-20260114": { canonicalModel: "claude-sonnet-5", provider: "firstParty" },
    },
    total_cost_usd: 0.01,
  }),
});

const secondAgentInit = (conversation = "conv-second-1") => () => ({
  stdout: JSON.stringify({
    conversation_id: conversation,
    status: "SUCCESS",
    response: JSON.stringify({ ready: true }),
    usage: { input_tokens: 5, output_tokens: 1 },
  }),
});

const grokInit = (session = "sess-grok-1") => () => ({
  stdout: JSON.stringify({
    text: JSON.stringify({ ready: true }),
    stopReason: "end_turn",
    sessionId: session,
    usage: { input_tokens: 5, output_tokens: 1 },
    modelUsage: { "grok-4.6-build": { inputTokens: 5 } },
    total_cost_usd: 0.002,
  }),
});

function world(): { root: string; runner: ScriptedRunner; adapter: CliAgentRuntimeAdapter; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "adp-cli-agent-"));
  const runner = new ScriptedRunner();
  const adapter = new CliAgentRuntimeAdapter(config(root), runner);
  return { root, runner, adapter, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("CA-1 (#51): two role bindings produce distinct explicit backend requests; UNSPECIFIED sends nothing", () => {
  const w = world();
  try {
    w.runner.answers.push(claudeInit("s-actor"), claudeInit("s-auditor"), claudeInit("s-plain"));
    w.adapter.spawn_session({ op_key: "op:a:spawn" }, "ACTOR", PROFILE("claude-actor"), w.root, {}, GRANT);
    w.adapter.spawn_session({ op_key: "op:b:spawn" }, "AUDITOR", PROFILE("claude-auditor"), w.root, {}, GRANT);
    w.adapter.spawn_session({ op_key: "op:c:spawn" }, "ACTOR", PROFILE("claude-plain"), w.root, {}, GRANT);

    const turns = w.runner.invocations.filter((call) => call.args[0] === "-p");
    const effortOf = (call: CliAgentInvocation): string | null => {
      const index = call.args.indexOf("--effort");
      return index === -1 ? null : (call.args[index + 1] ?? null);
    };
    assert.equal(effortOf(turns[0]!), "high");
    assert.equal(effortOf(turns[1]!), "max", "distinct roles carry distinct explicit efforts");
    assert.equal(effortOf(turns[2]!), null, "UNSPECIFIED is omitted, never silently rewritten");
  } finally {
    w.dispose();
  }
});

test("CA-2 (#51): a wrong effort value fails closed at construction, per measured vocabulary", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-cli-agent-"));
  try {
    assert.throws(
      () =>
        new CliAgentRuntimeAdapter(
          config(root, {
            profiles: { bad: { provider: CLAUDE_CODE_PROVIDER, model: "m", effort: "extreme" } },
          }),
          new ScriptedRunner(),
        ),
      CliAgentBackendCapabilityGap,
    );
    assert.throws(
      () =>
        new CliAgentRuntimeAdapter(
          config(root, { profiles: { bad: { provider: SECOND_AGENT_PROVIDER, model: "m", effort: "xhigh" } } }),
          new ScriptedRunner(),
        ),
      CliAgentBackendCapabilityGap,
      "the second agent tool's measured vocabulary is low|medium|high",
    );
    assert.throws(
      () =>
        new CliAgentRuntimeAdapter(
          config(root, { profiles: { bad: { provider: GROK_PROVIDER, model: "m", effort: "two words" } } }),
          new ScriptedRunner(),
        ),
      CliAgentBackendCapabilityGap,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-3: spawn is op-idempotent, conflicting reuse is refused, resume pins the exact session", () => {
  const w = world();
  try {
    w.runner.answers.push(claudeInit("s-1"));
    const spawned = w.adapter.spawn_session({ op_key: "op:s" }, "ACTOR", PROFILE("claude-actor"), w.root, {}, GRANT);
    const again = w.adapter.spawn_session({ op_key: "op:s" }, "ACTOR", PROFILE("claude-actor"), w.root, {}, GRANT);
    assert.deepEqual(again.session_handle, spawned.session_handle);
    assert.equal(w.runner.invocations.filter((call) => call.args[0] === "-p").length, 1, "one init turn");
    assert.throws(
      () => w.adapter.spawn_session({ op_key: "op:s" }, "ACTOR", PROFILE("claude-actor"), "/elsewhere", {}, GRANT),
      CliAgentRuntimeOperationConflict,
    );

    // A resumed turn must answer as the same backend session; a different id is a broken
    // continuation, fail-closed, never adopted.
    w.runner.answers.push(() => ({
      stdout: JSON.stringify({
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ declared_status: "DONE", summary: "s", refs: [] }),
        session_id: "s-OTHER",
        usage: {},
      }),
    }));
    assert.throws(
      () => w.adapter.send_turn({ op_key: "op:t" }, spawned.session_handle, "do work"),
      CliAgentBackendCapabilityGap,
    );

    w.runner.answers.push(() => ({
      stdout: JSON.stringify({
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ declared_status: "DONE", summary: "s", refs: [] }),
        session_id: "s-1",
        usage: { output_tokens: 3 },
        modelUsage: { "claude-sonnet-5-20260114": { canonicalModel: "claude-sonnet-5", provider: "firstParty" } },
        total_cost_usd: 0.02,
      }),
    }));
    const turn = w.adapter.send_turn({ op_key: "op:t2" }, spawned.session_handle, "do work");
    const resumeCall = w.runner.invocations.at(-1)!;
    assert.equal(resumeCall.args[resumeCall.args.indexOf("--resume") + 1], "s-1");
    const result = w.adapter.get_turn_result(turn);
    assert.equal(result.backend_status, "COMPLETED");
  } finally {
    w.dispose();
  }
});

test("CA-4 (#51): actual identity is REPORTED only where the envelope carries it, never copied", () => {
  const w = world();
  try {
    // claude: modelUsage reports the executed model + provider + cost.
    w.runner.answers.push(claudeInit("s-c"));
    const claude = w.adapter.spawn_session({ op_key: "op:c" }, "ACTOR", PROFILE("claude-actor"), w.root, {}, GRANT);
    w.runner.answers.push(() => ({
      stdout: JSON.stringify({
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ declared_status: "DONE", summary: "s", refs: [] }),
        session_id: "s-c",
        usage: { input_tokens: 9 },
        modelUsage: { "claude-haiku-4-5-20251001": { canonicalModel: "claude-haiku-4-5", provider: "firstParty" } },
        total_cost_usd: 0.016,
      }),
    }));
    const claudeTurn = w.adapter.get_turn_result(
      w.adapter.send_turn({ op_key: "op:c:t" }, claude.session_handle, "work"),
    );
    const claudeObserved = claudeTurn.execution_observation!;
    assert.deepEqual(claudeObserved.actual.model, {
      availability: "REPORTED",
      value: "claude-haiku-4-5",
    }, "the observed model is the backend's record — visibly distinct from the requested one");
    assert.deepEqual(claudeObserved.actual.provider, { availability: "REPORTED", value: "firstParty" });
    assert.equal(claudeObserved.cost.kind, "REPORTED");

    // second agent tool: no model identity and no cost in the measured envelope — honest UNKNOWN.
    w.runner.answers.push(secondAgentInit("c-a"));
    const gemini = w.adapter.spawn_session({ op_key: "op:g" }, "SUPERVISOR", PROFILE("gemini-supervisor"), w.root, {}, GRANT);
    w.runner.answers.push(() => ({
      stdout: JSON.stringify({
        conversation_id: "c-a",
        status: "SUCCESS",
        response: JSON.stringify({
          proposal: { proposal_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA1", decision: "CLOSE_BATCH", expected: { compiled_profile_hash: "h" }, reason_refs: [] },
          declared_status: "DONE",
          summary: "s",
          refs: [],
        }),
        usage: { input_tokens: 4 },
      }),
    }));
    const geminiTurn = w.adapter.get_turn_result(
      w.adapter.send_turn({ op_key: "op:g:t" }, gemini.session_handle, "decide"),
    );
    const geminiObserved = geminiTurn.execution_observation!;
    assert.deepEqual(geminiObserved.actual.model, { availability: "UNKNOWN" });
    assert.deepEqual(geminiObserved.actual.provider, { availability: "UNKNOWN" });
    assert.equal(geminiObserved.cost.kind, "UNKNOWN");
    assert.equal(geminiTurn.structured_output?.protocol, "platform-supervisor-proposal-v1");
  } finally {
    w.dispose();
  }
});

test("CA-5: failure honesty — malformed JSON, non-terminal stop and timeouts are never COMPLETED", () => {
  const w = world();
  try {
    w.runner.answers.push(grokInit("s-g"));
    const grok = w.adapter.spawn_session({ op_key: "op:k" }, "ACTOR", PROFILE("grok-actor"), w.root, {}, GRANT);

    w.runner.answers.push(() => ({ stdout: "not json at all" }));
    const malformed = w.adapter.get_turn_result(
      w.adapter.send_turn({ op_key: "op:k:1" }, grok.session_handle, "work"),
    );
    assert.equal(malformed.backend_status, "RUNTIME_ERROR");
    assert.equal(malformed.execution_observation?.failure_attribution?.detail_code, "INVALID_PRINT_JSON");

    w.runner.answers.push(() => ({
      stdout: JSON.stringify({ text: "partial", stopReason: "max_tokens", sessionId: "s-g", usage: {} }),
    }));
    const truncated = w.adapter.get_turn_result(
      w.adapter.send_turn({ op_key: "op:k:2" }, grok.session_handle, "more work"),
    );
    assert.equal(truncated.backend_status, "RUNTIME_ERROR", "a non-end_turn stop is not completion");

    w.runner.answers.push(() => ({ timed_out: true, exit_code: null }));
    const timedOut = w.adapter.get_turn_result(
      w.adapter.send_turn({ op_key: "op:k:3" }, grok.session_handle, "slow work"),
    );
    assert.equal(timedOut.backend_status, "TIMEOUT");
  } finally {
    w.dispose();
  }
});

test("CA-6: unknown profiles, version drift and foreign handles fail closed; manifest is honest", () => {
  const w = world();
  try {
    assert.throws(
      () => w.adapter.spawn_session({ op_key: "op:x" }, "ACTOR", PROFILE("nope"), w.root, {}, GRANT),
      CliAgentBackendCapabilityGap,
    );
    assert.throws(
      () => w.adapter.send_turn({ op_key: "op:y" }, { foreign: true } as unknown as RuntimeSessionHandle, "hi"),
      CliAgentBackendCapabilityGap,
    );

    const drifted = new CliAgentRuntimeAdapter(
      config(w.root, {
        expected_cli_versions: {
          [CLAUDE_CODE_PROVIDER]: "9.9.9",
          [SECOND_AGENT_PROVIDER]: "1.1.22",
          [GROK_PROVIDER]: "grok 1.0.13",
        },
      }),
      w.runner,
    );
    const preflight = drifted.preflight();
    assert.equal(preflight.status, "BLOCKED", "a version pin mismatch blocks before any turn");

    const manifests = cliAgentPilotManifests({ backend_instance_id: "b1" }, config(w.root));
    const runtimeManifest = manifests.runtime as { body: CanonicalObject };
    const features = runtimeManifest.body["features"] as Record<string, unknown>;
    assert.deepEqual(features["resolved_model_identity"], {
      [SECOND_AGENT_PROVIDER]: "UNAVAILABLE",
      [CLAUDE_CODE_PROVIDER]: "REPORTED",
      [GROK_PROVIDER]: "REPORTED",
    });
    assert.equal(runtimeManifest.body["receipt_supported"], false);
  } finally {
    w.dispose();
  }
});
