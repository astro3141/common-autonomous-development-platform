/** Configuration and process seam for the bounded Codex CLI RuntimeAdapter pilot. */

export type CodexCliSandbox = "read-only" | "workspace-write";

export interface CodexCliRuntimeProfileBinding {
  /** The inspected CLI defaults to its built-in `openai` provider when user config is ignored. */
  readonly provider: "openai";
  /** Exact model request passed to `codex exec --model`; not an observed resolved model id. */
  readonly model: string;
  /** Fixed for the lifetime of the persisted CLI thread. */
  readonly sandbox: CodexCliSandbox;
}

export interface CodexCliRuntimeAdapterConfig {
  readonly adapter_instance_id: string;
  readonly cli_executable: string;
  /** Exact `codex --version` output accepted by this inspected pilot implementation. */
  readonly expected_cli_version: string;
  /** Host-owned files such as generated output schemas; never candidate-owned state. */
  readonly state_root: string;
  /** Used only when ADP intentionally supplies an empty cwd for the Supervisor session. */
  readonly default_cwd: string;
  readonly turn_timeout_seconds: number;
  /** Complete advertised matrix. Unlisted runtime profiles fail closed. */
  readonly profiles: Readonly<Record<string, CodexCliRuntimeProfileBinding>>;
}

export interface CodexCliInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeout_ms: number;
}

export interface CodexCliCommandObservation {
  readonly started_at: string;
  readonly completed_at: string;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly error_code: string | null;
}

/** Narrow injectable seam so parsing and adapter authority can be tested without paid turns. */
export interface CodexCliProcessRunner {
  run(invocation: CodexCliInvocation): CodexCliCommandObservation;
}
