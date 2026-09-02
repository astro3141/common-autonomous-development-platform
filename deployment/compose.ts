/**
 * Dependency construction — the production composition root (PREFLIGHT §6, STATUS mvp1 §8 O1).
 *
 * Wiring over sealed exports, and nothing else: no transition, validation, derivation or
 * eligibility logic lives here, and nothing reaches past `ProductionCoordinator` into a sealed
 * use-case (the CORR1 rule). Every slot is the production implementation; a test may override an
 * *adapter seam* (the runtime gateway, the workflow tool transport) to stand in for the external
 * backend, which replaces the backend, not the Platform.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import {
  backendRuntimePreflight,
  type BackendRuntimePreflightConfig,
} from "../adapters/backend-runtime-preflight/index.ts";
import {
  DurableJobsWorkflowAdapter,
  PluginToolsMcpTransport,
} from "../adapters/durable-jobs-workflow/index.ts";
import { FileReportAdapter } from "../adapters/file-report/index.ts";
import type { ReportAdapter } from "../adapters/interfaces/report-adapter.ts";
import type { RepositoryAdapter } from "../adapters/interfaces/repository-adapter.ts";
import type { RuntimeAdapter, RuntimePreflight } from "../adapters/interfaces/runtime-adapter.ts";
import type { VerificationAdapter } from "../adapters/interfaces/verification-adapter.ts";
import type { WorkflowAdapter } from "../adapters/interfaces/workflow-adapter.ts";
import type { RuntimeProfile } from "../adapters/interfaces/handles.ts";
import {
  DocumentProfileSource,
  FileContractSourceReader,
} from "../adapters/local-drift-source/index.ts";
import {
  GhCliTransport,
  GitHubIssuesChildMaterializer,
  GitHubIssuesTaskSource,
  GitHubPullRequestProjection,
} from "../adapters/github/index.ts";
import { LocalGitRepositoryAdapter } from "../adapters/local-git/index.ts";
import {
  createLocalVerification,
  type DeclaredCheck,
  type VerificationProfileChecks,
} from "../adapters/local-verification/index.ts";
import type { WorkflowToolTransport } from "../adapters/local-verification/index.ts";
import {
  OpenClawProductionGateway,
  OpenClawRuntimeAdapter,
  type OpenClawGatewaySeam,
} from "../adapters/openclaw-runtime/index.ts";
import { RuntimeResultChannel } from "../adapters/runtime-result-channel/index.ts";
import type { ManifestSetInput } from "../core/capability/manifest-set.ts";
import {
  ProductionCoordinator,
  type CoordinatorIdentities,
  type ProductionCoordinatorDependencies,
} from "../core/coordinator/production-coordinator.ts";
import { compileProfile, type CompileResult } from "../core/profile/compiler.ts";
import type { TaskSourceEntry } from "../core/profile/types.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import { PlatformStore } from "../core/store/platform-store.ts";
import { ProjectDocumentTaskSource } from "../core/tasksource/index.ts";
import type { TaskSourceV1 } from "../core/tasksource/types.ts";
import { ConfigError, type DeploymentConfig } from "./config.ts";
import { isoNow, ulid } from "./identities.ts";
import { backendV1Manifests } from "./manifests.ts";

/** Seam-level overrides. Each one replaces an external backend, never a Platform component. */
export interface ComposeOverrides {
  readonly runtime_gateway?: OpenClawGatewaySeam;
  readonly workflow_transport?: WorkflowToolTransport;
  readonly runtime?: RuntimeAdapter;
  readonly workflow?: WorkflowAdapter;
  readonly verification?: VerificationAdapter;
  readonly report?: ReportAdapter;
  readonly repository?: RepositoryAdapter;
  readonly taskSource?: TaskSourceV1;
  readonly preflight?: RuntimePreflight;
  readonly manifests?: ManifestSetInput;
  readonly identities?: CoordinatorIdentities;
  /** §8.1b (D24) — the configured child-materialisation backend, when the Profile declares one. */
  readonly child_materializer?: import("../adapters/interfaces/child-materialization-adapter.ts").ChildTaskMaterializationAdapterV1;
}

export interface Composition {
  readonly config: DeploymentConfig;
  readonly store: PlatformStore;
  readonly compiled: CompileResult;
  readonly coordinator: ProductionCoordinator;
  readonly deps: ProductionCoordinatorDependencies;
  /** #78 — present exactly when the frozen Profile selects the GitHub vertical. */
  readonly projection?: import("../adapters/interfaces/pull-request-projection.ts").PullRequestProjectionAdapterV1;
  readonly projection_base_branch?: string;
  dispose(): void;
}

/** Builds the full dependency graph. Fail-closed: any invalid piece refuses the whole composition. */
export function compose(config: DeploymentConfig, overrides: ComposeOverrides = {}): Composition {
  // I-TD6 (finding 17) — the result channel must be a surface no repository content can reach,
  // judged **before** any directory is created or any store is opened.
  assertResultChannelSeparation(config);

  // TD §7.1d (finding 14) — a production unattended composition must bind its Supervisor in the
  // frozen Profile (v2). Compiling first costs nothing durable; refusing here means a v1 profile
  // never opens a store, never bootstraps a run and never writes an INTENT.
  const compiled = compileProfileDocuments(config);
  if ((compiled.body.effective.project as { supervisor_profile?: string }).supervisor_profile === undefined) {
    throw new ConfigError(
      "/profiles/project_profile_path",
      "a production composition requires ProjectProfile v2 (supervisor_profile); supplementing a v1 profile with a deployment default is forbidden (TD §7.1d)",
    );
  }

  for (const dir of [
    dirname(config.store_path),
    config.report.root,
    config.repository.workspace_root,
    config.result_channel_root,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const store = PlatformStore.open(config.store_path);

  const profiles = new DocumentProfileSource({
    project_profile_path: config.profiles.project_profile_path,
    execution_policy_path: config.profiles.execution_policy_path,
  });

  const contractSources = new FileContractSourceReader(config.contract_source_root);
  // #78 — the TaskSource (and its optional D24 child materializer) is *selected by the frozen
  // Compiled Profile* (§7.1a/§7.1e), never by a deployment default and never inferred from what
  // happens to be installed. The deployment owns only host installation facts (document paths,
  // canonical repository location); the Profile owns which source, and for GitHub, which
  // owner/repo. Unknown adapter ids fail the whole composition closed.
  const github = composeGitHubVertical(config, compiled);
  const taskSource = overrides.taskSource ?? composeTaskSource(config, compiled, github);
  const repository =
    overrides.repository ??
    new LocalGitRepositoryAdapter({
      root: config.repository.root,
      canonical_ref: config.repository.canonical_ref,
      workspace_root: config.repository.workspace_root,
    });

  const preflightConfig: BackendRuntimePreflightConfig = {
    core_dist_dir: config.backend.core_dist_dir,
    agent_extension_dir: config.backend.agent_extension_dir,
    permission_mode: config.backend.permission_mode,
  };
  const preflight: RuntimePreflight = overrides.preflight ?? backendRuntimePreflight(preflightConfig);

  const gateway =
    overrides.runtime_gateway ??
    new OpenClawProductionGateway({
      core_dist_dir: config.backend.core_dist_dir,
      agent_extension_dir: config.backend.agent_extension_dir,
      controller_agent_id: config.backend.controller_agent_id,
      controller_cwd: config.backend.controller_cwd,
    });
  const runtime =
    overrides.runtime ??
    new OpenClawRuntimeAdapter({
      gateway,
      channel: new RuntimeResultChannel(config.result_channel_root),
    });

  const workflow_transport =
    overrides.workflow_transport ??
    new PluginToolsMcpTransport({
      serve_entry: `${config.backend.core_dist_dir}/mcp/openclaw-tools-serve.js`,
      // Trusted-context values are host-injected process environment; the deployment passes them
      // through opaquely and never persists them (I-TD7).
      env: pickEnv([
        "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY",
        "OPENCLAW_TOOLS_MCP_WORKSPACE_DIR",
      ]),
    });
  const workflow =
    overrides.workflow ??
    new DurableJobsWorkflowAdapter({
      transport: workflow_transport,
      // Finding 2 — the binding is whatever the Runtime adapter's controller handle actually is,
      // resolved lazily at first workflow use (post-preflight). No hard-coded stand-in exists for
      // it: the Runtime issues the handle, the Workflow adapter checks against that same handle.
      controller_binding: () =>
        runtime.acquire_workflow_controller() as unknown as CanonicalObject,
    });

  const verification =
    overrides.verification ??
    createLocalVerification({
      preflight,
      runtime,
      workflow,
      repository,
      transport: workflow_transport,
      profiles: declaredChecks(compiled),
    });

  const report = overrides.report ?? new FileReportAdapter(config.report.root);
  const manifests =
    overrides.manifests ??
    backendV1Manifests({ backend_instance_id: config.backend.backend_instance_id });

  const identities: CoordinatorIdentities = overrides.identities ?? {
    nextUlid: () => ulid(),
    now: isoNow,
    reportChannel: config.report.channel,
    supervisorRuntimeProfile: config.supervisor_runtime_profile as unknown as RuntimeProfile,
  };

  const deps: ProductionCoordinatorDependencies = {
    store,
    repository,
    runtime,
    verification,
    report,
    taskSource,
    profiles,
    contractSources,
    manifests,
    preflight,
    ...(overrides.child_materializer !== undefined
      ? { materializer: overrides.child_materializer }
      : github?.materializer !== undefined
        ? { materializer: github.materializer }
        : {}),
    identities,
  };

  return {
    config,
    store,
    compiled,
    deps,
    ...(github === null
      ? {}
      : { projection: github.projection, projection_base_branch: github.base_branch }),
    coordinator: new ProductionCoordinator(deps),
    dispose() {
      store.close();
    },
  };
}

/** The deployment's registered TaskSource adapter ids. Registration is deployment vocabulary. */
const DOCUMENT_TASK_SOURCE_ADAPTER = "ProjectDocumentTaskSource";
const GITHUB_TASK_SOURCE_ADAPTER = "GitHubIssuesTaskSource";
const GITHUB_CHILD_MATERIALIZER_ADAPTER = "GitHubIssuesChildMaterializer";

interface GitHubVertical {
  readonly owner: string;
  readonly repo: string;
  readonly transport: GhCliTransport;
  readonly taskSource: GitHubIssuesTaskSource;
  readonly materializer?: GitHubIssuesChildMaterializer;
  readonly projection: GitHubPullRequestProjection;
  readonly base_branch: string;
}

/** The single frozen Profile task-source entry, or a fail-closed refusal. */
function profileTaskSourceEntry(compiled: CompileResult): TaskSourceEntry {
  const entries = compiled.body.effective.project.task_sources;
  if (entries.length !== 1) {
    throw new ConfigError(
      "/profiles/project_profile_path",
      `the composition supports exactly one frozen task source; the Profile declares ${entries.length}`,
    );
  }
  return entries[0]!;
}

/**
 * #78 — constructs the production GitHub vertical exactly when the frozen Profile selects the
 * GitHub TaskSource. Target identity (owner/repo) comes only from the Profile entry's own
 * config; the D24 materializer is constructed only when the Profile binds one, over the same
 * target and transport, and is handed solely to the existing Coordinator seam.
 */
function composeGitHubVertical(
  config: DeploymentConfig,
  compiled: CompileResult,
): GitHubVertical | null {
  const entry = profileTaskSourceEntry(compiled);
  if (entry.adapter !== GITHUB_TASK_SOURCE_ADAPTER) return null;

  const source_config = entry.config as Record<string, unknown>;
  const owner = source_config["owner"];
  const repo = source_config["repo"];
  const discovery_limit = source_config["discovery_limit"];
  if (typeof owner !== "string" || owner.length === 0 || typeof repo !== "string" || repo.length === 0) {
    throw new ConfigError(
      "/profiles/project_profile_path",
      `task source ${entry.id} (${GITHUB_TASK_SOURCE_ADAPTER}) requires config.owner and config.repo`,
    );
  }

  const transport = new GhCliTransport();
  const taskSource = new GitHubIssuesTaskSource(transport, {
    owner,
    repo,
    ...(typeof discovery_limit === "number" ? { discovery_limit } : {}),
  });

  let materializer: GitHubIssuesChildMaterializer | undefined;
  if (entry.child_materializer !== undefined) {
    if (entry.child_materializer.adapter !== GITHUB_CHILD_MATERIALIZER_ADAPTER) {
      throw new ConfigError(
        "/profiles/project_profile_path",
        `task source ${entry.id} binds unknown child materializer ${JSON.stringify(entry.child_materializer.adapter)}`,
      );
    }
    // §7.1e/D24 — the materializer is bound to this task source: same target identity. A config
    // that names a different target is a contradiction, never a second route.
    const declared = entry.child_materializer.config as Record<string, unknown>;
    for (const [field, expected] of [["owner", owner], ["repo", repo]] as const) {
      if (declared[field] !== undefined && declared[field] !== expected) {
        throw new ConfigError(
          "/profiles/project_profile_path",
          `child materializer ${field} ${JSON.stringify(declared[field])} contradicts the bound task source`,
        );
      }
    }
    materializer = new GitHubIssuesChildMaterializer(transport, { owner, repo });
  }

  // The projection targets the same configured repository; the base branch is a configured
  // canonical repository fact, never caller/model text (#52 acceptance).
  const canonical_ref = config.repository.canonical_ref;
  if (!canonical_ref.startsWith("refs/heads/")) {
    throw new ConfigError(
      "/repository/canonical_ref",
      `PR projection requires a refs/heads/* canonical ref, got ${JSON.stringify(canonical_ref)}`,
    );
  }
  const projection = new GitHubPullRequestProjection(transport, {
    owner,
    repo,
    canonical_repo_path: config.repository.root,
  });
  return {
    owner,
    repo,
    transport,
    taskSource,
    ...(materializer === undefined ? {} : { materializer }),
    projection,
    base_branch: canonical_ref.slice("refs/heads/".length),
  };
}

/** Resolves the Profile-selected TaskSource through the deployment's adapter registry. */
function composeTaskSource(
  config: DeploymentConfig,
  compiled: CompileResult,
  github: GitHubVertical | null,
): TaskSourceV1 {
  if (github !== null) return github.taskSource;
  const entry = profileTaskSourceEntry(compiled);
  if (entry.adapter === DOCUMENT_TASK_SOURCE_ADAPTER) {
    // The Profile selects the document source; *where those documents live on this host* is the
    // deployment installation fact (#78 boundary).
    if (config.task_source === null) {
      throw new ConfigError(
        "/task_source",
        "the Profile selects the document task source, but no document paths are configured",
      );
    }
    return new ProjectDocumentTaskSource({
      paths: config.task_source.paths,
      parser: "markdown-sections-v1",
    });
  }
  throw new ConfigError(
    "/profiles/project_profile_path",
    `task source adapter ${JSON.stringify(entry.adapter)} is not registered in this deployment`,
  );
}

/** Compiles the configured Profile documents through the sealed compiler. */
export function compileProfileDocuments(config: DeploymentConfig): CompileResult {
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
  return compileProfile({
    projectProfile: read(config.profiles.project_profile_path),
    executionPolicy: read(config.profiles.execution_policy_path),
    approvedOverrides:
      config.profiles.approved_overrides_path === null
        ? { items: [] }
        : read(config.profiles.approved_overrides_path),
  });
}

/**
 * The `config` half of each verification profile, read with the adapter-owned vocabulary the
 * deployment declares: `config.checks = [{ check_id, argv, timeout_seconds? }]`. Core never
 * interprets this (TD §7.1a); the adapter that runs the checks does.
 */
function declaredChecks(compiled: CompileResult): Record<string, VerificationProfileChecks> {
  const declared: Record<string, VerificationProfileChecks> = {};
  const profiles = compiled.body.effective.project.verification_profiles as Record<
    string,
    { readonly config: Record<string, unknown> }
  >;
  for (const [id, profile] of Object.entries(profiles)) {
    const checks = profile.config["checks"];
    if (!Array.isArray(checks)) continue;
    declared[id] = checks.map((check, index): DeclaredCheck => {
      const entry = check as Record<string, unknown>;
      const check_id = entry["check_id"];
      const argv = entry["argv"];
      if (typeof check_id !== "string" || !Array.isArray(argv)) {
        throw new Error(`verification profile ${id} check ${index} is not {check_id, argv}`);
      }
      return {
        check_id,
        argv: argv.map(String),
        ...(Number.isInteger(entry["timeout_seconds"])
          ? { timeout_seconds: entry["timeout_seconds"] as number }
          : {}),
      };
    });
  }
  return declared;
}

function pickEnv(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * I-TD6 (finding 17) — the RuntimeResultChannel root must not be, contain, or live inside the
 * repository or its workspace root, judged after resolving symlinks on the nearest existing
 * ancestor so an alias cannot smuggle the channel into repository reach. Runs before any mkdir.
 */
function assertResultChannelSeparation(config: DeploymentConfig): void {
  const channel = canonicalPath(config.result_channel_root);
  for (const [name, path] of [
    ["repository root", config.repository.root],
    ["workspace root", config.repository.workspace_root],
  ] as const) {
    const other = canonicalPath(path);
    if (channel === other || isInside(channel, other) || isInside(other, channel)) {
      throw new ConfigError(
        "/result_channel_root",
        `must be disjoint from the ${name} (${path}) — result artifacts may never share a surface with repository content (I-TD6)`,
      );
    }
  }
}

/** The symlink-resolved form of a path that may not exist yet: realpath of its nearest existing ancestor. */
function canonicalPath(path: string): string {
  let current = resolve(path);
  const pending: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    pending.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync(current) : current;
  return pending.length === 0 ? real : [real, ...pending].join(sep);
}

function isInside(candidate: string, ancestor: string): boolean {
  return candidate.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`);
}
