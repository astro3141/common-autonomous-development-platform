/** Configuration and process seam for the multi-provider CLI agent RuntimeAdapter (#73/#49/#50). */

export type CliAgentProvider = "claude-code" | "agy" | "grok";

export interface CliAgentProfileBinding {
  readonly provider: CliAgentProvider;
  /** Exact model request passed to the CLI; never an observed resolved model id. */
  readonly model: string;
  /**
   * #51 — explicit per-binding reasoning effort where the measured CLI supports one. Absent means
   * UNSPECIFIED: no flag is sent and no hidden default is invented. Each provider seam validates
   * the value against its own measured vocabulary and fails closed on anything else.
   */
  readonly effort?: string;
}

export interface CliAgentRuntimeAdapterConfig {
  readonly adapter_instance_id: string;
  /** Executable per provider; only providers actually used by `profiles` need an entry. */
  readonly executables: Readonly<Partial<Record<CliAgentProvider, string>>>;
  /** Exact `--version` output accepted per used provider (measured-pilot honesty). */
  readonly expected_cli_versions: Readonly<Partial<Record<CliAgentProvider, string>>>;
  /** Host-owned files such as generated output schemas; never candidate-owned state. */
  readonly state_root: string;
  /** Used only when ADP intentionally supplies an empty cwd for the Supervisor session. */
  readonly default_cwd: string;
  readonly turn_timeout_seconds: number;
  /** Complete advertised matrix. Unlisted runtime profiles fail closed. */
  readonly profiles: Readonly<Record<string, CliAgentProfileBinding>>;
}

export interface CliAgentInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeout_ms: number;
}

export interface CliAgentCommandObservation {
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
export interface CliAgentProcessRunner {
  run(invocation: CliAgentInvocation): CliAgentCommandObservation;
}

/** One parsed print-mode turn, provider vocabulary already mapped to Platform facts. */
export interface ParsedCliAgentTurn {
  /** The backend's session/conversation identity for resume, when reported. */
  readonly session_ref: string | null;
  readonly terminal: "COMPLETED" | "FAILED" | "MISSING";
  readonly terminal_reason: string;
  /** The final answer text (the structured JSON when a schema was enforced). */
  readonly final_text: string | null;
  /** Measured neutral usage quantities, when reported. */
  readonly usage: Readonly<Record<string, number>> | null;
  /** Observed actual model identity, only when the backend authoritatively reports one. */
  readonly actual_model: string | null;
  /** Observed actual provider identity, only when the backend reports one. */
  readonly actual_provider: string | null;
  /** Observed cost in USD, only when the backend reports one. */
  readonly cost_usd: number | null;
  readonly parse_error: string | null;
}
