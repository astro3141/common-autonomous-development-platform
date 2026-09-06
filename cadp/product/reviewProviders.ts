/** Closed set of reviewer CLI profiles supported by the product. */
export type ReviewProvider = "claude" | "grok";

/**
 * How the reviewer authenticates inside the isolated container. Descriptors only — never a
 * credential. `oauth_env` injects an operator-extracted token via the named env var (the claude
 * path: `CLAUDE_CODE_OAUTH_TOKEN`). `auth_files` copies the named files from the host HOME's
 * auth subdirectory into the container HOME read-only (the grok path: `~/.grok/auth.json`,
 * subscription OAuth — same posture the worker surface already uses). Host keychain and every
 * OTHER provider's auth stay unreachable either way.
 */
export type ReviewAuthMethod =
  | { readonly kind: "oauth_env"; readonly env_var: string }
  | { readonly kind: "auth_files"; readonly auth_subdir: string; readonly auth_files: readonly string[] };

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
  grok: {
    // Measured (2026-09-06 container probes, grok 1.0.13):
    //  - `--permission-mode plan` blocks the `write` tool (auto-cancelled, no file created) but
    //    does NOT block `run_terminal_command` (a touch executed and the file appeared), so plan
    //    mode ALONE is not read-only for grok.
    //  - `--tools read_file,list_dir,grep` (allow-list) held: a direct "run the terminal command"
    //    prompt could not execute it and no file was created. This allow-list — not plan mode —
    //    is the enforced read-only boundary; plan mode stays as defense in depth.
    //  - `--disable-web-search` removes web_search/web_fetch.
    //  - Plain `-p` output prints the verdict text directly (APPROVE\n<reason>), parser-compatible.
    argv_template: [
      "-p",
      DIFF_PROMPT_SENTINEL,
      "--permission-mode",
      "plan",
      "--disable-web-search",
      "--tools",
      "read_file,list_dir,grep",
    ],
    auth_method: { kind: "auth_files", auth_subdir: ".grok", auth_files: ["auth.json"] },
    identity_class_product: "grok",
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

/**
 * §8.4 reviewer independence, failed closed AT ENTRY: the review provider's `identity_class`
 * product must differ from the implementing worker's. The policy enforces the same invariant on
 * the sealed evidence at the PR/merge gates — this guard just refuses the doomed run before
 * anything is sealed or any surface spends compute. Pure; throws on violation.
 */
export function assertReviewIndependence(worker_product: string, review_provider: ReviewProvider): void {
  const review_product = REVIEW_PROVIDERS[review_provider].identity_class_product;
  if (review_product === worker_product) {
    throw new Error(
      `reviewer independence (§8.4): review provider "${review_provider}" shares identity_class product "${review_product}" with the implementing worker — a run cannot be reviewed by its own product`,
    );
  }
}
