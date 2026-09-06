/** Closed set of worker CLI profiles supported by the product. */
export type WorkerProvider = "codex" | "grok" | "gemini";

export interface WorkerProviderProfile {
  readonly argv_prefix: readonly string[];
  readonly auth_files: readonly string[];
  readonly auth_subdir: string;
  readonly sessions_subdir: string;
}

/**
 * Provider-controlled paths and arguments only. None of these values may be supplied by a work
 * item: they determine the small credential surface copied into each fresh worker HOME.
 */
export const WORKER_PROVIDERS: Record<WorkerProvider, WorkerProviderProfile> = {
  codex: {
    argv_prefix: ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check"],
    auth_files: ["auth.json"],
    auth_subdir: ".codex",
    sessions_subdir: "codex-sessions",
  },
  grok: {
    argv_prefix: [],
    auth_files: ["auth.json"],
    auth_subdir: ".grok",
    sessions_subdir: "grok-sessions",
  },
  gemini: {
    argv_prefix: [],
    auth_files: ["oauth_creds.json"],
    auth_subdir: ".gemini",
    sessions_subdir: "gemini-sessions",
  },
};

/** Pure, fail-closed provider-name validation. */
export function resolveWorkerProvider(name: string): WorkerProvider {
  if (Object.prototype.hasOwnProperty.call(WORKER_PROVIDERS, name)) return name as WorkerProvider;
  throw new Error(`unknown worker provider: ${name}`);
}
