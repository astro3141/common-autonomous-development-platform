/**
 * Deployment-composition fixtures: a real pilot world on disk.
 *
 * A temp directory holds everything a deployment owns — a real canonical git repository, real
 * Profile/Policy JSON documents, a real task document, a real contract source and a real store
 * path — so the production composition can be exercised with only the *external backends*
 * replaced at their seams. Nothing here stubs a Platform component.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BackendGatewaySeam,
  GatewayEnsureSessionRequest,
  GatewaySessionRef,
  GatewayTurnStatus,
} from "../../adapters/backend-v1/index.ts";
import { validateConfig, type DeploymentConfig } from "../../deployment/config.ts";
import { tempGitRepo, CANONICAL_REF, type TempGitRepo } from "./temp-git-repo.ts";

export const PILOT_TASK_REF = "T-1";
export const PILOT_CLASSIFICATION = "ROUTINE";
export const PILOT_PIPELINE = "standard";
export const PILOT_ACTOR_PROFILE = "implementation";
export const PILOT_VERIFICATION_PROFILE = "full";
export const PILOT_SCOPE = "feature_scope";
export const PILOT_CHECK = "unit";

export const pilotProjectProfile = (): Record<string, unknown> => ({
  id: "pilot",
  version: 1,
  // TD §7.1d — a production unattended composition binds its Supervisor explicitly (v2).
  supervisor_profile: "supervisor",
  repository: { adapter: "local-git", config: {} },
  task_sources: [
    {
      id: "docs",
      adapter: "ProjectDocumentTaskSource",
      config: { paths: ["TASKS.md"], parser: "markdown-sections-v1" },
    },
  ],
  contract_sources: [{ path: "SPEC.md" }],
  classifications: {
    [PILOT_CLASSIFICATION]: { default_execution_policy: "AUTO_EXECUTE" },
  },
  roles: {
    supervisor: { runtime_profile: "supervisor-agent", config: {} },
    [PILOT_ACTOR_PROFILE]: { runtime_profile: "actor-agent", config: {} },
    review: { runtime_profile: "auditor-agent", config: {} },
  },
  pipelines: {
    [PILOT_PIPELINE]: {
      steps: ["ACTOR", "VERIFY", "AUDITOR", "MERGE_GATE"],
      auditor_profile: "review",
    },
  },
  verification_profiles: {
    [PILOT_VERIFICATION_PROFILE]: {
      adapter: "local-verification",
      config: {
        checks: [{ check_id: PILOT_CHECK, argv: ["node", "-e", "process.exit(0)"] }],
      },
    },
  },
  repository_scopes: {
    [PILOT_SCOPE]: { allowed_paths: ["src"], forbidden_paths: [] },
  },
  hooks: {},
});

export const pilotExecutionPolicy = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "pilot-guarded",
  version: 1,
  classification_policy: {},
  auto_merge: false,
  allow_auto_subflow: false,
  batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 },
  repository_policy: {
    remote_push: "DENY",
    direct_canonical_write: false,
    allow_force_push: false,
    allow_tag_change: false,
    allow_git_clean: false,
    allow_reset_hard: false,
  },
  human_gate_policy: { required_decisions: [] },
  verification_policy: {
    required_verification: { [PILOT_CHECK]: { accepted_assurance: ["REEXECUTED"] } },
  },
  // Exactly what Backend v1 honestly provides today (TD §12.3): reduced-assurance feature write,
  // unaudited shell/read. A stricter policy is *supposed* to be rejected by V10 on this backend.
  capability_requirements: {
    actor_execution: {
      "repository.feature_write": {
        accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE"],
      },
      "shell.execute": {
        accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE", "NOT_YET_AUDITED"],
      },
    },
    auditor_execution: {
      "repository.read": {
        accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE", "NOT_YET_AUDITED"],
      },
    },
  },
  contract_drift_policy: {
    canonical_head: { action: "HOLD_AT_BOUNDARY", boundary: "MERGE_ONLY" },
  },
  recovery_policy: { capability_downgrade: "HOLD" },
  ...overrides,
});

export const pilotTaskDocument = (): string => `# Pilot backlog

## Task
task-ref: ${PILOT_TASK_REF}
version: 1
state: READY
title: Add the feature marker

### Description
Create src/feature.txt with the marker line.

### Dependencies

### References
- SPEC.md

### Acceptance
- src/feature.txt exists with the marker line
`;

export interface PilotWorld {
  readonly repo: TempGitRepo;
  readonly base: string;
  readonly config: DeploymentConfig;
  /** The canonical head the pilot started from. */
  readonly base_head: string;
  dispose(): void;
}

/** Builds the on-disk pilot world and its deployment config. */
export function pilotWorld(policyOverrides: Record<string, unknown> = {}): PilotWorld {
  const repo = tempGitRepo();
  const base = join(repo.root, "..");

  // The repository carries the pilot's own documents — task source and contract source are
  // repository content, exactly as a real project would hold them.
  writeFileSync(join(repo.root, "SPEC.md"), "# Pilot spec\n\nThe marker must exist.\n");
  writeFileSync(join(repo.root, "TASKS.md"), pilotTaskDocument());
  mkdirSync(join(repo.root, "src"), { recursive: true });
  writeFileSync(join(repo.root, "src", ".keep"), "");
  repo.git(["add", "--all"]);
  repo.git(["commit", "--quiet", "-m", "pilot world"]);
  const base_head = repo.head();

  writeFileSync(join(base, "project-profile.json"), JSON.stringify(pilotProjectProfile()));
  writeFileSync(
    join(base, "execution-policy.json"),
    JSON.stringify(pilotExecutionPolicy(policyOverrides)),
  );

  const config = validateConfig(
    {
      project_id: "pilot",
      store_path: join(base, "state", "platform.db"),
      profiles: {
        project_profile_path: join(base, "project-profile.json"),
        execution_policy_path: join(base, "execution-policy.json"),
        approved_overrides_path: null,
      },
      contract_source_root: repo.root,
      task_source: { paths: [join(repo.root, "TASKS.md")] },
      repository: {
        root: repo.root,
        canonical_ref: CANONICAL_REF,
        workspace_root: repo.workspaceRoot,
      },
      report: { root: join(base, "reports"), channel: "operations" },
      ingress: { port: 0, host: "127.0.0.1" },
      supervisor_runtime_profile: "supervisor-agent",
      result_channel_root: join(base, "result-channel"),
      backend: {
        core_dist_dir: join(base, "no-backend", "dist"),
        agent_extension_dir: null,
        permission_mode: "approve-reads",
        backend_instance_id: "pilot-host",
        controller_agent_id: "platform-controller",
        controller_cwd: base,
      },
      tick_interval_ms: 1000,
    },
    base,
  );

  return {
    repo,
    base,
    config,
    base_head,
    dispose() {
      repo.dispose();
    },
  };
}

/**
 * A scripted runtime gateway: the Backend v1 runtime at its measured seam. Sessions are logical and
 * deterministic; turn completion is a fact the test states, never something inferred.
 */
export class ScriptedGateway implements BackendGatewaySeam {
  readonly ensures: GatewayEnsureSessionRequest[] = [];
  readonly turns: { session: GatewaySessionRef; request_id: string; instruction: string }[] = [];
  readonly #sessions = new Map<string, GatewaySessionRef>();
  readonly #statuses = new Map<string, GatewayTurnStatus>();
  #next = 0;

  ensure_session(request: GatewayEnsureSessionRequest): GatewaySessionRef {
    this.ensures.push(request);
    const key = `${request.role}:${request.runtime_profile}:${request.cwd}`;
    const existing = this.#sessions.get(key);
    if (existing !== undefined) return existing;
    const ref: GatewaySessionRef = {
      agent_id: request.runtime_profile,
      session_id: `session-${++this.#next}`,
    };
    this.#sessions.set(key, ref);
    return ref;
  }

  start_turn(session: GatewaySessionRef, request_id: string, instruction: string): void {
    this.turns.push({ session, request_id, instruction });
  }

  turn_status(session: GatewaySessionRef, request_id: string): GatewayTurnStatus | undefined {
    return this.#statuses.get(`${session.agent_id}:${session.session_id}:${request_id}`);
  }

  /** The test states the backend fact: this turn ended. */
  complete(session: GatewaySessionRef, request_id: string): void {
    this.#statuses.set(`${session.agent_id}:${session.session_id}:${request_id}`, {
      backend_status: "COMPLETED",
      termination_reason: "end_turn",
      started_at: "t1",
      completed_at: "t2",
    });
  }

  /** The test states the backend fact: the session vanished (backend restart — ALIVE-4). */
  lose(session: GatewaySessionRef, request_id: string): void {
    this.#statuses.set(`${session.agent_id}:${session.session_id}:${request_id}`, {
      backend_status: "SESSION_LOST",
      termination_reason: "session_lost",
      started_at: "t1",
      completed_at: "t2",
    });
  }

  session_status(session: GatewaySessionRef): Record<string, unknown> {
    return { ...session };
  }

  cancel_session(): void {}
  close_session(): void {}

  controller_session(): GatewaySessionRef {
    return { agent_id: "platform-controller", session_id: "controller-1" };
  }
}
