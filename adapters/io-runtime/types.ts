/**
 * Configuration and transport types for the Issue-Orchestrator-backed RuntimeAdapter.
 *
 * IO remains an execution backend.  These types intentionally contain no issue, label, lane,
 * reviewer, continuation, or IO control-state vocabulary.
 */

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";

export interface IORuntimeProfileBinding {
  /** Exact provider id reported by IO's provider registry. */
  readonly provider: string;
  /** Exact model request passed through IO's provider command builder; not an observed model id. */
  readonly model: string;
  /** IO provider-builder arguments. Values are strings because that is IO's public seam. */
  readonly provider_args?: Readonly<Record<string, string>>;
}

export interface IOWorkspaceTrustConfig {
  /** Human-approved canonical repository root required by IO's interactive Codex provider. */
  readonly approved_repository_root: string;
  /** Absolute path of the authority document carrying that approval. */
  readonly authority_source: string;
  /** Fingerprint of the authority document bytes. */
  readonly authority_fingerprint: string;
}

export interface IORuntimeAdapterConfig {
  readonly adapter_instance_id: string;
  /** Root of an IO checkout, containing src/issue_orchestrator. */
  readonly io_checkout: string;
  /** Exact IO commit whose execution seam was inspected. */
  readonly expected_io_commit: string;
  /** Host Python capable of importing the configured IO checkout and its dependencies. */
  readonly python_executable: string;
  /** Host-owned state outside candidate repositories. */
  readonly state_root: string;
  /** Used only when ADP intentionally supplies an empty cwd (the Supervisor session). */
  readonly default_cwd: string;
  readonly turn_timeout_seconds: number;
  /** The complete advertised matrix. An unlisted runtime_profile fails closed. */
  readonly profiles: Readonly<Record<string, IORuntimeProfileBinding>>;
  readonly workspace_trust?: IOWorkspaceTrustConfig;
}

export interface IOProviderCapability {
  readonly provider: string;
  readonly executable: string;
  readonly version: string | null;
  readonly readiness: "ready" | "not_installed" | "auth_expired" | "unknown";
  readonly readiness_detail: string;
}

export interface IOBridgeCapabilities {
  readonly io_commit: string;
  readonly providers: readonly IOProviderCapability[];
  /** IO exposes model pass-through, not a discoverable provider model catalogue. */
  readonly model_catalog: null;
  readonly execution: {
    readonly persistent_session: true;
    readonly turn_submission: true;
    readonly result_observation: true;
    readonly status_observation: true;
    readonly cancellation: true;
    readonly same_bridge_reacquisition: true;
    readonly bridge_restart_reacquisition: false;
  };
}

export interface IOSpawnRequest {
  readonly op_key: string;
  readonly material_hash: string;
  readonly role: string;
  readonly runtime_profile: string;
  readonly binding: IORuntimeProfileBinding;
  readonly cwd: string;
  readonly bootstrap_context: CanonicalObject;
}

export interface IOSpawnObservation {
  readonly session_ref: string;
  readonly pid: number;
  readonly provider: string;
  readonly requested_model: string;
  readonly io_commit: string;
  readonly reacquired: boolean;
}

export interface IOTurnRequest {
  readonly op_key: string;
  readonly session_ref: string;
  readonly instruction: string;
  readonly timeout_seconds: number;
}

export interface IOTurnObservation {
  readonly turn_ref: string;
}

export interface IOTerminalTurnObservation {
  readonly turn_ref: string;
  readonly session_ref: string;
  readonly backend_status: "COMPLETED" | "CANCELLED" | "TIMEOUT" | "RUNTIME_ERROR" | "SESSION_LOST";
  readonly termination_reason: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly provider: string;
  /** IO preserves the request but does not report the provider's resolved model identity. */
  readonly requested_model: string;
  readonly pid: number;
  readonly io_commit: string;
  readonly response: CanonicalObject | null;
  readonly failure_kind: string | null;
}

export interface IOSessionObservation extends CanonicalObject {
  readonly session_ref: string;
  readonly state: "RUNNING" | "EXITED" | "CLOSED" | "SESSION_LOST";
  readonly pid: number | null;
  readonly return_code: number | null;
  readonly provider: string | null;
  readonly requested_model: string | null;
  readonly io_commit: string;
}

/** Narrow transport so adapter semantics can be tested without launching a provider. */
export interface IORuntimeTransport {
  capabilities(): IOBridgeCapabilities;
  spawn(request: IOSpawnRequest): IOSpawnObservation;
  sendTurn(request: IOTurnRequest): IOTurnObservation;
  turnResult(turn_ref: string): IOTerminalTurnObservation;
  sessionStatus(session_ref: string): IOSessionObservation;
  cancel(session_ref: string): void;
  close(session_ref: string): void;
}
