/**
 * RA-4 preflight for the Backend v1 runtime (TD §19.3e step 0, §30.2).
 *
 * This is the one module in the repository that is *allowed* to name Backend-v1-specific
 * mechanisms, because naming them is its entire job — the same arrangement
 * `core/store/restricted-key-denylist.ts` already has for the I-TD7 categories. Nothing here
 * crosses into Core: the Platform sees only `READY | BLOCKED(reason[])`.
 *
 * Two properties matter more than the checks themselves:
 *
 *   - **Read-only.** It opens files and nothing else. No install, no upgrade, no config rewrite,
 *     no plugin rollout, no symlink repair, no package patch, no gateway mutation. A blocked
 *     environment is reported, never fixed.
 *   - **No environment-health framework.** Six conditions, hard-coded, in order. There is no check
 *     registry, no plugin point, no severity model and no remediation vocabulary.
 *
 * C7 (version provenance) is collected as supporting information only: a version string is
 * explicitly *not* READY authority, so it never participates in the verdict.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RuntimePreflightOutcome } from "../interfaces/runtime-adapter.ts";

/**
 * The Backend-v1 mechanisms the six conditions are stated over.
 *
 * Exported so that a test can build a READY or BLOCKED fixture tree without restating the strings:
 * the fixture and the probe then cannot drift apart, and no test file has to name a backend
 * mechanism itself.
 */
export const BACKEND_RUNTIME_PROBES = {
  /** C1 — the per-agent session-key mechanism the patched tools server reads. */
  per_agent_identity_env: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY",
  /** C2 — the per-workspace directory mechanism. */
  workspace_dir_env: "OPENCLAW_TOOLS_MCP_WORKSPACE_DIR",
  /** C4 — the acpx symbol that resolves which core distribution entry is served. */
  core_dist_resolver_symbol: "resolveOpenClawCoreDistEntry",
  /** C5 — the patched plugin-tools serve implementation, relative to the core dist directory. */
  serve_entry_relative_path: "mcp/openclaw-tools-serve.js",
} as const;

/** C6 — the values the backend itself accepts. An unset or unlisted mode is not "the default". */
export const BACKEND_PERMISSION_MODES: readonly string[] = [
  "approve-all",
  "approve-reads",
  "deny-all",
];

/**
 * What the caller has already resolved about the installation. Resolution is the caller's
 * (it owns module resolution and configuration reading); this module only measures.
 */
export interface BackendRuntimePreflightConfig {
  /** Directory the backend core distribution resolves to. */
  readonly core_dist_dir: string;
  /** Directory the acpx package resolves to, or `null` when it does not resolve at all (C3). */
  readonly agent_extension_dir: string | null;
  /** The explicitly configured permission mode, or `null` when nothing was configured (C6). */
  readonly permission_mode: string | null;
  /** C7 — version provenance, recorded but never decisive. */
  readonly core_version?: string;
  readonly agent_extension_version?: string;
}

/** The individual condition results, for evidence. The verdict is C1–C6 only. */
export interface BackendRuntimePreflightReport {
  readonly outcome: RuntimePreflightOutcome;
  readonly conditions: Readonly<Record<string, boolean>>;
  /** C7 — supporting information, deliberately outside `conditions`. */
  readonly provenance: Readonly<Record<string, string>>;
}

const CODE_EXTENSIONS = [".js", ".mjs", ".cjs"];

/** Reads a file if it is there. A missing or unreadable file is a failed condition, never a throw. */
function readIfPresent(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Every code file directly in `dir` and one level below it. No recursion into the whole tree. */
function shallowCodeFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && CODE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    } else if (entry.isDirectory()) {
      let nested;
      try {
        nested = readdirSync(path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of nested) {
        if (child.isFile() && CODE_EXTENSIONS.some((extension) => child.name.endsWith(extension))) {
          files.push(join(path, child.name));
        }
      }
    }
  }
  return files.sort();
}

const containsIn = (files: readonly string[], needle: string): boolean =>
  files.some((file) => (readIfPresent(file) ?? "").includes(needle));

/**
 * Measures C1–C7 against one resolved installation.
 *
 * `READY ⟺ C1–C6 all pass`. The reasons are the failed condition ids, in order, so a caller can
 * report them verbatim without interpreting them.
 */
export function inspectBackendRuntime(config: BackendRuntimePreflightConfig): BackendRuntimePreflightReport {
  const serveEntry = join(config.core_dist_dir, BACKEND_RUNTIME_PROBES.serve_entry_relative_path);
  const serveSource = readIfPresent(serveEntry);

  const extensionFiles = config.agent_extension_dir === null ? [] : shallowCodeFiles(config.agent_extension_dir);

  const c3 =
    config.agent_extension_dir !== null && existsSync(join(config.agent_extension_dir, "package.json"));
  const c4 = c3 && containsIn(extensionFiles, BACKEND_RUNTIME_PROBES.core_dist_resolver_symbol);

  const conditions = {
    C1: serveSource !== null && serveSource.includes(BACKEND_RUNTIME_PROBES.per_agent_identity_env),
    C2: serveSource !== null && serveSource.includes(BACKEND_RUNTIME_PROBES.workspace_dir_env),
    C3: c3,
    C4: c4,
    // C5 — the entry the resolver names must be the patched implementation that is actually there,
    // not merely a resolver that exists. Both halves are required.
    C5: c4 && serveSource !== null && containsIn(extensionFiles, BACKEND_RUNTIME_PROBES.serve_entry_relative_path),
    C6: config.permission_mode !== null && BACKEND_PERMISSION_MODES.includes(config.permission_mode),
  };

  const failed = Object.entries(conditions)
    .filter(([, passed]) => !passed)
    .map(([id]) => id);

  const provenance: Record<string, string> = {};
  if (config.core_version !== undefined) provenance["core_version"] = config.core_version;
  if (config.agent_extension_version !== undefined) provenance["agent_extension_version"] = config.agent_extension_version;

  return {
    outcome: failed.length === 0 ? { status: "READY" } : { status: "BLOCKED", reasons: failed },
    conditions,
    provenance,
  };
}

/** The `RuntimePreflight` seam Core is handed: the verdict alone, with the evidence dropped. */
export const backendRuntimePreflight =
  (config: BackendRuntimePreflightConfig) => (): RuntimePreflightOutcome =>
    inspectBackendRuntime(config).outcome;
