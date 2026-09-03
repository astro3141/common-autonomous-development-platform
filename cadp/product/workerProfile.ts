/**
 * Surface profiles (TD §4.1/§8, PR #102 review findings 1–3): ONE construction, shared by
 * the activities that run the surfaces and by the deployment-control probes that attest
 * their reach — the attestation measures the exact profile production uses.
 *
 * - worker (codex): fresh HOME; ONLY `~/.codex/auth.json` is copied in (no host config.toml,
 *   no MCP servers, no sessions); pinned argv.
 * - verifier (candidate `node --test`): fully scrubbed env — no kernel URL/tokens, no
 *   credentials; untrusted candidate code sees nothing it could act on.
 * - reviewer (claude -p): real HOME (Claude authentication lives there) with every other
 *   credential surface neutralized at env level: git global/system config disabled, empty gh
 *   config, no SSH agent, no token env, no CADP_* vars.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { jcsDigest } from "../kernel/canonical.ts";

export const WORKER_ARGV_PREFIX: readonly string[] = ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"];

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

export function workerEnv(home: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    GH_CONFIG_DIR: join(home, ".config", "gh-empty"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

/**
 * Verifier env (finding 1): the candidate's own test process runs with NOTHING — no kernel
 * URL, no tokens, no credential surfaces. Exported so the negative control and the live
 * verifier use the identical construction.
 */
export function verifierEnv(home: string): Record<string, string> {
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(home, ".config", "gh-empty"), { recursive: true });
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    GH_CONFIG_DIR: join(home, ".config", "gh-empty"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

/**
 * Reviewer env (finding 3): minimal — Claude authentication context (real HOME + USER) plus
 * read-only terminal vars; git global/system config disabled, empty gh config, no SSH agent,
 * no token env, no CADP_* vars. Measured stable for `claude -p`.
 */
export function reviewerEnv(sandboxHome: string): Record<string, string> {
  mkdirSync(join(sandboxHome, "tmp"), { recursive: true });
  mkdirSync(join(sandboxHome, ".config", "gh-empty"), { recursive: true });
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? sandboxHome,
    USER: process.env["USER"] ?? "cadp",
    TMPDIR: join(sandboxHome, "tmp"),
    GH_CONFIG_DIR: join(sandboxHome, ".config", "gh-empty"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}
