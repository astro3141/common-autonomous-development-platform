/**
 * RuntimeAdapter backed only by Issue-Orchestrator's proven provider/session execution seam.
 *
 * IO owns process execution here and nothing else. ADP still owns task lifecycle, roles,
 * selection, verification/audit policy, recovery authority, evidence and merge policy.
 */

import { createHash } from "node:crypto";

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
  IOBridgeCapabilities,
  IORuntimeAdapterConfig,
  IORuntimeProfileBinding,
  IORuntimeTransport,
  IOTerminalTurnObservation,
} from "./types.ts";

export const IO_RUNTIME_BACKEND = "issue-orchestrator-runtime-v1";
export const IO_SUPERVISOR_PROPOSAL_PROTOCOL = "platform-supervisor-proposal-v1";
export const IO_ACTOR_RESULT_PROTOCOL = "io-actor-turn-result-v1";
export const IO_AUDITOR_VERDICT_PROTOCOL = "platform-auditor-verdict-v1";

/** An unavailable IO capability is always explicit and machine-greppable. */
export class BackendCapabilityGap extends Error {
  readonly code = "BACKEND_CAPABILITY_GAP";

  constructor(detail: string) {
    super(`BACKEND_CAPABILITY_GAP: ${detail}`);
    this.name = "BackendCapabilityGap";
  }
}

export class IORuntimeOperationConflict extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "IORuntimeOperationConflict";
  }
}

interface IOSessionHandleValue extends CanonicalObject {
  readonly adapter: typeof IO_RUNTIME_BACKEND;
  readonly adapter_instance_id: string;
  readonly session_ref: string;
  readonly provider: string;
  readonly requested_model: string;
  readonly io_commit: string;
  readonly role: string;
  readonly runtime_profile: string;
}

interface IOTurnHandleValue extends CanonicalObject {
  readonly adapter: typeof IO_RUNTIME_BACKEND;
  readonly adapter_instance_id: string;
  readonly session_ref: string;
  readonly turn_ref: string;
  readonly op_key: string;
  readonly provider: string;
  readonly requested_model: string;
  readonly io_commit: string;
  readonly role: string;
  readonly runtime_profile: string;
}

export interface IORuntimeCapabilityAdvertisement {
  readonly io_commit: string;
  /** IO exposes model request pass-through but no discoverable/verified model catalogue. */
  readonly model_catalog: null;
  readonly profiles: Readonly<Record<string, IORuntimeProfileBinding>>;
  readonly providers: IOBridgeCapabilities["providers"];
  readonly execution: IOBridgeCapabilities["execution"];
}

const digest = (value: CanonicalObject): string =>
  `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

const asProfileId = (runtime_profile: RuntimeProfile): string =>
  runtime_profile as unknown as string;

export class IORuntimeAdapter implements RuntimeAdapter {
  readonly #config: IORuntimeAdapterConfig;
  readonly #transport: IORuntimeTransport;
  readonly #spawns = new Map<
    string,
    { readonly material_hash: string; readonly handle: IOSessionHandleValue }
  >();
  #capabilities: IOBridgeCapabilities | undefined;

  constructor(config: IORuntimeAdapterConfig, transport: IORuntimeTransport) {
    validateConfig(config);
    this.#config = config;
    this.#transport = transport;
  }

  /** Exact configured provider/model requests intersected with IO's live provider registry. */
  capabilityAdvertisement(): IORuntimeCapabilityAdvertisement {
    const capabilities = this.#loadCapabilities();
    const available = new Set(capabilities.providers.map((entry) => entry.provider));
    for (const [profile, binding] of Object.entries(this.#config.profiles)) {
      if (!available.has(binding.provider)) {
        throw new BackendCapabilityGap(
          `runtime_profile ${JSON.stringify(profile)} requests provider ${JSON.stringify(binding.provider)}, ` +
            `but IO ${capabilities.io_commit} advertises only ${JSON.stringify([...available])}`,
        );
      }
    }
    return {
      io_commit: capabilities.io_commit,
      model_catalog: capabilities.model_catalog,
      profiles: this.#config.profiles,
      providers: capabilities.providers,
      execution: capabilities.execution,
    };
  }

  /** RA-4-shaped preflight for this adapter only; no lifecycle action is taken. */
  preflight(): ReturnType<RuntimePreflight> {
    try {
      const advertised = this.capabilityAdvertisement();
      const selectedProviders = new Set(
        Object.values(advertised.profiles).map((binding) => binding.provider),
      );
      const blocked = advertised.providers
        .filter((provider) => selectedProviders.has(provider.provider))
        .filter(
          (provider) =>
            provider.readiness === "not_installed" || provider.readiness === "auth_expired",
        )
        .map(
          (provider) =>
            `${provider.provider}:${provider.readiness}:${provider.readiness_detail}`,
        );
      return blocked.length === 0 ? { status: "READY" } : { status: "BLOCKED", reasons: blocked };
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
    this.capabilityAdvertisement();
    const effectiveCwd = cwd.length === 0 ? this.#config.default_cwd : cwd;
    const material_hash = digest({
      role,
      runtime_profile: profileId,
      cwd: effectiveCwd,
      bootstrap_context,
      capability_grant: capability_grant as unknown as CanonicalObject,
    });

    const seen = this.#spawns.get(operation_context.op_key);
    if (seen !== undefined) {
      if (seen.material_hash !== material_hash) {
        throw new IORuntimeOperationConflict(
          `${operation_context.op_key} was reused with different spawn material`,
        );
      }
      return { session_handle: seen.handle as unknown as RuntimeSessionHandle };
    }

    const observation = this.#transport.spawn({
      op_key: operation_context.op_key,
      material_hash,
      role,
      runtime_profile: profileId,
      binding,
      cwd: effectiveCwd,
      bootstrap_context,
    });
    if (
      observation.provider !== binding.provider ||
      observation.requested_model !== binding.model ||
      observation.io_commit !== this.#config.expected_io_commit
    ) {
      throw new BackendCapabilityGap(
        `IO spawn identity disagreed with the configured binding for ${profileId}`,
      );
    }
    const handle: IOSessionHandleValue = {
      adapter: IO_RUNTIME_BACKEND,
      adapter_instance_id: this.#config.adapter_instance_id,
      session_ref: observation.session_ref,
      provider: observation.provider,
      requested_model: observation.requested_model,
      io_commit: observation.io_commit,
      role,
      runtime_profile: profileId,
    };
    this.#spawns.set(operation_context.op_key, { material_hash, handle });
    // IO reports no ADP capability-enforcement receipt. Never synthesize one from configuration.
    return { session_handle: handle as unknown as RuntimeSessionHandle };
  }

  send_turn(
    operation_context: RuntimeOperationContextV1,
    session_handle: RuntimeSessionHandle,
    instruction: string,
  ): RuntimeTurnHandle {
    const session = this.#session(session_handle);
    const observation = this.#transport.sendTurn({
      op_key: operation_context.op_key,
      session_ref: session.session_ref,
      instruction,
      timeout_seconds: this.#config.turn_timeout_seconds,
    });
    return {
      ...session,
      turn_ref: observation.turn_ref,
      op_key: operation_context.op_key,
    } as unknown as RuntimeTurnHandle;
  }

  get_turn_result(turn_handle: RuntimeTurnHandle): RuntimeTurnResult {
    const turn = this.#turn(turn_handle);
    const observed = this.#transport.turnResult(turn.turn_ref);
    this.#assertTurnIdentity(turn, observed);
    const structured = structuredOutput(turn.role, observed.response);
    const declared = declaredOutcome(observed.response);
    const resultChannel = structured === undefined ? "TURN_TEXT" : "STRUCTURED_PROTOCOL";
    const binding_ref = digest({
      io_commit: turn.io_commit,
      provider: turn.provider,
      requested_model: turn.requested_model,
    });

    return {
      schema_version: 2,
      session_handle: sessionFromTurn(turn) as unknown as RuntimeSessionHandle,
      turn_handle,
      backend_status: observed.backend_status,
      termination_reason: observed.termination_reason,
      started_at: observed.started_at,
      completed_at: observed.completed_at,
      provenance: {
        runtime_backend: IO_RUNTIME_BACKEND,
        identity_authority: "BACKEND",
        result_channel: resultChannel,
      },
      ...(structured === undefined ? {} : { structured_output: structured }),
      ...(declared === undefined ? {} : { model_declared_outcome: declared }),
      backend_native_refs: {
        io_commit: observed.io_commit,
        session_process_id: observed.pid,
        session_ref: observed.session_ref,
        turn_ref: observed.turn_ref,
        requested_model: observed.requested_model,
        ...(observed.failure_kind === null ? {} : { failure_kind: observed.failure_kind }),
      },
      execution_observation: {
        op_key: turn.op_key,
        subject: { kind: "UNKNOWN" },
        role: "UNKNOWN",
        role_profile_id: "",
        runtime_profile: turn.runtime_profile,
        requested_binding_ref: binding_ref,
        actual: {
          provider: { availability: "REPORTED", value: observed.provider },
          // IO passes the configured model to the CLI but does not observe the provider-resolved
          // identity. The request is retained above; presenting it as actual would be inference.
          model: { availability: "UNKNOWN" },
          binding_ref: { availability: "UNKNOWN" },
        },
        timing: { started_at: observed.started_at, completed_at: observed.completed_at },
        // IO's persistent-round seam does not report token usage or cost.
        usage: { kind: "UNKNOWN" },
        cost: { kind: "UNKNOWN" },
        failure_attribution:
          observed.backend_status === "COMPLETED"
            ? null
            : {
                domain: "RUNTIME_INFRASTRUCTURE",
                detail_code: observed.failure_kind ?? observed.backend_status,
                source_ref: observed.turn_ref,
                reporter: "BACKEND",
                retryable: { kind: "UNKNOWN" },
              },
      },
    };
  }

  get_session_status(session_handle: RuntimeSessionHandle): RuntimeSessionStatus {
    const session = this.#session(session_handle);
    return this.#transport.sessionStatus(session.session_ref) as unknown as RuntimeSessionStatus;
  }

  cancel_session(session_handle: RuntimeSessionHandle): void {
    this.#transport.cancel(this.#session(session_handle).session_ref);
  }

  close_session(session_handle: RuntimeSessionHandle): void {
    this.#transport.close(this.#session(session_handle).session_ref);
  }

  acquire_workflow_controller(): WorkflowControllerHandle {
    // IO's provider/session execution seam has no Backend v1 workflow-controller identity. The
    // separate Backend v1 runtime remains the owner of that capability; fabricating a handle here
    // would silently turn IO into an ADP control plane.
    throw new BackendCapabilityGap(
      "Issue-Orchestrator exposes no ADP WorkflowControllerHandle; use the separate Backend v1 workflow composition",
    );
  }

  #loadCapabilities(): IOBridgeCapabilities {
    const capabilities = this.#capabilities ?? this.#transport.capabilities();
    if (capabilities.io_commit !== this.#config.expected_io_commit) {
      throw new BackendCapabilityGap(
        `configured IO commit ${this.#config.expected_io_commit} but bridge loaded ${capabilities.io_commit}`,
      );
    }
    this.#capabilities = capabilities;
    return capabilities;
  }

  #binding(profileId: string): IORuntimeProfileBinding {
    const binding = this.#config.profiles[profileId];
    if (binding === undefined) {
      throw new BackendCapabilityGap(
        `runtime_profile ${JSON.stringify(profileId)} is not in the configured IO provider/model matrix`,
      );
    }
    return binding;
  }

  #session(handle: RuntimeSessionHandle): IOSessionHandleValue {
    const value = handle as unknown as Partial<IOSessionHandleValue>;
    if (
      value.adapter !== IO_RUNTIME_BACKEND ||
      value.adapter_instance_id !== this.#config.adapter_instance_id ||
      typeof value.session_ref !== "string" ||
      typeof value.provider !== "string" ||
      typeof value.requested_model !== "string" ||
      typeof value.io_commit !== "string" ||
      typeof value.role !== "string" ||
      typeof value.runtime_profile !== "string"
    ) {
      throw new BackendCapabilityGap("session handle is not owned by this IO adapter instance");
    }
    return value as IOSessionHandleValue;
  }

  #turn(handle: RuntimeTurnHandle): IOTurnHandleValue {
    const value = handle as unknown as Partial<IOTurnHandleValue>;
    this.#session(value as unknown as RuntimeSessionHandle);
    if (typeof value.turn_ref !== "string" || typeof value.op_key !== "string") {
      throw new BackendCapabilityGap("turn handle is not an IO turn reference");
    }
    return value as IOTurnHandleValue;
  }

  #assertTurnIdentity(turn: IOTurnHandleValue, observed: IOTerminalTurnObservation): void {
    if (
      observed.turn_ref !== turn.turn_ref ||
      observed.session_ref !== turn.session_ref ||
      observed.provider !== turn.provider ||
      observed.requested_model !== turn.requested_model ||
      observed.io_commit !== turn.io_commit
    ) {
      throw new BackendCapabilityGap(`IO result identity did not match turn ${turn.turn_ref}`);
    }
  }
}

export const ioRuntimePreflight = (adapter: IORuntimeAdapter): RuntimePreflight =>
  () => adapter.preflight();

function sessionFromTurn(turn: IOTurnHandleValue): IOSessionHandleValue {
  return {
    adapter: turn.adapter,
    adapter_instance_id: turn.adapter_instance_id,
    session_ref: turn.session_ref,
    provider: turn.provider,
    requested_model: turn.requested_model,
    io_commit: turn.io_commit,
    role: turn.role,
    runtime_profile: turn.runtime_profile,
  };
}

function structuredOutput(
  role: string,
  response: CanonicalObject | null,
): RuntimeTurnResult["structured_output"] | undefined {
  if (response === null) return undefined;
  if (role === "AUDITOR") {
    return { protocol: IO_AUDITOR_VERDICT_PROTOCOL, body: response };
  }
  if (role === "SUPERVISOR") {
    const proposal = response["proposal"];
    if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) return undefined;
    return { protocol: IO_SUPERVISOR_PROPOSAL_PROTOCOL, body: proposal as CanonicalObject };
  }
  return { protocol: IO_ACTOR_RESULT_PROTOCOL, body: response };
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

function validateConfig(config: IORuntimeAdapterConfig): void {
  const required = [
    config.adapter_instance_id,
    config.io_checkout,
    config.expected_io_commit,
    config.python_executable,
    config.state_root,
    config.default_cwd,
  ];
  if (required.some((value) => value.length === 0)) {
    throw new BackendCapabilityGap("IO adapter configuration contains an empty required value");
  }
  if (!Number.isInteger(config.turn_timeout_seconds) || config.turn_timeout_seconds <= 0) {
    throw new BackendCapabilityGap("turn_timeout_seconds must be a positive integer");
  }
  const profiles = Object.entries(config.profiles);
  if (profiles.length === 0) {
    throw new BackendCapabilityGap("at least one exact runtime_profile binding is required");
  }
  for (const [profile, binding] of profiles) {
    if (
      profile.length === 0 ||
      binding.provider.length === 0 ||
      binding.model.length === 0 ||
      Object.values(binding.provider_args ?? {}).some((value) => typeof value !== "string")
    ) {
      throw new BackendCapabilityGap(`invalid provider/model binding for ${JSON.stringify(profile)}`);
    }
  }
}
