/**
 * Surface profiles (TD §4.1/§8, PR #102 review findings 1–3): ONE construction, shared by
 * the activities that run the surfaces and by the deployment-control probes that attest
 * their reach — the attestation measures the exact profile production uses.
 *
 * - worker (codex): fresh HOME; ONLY `~/.codex/auth.json` is copied in (no host config.toml,
 *   no MCP servers, no sessions); pinned argv.
 * Isolation of the surfaces themselves (containers / Seatbelt) lives in ./isolation.ts; this
 * module owns only the codex worker PROFILE (auth-only sandbox + pinned argv + profile digest)
 * that the reach attestation binds.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { jcsDigest } from "../kernel/canonical.ts";
import { resolveWorkerProvider, WORKER_PROVIDERS } from "./workerProviders.ts";
import type { WorkerProvider } from "./workerProviders.ts";

export { WORKER_PROVIDERS, resolveWorkerProvider } from "./workerProviders.ts";
export type { WorkerProvider } from "./workerProviders.ts";

// Inside the isolation container the container itself is the sandbox boundary, so codex runs
// with container-native full access (nesting bubblewrap adds no security and stalls startup).
export const WORKER_ARGV_PREFIX: readonly string[] = WORKER_PROVIDERS.codex.argv_prefix;

/** Relative paths copied from the host `~/.codex` into the worker sandbox — auth only. */
export const WORKER_AUTH_FILES: readonly string[] = WORKER_PROVIDERS.codex.auth_files;

export interface WorkerSandbox {
  readonly home: string;
  readonly copied: readonly string[];
}

/** Fresh worker HOME with ONLY the minimum codex auth material (finding 2). */
export function buildWorkerSandbox(baseDir: string, provider: WorkerProvider = "codex"): WorkerSandbox {
  const profile = WORKER_PROVIDERS[resolveWorkerProvider(provider)];
  const home = join(baseDir, "home");
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(home, profile.auth_subdir), { recursive: true });
  mkdirSync(join(home, ".config", "gh-empty"), { recursive: true });
  const copied: string[] = [];
  const hostAuth = join(process.env["HOME"] ?? "", profile.auth_subdir);
  for (const rel of profile.auth_files) {
    const src = join(hostAuth, rel);
    if (existsSync(src)) {
      cpSync(src, join(home, profile.auth_subdir, rel));
      copied.push(rel);
    }
  }
  return { home, copied };
}

/** The worker profile identity bound into WORK_START material AND the reach attestation. */
export function workerProfileDigest(sandbox?: WorkerSandbox, provider: WorkerProvider = "codex"): string {
  const profile = WORKER_PROVIDERS[resolveWorkerProvider(provider)];
  return jcsDigest({
    schema: "cadp.worker-profile.v1",
    product: `${provider}-cli`,
    argv_prefix: [...profile.argv_prefix],
    auth_files: sandbox === undefined ? [...profile.auth_files] : [...sandbox.copied],
    home: "fresh-per-invocation",
  }).value;
}
