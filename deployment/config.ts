/**
 * Deployment configuration — load + validation (composition root, PREFLIGHT §6).
 *
 * Configuration is deployment-owned fact: paths, ports, channel names, backend install locations.
 * Nothing here is Platform policy — policy lives in the Project Profile / Execution Policy
 * documents the config merely points at. Validation is fail-closed: a config that cannot be read
 * completely is not "defaulted", it is rejected.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface DeploymentConfig {
  readonly project_id: string;
  readonly store_path: string;
  readonly profiles: {
    readonly project_profile_path: string;
    readonly execution_policy_path: string;
    /** Optional; when absent an empty override set is compiled. */
    readonly approved_overrides_path: string | null;
  };
  /** Root the declared, repository-relative contract-source paths resolve against. */
  readonly contract_source_root: string;
  readonly task_source: { readonly paths: readonly string[] };
  readonly repository: {
    readonly root: string;
    readonly canonical_ref: string;
    readonly workspace_root: string;
  };
  readonly report: { readonly root: string; readonly channel: string };
  readonly ingress: { readonly port: number; readonly host: string };
  /**
   * #55 — the read-only observation server (worker thread, own read-only store connection).
   * `null` disables it. It exists so the read-only surface stays reachable while the lifecycle
   * thread is inside a model turn; it holds no authority and accepts no mutation.
   */
  readonly observation: { readonly port: number; readonly host: string } | null;
  readonly supervisor_runtime_profile: string;
  /** Host-owned ephemeral directory for the RuntimeResultChannel; never inside a repository. */
  readonly result_channel_root: string;
  readonly backend: {
    readonly core_dist_dir: string;
    readonly agent_extension_dir: string | null;
    readonly permission_mode: string | null;
    readonly backend_instance_id: string;
    readonly controller_agent_id: string;
    readonly controller_cwd: string;
  };
  readonly tick_interval_ms: number;
}

export class ConfigError extends Error {
  constructor(field: string, detail: string) {
    super(`deployment config ${field}: ${detail}`);
    this.name = "ConfigError";
  }
}

/** Loads and validates the JSON config file; relative paths resolve against the file's directory. */
export function loadConfig(path: string): DeploymentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError("/", `cannot read ${path}: ${(error as Error).message}`);
  }
  return validateConfig(raw, dirname(resolve(path)));
}

export function validateConfig(raw: unknown, baseDir: string): DeploymentConfig {
  const root = asObject(raw, "/");
  const against = (value: string): string => (isAbsolute(value) ? value : resolve(baseDir, value));

  const profiles = asObject(root["profiles"], "/profiles");
  const taskSource = asObject(root["task_source"], "/task_source");
  const repository = asObject(root["repository"], "/repository");
  const report = asObject(root["report"], "/report");
  const ingress = asObject(root["ingress"] ?? { port: 0, host: "127.0.0.1" }, "/ingress");
  const backend = asObject(root["backend"], "/backend");

  const paths = taskSource["paths"];
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string")) {
    throw new ConfigError("/task_source/paths", "must be a non-empty string array");
  }

  return {
    project_id: asString(root["project_id"], "/project_id"),
    store_path: against(asString(root["store_path"], "/store_path")),
    profiles: {
      project_profile_path: against(
        asString(profiles["project_profile_path"], "/profiles/project_profile_path"),
      ),
      execution_policy_path: against(
        asString(profiles["execution_policy_path"], "/profiles/execution_policy_path"),
      ),
      approved_overrides_path:
        profiles["approved_overrides_path"] === undefined ||
        profiles["approved_overrides_path"] === null
          ? null
          : against(
              asString(profiles["approved_overrides_path"], "/profiles/approved_overrides_path"),
            ),
    },
    contract_source_root: against(
      asString(root["contract_source_root"], "/contract_source_root"),
    ),
    task_source: { paths: (paths as string[]).map(against) },
    repository: {
      root: against(asString(repository["root"], "/repository/root")),
      canonical_ref: asString(repository["canonical_ref"], "/repository/canonical_ref"),
      workspace_root: against(asString(repository["workspace_root"], "/repository/workspace_root")),
    },
    report: {
      root: against(asString(report["root"], "/report/root")),
      channel: asString(report["channel"], "/report/channel"),
    },
    ingress: {
      port: asPort(ingress["port"], "/ingress/port"),
      host: typeof ingress["host"] === "string" ? ingress["host"] : "127.0.0.1",
    },
    observation:
      root["observation"] === undefined || root["observation"] === null
        ? null
        : (() => {
            const observation = asObject(root["observation"], "/observation");
            return {
              port: asPort(observation["port"], "/observation/port"),
              host: typeof observation["host"] === "string" ? observation["host"] : "127.0.0.1",
            };
          })(),
    supervisor_runtime_profile: asString(
      root["supervisor_runtime_profile"],
      "/supervisor_runtime_profile",
    ),
    result_channel_root: against(
      asString(root["result_channel_root"], "/result_channel_root"),
    ),
    backend: {
      core_dist_dir: against(asString(backend["core_dist_dir"], "/backend/core_dist_dir")),
      agent_extension_dir:
        backend["agent_extension_dir"] === null || backend["agent_extension_dir"] === undefined
          ? null
          : against(asString(backend["agent_extension_dir"], "/backend/agent_extension_dir")),
      permission_mode:
        backend["permission_mode"] === null || backend["permission_mode"] === undefined
          ? null
          : asString(backend["permission_mode"], "/backend/permission_mode"),
      backend_instance_id: asString(
        backend["backend_instance_id"],
        "/backend/backend_instance_id",
      ),
      controller_agent_id: asString(
        backend["controller_agent_id"],
        "/backend/controller_agent_id",
      ),
      controller_cwd: against(asString(backend["controller_cwd"], "/backend/controller_cwd")),
    },
    tick_interval_ms: asInterval(root["tick_interval_ms"]),
  };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(field, "must be a non-empty string");
  }
  return value;
}

function asPort(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65535) {
    throw new ConfigError(field, "must be an integer port");
  }
  return value as number;
}

function asInterval(value: unknown): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || (value as number) < 100) {
    throw new ConfigError("/tick_interval_ms", "must be an integer >= 100");
  }
  return value as number;
}
