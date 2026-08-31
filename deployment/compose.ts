/**
 * Dependency construction — the production composition root (PREFLIGHT §6, STATUS mvp1 §8 O1).
 *
 * Wiring over sealed exports, and nothing else: no transition, validation, derivation or
 * eligibility logic lives here, and nothing reaches past `ProductionCoordinator` into a sealed
 * use-case (the CORR1 rule). Every slot is the production implementation; a test may override an
 * *adapter seam* (the runtime gateway, the workflow tool transport) to stand in for the external
 * backend, which replaces the backend, not the Platform.
 */

import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

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
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import { PlatformStore } from "../core/store/platform-store.ts";
import { ProjectDocumentTaskSource } from "../core/tasksource/index.ts";
import type { TaskSourceV1 } from "../core/tasksource/types.ts";
import type { DeploymentConfig } from "./config.ts";
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
}

export interface Composition {
  readonly config: DeploymentConfig;
  readonly store: PlatformStore;
  readonly compiled: CompileResult;
  readonly coordinator: ProductionCoordinator;
  readonly deps: ProductionCoordinatorDependencies;
  dispose(): void;
}

/** Builds the full dependency graph. Fail-closed: any invalid piece refuses the whole composition. */
export function compose(config: DeploymentConfig, overrides: ComposeOverrides = {}): Composition {
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
  const compiled = compileProfileDocuments(config);

  const contractSources = new FileContractSourceReader(config.contract_source_root);
  const taskSource =
    overrides.taskSource ??
    new ProjectDocumentTaskSource({
      paths: config.task_source.paths,
      parser: "markdown-sections-v1",
    });
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
      controller_binding: {
        controller_agent_id: config.backend.controller_agent_id,
        controller_session_id: "managed",
      } as unknown as CanonicalObject,
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
    identities,
  };

  return {
    config,
    store,
    compiled,
    deps,
    coordinator: new ProductionCoordinator(deps),
    dispose() {
      store.close();
    },
  };
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
