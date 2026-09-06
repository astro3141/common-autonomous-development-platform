/** Closed set of reviewer CLI profiles supported by the product. */
export type ReviewProvider = "claude";

export interface ReviewAuthMethod {
  /**
   * How the reviewer authenticates inside the isolated container. Descriptor only — never a
   * credential. `oauth_env` injects an operator-extracted token via the named env var (the claude
   * path: `CLAUDE_CODE_OAUTH_TOKEN`). Host keychain and worker auth files stay unreachable.
   */
  readonly kind: "oauth_env";
  readonly env_var: string;
}

export interface ReviewProviderProfile {
  /**
   * The provider's exact argv AFTER the binary name, with the sentinel `{{DIFF_PROMPT}}` replaced
   * by the review prompt. A template (not a prefix) so a provider whose prompt is not the last
   * token is expressible without special-casing.
   */
  readonly argv_template: readonly string[];
  readonly auth_method: ReviewAuthMethod;
  /**
   * `identity_class.product` (TD §8.4). Policy independence is `identity_class.product ≠` the
   * implementer's product; this string is the product-side declaration of that class. Adapters
   * cannot self-assert a different class at submit time.
   */
  readonly identity_class_product: string;
}

export const DIFF_PROMPT_SENTINEL = "{{DIFF_PROMPT}}";

/** Omitted `review_product` keeps the measured claude path. `resolveReviewProvider` never defaults. */
export const DEFAULT_REVIEW_PROVIDER: ReviewProvider = "claude";

export const REVIEW_PROVIDERS: Record<ReviewProvider, ReviewProviderProfile> = {
  claude: {
    // Measured #90: Claude Code plan-mode, read-only (mutating and filesystem tools disallowed).
    argv_template: [
      "-p",
      "--model",
      "claude-sonnet-5",
      "--permission-mode",
      "plan",
      "--disallowedTools=Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit",
      DIFF_PROMPT_SENTINEL,
    ],
    auth_method: { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN" },
    identity_class_product: "claude-code",
  },
};

/** Build the full argv (binary + expanded template) for a provider + diff prompt. */
export function reviewArgv(provider: ReviewProvider, diff_prompt: string): string[] {
  return [provider, ...REVIEW_PROVIDERS[provider].argv_template.map((a) => (a === DIFF_PROMPT_SENTINEL ? diff_prompt : a))];
}

/** Pure, fail-closed provider-name validation. Never defaults silently. */
export function resolveReviewProvider(name: string): ReviewProvider {
  if (Object.prototype.hasOwnProperty.call(REVIEW_PROVIDERS, name)) return name as ReviewProvider;
  throw new Error(`unknown review provider: ${name}`);
}
