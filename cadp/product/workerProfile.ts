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

// Inside the isolation container the container itself is the sandbox boundary, so codex runs
// with container-native full access (nesting bubblewrap adds no security and stalls startup).
export const WORKER_ARGV_PREFIX: readonly string[] = ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check"];

/** Relative paths copied from the host `~/.codex` into the worker sandbox — auth only. */
export const WORKER_AUTH_FILES: readonly string[] = ["auth.json"];

export interface WorkerSandbox {
  readonly home: string;
  readonly copied: readonly string[];
}

/** Fresh worker HOME with ONLY the minimum codex auth material (finding 2). */
export function buildWorkerSandbox(baseDir: string): WorkerSandbox {
  const home = join(baseDir, "home");
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".config", "gh-empty"), { recursive: true });
  const copied: string[] = [];
  const hostCodex = join(process.env["HOME"] ?? "", ".codex");
  for (const rel of WORKER_AUTH_FILES) {
    const src = join(hostCodex, rel);
    if (existsSync(src)) {
      cpSync(src, join(home, ".codex", rel));
      copied.push(rel);
    }
  }
  return { home, copied };
}

/** The worker profile identity bound into WORK_START material AND the reach attestation. */
export function workerProfileDigest(sandbox?: WorkerSandbox): string {
  return jcsDigest({
    schema: "cadp.worker-profile.v1",
    product: "codex-cli",
    argv_prefix: [...WORKER_ARGV_PREFIX],
    auth_files: sandbox === undefined ? [...WORKER_AUTH_FILES] : [...sandbox.copied],
    home: "fresh-per-invocation",
  }).value;
}
