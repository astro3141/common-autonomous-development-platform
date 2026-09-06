/** Closed set of planner CLI profiles supported by the product. */
export type PlanProvider = "claude";

export interface PlanAuthMethod {
  /**
   * How the planner authenticates inside the isolated container. Descriptor only — never a
   * credential. `oauth_env` injects an operator-extracted token via the named env var (the claude
   * path: `CLAUDE_CODE_OAUTH_TOKEN`). Host keychain and worker auth files stay unreachable.
   */
  readonly kind: "oauth_env";
  readonly env_var: string;
}

export interface PlanProviderProfile {
  /**
   * The provider's exact argv AFTER the binary name, with the sentinel `{{PLAN_PROMPT}}` replaced
   * by the plan prompt. A template (not a prefix) so a provider whose prompt is not the last
   * token is expressible without special-casing.
   */
  readonly argv_template: readonly string[];
  readonly auth_method: PlanAuthMethod;
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
    identity_class_product: "claude-code",
  },
};

/** Build the full argv (binary + expanded template) for a provider + plan prompt. */
export function planArgv(provider: PlanProvider, plan_prompt: string): string[] {
  return [provider, ...PLAN_PROVIDERS[provider].argv_template.map((a) => (a === PLAN_PROMPT_SENTINEL ? plan_prompt : a))];
}

/** Pure, fail-closed provider-name validation. Never defaults silently. */
export function resolvePlanProvider(name: string): PlanProvider {
  if (Object.prototype.hasOwnProperty.call(PLAN_PROVIDERS, name)) return name as PlanProvider;
  throw new Error(`unknown plan provider: ${name}`);
}
