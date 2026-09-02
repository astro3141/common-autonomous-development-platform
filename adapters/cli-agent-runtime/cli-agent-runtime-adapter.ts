/**
 * CliAgentRuntimeAdapter — one RuntimeAdapter over the measured print-mode CLI agent seams
 * (#73 Claude Code, #49 AGY/Gemini, #50 Grok), on the same bounded pilot pattern the direct
 * Codex CLI adapter proved.
 *
 * ADP owns lifecycle, roles, policy, capability, verification/audit and merge authority; each
 * CLI owns process execution only. Sessions are backend conversations: none of the measured CLIs
 * has a create-only session primitive, so `spawn_session` runs one bounded initialization turn to
 * obtain the backend session/conversation id, and every later turn resumes that exact id —
 * a resume that comes back with a different id is a fail-closed identity break, never adopted.
 *
 * Requested provider/model/effort are frozen per runtime profile (#51) and are never presented as
 * observed actual identity: the v2 execution observation reports the actually executed model only
 * where the measured envelope authoritatively carries one (claude/grok `modelUsage`), and honest
 * `UNKNOWN` where it does not (agy). Credentials stay ambient behind the CLI; nothing here reads
 * or transports a token.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CanonicalObject, CanonicalValue } from "../../core/schemas/canonical-json.ts";
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
import {
  AUDITOR_VERDICT_PROTOCOL,
  SUPERVISOR_PROPOSAL_PROTOCOL,
  initializationSchema,
  roleSchema,
} from "../runtime-shared/structured-protocol.ts";
import { PROVIDER_SEAMS, type CliAgentProviderSeam } from "./providers.ts";
import type {
  CliAgentCommandObservation,
  CliAgentInvocation,
  CliAgentProcessRunner,
  CliAgentProfileBinding,
  CliAgentRuntimeAdapterConfig,
  ParsedCliAgentTurn,
} from "./types.ts";

export const CLI_AGENT_RUNTIME_BACKEND = "cli-agent-runtime-v1";
export const CLI_AGENT_ACTOR_RESULT_PROTOCOL = "cli-agent-actor-turn-result-v1";

export class CliAgentBackendCapabilityGap extends Error {
  readonly code = "BACKEND_CAPABILITY_GAP";
  constructor(detail: string) {
    super(`BACKEND_CAPABILITY_GAP: ${detail}`);
    this.name = "CliAgentBackendCapabilityGap";
  }
}

export class CliAgentRuntimeOperationConflict extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CliAgentRuntimeOperationConflict";
  }
}

interface CliAgentSessionHandleValue extends CanonicalObject {
  readonly adapter: typeof CLI_AGENT_RUNTIME_BACKEND;
  readonly adapter_instance_id: string;
  readonly provider: string;
  readonly session_ref: string;
  readonly requested_model: string;
  /** #51 — "UNSPECIFIED" when the binding requests none; never a hidden default. */
  readonly requested_effort: string;
  readonly cli_version: string;
  readonly role: string;
  readonly runtime_profile: string;
  readonly cwd: string;
}

interface CliAgentTurnHandleValue extends CliAgentSessionHandleValue {
  readonly turn_ref: string;
  readonly op_key: string;
}

interface ExecutedTurn {
  readonly observation: CliAgentCommandObservation;
  readonly parsed: ParsedCliAgentTurn;
  readonly response: CanonicalObject | null;
  readonly status: RuntimeTurnResult["backend_status"];
  readonly reason: string;
}

export class CliAgentRuntimeAdapter implements RuntimeAdapter {
  readonly #config: CliAgentRuntimeAdapterConfig;
  readonly #runner: CliAgentProcessRunner;
  readonly #spawns = new Map<string, { material_hash: string; handle: CliAgentSessionHandleValue }>();
  readonly #turnsByOperation = new Map<
    string,
    { material_hash: string; handle: CliAgentTurnHandleValue; result: RuntimeTurnResult }
  >();
  readonly #closedSessions = new Set<string>();
  readonly #verified = new Set<string>();

  constructor(config: CliAgentRuntimeAdapterConfig, runner: CliAgentProcessRunner) {
    for (const [profile, binding] of Object.entries(config.profiles)) {
      const seam = PROVIDER_SEAMS[binding.provider];
      if (seam === undefined) {
        throw new CliAgentBackendCapabilityGap(`profile ${profile} names unknown provider`);
      }
      if (config.executables[binding.provider] === undefined) {
        throw new CliAgentBackendCapabilityGap(`no executable configured for ${binding.provider}`);
      }
      if (config.expected_cli_versions[binding.provider] === undefined) {
        throw new CliAgentBackendCapabilityGap(`no expected CLI version pinned for ${binding.provider}`);
      }
      if (binding.model.length === 0) {
        throw new CliAgentBackendCapabilityGap(`profile ${profile} requests an empty model`);
      }
      if (binding.effort !== undefined) {
        if (seam.effort_vocabulary === null) {
          if (binding.effort.trim().length === 0 || /\s/u.test(binding.effort)) {
            throw new CliAgentBackendCapabilityGap(`profile ${profile} requests a malformed effort`);
          }
        } else if (!seam.effort_vocabulary.includes(binding.effort)) {
          throw new CliAgentBackendCapabilityGap(
            `profile ${profile} requests effort ${JSON.stringify(binding.effort)}; ` +
              `${binding.provider} supports ${seam.effort_vocabulary.join("|")}`,
          );
        }
      }
    }
    this.#config = config;
    this.#runner = runner;
  }

  preflight(): ReturnType<RuntimePreflight> {
    const reasons: string[] = [];
    const providers = new Set(Object.values(this.#config.profiles).map((binding) => binding.provider));
    for (const provider of providers) {
      try {
        this.#version(PROVIDER_SEAMS[provider]);
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    return reasons.length === 0 ? { status: "READY" } : { status: "BLOCKED", reasons };
  }

  spawn_session(
    operation_context: RuntimeOperationContextV1,
    role: string,
    runtime_profile: RuntimeProfile,
    cwd: string,
    bootstrap_context: CanonicalObject,
    capability_grant: CapabilityGrant,
  ): RuntimeSpawnResult {
    const profileId = runtime_profile as unknown as string;
    const binding = this.#binding(profileId);
    const seam = PROVIDER_SEAMS[binding.provider];
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
        throw new CliAgentRuntimeOperationConflict(
          `${operation_context.op_key} was reused with different spawn material`,
        );
      }
      return { session_handle: prior.handle as unknown as RuntimeSessionHandle };
    }

    // None of the measured CLIs offers create-only session creation: one bounded initialization
    // turn obtains the backend session/conversation identity the RuntimeAdapter contract needs.
    const initialized = this.#execute(
      seam,
      binding,
      effectiveCwd,
      role,
      initializationPrompt(role, bootstrap_context),
      initializationSchema(),
      undefined,
    );
    if (
      initialized.status !== "COMPLETED" ||
      initialized.parsed.session_ref === null ||
      initialized.response?.["ready"] !== true
    ) {
      throw new CliAgentBackendCapabilityGap(
        `${binding.provider} could not establish a session for ${profileId}: ${initialized.reason}`,
      );
    }
    const handle: CliAgentSessionHandleValue = {
      adapter: CLI_AGENT_RUNTIME_BACKEND,
      adapter_instance_id: this.#config.adapter_instance_id,
      provider: binding.provider,
      session_ref: initialized.parsed.session_ref,
      requested_model: binding.model,
      requested_effort: binding.effort ?? "UNSPECIFIED",
      cli_version: this.#config.expected_cli_versions[binding.provider]!,
      role,
      runtime_profile: profileId,
      cwd: effectiveCwd,
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
    if (this.#closedSessions.has(session.session_ref)) {
      throw new CliAgentBackendCapabilityGap(`session ${session.session_ref} is locally closed`);
    }
    const material_hash = digest({ session_handle: session, instruction });
    const prior = this.#turnsByOperation.get(operation_context.op_key);
    if (prior !== undefined) {
      if (prior.material_hash !== material_hash) {
        throw new CliAgentRuntimeOperationConflict(
          `${operation_context.op_key} was reused with different turn material`,
        );
      }
      return prior.handle as unknown as RuntimeTurnHandle;
    }

    const binding = this.#binding(session.runtime_profile);
    const seam = PROVIDER_SEAMS[binding.provider];
    const executed = this.#execute(
      seam,
      binding,
      session.cwd,
      session.role,
      turnPrompt(session.role, instruction),
      roleSchema(session.role),
      session.session_ref,
    );
    // Identity pinning: a resumed turn answering under a different backend session identity is a
    // broken continuation, never silently adopted.
    if (executed.parsed.session_ref !== null && executed.parsed.session_ref !== session.session_ref) {
      throw new CliAgentBackendCapabilityGap(
        `resume answered as session ${executed.parsed.session_ref}, expected ${session.session_ref}`,
      );
    }

    const turn_ref = digest({
      adapter_instance_id: this.#config.adapter_instance_id,
      session_ref: session.session_ref,
      op_key: operation_context.op_key,
    });
    const handle: CliAgentTurnHandleValue = { ...session, turn_ref, op_key: operation_context.op_key };
    const structured = structuredOutput(session.role, executed.response);
    const result: RuntimeTurnResult = {
      schema_version: 2,
      session_handle,
      turn_handle: handle as unknown as RuntimeTurnHandle,
      backend_status: executed.status,
      termination_reason: executed.reason,
      started_at: executed.observation.started_at,
      completed_at: executed.observation.completed_at,
      provenance: {
        runtime_backend: CLI_AGENT_RUNTIME_BACKEND,
        identity_authority: "BACKEND",
        result_channel: structured === undefined ? "TURN_TEXT" : "STRUCTURED_PROTOCOL",
      },
      ...(structured === undefined ? {} : { structured_output: structured }),
      ...(declaredOutcome(executed.response) === undefined
        ? {}
        : { model_declared_outcome: declaredOutcome(executed.response) }),
      backend_native_refs: {
        provider: binding.provider,
        cli_version: session.cli_version,
        session_ref: session.session_ref,
        turn_ref,
        requested_model: session.requested_model,
        requested_effort: session.requested_effort,
        exit_code: executed.observation.exit_code,
        signal: executed.observation.signal,
        stdout_digest: textDigest(executed.observation.stdout),
        stderr_digest: textDigest(executed.observation.stderr),
      },
      execution_observation: {
        op_key: operation_context.op_key,
        subject: { kind: "UNKNOWN" },
        role: "UNKNOWN",
        role_profile_id: "",
        runtime_profile: session.runtime_profile,
        requested_binding_ref: digest({
          provider: binding.provider,
          model: session.requested_model,
          effort: session.requested_effort,
          cli_version: session.cli_version,
        }),
        actual: {
          provider:
            executed.parsed.actual_provider === null
              ? { availability: "UNKNOWN" }
              : { availability: "REPORTED", value: executed.parsed.actual_provider },
          model:
            executed.parsed.actual_model === null
              ? { availability: "UNKNOWN" }
              : { availability: "REPORTED", value: executed.parsed.actual_model },
          // Review 5503120466 blocker 1 — an actual binding fingerprint exists only when the
          // backend evidences the COMPLETE actual binding: both provider and model REPORTED.
          // A missing leg is never filled from the requested/configured binding — requested
          // facts live in requested_binding_ref, and mixing them here would launder
          // configuration into execution identity.
          binding_ref:
            executed.parsed.actual_model === null || executed.parsed.actual_provider === null
              ? { availability: "UNKNOWN" }
              : {
                  availability: "REPORTED",
                  value: digest({
                    provider: executed.parsed.actual_provider,
                    model: executed.parsed.actual_model,
                  }),
                },
        },
        timing: {
          started_at: executed.observation.started_at,
          completed_at: executed.observation.completed_at,
        },
        usage:
          executed.parsed.usage === null
            ? { kind: "UNKNOWN" }
            : { kind: "REPORTED", quantities: usageQuantities(executed.parsed.usage) },
        cost:
          executed.parsed.cost_usd === null
            ? { kind: "UNKNOWN" }
            : { kind: "REPORTED", value: String(executed.parsed.cost_usd), currency: "USD" },
        failure_attribution:
          executed.status === "COMPLETED"
            ? null
            : {
                domain: "RUNTIME_INFRASTRUCTURE",
                detail_code: failureCode(executed),
                source_ref: turn_ref,
                reporter: executed.parsed.terminal === "FAILED" ? "BACKEND" : "PLATFORM",
                // The measured envelopes carry no retryability statement; nothing is invented.
                retryable: { kind: "UNKNOWN" },
              },
      },
    };
    this.#turnsByOperation.set(operation_context.op_key, { material_hash, handle, result });
    return handle as unknown as RuntimeTurnHandle;
  }

  get_turn_result(turn_handle: RuntimeTurnHandle): RuntimeTurnResult {
    const turn = this.#turn(turn_handle);
    const stored = this.#turnsByOperation.get(turn.op_key);
    if (stored === undefined || stored.handle.turn_ref !== turn.turn_ref) {
      // Honest gap: this pilot adapter cannot reacquire an in-flight or pre-restart turn.
      throw new CliAgentBackendCapabilityGap(
        `turn ${turn.turn_ref} is not resident in this adapter process`,
      );
    }
    return stored.result;
  }

  get_session_status(session_handle: RuntimeSessionHandle): RuntimeSessionStatus {
    const session = this.#session(session_handle);
    // The measured CLIs expose no backend session-status query; local knowledge is all there is.
    return (this.#closedSessions.has(session.session_ref)
      ? "CLOSED"
      : "ACTIVE") as unknown as RuntimeSessionStatus;
  }

  cancel_session(_session_handle: RuntimeSessionHandle): void {
    // Print-mode turns are synchronous child processes; there is no measured cancel primitive for
    // an already-returned turn and no in-flight handle to cancel from outside.
    throw new CliAgentBackendCapabilityGap("active turn cancellation is not supported by this seam");
  }

  close_session(session_handle: RuntimeSessionHandle): void {
    const session = this.#session(session_handle);
    // Local fence only: the backends keep their conversations; nothing external is destroyed.
    this.#closedSessions.add(session.session_ref);
  }

  acquire_workflow_controller(): WorkflowControllerHandle {
    throw new CliAgentBackendCapabilityGap(
      "cli-agent runtime provides no workflow controller; compose a WorkflowAdapter separately",
    );
  }

  // --- internals ---------------------------------------------------------------------------------

  #binding(profileId: string): CliAgentProfileBinding {
    const binding = this.#config.profiles[profileId];
    if (binding === undefined) {
      throw new CliAgentBackendCapabilityGap(`runtime profile ${profileId} is not configured`);
    }
    return binding;
  }

  #version(seam: CliAgentProviderSeam): void {
    if (this.#verified.has(seam.provider_id)) return;
    const executable = this.#config.executables[seam.provider_id]!;
    const expected = this.#config.expected_cli_versions[seam.provider_id]!;
    // Review 5503120466 blocker 2 — the pin names one exact measured semantic version; only
    // the provider's measured presentation decoration around it is tolerated. Substring
    // matching accepted 1.1.220 / 1.1.22-malformed / foo-1.1.22-bar for a 1.1.22 pin.
    const pinned = /^(?:\S+ )?(\d+\.\d+\.\d+)$/u.exec(expected)?.[1];
    if (pinned === undefined) {
      throw new CliAgentBackendCapabilityGap(
        `${seam.provider_id} pin ${JSON.stringify(expected)} does not name an exact version`,
      );
    }
    const observation = this.#runner.run({
      executable,
      args: [...seam.version_args],
      cwd: this.#config.default_cwd,
      timeout_ms: 10_000,
    });
    const line = observation.stdout.trim().split("\n")[0] ?? "";
    const observed = seam.version_pattern.exec(line)?.[1];
    if (observation.exit_code !== 0 || observed === undefined || observed !== pinned) {
      throw new CliAgentBackendCapabilityGap(
        `${seam.provider_id} version ${JSON.stringify(line)} does not exactly match pinned ${JSON.stringify(pinned)}`,
      );
    }
    this.#verified.add(seam.provider_id);
  }

  #execute(
    seam: CliAgentProviderSeam,
    binding: CliAgentProfileBinding,
    cwd: string,
    role: string,
    prompt: string,
    schema: CanonicalObject,
    resume_session_ref: string | undefined,
  ): ExecutedTurn {
    this.#version(seam);
    const schema_json = JSON.stringify(schema);
    const schema_path = this.#schemaPath(role, schema);
    const built = seam.argv({ binding, prompt, schema_json, schema_path, resume_session_ref });
    const invocation: CliAgentInvocation = {
      executable: this.#config.executables[binding.provider]!,
      args: built.args,
      cwd,
      ...(built.stdin === undefined ? {} : { stdin: built.stdin }),
      timeout_ms: this.#config.turn_timeout_seconds * 1_000,
    };
    const observation = this.#runner.run(invocation);
    const parsed = seam.parse(observation);
    const response = parseResponse(parsed.final_text);
    const status = backendStatus(observation, parsed);
    return { observation, parsed, response, status, reason: terminationReason(observation, parsed) };
  }

  #schemaPath(role: string, schema: CanonicalObject): string {
    const hash = digest({ role, schema }).slice("sha256:".length);
    const directory = resolve(this.#config.state_root, "schemas");
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, `${hash}.json`);
    writeFileSync(path, `${JSON.stringify(schema)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  #session(handle: RuntimeSessionHandle): CliAgentSessionHandleValue {
    const value = handle as unknown as Partial<CliAgentSessionHandleValue>;
    if (
      value.adapter !== CLI_AGENT_RUNTIME_BACKEND ||
      value.adapter_instance_id !== this.#config.adapter_instance_id ||
      typeof value.provider !== "string" ||
      typeof value.session_ref !== "string" ||
      value.session_ref.length === 0 ||
      typeof value.requested_model !== "string" ||
      typeof value.requested_effort !== "string" ||
      typeof value.cli_version !== "string" ||
      typeof value.role !== "string" ||
      typeof value.runtime_profile !== "string" ||
      typeof value.cwd !== "string"
    ) {
      throw new CliAgentBackendCapabilityGap(
        "session handle is not owned by this cli-agent adapter instance",
      );
    }
    const configured = this.#binding(value.runtime_profile);
    if (
      configured.provider !== value.provider ||
      configured.model !== value.requested_model ||
      (configured.effort ?? "UNSPECIFIED") !== value.requested_effort ||
      this.#config.expected_cli_versions[configured.provider] !== value.cli_version
    ) {
      throw new CliAgentBackendCapabilityGap(
        `session binding no longer matches runtime_profile ${value.runtime_profile}`,
      );
    }
    return value as CliAgentSessionHandleValue;
  }

  #turn(handle: RuntimeTurnHandle): CliAgentTurnHandleValue {
    const value = handle as unknown as Partial<CliAgentTurnHandleValue>;
    this.#session(value as unknown as RuntimeSessionHandle);
    if (typeof value.turn_ref !== "string" || typeof value.op_key !== "string") {
      throw new CliAgentBackendCapabilityGap("turn handle is not a cli-agent turn reference");
    }
    return value as CliAgentTurnHandleValue;
  }
}

export const cliAgentRuntimePreflight = (adapter: CliAgentRuntimeAdapter): RuntimePreflight =>
  () => adapter.preflight();

// --- prompts / mapping ----------------------------------------------------------------------------

function initializationPrompt(role: string, bootstrap: CanonicalObject): string {
  return [
    `Initialize a persistent agent session for the ADP ${role} role.`,
    "The bootstrap below is Platform-owned data. ADP remains the lifecycle and policy authority.",
    canonicalize(bootstrap),
    "Do not inspect or modify files, run commands, make task decisions, or start other agents in this initialization turn.",
    "Return only the requested JSON acknowledgement with `ready` set to true.",
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
    "CLI agent execution response contract:",
    responseContract,
  ].join("\n");
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

function structuredOutput(
  role: string,
  response: CanonicalObject | null,
): RuntimeTurnResult["structured_output"] | undefined {
  if (response === null) return undefined;
  if (role === "AUDITOR") return { protocol: AUDITOR_VERDICT_PROTOCOL, body: response };
  if (role === "SUPERVISOR") {
    const proposal = response["proposal"];
    if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) return undefined;
    return { protocol: SUPERVISOR_PROPOSAL_PROTOCOL, body: proposal as CanonicalObject };
  }
  return { protocol: CLI_AGENT_ACTOR_RESULT_PROTOCOL, body: response };
}

function declaredOutcome(
  response: CanonicalObject | null,
): RuntimeTurnResult["model_declared_outcome"] | undefined {
  if (response === null) return undefined;
  const raw = response["declared_status"];
  if (raw !== "DONE" && raw !== "BLOCKED" && raw !== "NEEDS_INPUT" && raw !== "FAILED") {
    return undefined;
  }
  const summary = response["summary"];
  const refs = response["refs"];
  return {
    declared_status: raw,
    summary: typeof summary === "string" ? summary : "",
    refs: Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [],
  };
}

function backendStatus(
  observation: CliAgentCommandObservation,
  parsed: ParsedCliAgentTurn,
): RuntimeTurnResult["backend_status"] {
  if (observation.timed_out) return "TIMEOUT";
  if (parsed.terminal === "FAILED") return "RUNTIME_ERROR";
  if (observation.exit_code !== 0 || parsed.terminal !== "COMPLETED" || parsed.parse_error !== null) {
    return "RUNTIME_ERROR";
  }
  return "COMPLETED";
}

function terminationReason(
  observation: CliAgentCommandObservation,
  parsed: ParsedCliAgentTurn,
): string {
  if (observation.timed_out) return "print-mode turn timed out";
  if (parsed.parse_error !== null) return `invalid print-mode JSON: ${parsed.parse_error}`;
  if (parsed.terminal === "FAILED") return parsed.terminal_reason;
  if (observation.exit_code !== 0) {
    const stderr = observation.stderr.trim();
    return `exit=${observation.exit_code ?? "null"} signal=${observation.signal ?? "null"}${
      stderr.length === 0 ? "" : ` stderr=${stderr.slice(0, 500)}`
    }`;
  }
  return parsed.terminal_reason;
}

function failureCode(executed: ExecutedTurn): string {
  if (executed.observation.timed_out) return "CLI_TIMEOUT";
  if (executed.parsed.parse_error !== null) return "INVALID_PRINT_JSON";
  if (executed.parsed.terminal === "FAILED") return "TURN_FAILED";
  if (executed.observation.exit_code !== 0) return "CLI_NONZERO_EXIT";
  return "MISSING_TERMINAL_FACT";
}

function usageQuantities(
  usage: Readonly<Record<string, number>>,
): Readonly<Record<string, { readonly value: number; readonly unit: string }>> {
  // I-TD7 — adapter_metadata rejects nested keys containing `token`; measured quantity names are
  // mapped to neutral metric names, the unit stays the non-key value `token`.
  return Object.fromEntries(
    Object.entries(usage).map(([key, value]) => [
      key.replace(/_?tokens?/gu, "").replace(/^$/u, "total") || key,
      { value, unit: "token" },
    ]),
  );
}

function digest(value: CanonicalValue): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function textDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
