/** Closed set of worker CLI profiles supported by the product. */
export type WorkerProvider = "codex" | "grok" | "claude";

export interface WorkerProviderProfile {
  /**
   * The provider's exact argv AFTER the binary name, with the sentinel `{{WORK_ITEM}}` replaced by
   * the work item. A template (not a prefix) so a provider whose prompt is not the last token —
   * e.g. grok's `-p <prompt> --output-format streaming-json` — is expressible without special-casing.
   */
  readonly argv_template: readonly string[];
  /** Relative auth files copied from the host `~/<auth_subdir>` into the fresh sandbox HOME. */
  readonly auth_files: readonly string[];
  /** Auth subdirectory under HOME (e.g. `.codex`, `.grok`, `.claude`). */
  readonly auth_subdir: string;
  /**
   * Env-injected auth (the claude path): the operator-extracted token enters via `env_var`, plus
   * measured static env the CLI requires headless. MEASURED: claude refuses
   * `--permission-mode bypassPermissions` as root unless `IS_SANDBOX=1` acknowledges the isolated
   * container. Providers with file auth omit this; `auth_files` may then be empty.
   */
  readonly auth_env?: { readonly env_var: string; readonly static_env: Readonly<Record<string, string>> };
  /** Session-log subdirectory the broker preserves on the host side. */
  readonly sessions_subdir: string;
  /**
   * The directory name UNDER `~/<auth_subdir>` the CLI actually writes sessions into inside the
   * container. Default "sessions" (codex/grok, measured); claude writes `~/.claude/projects`.
   */
  readonly sessions_container_dir?: string;
  /**
   * `identity_class.product` (TD §8.4) of this worker — matches the policy identity registry's
   * product string. Reviewer independence compares the review provider's product against THIS, so
   * a same-product reviewer selection can fail closed at entry, before anything is sealed.
   */
  readonly identity_class_product: string;
  /**
   * How to scan the provider's OWN session log / stdout for the observed model (#91). Absent ⇒ the
   * observed model stays UNKNOWN (never guessed): a provider's format must be MEASURED before a
   * `PRESENT` value with a locator is claimed. Both regexes carry exactly ONE capture group that
   * yields the model; `session_regex` runs over each session file's text, `stdout_regex` is the
   * fallback over the worker's stdout. (Previously the session scan hardcoded a `"model":"…"`
   * capture after a prefix match — grok's measured field is `"model_id"`, so the capture now lives
   * in the spec itself; codex's expansion is capture-equivalent, byte-identical in effect.)
   */
  readonly model_scan?: { readonly session_regex: string; readonly stdout_regex: string };
}

export const WORK_ITEM_SENTINEL = "{{WORK_ITEM}}";

export const WORKER_PROVIDERS: Record<WorkerProvider, WorkerProviderProfile> = {
  codex: {
    argv_template: ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-C", "/ws", WORK_ITEM_SENTINEL],
    auth_files: ["auth.json"],
    auth_subdir: ".codex",
    sessions_subdir: "codex-sessions",
    identity_class_product: "codex-cli",
    // Measured: codex writes rollout-*.jsonl with a "model":"..." field (#91).
    model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: "model:\\s*(\\S+)" },
  },
  grok: {
    // Measured live: `grok -p "<prompt>" --output-format streaming-json` authenticates from the
    // injected ~/.grok/auth.json (subscription OAuth) and emits an NDJSON event stream.
    //
    // `--permission-mode bypassPermissions` is grok's analogue of codex's `--sandbox
    // danger-full-access`: it bypasses grok's OWN in-CLI approval prompts for edit tools. Without
    // it grok's default permission mode requires interactive approval, which a headless (`-p`, no
    // TTY) session cannot grant — so grok falls back to emitting a prose plan and never edits
    // files, yielding a no-op candidate the reviewer correctly rejects (observed live, 3rd pilot).
    // Bypassing grok's internal prompts does NOT widen what the surface can reach: the worker still
    // runs inside `--network none` + egress allowlist + host-fs-not-mounted, with only auth.json
    // injected. This restores byte-for-byte the same autonomous-edit posture codex already has.
    argv_template: ["-p", WORK_ITEM_SENTINEL, "--output-format", "streaming-json", "--permission-mode", "bypassPermissions"],
    auth_files: ["auth.json"],
    auth_subdir: ".grok",
    sessions_subdir: "grok-sessions",
    identity_class_product: "grok",
    // Measured (2026-09-06 container probe, grok 1.0.13): the mounted /root/.grok/sessions dir gets
    // <urlencoded-cwd>/<session-id>/chat_history.jsonl with `"model_id":"grok-4.6-build"` (the
    // serving model; `updates.jsonl`'s `"modelId"` is the coarser alias). Headless stdout ends with
    // an `end` event carrying `"modelUsage":{"grok-4.6-build":{…}}` — the fallback capture.
    model_scan: { session_regex: '"model_id"\\s*:\\s*"([^"]+)"', stdout_regex: '"modelUsage":\\{"([^"]+)"' },
  },
  claude: {
    // Measured (2026-09-06 container probes): headless `claude -p <item> --permission-mode
    // bypassPermissions` edits files IF IS_SANDBOX=1 and the OAuth token are in env — as root
    // without IS_SANDBOX it refuses outright ("cannot be used with root/sudo privileges"). The
    // declaration is honest: the worker genuinely runs in the isolated surface container.
    argv_template: ["-p", WORK_ITEM_SENTINEL, "--permission-mode", "bypassPermissions"],
    auth_files: [], // no file auth — the operator-extracted token is injected by env
    auth_subdir: ".claude",
    auth_env: { env_var: "CLAUDE_CODE_OAUTH_TOKEN", static_env: { IS_SANDBOX: "1" } },
    sessions_subdir: "claude-sessions",
    // Measured: claude writes ~/.claude/projects/<cwd-slug>/<uuid>.jsonl (not .../sessions).
    sessions_container_dir: "projects",
    identity_class_product: "claude-code",
    // Measured: the session jsonl carries "model":"claude-sonnet-5" — same field shape as codex.
    model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' },
  },
};

/** Build the full argv (binary + expanded template) for a provider + work item. */
export function workerArgv(provider: WorkerProvider, work_item: string): string[] {
  return [provider, ...WORKER_PROVIDERS[provider].argv_template.map((a) => (a === WORK_ITEM_SENTINEL ? work_item : a))];
}

/** Pure, fail-closed provider-name validation. */
export function resolveWorkerProvider(name: string): WorkerProvider {
  if (Object.prototype.hasOwnProperty.call(WORKER_PROVIDERS, name)) return name as WorkerProvider;
  throw new Error(`unknown worker provider: ${name}`);
}
