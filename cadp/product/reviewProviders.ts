/** Closed set of reviewer CLI profiles supported by the product. */
export type ReviewProvider = "claude";

/**
 * How the isolated reviewer receives credentials. Env injection only: the surface never sees a
 * host keychain or an extra credential mount (TD §4.1).
 */
export type ReviewAuthMethod = {
  readonly kind: "env";
  readonly env_var: string;
};

export interface ReviewProviderProfile {
  /**
   * The provider's exact argv AFTER the binary name, with the sentinel `{{DIFF_PROMPT}}` replaced
   * by the review prompt (work item + candidate diff). A template (not a prefix) so a provider
   * whose prompt is not the last token is expressible without special-casing.
   */
  readonly argv_template: readonly string[];
  /** Credential injection descriptor for the isolated reviewer container. */
  readonly auth_method: ReviewAuthMethod;
  /**
   * `identity_class.product` used for TD §8.4 reviewer-independence (`identity_class.product ≠`
   * every implementer). The kernel derives class from the identity_registry; this is the
   * product-side declaration the registered reviewer principal must match.
   */
  readonly identity_class_product: string;
}

export const DIFF_PROMPT_SENTINEL = "{{DIFF_PROMPT}}";

/** Callers that omit a review-provider name get this; `resolveReviewProvider` itself never defaults. */
export const DEFAULT_REVIEW_PROVIDER: ReviewProvider = "claude";

export const REVIEW_PROVIDERS: Record<ReviewProvider, ReviewProviderProfile> = {
  claude: {
    // Measured #90 reviewer: plan-mode, mutating/read/external tools disallowed; the diff is IN the
    // prompt so even Read is denied. Do not weaken this permission profile.
    argv_template: [
      "-p",
      "--model",
      "claude-sonnet-5",
      "--permission-mode",
      "plan",
      "--disallowedTools=Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit",
      DIFF_PROMPT_SENTINEL,
    ],
    auth_method: { kind: "env", env_var: "CLAUDE_CODE_OAUTH_TOKEN" },
    identity_class_product: "claude-code",
  },
};

/** Build the full argv (binary + expanded template) for a provider + diff prompt. */
export function reviewArgv(provider: ReviewProvider, diff_prompt: string): string[] {
  return [provider, ...REVIEW_PROVIDERS[provider].argv_template.map((a) => (a === DIFF_PROMPT_SENTINEL ? diff_prompt : a))];
}

/** Pure, fail-closed provider-name validation. Never substitutes a default. */
export function resolveReviewProvider(name: string): ReviewProvider {
  if (Object.prototype.hasOwnProperty.call(REVIEW_PROVIDERS, name)) return name as ReviewProvider;
  throw new Error(`unknown review provider: ${name}`);
}
