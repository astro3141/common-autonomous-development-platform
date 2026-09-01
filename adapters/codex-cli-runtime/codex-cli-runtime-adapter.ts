/**
 * RuntimeAdapter over the inspected `codex exec` JSONL and explicit thread-resume seam.
 *
 * ADP remains the sole owner of role semantics, selection, verification/audit, recovery,
 * evidence and merge policy. The CLI supplies only model turns and their native observations.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import { canonicalize } from "../../core/schemas/canonical-json.ts";
import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeSessionStatus,
  RuntimeTurnHandle,
  WorkflowControllerHandle,
} from "../interfaces/handles.ts";
import type {
  RuntimeAdapter,
  RuntimeOperationContextV1,
  RuntimePreflight,
  RuntimeSpawnResult,
  RuntimeTurnResult,
} from "../interfaces/runtime-adapter.ts";
import type {
  CodexCliCommandObservation,
  CodexCliInvocation,
  CodexCliProcessRunner,
  CodexCliRuntimeAdapterConfig,
  CodexCliRuntimeProfileBinding,
} from "./types.ts";

export const CODEX_CLI_RUNTIME_BACKEND = "codex-cli-runtime-v1";
export const CODEX_CLI_INSPECTED_VERSION = "codex-cli 0.151.0";
export const CODEX_CLI_INSPECTED_SOURCE_TAG = "rust-v0.151.0";
export const CODEX_CLI_INSPECTED_SOURCE_COMMIT =
  "78c290807ce710180111df227df3b7a4fe845452";
export const CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE =
  "adp-isolated-workspace-commit";
export const CODEX_CLI_SUPERVISOR_PROPOSAL_PROTOCOL = "platform-supervisor-proposal-v1";
export const CODEX_CLI_ACTOR_RESULT_PROTOCOL = "codex-cli-actor-turn-result-v1";
export const CODEX_CLI_AUDITOR_VERDICT_PROTOCOL = "platform-auditor-verdict-v1";

export class CodexCliBackendCapabilityGap extends Error {
  readonly code = "BACKEND_CAPABILITY_GAP";

  constructor(detail: string) {
    super(`BACKEND_CAPABILITY_GAP: ${detail}`);
    this.name = "CodexCliBackendCapabilityGap";
  }
}

export class CodexCliRuntimeOperationConflict extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CodexCliRuntimeOperationConflict";
  }
}

interface CodexCliSessionHandleValue extends CanonicalObject {
  readonly adapter: typeof CODEX_CLI_RUNTIME_BACKEND;
  readonly adapter_instance_id: string;
  readonly thread_id: string;
  readonly requested_provider: "openai";
  readonly requested_model: string;
  readonly cli_version: string;
  readonly role: string;
  readonly runtime_profile: string;
  readonly cwd: string;
  readonly sandbox: "read-only" | "workspace-write";
}

interface CodexCliTurnHandleValue extends CanonicalObject {
  readonly adapter: typeof CODEX_CLI_RUNTIME_BACKEND;
  readonly adapter_instance_id: string;
  readonly thread_id: string;
  readonly requested_provider: "openai";
  readonly requested_model: string;
  readonly cli_version: string;
  readonly role: string;
  readonly runtime_profile: string;
  readonly cwd: string;
  readonly sandbox: "read-only" | "workspace-write";
  readonly turn_ref: string;
  readonly op_key: string;
}

interface ParsedCodexTurn {
  readonly thread_id: string | null;
  readonly terminal: "COMPLETED" | "FAILED" | "MISSING";
  readonly terminal_reason: string;
  readonly final_text: string | null;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly event_count: number;
  readonly parse_error: string | null;
}

interface StoredTurn {
  readonly material_hash: string;
  readonly handle: CodexCliTurnHandleValue;
  readonly result: RuntimeTurnResult;
}

export interface CodexCliCapabilityAdvertisement {
  readonly cli_version: string;
  readonly inspected_source_tag: string;
  readonly inspected_source_commit: string;
  /** There is no no-cost catalogue in the inspected `codex exec` surface. */
  readonly model_catalog: null;
  readonly profiles: Readonly<Record<string, CodexCliRuntimeProfileBinding>>;
  readonly execution: {
    readonly non_interactive_turn: true;
    readonly explicit_thread_resume: true;
    readonly jsonl_result_observation: true;
    readonly usage_observation: true;
    readonly isolated_workspace_git_commit: true;
    readonly git_config_write: false;
    readonly git_hooks_write: false;
    readonly create_only_session: false;
    readonly backend_session_status_query: false;
    readonly backend_session_close: false;
    readonly active_turn_cancellation: false;
    readonly spawn_op_reacquisition_after_adapter_restart: false;
    readonly turn_op_reacquisition_after_adapter_restart: false;
    readonly in_flight_turn_reacquisition: false;
  };
}

const digest = (value: CanonicalObject): string =>
  `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

const textDigest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const asProfileId = (runtime_profile: RuntimeProfile): string =>
  runtime_profile as unknown as string;

export class CodexCliRuntimeAdapter implements RuntimeAdapter {
  readonly #config: CodexCliRuntimeAdapterConfig;
  readonly #runner: CodexCliProcessRunner;
  readonly #spawns = new Map<
    string,
    { readonly material_hash: string; readonly handle: CodexCliSessionHandleValue }
  >();
  readonly #turnsByOperation = new Map<string, StoredTurn>();
  readonly #turnsByRef = new Map<string, StoredTurn>();
  readonly #closedThreads = new Set<string>();
  #observedVersion: string | undefined;

  constructor(config: CodexCliRuntimeAdapterConfig, runner: CodexCliProcessRunner) {
    validateConfig(config);
    this.#config = config;
    this.#runner = runner;
    mkdirSync(resolve(config.state_root, "schemas"), { recursive: true, mode: 0o700 });
  }

  capabilityAdvertisement(): CodexCliCapabilityAdvertisement {
    const cli_version = this.#version();
    return {
      cli_version,
      inspected_source_tag: CODEX_CLI_INSPECTED_SOURCE_TAG,
      inspected_source_commit: CODEX_CLI_INSPECTED_SOURCE_COMMIT,
      model_catalog: null,
      profiles: this.#config.profiles,
      execution: {
        non_interactive_turn: true,
        explicit_thread_resume: true,
        jsonl_result_observation: true,
        usage_observation: true,
        isolated_workspace_git_commit: true,
        git_config_write: false,
        git_hooks_write: false,
        create_only_session: false,
        backend_session_status_query: false,
        backend_session_close: false,
        active_turn_cancellation: false,
        spawn_op_reacquisition_after_adapter_restart: false,
        turn_op_reacquisition_after_adapter_restart: false,
        in_flight_turn_reacquisition: false,
      },
    };
  }

  preflight(): ReturnType<RuntimePreflight> {
    try {
      this.capabilityAdvertisement();
      const login = this.#runner.run({
        executable: this.#config.cli_executable,
        args: ["login", "status"],
        cwd: this.#config.default_cwd,
        timeout_ms: 10_000,
      });
      if (login.exit_code !== 0 || login.timed_out) {
        return {
          status: "BLOCKED",
          reasons: [
            `codex login status failed (${commandFailure(login)})`,
          ],
        };
      }
      return { status: "READY" };
    } catch (error) {
      return {
        status: "BLOCKED",
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  spawn_session(
    operation_context: RuntimeOperationContextV1,
    role: string,
    runtime_profile: RuntimeProfile,
    cwd: string,
    bootstrap_context: CanonicalObject,
    capability_grant: CapabilityGrant,
  ): RuntimeSpawnResult {
    const profileId = asProfileId(runtime_profile);
    const binding = this.#binding(profileId);
    const preflight = this.preflight();
    if (preflight.status === "BLOCKED") {
      throw new CodexCliBackendCapabilityGap(preflight.reasons.join("; "));
    }
    const effectiveCwd = cwd.length === 0 ? this.#config.default_cwd : cwd;
    const material_hash = digest({
      role,
      runtime_profile: profileId,
      cwd: effectiveCwd,
      bootstrap_context,
      capability_grant: capability_grant as unknown as CanonicalObject,
    });
    const prior = this.#spawns.get(operation_context.op_key);
    if (prior !== undefined) {
      if (prior.material_hash !== material_hash) {
        throw new CodexCliRuntimeOperationConflict(
          `${operation_context.op_key} was reused with different spawn material`,
        );
      }
      return { session_handle: prior.handle as unknown as RuntimeSessionHandle };
    }

    // `codex exec` 0.151.0 has no create-only command. A bounded initialization turn is the only
    // inspected way to obtain the backend thread id required by RuntimeAdapter.spawn_session.
    const initialized = this.#execute(
      binding,
      effectiveCwd,
      role,
      initializationPrompt(role, bootstrap_context),
      initializationSchema(),
      undefined,
    );
    if (
      initialized.status !== "COMPLETED" ||
      initialized.parsed.thread_id === null ||
      initialized.response?.["ready"] !== true
    ) {
      throw new CodexCliBackendCapabilityGap(
        `Codex CLI could not establish a session for ${profileId}: ${initialized.reason}`,
      );
    }
    const handle: CodexCliSessionHandleValue = {
      adapter: CODEX_CLI_RUNTIME_BACKEND,
      adapter_instance_id: this.#config.adapter_instance_id,
      thread_id: initialized.parsed.thread_id,
      requested_provider: binding.provider,
      requested_model: binding.model,
      cli_version: this.#config.expected_cli_version,
      role,
      runtime_profile: profileId,
      cwd: effectiveCwd,
      sandbox: binding.sandbox,
    };
    this.#spawns.set(operation_context.op_key, { material_hash, handle });
    return { session_handle: handle as unknown as RuntimeSessionHandle };
  }

  send_turn(
    operation_context: RuntimeOperationContextV1,
    session_handle: RuntimeSessionHandle,
    instruction: string,
  ): RuntimeTurnHandle {
    const session = this.#session(session_handle);
    if (this.#closedThreads.has(session.thread_id)) {
      throw new CodexCliBackendCapabilityGap(`session ${session.thread_id} is locally closed`);
    }
    const material_hash = digest({
      session_handle: session,
      instruction,
    });
    const prior = this.#turnsByOperation.get(operation_context.op_key);
    if (prior !== undefined) {
      if (prior.material_hash !== material_hash) {
        throw new CodexCliRuntimeOperationConflict(
          `${operation_context.op_key} was reused with different turn material`,
        );
      }
      return prior.handle as unknown as RuntimeTurnHandle;
    }

    const binding: CodexCliRuntimeProfileBinding = {
      provider: session.requested_provider,
      model: session.requested_model,
      sandbox: session.sandbox,
    };
    const executed = this.#execute(
      binding,
      session.cwd,
      session.role,
      turnPrompt(session.role, instruction),
      roleSchema(session.role),
      session.thread_id,
    );
    if (
      executed.parsed.thread_id !== null &&
      executed.parsed.thread_id !== session.thread_id
    ) {
      throw new CodexCliBackendCapabilityGap(
        `resume returned thread ${executed.parsed.thread_id}, expected ${session.thread_id}`,
      );
    }
    const turn_ref = digest({
      adapter_instance_id: this.#config.adapter_instance_id,
      thread_id: session.thread_id,
      op_key: operation_context.op_key,
    });
    const handle: CodexCliTurnHandleValue = {
      ...session,
      turn_ref,
      op_key: operation_context.op_key,
    };
    const structured = structuredOutput(session.role, executed.response);
    const declared = declaredOutcome(executed.response);
    const result: RuntimeTurnResult = {
      schema_version: 2,
      session_handle,
      turn_handle: handle as unknown as RuntimeTurnHandle,
      backend_status: executed.status,
      termination_reason: executed.reason,
      started_at: executed.observation.started_at,
      completed_at: executed.observation.completed_at,
      provenance: {
        runtime_backend: CODEX_CLI_RUNTIME_BACKEND,
        identity_authority: "BACKEND",
        result_channel: structured === undefined ? "TURN_TEXT" : "STRUCTURED_PROTOCOL",
      },
      ...(structured === undefined ? {} : { structured_output: structured }),
      ...(declared === undefined ? {} : { model_declared_outcome: declared }),
      backend_native_refs: {
        cli_version: this.#config.expected_cli_version,
        cli_source_tag: CODEX_CLI_INSPECTED_SOURCE_TAG,
        cli_source_commit: CODEX_CLI_INSPECTED_SOURCE_COMMIT,
        thread_id: session.thread_id,
        turn_ref,
        requested_provider: session.requested_provider,
        requested_model: session.requested_model,
        exit_code: executed.observation.exit_code,
        signal: executed.observation.signal,
        event_count: executed.parsed.event_count,
        stdout_digest: textDigest(executed.observation.stdout),
        stderr_digest: textDigest(executed.observation.stderr),
        ...(executed.parsed.parse_error === null
          ? {}
          : { jsonl_parse_error: executed.parsed.parse_error }),
      },
      execution_observation: {
        op_key: operation_context.op_key,
        subject: { kind: "UNKNOWN" },
        role: "UNKNOWN",
        role_profile_id: "",
        runtime_profile: session.runtime_profile,
        requested_binding_ref: digest({
          provider: session.requested_provider,
          model: session.requested_model,
          sandbox: session.sandbox,
          cli_version: session.cli_version,
        }),
        actual: {
          // JSONL 0.151.0 reports thread identity but omits effective provider and resolved model.
          provider: { availability: "UNKNOWN" },
          model: { availability: "UNKNOWN" },
          binding_ref: { availability: "UNKNOWN" },
        },
        timing: {
          started_at: executed.observation.started_at,
          completed_at: executed.observation.completed_at,
        },
        usage:
          executed.parsed.usage === null
            ? { kind: "UNKNOWN" }
            : { kind: "REPORTED", quantities: usageQuantities(executed.parsed.usage) },
        cost: { kind: "UNKNOWN" },
        failure_attribution:
          executed.status === "COMPLETED"
            ? null
            : {
                domain: "RUNTIME_INFRASTRUCTURE",
                detail_code: failureCode(executed),
                source_ref: turn_ref,
                reporter: executed.parsed.terminal === "FAILED" ? "BACKEND" : "PLATFORM",
                retryable: { kind: "UNKNOWN" },
              },
      },
    };
    const stored = { material_hash, handle, result };
    this.#turnsByOperation.set(operation_context.op_key, stored);
    this.#turnsByRef.set(turn_ref, stored);
    return handle as unknown as RuntimeTurnHandle;
  }

  get_turn_result(turn_handle: RuntimeTurnHandle): RuntimeTurnResult {
    const turn = this.#turn(turn_handle);
    const stored = this.#turnsByRef.get(turn.turn_ref);
    if (stored === undefined) {
      throw new CodexCliBackendCapabilityGap(
        "turn result reacquisition after adapter restart is unsupported",
      );
    }
    return stored.result;
  }

  get_session_status(session_handle: RuntimeSessionHandle): RuntimeSessionStatus {
    const session = this.#session(session_handle);
    // `codex exec` exposes no thread status query. This is explicitly adapter-local state.
    return {
      state: this.#closedThreads.has(session.thread_id) ? "CLOSED" : "READY",
      authority: "ADAPTER_LOCAL",
      thread_id: session.thread_id,
      backend_status_query: "UNSUPPORTED",
    } as unknown as RuntimeSessionStatus;
  }

  cancel_session(_session_handle: RuntimeSessionHandle): void {
    throw new CodexCliBackendCapabilityGap(
      "active-turn cancellation is unsupported by this synchronous Codex CLI pilot adapter",
    );
  }

  close_session(session_handle: RuntimeSessionHandle): void {
    const session = this.#session(session_handle);
    // The CLI process already exited and `codex exec` has no close-thread command.
    this.#closedThreads.add(session.thread_id);
  }

  acquire_workflow_controller(): WorkflowControllerHandle {
    throw new CodexCliBackendCapabilityGap(
      "Codex CLI exposes no ADP WorkflowControllerHandle; it is an execution backend only",
    );
  }

  #version(): string {
    if (this.#observedVersion !== undefined) return this.#observedVersion;
    const observed = this.#runner.run({
      executable: this.#config.cli_executable,
      args: ["--version"],
      cwd: this.#config.default_cwd,
      timeout_ms: 10_000,
    });
    const version = observed.stdout.trim();
    if (observed.exit_code !== 0 || observed.timed_out || version !== this.#config.expected_cli_version) {
      throw new CodexCliBackendCapabilityGap(
        `expected ${JSON.stringify(this.#config.expected_cli_version)}, observed ${JSON.stringify(version)} (${commandFailure(observed)})`,
      );
    }
    this.#observedVersion = version;
    return version;
  }

  #binding(profileId: string): CodexCliRuntimeProfileBinding {
    const binding = this.#config.profiles[profileId];
    if (binding === undefined) {
      throw new CodexCliBackendCapabilityGap(
        `runtime_profile ${JSON.stringify(profileId)} is not in the configured Codex CLI matrix`,
      );
    }
    return binding;
  }

  #execute(
    binding: CodexCliRuntimeProfileBinding,
    cwd: string,
    role: string,
    prompt: string,
    schema: CanonicalObject,
    resumeThreadId: string | undefined,
  ): {
    readonly observation: CodexCliCommandObservation;
    readonly parsed: ParsedCodexTurn;
    readonly response: CanonicalObject | null;
    readonly status: RuntimeTurnResult["backend_status"];
    readonly reason: string;
  } {
    this.#version();
    const schemaPath = this.#schemaPath(role, schema);
    const args = [
      "exec",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--json",
      "--model",
      binding.model,
      ...sandboxArgs(binding),
      "--output-schema",
      schemaPath,
      "-C",
      cwd,
      ...(resumeThreadId === undefined ? [] : ["resume", resumeThreadId]),
      "-",
    ];
    const invocation: CodexCliInvocation = {
      executable: this.#config.cli_executable,
      args,
      cwd,
      stdin: prompt,
      timeout_ms: this.#config.turn_timeout_seconds * 1_000,
    };
    const observation = this.#runner.run(invocation);
    const parsed = parseJsonl(observation.stdout);
    const response = parseResponse(parsed.final_text);
    const status = backendStatus(observation, parsed);
    return {
      observation,
      parsed,
      response,
      status,
      reason: terminationReason(observation, parsed),
    };
  }

  #schemaPath(role: string, schema: CanonicalObject): string {
    const hash = digest({ role, schema }).slice("sha256:".length);
    const path = resolve(this.#config.state_root, "schemas", `${hash}.json`);
    writeFileSync(path, `${JSON.stringify(schema)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  #session(handle: RuntimeSessionHandle): CodexCliSessionHandleValue {
    const value = handle as unknown as Partial<CodexCliSessionHandleValue>;
    if (
      value.adapter !== CODEX_CLI_RUNTIME_BACKEND ||
      value.adapter_instance_id !== this.#config.adapter_instance_id ||
      typeof value.thread_id !== "string" ||
      value.thread_id.length === 0 ||
      value.requested_provider !== "openai" ||
      typeof value.requested_model !== "string" ||
      value.cli_version !== this.#config.expected_cli_version ||
      typeof value.role !== "string" ||
      typeof value.runtime_profile !== "string" ||
      typeof value.cwd !== "string" ||
      (value.sandbox !== "read-only" && value.sandbox !== "workspace-write")
    ) {
      throw new CodexCliBackendCapabilityGap(
        "session handle is not owned by this Codex CLI adapter instance",
      );
    }
    const configured = this.#binding(value.runtime_profile);
    if (
      configured.provider !== value.requested_provider ||
      configured.model !== value.requested_model ||
      configured.sandbox !== value.sandbox
    ) {
      throw new CodexCliBackendCapabilityGap(
        `session binding no longer matches runtime_profile ${value.runtime_profile}`,
      );
    }
    return value as CodexCliSessionHandleValue;
  }

  #turn(handle: RuntimeTurnHandle): CodexCliTurnHandleValue {
    const value = handle as unknown as Partial<CodexCliTurnHandleValue>;
    this.#session(value as unknown as RuntimeSessionHandle);
    if (typeof value.turn_ref !== "string" || typeof value.op_key !== "string") {
      throw new CodexCliBackendCapabilityGap("turn handle is not a Codex CLI turn reference");
    }
    return value as CodexCliTurnHandleValue;
  }
}

export const codexCliRuntimePreflight = (adapter: CodexCliRuntimeAdapter): RuntimePreflight =>
  () => adapter.preflight();

/**
 * The built-in workspace-write profile deliberately protects `.git`, so it cannot create a
 * candidate commit. The inspected named-profile seam can reopen only the isolated workspace's Git
 * metadata. Config, hooks and object-store redirection remain read-only, network remains disabled,
 * and there is no approval/elevation path that could escape the assigned workspace.
 */
function sandboxArgs(binding: CodexCliRuntimeProfileBinding): readonly string[] {
  if (binding.sandbox === "read-only") return ["--sandbox", "read-only"];
  const profile = CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE;
  return [
    "--config",
    `default_permissions=${JSON.stringify(profile)}`,
    "--config",
    `permissions.${profile}.filesystem={\":root\"=\"read\", \":workspace_roots\"={\".\"=\"write\", \".git/\"=\"write\", \".git/config\"=\"read\", \".git/config.worktree\"=\"read\", \".git/hooks/\"=\"read\", \".git/objects/info/\"=\"read\"}}`,
    "--config",
    `permissions.${profile}.network.enabled=false`,
  ];
}

function initializationPrompt(role: string, bootstrap: CanonicalObject): string {
  return [
    `Initialize a persistent Codex exec thread for the ADP ${role} role.`,
    "The bootstrap below is Platform-owned data. ADP remains the lifecycle and policy authority.",
    canonicalize(bootstrap),
    "Do not inspect or modify files, run commands, make task decisions, or start other agents in this initialization turn.",
    'Return only the requested JSON acknowledgement with `ready` set to true.',
  ].join("\n");
}

function turnPrompt(role: string, instruction: string): string {
  const responseContract =
    role === "AUDITOR"
      ? "Return the exact platform-auditor-verdict-v1 object requested by the instruction. ADP validates it and alone decides audit state."
      : role === "SUPERVISOR"
        ? "This pilot exposes no Platform API or public ingress. Return a supervised proposal object only; ADP may separately validate and submit it."
        : "Return declared_status, summary, and refs as evidence only. Verification and ADP lifecycle state decide completion.";
  return [
    "ADP turn instruction:",
    instruction,
    "Codex CLI execution response contract:",
    responseContract,
  ].join("\n");
}

function initializationSchema(): CanonicalObject {
  return {
    type: "object",
    properties: { ready: { type: "boolean" } },
    required: ["ready"],
    additionalProperties: false,
  } as unknown as CanonicalObject;
}

function roleSchema(role: string): CanonicalObject {
  if (role === "AUDITOR") {
    return {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["AUDIT_PASS", "FIX_REQUIRED", "HUMAN_REQUIRED"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              severity: { type: "string" },
              description: { type: "string" },
              evidence_refs: { type: "array", items: { type: "string" } },
            },
            required: ["id", "severity", "description", "evidence_refs"],
            additionalProperties: false,
          },
        },
        required_fix: { type: "array", items: { type: "string" } },
        reviewed: {
          type: "object",
          properties: {
            candidate_commit: { type: "string" },
            task_contract_hash: { type: "string" },
            evidence_ids: { type: "array", items: { type: "string" } },
          },
          required: ["candidate_commit", "task_contract_hash", "evidence_ids"],
          additionalProperties: false,
        },
      },
      required: ["verdict", "findings", "required_fix", "reviewed"],
      additionalProperties: false,
    } as unknown as CanonicalObject;
  }
  const outcome = {
    declared_status: {
      type: "string",
      enum: ["DONE", "BLOCKED", "NEEDS_INPUT", "FAILED"],
    },
    summary: { type: "string" },
    refs: { type: "array", items: { type: "string" } },
  };
  if (role === "SUPERVISOR") {
    return {
      type: "object",
      properties: {
        proposal: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["START_TASK", "NO_ACTION"] },
            task_ref: { type: ["string", "null"] },
            reason_refs: { type: "array", items: { type: "string" } },
          },
          required: ["decision", "task_ref", "reason_refs"],
          additionalProperties: false,
        },
        ...outcome,
      },
      required: ["proposal", "declared_status", "summary", "refs"],
      additionalProperties: false,
    } as unknown as CanonicalObject;
  }
  return {
    type: "object",
    properties: outcome,
    required: ["declared_status", "summary", "refs"],
    additionalProperties: false,
  } as unknown as CanonicalObject;
}

function parseJsonl(stdout: string): ParsedCodexTurn {
  let thread_id: string | null = null;
  let terminal: ParsedCodexTurn["terminal"] = "MISSING";
  let terminal_reason = "codex exec emitted no terminal event";
  let final_text: string | null = null;
  let usage: Readonly<Record<string, number>> | null = null;
  let event_count = 0;
  let parse_error: string | null = null;
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("event is not an object");
      }
      event = parsed as Record<string, unknown>;
    } catch (error) {
      parse_error = `line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    event_count += 1;
    if (event["type"] === "thread.started" && typeof event["thread_id"] === "string") {
      thread_id = event["thread_id"];
    } else if (event["type"] === "item.completed") {
      const item = event["item"];
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        if (record["type"] === "agent_message" && typeof record["text"] === "string") {
          final_text = record["text"];
        }
      }
    } else if (event["type"] === "turn.completed") {
      terminal = "COMPLETED";
      terminal_reason = "turn.completed";
      usage = numericRecord(event["usage"]);
    } else if (event["type"] === "turn.failed") {
      terminal = "FAILED";
      const error = event["error"];
      terminal_reason =
        typeof error === "object" && error !== null && !Array.isArray(error) &&
        typeof (error as Record<string, unknown>)["message"] === "string"
          ? (error as Record<string, string>)["message"]!
          : "turn.failed";
    } else if (event["type"] === "error" && typeof event["message"] === "string") {
      terminal_reason = event["message"];
    }
  }
  return {
    thread_id,
    terminal,
    terminal_reason,
    final_text,
    usage,
    event_count,
    parse_error,
  };
}

function numericRecord(value: unknown): Readonly<Record<string, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result: Record<string, number> = {};
  for (const [key, quantity] of Object.entries(value)) {
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) return null;
    result[key] = quantity;
  }
  return result;
}

function parseResponse(text: string | null): CanonicalObject | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as CanonicalObject)
      : null;
  } catch {
    return null;
  }
}

function backendStatus(
  observation: CodexCliCommandObservation,
  parsed: ParsedCodexTurn,
): RuntimeTurnResult["backend_status"] {
  if (observation.timed_out) return "TIMEOUT";
  if (parsed.terminal === "FAILED") return "RUNTIME_ERROR";
  if (
    observation.exit_code !== 0 ||
    parsed.terminal !== "COMPLETED" ||
    parsed.parse_error !== null
  ) {
    return "RUNTIME_ERROR";
  }
  return "COMPLETED";
}

function terminationReason(
  observation: CodexCliCommandObservation,
  parsed: ParsedCodexTurn,
): string {
  if (observation.timed_out) return "codex exec timed out";
  if (parsed.parse_error !== null) return `invalid Codex JSONL: ${parsed.parse_error}`;
  if (parsed.terminal === "FAILED") return parsed.terminal_reason;
  if (observation.exit_code !== 0) return commandFailure(observation);
  return parsed.terminal_reason;
}

function commandFailure(observation: CodexCliCommandObservation): string {
  const stderr = observation.stderr.trim();
  return [
    `exit=${observation.exit_code ?? "null"}`,
    `signal=${observation.signal ?? "null"}`,
    `error=${observation.error_code ?? "null"}`,
    ...(stderr.length === 0 ? [] : [`stderr=${stderr.slice(0, 500)}`]),
  ].join(" ");
}

function usageQuantities(
  usage: Readonly<Record<string, number>>,
): Readonly<Record<string, { readonly value: number; readonly unit: string }>> {
  // Core persists this observation in adapter_metadata, whose I-TD7 key denylist correctly
  // rejects any nested key containing `token`. Preserve the five inspected JSONL quantities under
  // neutral metric names; the unit remains the non-key value `token`.
  const names: Readonly<Record<string, string>> = {
    input_tokens: "input",
    cached_input_tokens: "cached_input",
    cache_write_input_tokens: "cache_write_input",
    output_tokens: "output",
    reasoning_output_tokens: "reasoning_output",
  };
  return Object.fromEntries(
    Object.entries(usage).flatMap(([key, value]) => {
      const name = names[key];
      return name === undefined ? [] : [[name, { value, unit: "token" }]];
    }),
  );
}

function failureCode(executed: {
  readonly observation: CodexCliCommandObservation;
  readonly parsed: ParsedCodexTurn;
}): string {
  if (executed.observation.timed_out) return "CLI_TIMEOUT";
  if (executed.parsed.parse_error !== null) return "INVALID_JSONL";
  if (executed.parsed.terminal === "FAILED") return "TURN_FAILED";
  if (executed.observation.exit_code !== 0) return "CLI_NONZERO_EXIT";
  return "MISSING_TERMINAL_EVENT";
}

function structuredOutput(
  role: string,
  response: CanonicalObject | null,
): RuntimeTurnResult["structured_output"] | undefined {
  if (response === null) return undefined;
  if (role === "AUDITOR") {
    return { protocol: CODEX_CLI_AUDITOR_VERDICT_PROTOCOL, body: response };
  }
  if (role === "SUPERVISOR") {
    const proposal = response["proposal"];
    if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) return undefined;
    return {
      protocol: CODEX_CLI_SUPERVISOR_PROPOSAL_PROTOCOL,
      body: proposal as CanonicalObject,
    };
  }
  return { protocol: CODEX_CLI_ACTOR_RESULT_PROTOCOL, body: response };
}

function declaredOutcome(
  response: CanonicalObject | null,
): RuntimeTurnResult["model_declared_outcome"] | undefined {
  if (response === null) return undefined;
  const raw = response["declared_status"];
  const summary = response["summary"];
  const refs = response["refs"];
  if (
    (raw !== "DONE" && raw !== "BLOCKED" && raw !== "NEEDS_INPUT" && raw !== "FAILED") ||
    typeof summary !== "string" ||
    !Array.isArray(refs) ||
    refs.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  return { declared_status: raw, summary, refs: refs as string[] };
}

function validateConfig(config: CodexCliRuntimeAdapterConfig): void {
  const required = [
    config.adapter_instance_id,
    config.cli_executable,
    config.expected_cli_version,
    config.state_root,
    config.default_cwd,
  ];
  if (required.some((value) => value.length === 0)) {
    throw new CodexCliBackendCapabilityGap(
      "Codex CLI adapter configuration contains an empty required value",
    );
  }
  if (config.expected_cli_version !== CODEX_CLI_INSPECTED_VERSION) {
    throw new CodexCliBackendCapabilityGap(
      `only inspected version ${CODEX_CLI_INSPECTED_VERSION} is supported`,
    );
  }
  if (!Number.isInteger(config.turn_timeout_seconds) || config.turn_timeout_seconds <= 0) {
    throw new CodexCliBackendCapabilityGap("turn_timeout_seconds must be a positive integer");
  }
  const profiles = Object.entries(config.profiles);
  if (profiles.length === 0) {
    throw new CodexCliBackendCapabilityGap("at least one exact runtime_profile binding is required");
  }
  for (const [profile, binding] of profiles) {
    if (
      profile.length === 0 ||
      binding.provider !== "openai" ||
      binding.model.length === 0 ||
      (binding.sandbox !== "read-only" && binding.sandbox !== "workspace-write")
    ) {
      throw new CodexCliBackendCapabilityGap(
        `unsupported provider/model/sandbox binding for ${JSON.stringify(profile)}`,
      );
    }
  }
}
