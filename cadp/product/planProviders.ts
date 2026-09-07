/** Closed set of planner CLI profiles supported by the product. */
export type PlanProvider = "claude" | "grok" | "codex";

/**
 * How the planner authenticates inside the isolated container. Descriptors only — never a
 * credential. `oauth_env` injects an operator-extracted token via the named env var (the claude
 * path). `auth_files` copies the named files from the host HOME's auth subdirectory into the
 * container HOME read-only (the grok path — same posture as the worker surface). Host keychain
 * and every OTHER provider's auth stay unreachable either way.
 */
export type PlanAuthMethod =
  | { readonly kind: "oauth_env"; readonly env_var: string }
  | { readonly kind: "auth_files"; readonly auth_subdir: string; readonly auth_files: readonly string[] };

export interface PlanProviderProfile {
  /**
   * The provider's exact argv AFTER the binary name, with the sentinel `{{PLAN_PROMPT}}` replaced
   * by the plan prompt. A template (not a prefix) so a provider whose prompt is not the last
   * token is expressible without special-casing.
   */
  readonly argv_template: readonly string[];
  readonly auth_method: PlanAuthMethod;
  /** Session fields stay absent until this plan argv is measured in a live container probe. */
  readonly sessions_subdir?: string;
  readonly sessions_container_dir?: string;
  readonly model_scan?: { readonly session_regex: string; readonly stdout_regex: string };
  /** Requested reasoning effort; valid only when paired with a measured `effort_argv`. */
  readonly requested_effort?: string;
  readonly effort_argv?: {
    readonly flag: string;
    readonly value_placement: "separate" | "equals";
    readonly allowed_values: readonly string[];
  };
  readonly effort_scan?: { readonly session_regex: string; readonly stdout_regex: string };
  /**
   * `identity_class.product` (TD §8.4). Policy independence is `identity_class.product ≠` the
   * implementer's product; this string is the product-side declaration of that class. Adapters
   * cannot self-assert a different class at submit time.
   */
  readonly identity_class_product: string;
}

export const PLAN_PROMPT_SENTINEL = "{{PLAN_PROMPT}}";

/** Omitted `plan_product` keeps the measured claude path. `resolvePlanProvider` never defaults. */
export const DEFAULT_PLAN_PROVIDER: PlanProvider = "claude";

export const PLAN_PROVIDERS: Record<PlanProvider, PlanProviderProfile> = {
  claude: {
    // Measured planner path: Claude Code plan-mode. Reading the checkout is allowed; mutating
    // and external tools are disallowed. Proposal-only — never a mutating worker.
    argv_template: [
      "-p",
      "--model",
      "claude-sonnet-5",
      "--permission-mode",
      "plan",
      "--disallowedTools=Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task",
      PLAN_PROMPT_SENTINEL,
    ],
    auth_method: { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN" },
    sessions_subdir: "claude-sessions",
    sessions_container_dir: "projects",
    // Measured primary path: ~/.claude/projects/<slug>/<uuid>.jsonl. Stdout is a
    // same-shape fallback only.
    model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' },
    identity_class_product: "claude-code",
  },
  grok: {
    // Measured read-only posture (2026-09-06 container probes, grok 1.0.13) — see the grok entry
    // in reviewProviders.ts for the probe details. The `--tools` allow-list (not plan mode) is the
    // enforced boundary: plan mode blocks `write` but NOT `run_terminal_command`.
    argv_template: [
      "-p",
      PLAN_PROMPT_SENTINEL,
      "--permission-mode",
      "plan",
      "--disable-web-search",
      "--tools",
      "read_file,list_dir,grep",
    ],
    auth_method: { kind: "auth_files", auth_subdir: ".grok", auth_files: ["auth.json"] },
    sessions_subdir: "grok-sessions",
    // Measured primary path: ~/.grok/sessions/<urlencoded-cwd>/<session-id>/chat_history.jsonl.
    // Stdout is a same-shape fallback only.
    model_scan: { session_regex: '"model_id"\\s*:\\s*"([^"]+)"', stdout_regex: '"model_id"\\s*:\\s*"([^"]+)"' },
    identity_class_product: "grok",
  },
  codex: {
    // Measured read-only posture (2026-09-07 probe — see the codex entry in reviewProviders.ts).
    // Proposal output is parsed against the closed cadp.work-proposal.v1 schema, failing closed on
    // any deviation, so no extra output contract is needed here.
    argv_template: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", PLAN_PROMPT_SENTINEL],
    auth_method: { kind: "auth_files", auth_subdir: ".codex", auth_files: ["auth.json"] },
    sessions_subdir: "codex-sessions",
    // Measured primary path: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Stdout is a
    // same-shape fallback only.
    model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' },
    identity_class_product: "codex-cli",
  },
};

/** Build the full argv (binary + expanded template) for a provider + plan prompt. */
export function planArgv(provider: PlanProvider, plan_prompt: string): string[] {
  return [provider, ...PLAN_PROVIDERS[provider].argv_template.map((a) => (a === PLAN_PROMPT_SENTINEL ? plan_prompt : a))];
}

/** Pure, fail-closed provider-name validation. Never defaults silently. */
export function resolvePlanProvider(name: string): PlanProvider {
  if (Object.prototype.hasOwnProperty.call(PLAN_PROVIDERS, name)) {
    const provider = name as PlanProvider;
    const profile = PLAN_PROVIDERS[provider];
    if ((profile.requested_effort === undefined) !== (profile.effort_argv === undefined)) {
      throw new Error(`plan provider ${name} has an unpaired requested_effort/effort_argv configuration`);
    }
    return provider;
  }
  throw new Error(`unknown plan provider: ${name}`);
}
