import { appendRequestedEffort } from "./effortArgv.ts";

/** Closed set of reviewer CLI profiles supported by the product. */
export type ReviewProvider = "claude" | "grok" | "codex";

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
  /** Session fields stay absent until this review argv is measured in a live container probe. */
  readonly sessions_subdir?: string;
  readonly sessions_container_dir?: string;
  readonly model_scan?: { readonly session_regex: string; readonly stdout_regex: string };
  /** Requested reasoning effort; valid only when paired with a measured `effort_argv`. */
  readonly requested_effort?: string;
  readonly effort_argv?: {
    readonly flag: string;
    readonly value_placement: "separate" | "equals";
    readonly value_prefix?: string;
    readonly allowed_values: readonly string[];
  };
  readonly effort_scan?: { readonly session_regex: string; readonly stdout_regex: string };
  /**
   * `identity_class.product` (TD §8.4). Policy independence is `identity_class.product ≠` the
   * implementer's product; this string is the product-side declaration of that class. Adapters
   * cannot self-assert a different class at submit time.
   */
  readonly identity_class_product: string;
  /**
   * MEASURED verdict output contract. `first-line`: the verdict is the first stdout line starting
   * with APPROVE/REQUEST_CHANGES, reason on the next line (claude `-p`). `json-schema-text`: the
   * provider runs under `--json-schema`, stdout is `{"text": "..."}` whose text concatenates one
   * JSON object PER TURN (tool-use narration is coerced into the schema too — measured live, 9th
   * pilot); the LAST object is the final verdict. Anything unparseable fails closed to
   * REQUEST_CHANGES — a verdict is never guessed.
   */
  readonly verdict_format: "first-line" | "json-schema-text";
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
    sessions_subdir: "claude-sessions",
    sessions_container_dir: "projects",
    // Measured primary path: ~/.claude/projects/<slug>/<uuid>.jsonl. Stdout is a
    // same-shape fallback only.
    model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' },
    identity_class_product: "claude-code",
    verdict_format: "first-line",
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
    // 9th-pilot measurement: in plain `-p` output grok concatenates tool-use narration and the
    // final verdict WITHOUT a newline ("...file.APPROVE"), so the first-line contract is
    // unparseable. `--json-schema` constrains the reply to a verdict object instead (see
    // `verdict_format` for the measured wrapper shape).
    argv_template: [
      "-p",
      DIFF_PROMPT_SENTINEL,
      "--permission-mode",
      "plan",
      "--disable-web-search",
      "--tools",
      "read_file,list_dir,grep",
      "--json-schema",
      '{"type":"object","properties":{"verdict":{"type":"string","enum":["APPROVE","REQUEST_CHANGES"]},"reason":{"type":"string"}},"required":["verdict","reason"]}',
    ],
    auth_method: { kind: "auth_files", auth_subdir: ".grok", auth_files: ["auth.json"] },
    sessions_subdir: "grok-sessions",
    // Measured primary path: ~/.grok/sessions/<urlencoded-cwd>/<session-id>/chat_history.jsonl.
    // Stdout is a same-shape fallback only.
    model_scan: { session_regex: '"model_id"\\s*:\\s*"([^"]+)"', stdout_regex: '"model_id"\\s*:\\s*"([^"]+)"' },
    identity_class_product: "grok",
    verdict_format: "json-schema-text",
  },
  codex: {
    // Measured (2026-09-07 container probes): `codex exec --sandbox read-only` starts inside the
    // surface container and BLOCKS writes ("Shell write failed due to sandbox permissions", no
    // file created). With stderr discarded, stdout is the final message ONLY — first-line verdict
    // contract, no wrapper needed. `--skip-git-repo-check` matches the worker profile: the
    // reviewer checkout is a fresh clone, not the broker's own repo.
    argv_template: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", DIFF_PROMPT_SENTINEL],
    auth_method: { kind: "auth_files", auth_subdir: ".codex", auth_files: ["auth.json"] },
    sessions_subdir: "codex-sessions",
    // Measured primary path: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Stdout is a
    // same-shape fallback only.
    model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' },
    // Pinned: do not ride the host ~/.codex/config.toml default. Measured form is
    // `-c model_reasoning_effort=<value>`.
    requested_effort: "high",
    effort_argv: { flag: "-c", value_placement: "separate", value_prefix: "model_reasoning_effort=", allowed_values: ["high"] },
    identity_class_product: "codex-cli",
    verdict_format: "first-line",
  },
};

/** Build the full argv (binary + expanded template) for a provider + diff prompt. */
export function reviewArgv(provider: ReviewProvider, diff_prompt: string): string[] {
  const profile = REVIEW_PROVIDERS[provider];
  const argv = [provider, ...profile.argv_template.map((a) => (a === DIFF_PROMPT_SENTINEL ? diff_prompt : a))];
  return appendRequestedEffort(argv, profile, `review provider ${provider}`);
}

/** Pure, fail-closed provider-name validation. Never defaults silently. */
export function resolveReviewProvider(name: string): ReviewProvider {
  if (Object.prototype.hasOwnProperty.call(REVIEW_PROVIDERS, name)) {
    const provider = name as ReviewProvider;
    const profile = REVIEW_PROVIDERS[provider];
    appendRequestedEffort([], profile, `review provider ${name}`);
    return provider;
  }
  throw new Error(`unknown review provider: ${name}`);
}

/**
 * Parse a reviewer surface's stdout into a verdict per the provider's MEASURED contract. Fails
 * closed: anything that does not contain an unambiguous final verdict is REQUEST_CHANGES with an
 * honest reason — a verdict is never guessed from prose.
 */
export function parseReviewVerdict(provider: ReviewProvider, stdout: string): { verdict: "APPROVE" | "REQUEST_CHANGES"; reason: string } {
  const format = REVIEW_PROVIDERS[provider].verdict_format;
  if (format === "first-line") {
    const lines = stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const verdictLine = lines.find((l) => l === "APPROVE" || l === "REQUEST_CHANGES" || l.startsWith("APPROVE") || l.startsWith("REQUEST_CHANGES")) ?? "";
    const verdict = verdictLine.startsWith("APPROVE") ? "APPROVE" : "REQUEST_CHANGES";
    const reason = lines[lines.indexOf(verdictLine) + 1] ?? stdout.trim().slice(0, 200);
    return { verdict, reason };
  }
  // json-schema-text: {"text": "<one JSON object per turn, concatenated>"} — the LAST is final.
  try {
    const wrapper = JSON.parse(stdout) as { text?: string };
    const text = typeof wrapper.text === "string" ? wrapper.text : stdout;
    const matches = [...text.matchAll(/\{\s*"verdict"\s*:\s*"(APPROVE|REQUEST_CHANGES)"\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/gu)];
    const last = matches[matches.length - 1];
    if (last === undefined) return { verdict: "REQUEST_CHANGES", reason: "reviewer output carried no schema-shaped verdict — failing closed" };
    return { verdict: last[1] as "APPROVE" | "REQUEST_CHANGES", reason: JSON.parse(`"${last[2]!}"`) as string };
  } catch {
    return { verdict: "REQUEST_CHANGES", reason: "reviewer output was not the measured json-schema wrapper — failing closed" };
  }
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
