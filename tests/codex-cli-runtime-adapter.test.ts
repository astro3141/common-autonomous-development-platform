import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
} from "../adapters/interfaces/handles.ts";
import {
  CODEX_CLI_INSPECTED_SOURCE_COMMIT,
  CODEX_CLI_INSPECTED_VERSION,
  CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE,
  CodexCliBackendCapabilityGap,
  CodexCliRuntimeAdapter,
  CodexCliRuntimeOperationConflict,
  codexCliPilotManifests,
  type CodexCliCommandObservation,
  type CodexCliInvocation,
  type CodexCliProcessRunner,
  type CodexCliRuntimeAdapterConfig,
} from "../adapters/codex-cli-runtime/index.ts";
import { validateManifestSet } from "../core/capability/manifest-set.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import { DECISION_TYPES } from "../core/profile/types.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";

const NOW = "2026-09-01T00:00:00.000Z";

class ScriptedRunner implements CodexCliProcessRunner {
  readonly invocations: CodexCliInvocation[] = [];
  readonly turns: CodexCliCommandObservation[] = [];
  version = CODEX_CLI_INSPECTED_VERSION;
  loggedIn = true;

  run(invocation: CodexCliInvocation): CodexCliCommandObservation {
    this.invocations.push(invocation);
    if (invocation.args.length === 1 && invocation.args[0] === "--version") {
      return observation({ stdout: `${this.version}\n` });
    }
    if (invocation.args[0] === "login") {
      return this.loggedIn
        ? observation({ stdout: "Logged in using ChatGPT\n" })
        : observation({ exit_code: 1, stderr: "Not logged in\n" });
    }
    const next = this.turns.shift();
    if (next === undefined) throw new Error("no scripted Codex turn");
    return next;
  }
}

function observation(
  overrides: Partial<CodexCliCommandObservation> = {},
): CodexCliCommandObservation {
  return {
    started_at: NOW,
    completed_at: NOW,
    exit_code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timed_out: false,
    error_code: null,
    ...overrides,
  };
}

function completedTurn(thread_id: string, response: CanonicalObject): CodexCliCommandObservation {
  return observation({
    stdout: [
      { type: "thread.started", thread_id },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: JSON.stringify(response) },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 2,
          cache_write_input_tokens: 0,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  });
}

function failedTurn(thread_id: string, message: string): CodexCliCommandObservation {
  return observation({
    exit_code: 1,
    stdout: [
      { type: "thread.started", thread_id },
      { type: "turn.started" },
      { type: "turn.failed", error: { message } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  });
}

function config(root: string): CodexCliRuntimeAdapterConfig {
  return {
    adapter_instance_id: "codex-cli-test",
    cli_executable: "/opt/homebrew/bin/codex",
    expected_cli_version: CODEX_CLI_INSPECTED_VERSION,
    state_root: join(root, "state"),
    default_cwd: root,
    turn_timeout_seconds: 30,
    profiles: {
      "supervisor-agent": { provider: "openai", model: "gpt-5.6-sol", sandbox: "read-only" },
      "actor-agent": { provider: "openai", model: "gpt-5.6-sol", sandbox: "workspace-write" },
      "auditor-agent": { provider: "openai", model: "gpt-5.6-sol", sandbox: "read-only" },
    },
  };
}

function spawnActor(adapter: CodexCliRuntimeAdapter): RuntimeSessionHandle {
  return adapter.spawn_session(
    { op_key: "op:actor:spawn" },
    "ACTOR",
    "actor-agent" as unknown as RuntimeProfile,
    "/workspace",
    { task_ref: "TASK-1" },
    {} as CapabilityGrant,
  ).session_handle;
}

function spawnSupervisor(adapter: CodexCliRuntimeAdapter): RuntimeSessionHandle {
  return adapter.spawn_session(
    { op_key: "op:supervisor:spawn" },
    "SUPERVISOR",
    "supervisor-agent" as unknown as RuntimeProfile,
    "/workspace",
    { run_id: "run-1" },
    {} as CapabilityGrant,
  ).session_handle;
}

test("Codex CLI adapter advertises only inspected/configured capability and preflights auth", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const runner = new ScriptedRunner();
    const adapter = new CodexCliRuntimeAdapter(config(root), runner);
    assert.deepEqual(adapter.preflight(), { status: "READY" });
    const advertised = adapter.capabilityAdvertisement();
    assert.equal(advertised.cli_version, CODEX_CLI_INSPECTED_VERSION);
    assert.equal(advertised.inspected_source_commit, CODEX_CLI_INSPECTED_SOURCE_COMMIT);
    assert.equal(advertised.model_catalog, null);
    assert.equal(advertised.execution.explicit_thread_resume, true);
    assert.equal(advertised.execution.create_only_session, false);
    assert.equal(advertised.execution.active_turn_cancellation, false);

    runner.loggedIn = false;
    assert.equal(adapter.preflight().status, "BLOCKED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn uses a bounded real initialization turn and send uses explicit thread resume", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const runner = new ScriptedRunner();
    runner.turns.push(
      completedTurn("thread-actor", { ready: true }),
      completedTurn("thread-actor", {
        declared_status: "DONE",
        summary: "implemented",
        refs: ["src/feature.txt"],
      }),
    );
    const adapter = new CodexCliRuntimeAdapter(config(root), runner);
    const session = spawnActor(adapter);
    const turn = adapter.send_turn({ op_key: "op:actor:turn:1" }, session, "implement");
    const result = adapter.get_turn_result(turn);

    const execInvocations = runner.invocations.filter((entry) => entry.args[0] === "exec");
    assert.equal(execInvocations.length, 2);
    assert.equal(execInvocations[0]?.args.includes("resume"), false);
    const resumeAt = execInvocations[1]?.args.indexOf("resume") ?? -1;
    assert.notEqual(resumeAt, -1);
    assert.equal(execInvocations[1]?.args[resumeAt + 1], "thread-actor");
    assert.equal(execInvocations[1]?.args.includes("--ignore-user-config"), true);
    assert.equal(execInvocations[1]?.args.includes("--ignore-rules"), true);
    assert.equal(execInvocations[1]?.args.includes("--json"), true);
    assert.equal(execInvocations[1]?.args.includes("--output-schema"), true);
    assert.equal(execInvocations[1]?.args.includes("workspace-write"), false);
    assert.equal(execInvocations[1]?.args.includes("--approve-for-me"), false);
    assert.equal(execInvocations[1]?.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(
      execInvocations[1]?.args.includes(
        `default_permissions=${JSON.stringify(CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE)}`,
      ),
      true,
    );
    const filesystem = execInvocations[1]?.args.find((arg) =>
      arg.startsWith(`permissions.${CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE}.filesystem=`),
    );
    assert.match(filesystem ?? "", /"\."="write"/);
    assert.match(filesystem ?? "", /"\.git\/"="write"/);
    assert.match(filesystem ?? "", /"\.git\/config"="read"/);
    assert.match(filesystem ?? "", /"\.git\/hooks\/"="read"/);
    assert.match(filesystem ?? "", /"\.git\/objects\/info\/"="read"/);
    assert.match(filesystem ?? "", /"\.git\/commondir"="read"/);
    assert.match(filesystem ?? "", /"\.git\/gitdir"="read"/);
    assert.match(filesystem ?? "", /"\.git\/worktrees"="read"/);
    assert.match(filesystem ?? "", /"\.git\/worktrees\/"="read"/);

    assert.equal(result.backend_status, "COMPLETED");
    assert.equal(result.structured_output?.protocol, "codex-cli-actor-turn-result-v1");
    assert.equal(result.model_declared_outcome?.declared_status, "DONE");
    assert.deepEqual(result.execution_observation?.actual.provider, { availability: "UNKNOWN" });
    assert.deepEqual(result.execution_observation?.actual.model, { availability: "UNKNOWN" });
    assert.equal(result.execution_observation?.usage.kind, "REPORTED");
    if (result.execution_observation?.usage.kind === "REPORTED") {
      assert.equal(result.execution_observation.usage.quantities["input"]?.value, 11);
      assert.equal(result.execution_observation.usage.quantities["input"]?.unit, "token");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SUPERVISOR schema exposes the complete Core vocabulary and exact subflow parent intent", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const runner = new ScriptedRunner();
    const proposal = {
      proposal_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0G01",
      decision: "START_SUBFLOW",
      task_ref: "child-task",
      classification: "feature",
      pipeline_id: "standard",
      actor_profile: "actor",
      verification_profile: "verify",
      repository_scope_id: "repo",
      parent: {
        task_key: "parent-task",
        attempt_key: "parent-attempt",
        task_contract_hash: "contract-hash",
        attempt_state: "ACTIVE",
      },
      expected: {
        task_version: "1",
        task_definition_hash: "definition-hash",
        base_head: "abc123",
        compiled_profile_hash: "profile-hash",
      },
      reason_refs: ["reason-1"],
    };
    runner.turns.push(
      completedTurn("thread-supervisor", { ready: true }),
      completedTurn("thread-supervisor", {
        proposal,
        declared_status: "DONE",
        summary: "selected subflow",
        refs: [],
      }),
    );
    const adapter = new CodexCliRuntimeAdapter(config(root), runner);
    const session = spawnSupervisor(adapter);
    const turn = adapter.send_turn({ op_key: "op:supervisor:turn:1" }, session, "select");

    const invocation = runner.invocations.filter((entry) => entry.args[0] === "exec")[1];
    const schemaAt = invocation?.args.indexOf("--output-schema") ?? -1;
    const schema = JSON.parse(readFileSync(invocation!.args[schemaAt + 1]!, "utf8")) as any;
    const variants = schema.properties.proposal.anyOf as any[];
    assert.deepEqual(
      [...new Set(variants.flatMap((variant) => variant.properties.decision.enum))].toSorted(),
      DECISION_TYPES.toSorted(),
    );
    for (const variant of variants) {
      assert.deepEqual(variant.required.toSorted(), Object.keys(variant.properties).toSorted());
      const expected = variant.properties.expected;
      assert.deepEqual(expected.required.toSorted(), Object.keys(expected.properties).toSorted());
    }
    const subflow = variants.find(
      (variant) =>
        variant.properties.decision.enum.includes("START_SUBFLOW") &&
        Object.hasOwn(variant.properties, "parent"),
    );
    assert.deepEqual(
      Object.keys(subflow.properties.parent.properties).sort(),
      ["attempt_key", "attempt_state", "task_contract_hash", "task_key"],
    );
    assert.equal(subflow.properties.parent.type, "object");
    assert.equal(subflow.required.includes("parent"), true);
    assert.deepEqual(validateProposal(proposal), {
      ...proposal,
      variant: "SUBFLOW_SELECTION",
      decision: "START_SUBFLOW",
    });
    const parentlessSubflow = variants.find(
      (variant) =>
        variant.properties.decision.enum.includes("START_SUBFLOW") &&
        !Object.hasOwn(variant.properties, "parent"),
    );
    assert.notEqual(parentlessSubflow, undefined, "the schema must not pre-empt Core V1");
    const { parent: _parent, ...parentless } = proposal;
    void _parent;
    assert.throws(() => validateProposal(parentless));
    assert.deepEqual(adapter.get_turn_result(turn).structured_output?.body, proposal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SUPERVISOR adapter parsing fails closed when proposal is malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const runner = new ScriptedRunner();
    runner.turns.push(
      completedTurn("thread-supervisor-malformed", { ready: true }),
      completedTurn("thread-supervisor-malformed", {
        proposal: "not-an-object",
        declared_status: "DONE",
        summary: "malformed",
        refs: [],
      }),
    );
    const adapter = new CodexCliRuntimeAdapter(config(root), runner);
    const session = spawnSupervisor(adapter);
    const turn = adapter.send_turn({ op_key: "op:supervisor:malformed" }, session, "select");
    assert.equal(adapter.get_turn_result(turn).structured_output, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-process operation identity is idempotent and conflicting material fails", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const runner = new ScriptedRunner();
    runner.turns.push(
      completedTurn("thread-idempotent", { ready: true }),
      completedTurn("thread-idempotent", {
        declared_status: "DONE",
        summary: "done",
        refs: [],
      }),
    );
    const adapter = new CodexCliRuntimeAdapter(config(root), runner);
    const session = spawnActor(adapter);
    assert.equal(spawnActor(adapter), session);
    const first = adapter.send_turn({ op_key: "op:turn:same" }, session, "one");
    const second = adapter.send_turn({ op_key: "op:turn:same" }, session, "one");
    assert.equal(second, first);
    assert.throws(
      () => adapter.send_turn({ op_key: "op:turn:same" }, session, "different"),
      CodexCliRuntimeOperationConflict,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backend turn failure is terminal evidence, while unsupported control capabilities fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const runner = new ScriptedRunner();
    runner.turns.push(
      completedTurn("thread-failed", { ready: true }),
      failedTurn("thread-failed", "model rejected"),
    );
    const adapter = new CodexCliRuntimeAdapter(config(root), runner);
    const session = spawnActor(adapter);
    const turn = adapter.send_turn({ op_key: "op:actor:failed" }, session, "implement");
    const result = adapter.get_turn_result(turn);
    assert.equal(result.backend_status, "RUNTIME_ERROR");
    assert.match(result.termination_reason, /model rejected/);
    assert.equal(result.execution_observation?.failure_attribution?.reporter, "BACKEND");
    assert.throws(() => adapter.cancel_session(session), /BACKEND_CAPABILITY_GAP/);
    assert.throws(() => adapter.acquire_workflow_controller(), /BACKEND_CAPABILITY_GAP/);
    adapter.close_session(session);
    assert.equal(
      (adapter.get_session_status(session) as unknown as { state: string }).state,
      "CLOSED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninspected versions, providers and model profiles fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    assert.throws(
      () =>
        new CodexCliRuntimeAdapter(
          { ...config(root), expected_cli_version: "codex-cli 9.9.9" },
          new ScriptedRunner(),
        ),
      /BACKEND_CAPABILITY_GAP/,
    );
    const invalid = config(root) as unknown as {
      profiles: Record<string, { provider: string; model: string; sandbox: string }>;
    };
    invalid.profiles["actor-agent"] = {
      provider: "grok",
      model: "grok-code",
      sandbox: "workspace-write",
    };
    assert.throws(
      () => new CodexCliRuntimeAdapter(invalid as unknown as CodexCliRuntimeAdapterConfig, new ScriptedRunner()),
      /BACKEND_CAPABILITY_GAP/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest records the exact matrix and unsupported restart/reacquisition honestly", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const manifests = validateManifestSet(
      codexCliPilotManifests({ backend_instance_id: "backend-test" }, config(root)),
    );
    const features = manifests.runtime.body.features as Record<string, unknown>;
    assert.equal(features["active_turn_cancellation"], false);
    assert.equal(features["spawn_op_reacquisition_after_adapter_restart"], false);
    assert.equal(features["turn_op_reacquisition_after_adapter_restart"], false);
    assert.equal(features["in_flight_turn_reacquisition"], false);
    assert.equal(features["explicit_thread_resume_across_cli_processes"], true);
    assert.equal(features["resolved_model_identity"], "UNAVAILABLE_IN_JSONL");
    assert.equal(features["isolated_workspace_git_commit"], true);
    assert.equal(
      features["workspace_git_permission_profile"],
      CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE,
    );
    assert.equal(features["git_config_write"], false);
    assert.equal(features["git_hooks_write"], false);
    assert.equal(features["git_object_redirection_write"], false);
    assert.equal(features["git_commondir_write"], false);
    assert.equal(features["git_gitdir_write"], false);
    assert.equal(features["git_worktrees_metadata_write"], false);
    assert.equal(features["approval_elevation"], false);
    assert.equal(manifests.runtime.body.receipt_supported, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a projected thread handle can resume after a CLI process exit, but turn result reacquisition cannot", () => {
  const root = mkdtempSync(join(tmpdir(), "adp-codex-cli-unit-"));
  try {
    const firstRunner = new ScriptedRunner();
    firstRunner.turns.push(completedTurn("thread-persisted", { ready: true }));
    const first = new CodexCliRuntimeAdapter(config(root), firstRunner);
    const session = spawnActor(first);

    const secondRunner = new ScriptedRunner();
    secondRunner.turns.push(
      completedTurn("thread-persisted", {
        declared_status: "DONE",
        summary: "resumed",
        refs: [],
      }),
    );
    const second = new CodexCliRuntimeAdapter(config(root), secondRunner);
    const turn = second.send_turn({ op_key: "op:after:adapter:restart" }, session, "continue");
    assert.equal(second.get_turn_result(turn).backend_status, "COMPLETED");
    const third = new CodexCliRuntimeAdapter(config(root), new ScriptedRunner());
    assert.throws(() => third.get_turn_result(turn), /result reacquisition.*unsupported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
