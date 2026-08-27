/**
 * ProjectProfileV1 validation (TD §7.1a, §7.5).
 *
 * Exactly ten top-level fields, all required. Automation-authority fields are rejected by that
 * exactness alone — there is no separate blacklist engine (§7.5). Adapter `config` bodies stay
 * opaque: their inner fields are preserved and never interpreted.
 */

import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { schemaError } from "./errors.ts";
import {
  asArray,
  asMember,
  asNonEmptyString,
  asObject,
  asOpaqueConfig,
  asInteger,
  assertNonEmptyKeys,
  assertUnique,
  exactKeys,
} from "./shape.ts";
import {
  EXECUTION_DISPOSITIONS,
  PIPELINE_STEPS,
  PROJECT_PROFILE_TOP_LEVEL,
  type AdapterConfigured,
  type ClassificationEntry,
  type ContractSourceEntry,
  type PipelineEntry,
  REPOSITORY_SCOPE_FIELDS,
  type ProjectProfileV1Body,
  type RepositoryScopeV1,
  type RoleEntry,
  type TaskSourceEntry,
} from "./types.ts";

export function validateProjectProfile(input: unknown): ProjectProfileV1Body {
  const body = asObject(input, "");
  exactKeys(body, "", PROJECT_PROFILE_TOP_LEVEL as readonly string[]);

  const id = asNonEmptyString(body["id"], "/id");
  if (id.includes(":")) {
    // §6.1 project_id is a structural segment of task_key.
    throw schemaError("/id", 'must not contain ":" (structural separator)');
  }

  return {
    id,
    version: asInteger(body["version"], "/version", 1),
    repository: adapterConfigured(body["repository"], "/repository"),
    task_sources: taskSources(body["task_sources"]),
    contract_sources: contractSources(body["contract_sources"]),
    classifications: classifications(body["classifications"]),
    roles: roles(body["roles"]),
    pipelines: pipelines(body["pipelines"]),
    verification_profiles: adapterConfiguredMap(
      body["verification_profiles"],
      "/verification_profiles",
    ),
    repository_scopes: repositoryScopes(body["repository_scopes"]),
    hooks: adapterConfiguredMap(body["hooks"], "/hooks"),
  };
}

/**
 * TD §7.1a (M1-6) — named repository mutation scopes.
 *
 * At least one entry is required in MVP 1 and there is **no implicit default**: a Profile that
 * declares no scope cannot compile, because a missing scope must never resolve to "the whole
 * repository". Path arrays are carried verbatim — order-sensitive, never sorted or deduplicated.
 */
function repositoryScopes(value: unknown): Readonly<Record<string, RepositoryScopeV1>> {
  const map = asObject(value, "/repository_scopes");
  const ids = Object.keys(map);
  if (ids.length === 0) {
    throw schemaError("/repository_scopes", "at least one repository scope must be declared");
  }

  const scopes: Record<string, RepositoryScopeV1> = {};
  for (const id of ids) {
    const path = `/repository_scopes/${id}`;
    if (id.length === 0) throw schemaError(path, "scope id must not be empty");
    const scope = asObject(map[id], path);
    exactKeys(scope, path, REPOSITORY_SCOPE_FIELDS as readonly string[]);
    scopes[id] = {
      allowed_paths: pathList(scope["allowed_paths"], `${path}/allowed_paths`),
      forbidden_paths: pathList(scope["forbidden_paths"], `${path}/forbidden_paths`),
    };
  }
  return scopes;
}

function pathList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw schemaError(path, "expected an array");
  return value.map((entry, index) => asNonEmptyString(entry, `${path}/${index}`));
}

function adapterConfigured(value: unknown, path: string): AdapterConfigured {
  const object = asObject(value, path);
  exactKeys(object, path, ["adapter", "config"]);
  return {
    adapter: asNonEmptyString(object["adapter"], `${path}/adapter`),
    config: asOpaqueConfig(object["config"], `${path}/config`),
  };
}

function adapterConfiguredMap(
  value: unknown,
  path: string,
): Readonly<Record<string, AdapterConfigured>> {
  const object = asObject(value, path);
  assertNonEmptyKeys(object, path);
  const result: Record<string, AdapterConfigured> = {};
  for (const [key, entry] of Object.entries(object)) {
    result[key] = adapterConfigured(entry, `${path}/${key}`);
  }
  return result;
}

function taskSources(value: unknown): readonly TaskSourceEntry[] {
  const entries = asArray(value, "/task_sources");
  const result = entries.map((entry, index) => {
    const path = `/task_sources/${index}`;
    const object = asObject(entry, path);
    exactKeys(object, path, ["id", "adapter", "config"]);
    return {
      id: asNonEmptyString(object["id"], `${path}/id`),
      adapter: asNonEmptyString(object["adapter"], `${path}/adapter`),
      config: asOpaqueConfig(object["config"], `${path}/config`),
    };
  });
  assertUnique(
    result.map((entry) => entry.id),
    "/task_sources",
    "task source id",
  );
  return result;
}

function contractSources(value: unknown): readonly ContractSourceEntry[] {
  const entries = asArray(value, "/contract_sources");
  const result = entries.map((entry, index) => {
    const path = `/contract_sources/${index}`;
    const object = asObject(entry, path);
    exactKeys(object, path, ["path"]);
    return { path: asNonEmptyString(object["path"], `${path}/path`) };
  });
  assertUnique(
    result.map((entry) => entry.path),
    "/contract_sources",
    "contract source path",
  );
  return result;
}

function classifications(value: unknown): Readonly<Record<string, ClassificationEntry>> {
  const object = asObject(value, "/classifications");
  assertNonEmptyKeys(object, "/classifications");
  const result: Record<string, ClassificationEntry> = {};
  for (const [name, entry] of Object.entries(object)) {
    const path = `/classifications/${name}`;
    const body = asObject(entry, path);
    exactKeys(body, path, ["default_execution_policy"]);
    result[name] = {
      default_execution_policy: asMember(
        body["default_execution_policy"],
        `${path}/default_execution_policy`,
        EXECUTION_DISPOSITIONS,
      ),
    };
  }
  return result;
}

function roles(value: unknown): Readonly<Record<string, RoleEntry>> {
  const object = asObject(value, "/roles");
  assertNonEmptyKeys(object, "/roles");
  const result: Record<string, RoleEntry> = {};
  for (const [id, entry] of Object.entries(object)) {
    const path = `/roles/${id}`;
    const body = asObject(entry, path);
    exactKeys(body, path, ["runtime_profile", "config"]);
    result[id] = {
      runtime_profile: asNonEmptyString(body["runtime_profile"], `${path}/runtime_profile`),
      config: asOpaqueConfig(body["config"], `${path}/config`) as CanonicalObject,
    };
  }
  return result;
}

function pipelines(value: unknown): Readonly<Record<string, PipelineEntry>> {
  const object = asObject(value, "/pipelines");
  assertNonEmptyKeys(object, "/pipelines");
  const result: Record<string, PipelineEntry> = {};
  for (const [id, entry] of Object.entries(object)) {
    const path = `/pipelines/${id}`;
    const body = asObject(entry, path);
    const rawSteps = asArray(
      (body as Record<string, unknown>)["steps"],
      `${path}/steps`,
    );
    if (rawSteps.length === 0) throw schemaError(`${path}/steps`, "must not be empty");
    // Step order and repetition carry no rule the TD states, so none is imposed here.
    const steps = rawSteps.map((step, index) =>
      asMember(step, `${path}/steps/${index}`, PIPELINE_STEPS),
    );

    // M1-10 — the pipeline body stays exact; it simply has one more field when, and only when,
    // the pipeline actually audits. This is a declared role reference, not an extensible bag.
    const audits = steps.includes("AUDITOR");
    exactKeys(body, path, audits ? ["steps", "auditor_profile"] : ["steps"]);
    if (!audits) {
      result[id] = { steps };
      continue;
    }
    const auditor_profile = body["auditor_profile"];
    if (typeof auditor_profile !== "string" || auditor_profile.length === 0) {
      throw schemaError(`${path}/auditor_profile`, "must be a non-empty role reference");
    }
    result[id] = { steps, auditor_profile };
    continue;
  }
  return result;
}
