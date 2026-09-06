/** Closed set of worker CLI profiles supported by the product. */
export type WorkerProvider = "codex" | "grok";

export interface WorkerProviderProfile {
  /**
   * The provider's exact argv AFTER the binary name, with the sentinel `{{WORK_ITEM}}` replaced by
   * the work item. A template (not a prefix) so a provider whose prompt is not the last token —
   * e.g. grok's `-p <prompt> --output-format streaming-json` — is expressible without special-casing.
   */
  readonly argv_template: readonly string[];
  /** Relative auth files copied from the host `~/<auth_subdir>` into the fresh sandbox HOME. */
  readonly auth_files: readonly string[];
  /** Auth subdirectory under HOME (e.g. `.codex`, `.grok`). */
  readonly auth_subdir: string;
  /** Session-log subdirectory the CLI writes under HOME. */
  readonly sessions_subdir: string;
  /**
   * How to scan the provider's OWN session log / stdout for the observed model (#91). Absent ⇒ the
   * observed model stays UNKNOWN (never guessed): a provider's format must be MEASURED before a
   * `PRESENT` value with a locator is claimed. `session_regex` runs over each session file's text;
   * `stdout_regex` (with one capture group) is the fallback over the worker's stdout.
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
    // Measured: codex writes rollout-*.jsonl with a "model":"..." field (#91).
    model_scan: { session_regex: '"model"\\s*:\\s*"', stdout_regex: "model:\\s*(\\S+)" },
  },
  grok: {
    // Measured live: `grok -p "<prompt>" --output-format streaming-json` authenticates from the
    // injected ~/.grok/auth.json (subscription OAuth) and emits an NDJSON event stream.
    argv_template: ["-p", WORK_ITEM_SENTINEL, "--output-format", "streaming-json"],
    auth_files: ["auth.json"],
    auth_subdir: ".grok",
    sessions_subdir: "grok-sessions",
    // model_scan intentionally omitted: grok's session/model-field format is not yet measured, so
    // observed.model stays UNKNOWN rather than a guessed value (requested != observed honesty).
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
