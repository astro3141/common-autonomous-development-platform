/**
 * Neutral durable-domain fixtures.
 *
 * Invented vocabulary only (`IMPLEMENTABLE`, `standard`, `T-101`) so the independence guards keep
 * passing, and every identity is caller-supplied exactly as the contracts require.
 */

import { buildTaskContract, type TaskContractBuildResult } from "../../core/contract/builder.ts";
import { buildHumanGateDecision } from "../../core/humandecision/gate-request.ts";
import type { PendingDecisionV1 } from "../../core/humandecision/types.ts";
import { validateProposal } from "../../core/decision/proposal.ts";
import type { ProposalV1 } from "../../core/decision/types.ts";
import type { CompileResult } from "../../core/profile/compiler.ts";
import type {
  ExternalTaskSnapshotV1,
  SelectionBindingV1,
} from "../../core/store/domain-types.ts";
import { PlatformStore } from "../../core/store/platform-store.ts";
import { commitTaskDiscovery } from "../../core/statemachine/transition-commit.ts";
import {
  compiled,
  executionPolicy,
  manifests,
  projectProfile,
  selection,
  task,
  HEAD,
} from "./decision-fixtures.ts";
import { tempStore, type TempStore } from "./temp-store.ts";

export const ULID = {
  run: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA1",
  snapshot: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA2",
  snapshot2: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA9",
  actorGrant: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA3",
  auditorGrant: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA4",
  decision: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA5",
  decisionB: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA6",
  supervisorGrant: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA7",
  action: "01JQ8ZK5T7RC9V2W4X6Y8Z0AA8",
} as const;

export const PROJECT = "alpha";
export const RUN_ID = `run:${ULID.run}`;
export const BATCH_ID = `${"batch:"}${RUN_ID}:1`;
export const TASK_REF = "T-101";
export const TASK_KEY = `task:${PROJECT}:${TASK_REF}`;
export const ATTEMPT_KEY = `attempt:${TASK_KEY}:1`;

export const snapshot = (
  overrides: Partial<ExternalTaskSnapshotV1> = {},
): ExternalTaskSnapshotV1 => ({
  external_state: "READY",
  version: task().version,
  definition_hash: task().definition_hash,
  observed_at: "obs-1",
  ...overrides,
});

export interface DomainWorld {
  readonly temp: TempStore;
  readonly store: PlatformStore;
  readonly profile: CompileResult;
  /**
   * The exact normalized documents the Compiled Profile was compiled from. M1-11's `ProfileSource`
   * observes *components*, not the compiled result — `effective.policy` has the classification
   * policy resolved into it, so its hash is not the Execution Policy component's hash.
   */
  readonly inputs: {
    readonly project: Record<string, unknown>;
    readonly policy: Record<string, unknown>;
  };
  dispose(): void;
}

/** A store with a persisted Compiled Profile, one run and one batch. */
export function world(
  policyOverrides: Record<string, unknown> = {},
  options: { readonly now?: () => string; readonly projectOverrides?: Record<string, unknown> } = {},
): DomainWorld {
  const temp = tempStore();
  const store = temp.open(options.now === undefined ? {} : { now: options.now });
  const projectOverrides = options.projectOverrides ?? {};
  const inputs = { project: projectProfile(projectOverrides), policy: executionPolicy(policyOverrides) };
  const profile = compiled(policyOverrides, projectOverrides);

  store.withTransaction(() => {
    store.compiledProfiles.put(profile);
    store.runs.create({
      run_id: RUN_ID,
      project_id: PROJECT,
      compiled_profile_hash: profile.compiled_hash,
    });
    store.batches.create({
      batch_id: BATCH_ID,
      run_id: RUN_ID,
      ordinal: 1,
      compiled_profile_hash: profile.compiled_hash,
    });
  });

  return {
    temp,
    store,
    profile,
    inputs,
    dispose() {
      store.close();
      temp.dispose();
    },
  };
}

export const withWorld = <T>(
  run: (world: DomainWorld) => T,
  policyOverrides: Record<string, unknown> = {},
  options: { readonly now?: () => string; readonly projectOverrides?: Record<string, unknown> } = {},
): T => {
  const created = world(policyOverrides, options);
  try {
    return run(created);
  } finally {
    created.dispose();
  }
};

/** Records a DISCOVERED task; `ref` may contain ':' and is preserved verbatim. */
export function discover(world: DomainWorld, ref = TASK_REF): string {
  const taskKey = `task:${PROJECT}:${ref}`;
  commitTaskDiscovery(world.store, {
    task_key: taskKey,
    batch_id: BATCH_ID,
    project_id: PROJECT,
    external_task_ref: ref,
    external_snapshot: snapshot(),
  });
  return taskKey;
}

export const SELECTION = {
  classification: "IMPLEMENTABLE",
  pipeline_id: "standard",
  actor_profile: "implementation",
  verification_profile: "full",
} as const;

export const SCOPE_ID = "collector";

/** M1-7 — the validated selection basis a real admission would have recorded. */
export const BINDING: SelectionBindingV1 = {
  task_version: task().version,
  task_definition_hash: task().definition_hash,
  base_head: HEAD,
};

/** The whole selection provenance one admission writes (§19.3a). */
export const SELECTION_WRITE = {
  selection: SELECTION,
  repository_scope_id: SCOPE_ID,
  selection_binding: BINDING,
} as const;

/** Distinct valid ULIDs for fixtures that need several snapshots. */
export const snapshotId = (index: number): string =>
  `01JQ8ZK5T7RC9V2W4X6Y8Z0B${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[index] ?? "0"}${
    "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[index % 32] ?? "0"
  }`;

/** A completed Batch 6 build. Batch 8 only persists what this produced. */
export function contractBuild(
  world: DomainWorld,
  overrides: { attempt?: number; snapshot_id?: string; task_ref?: string } = {},
) {
  return (): TaskContractBuildResult =>
    buildTaskContract({
      snapshot_id:
        overrides.snapshot_id ?? ((overrides.attempt ?? 1) === 1 ? ULID.snapshot : ULID.snapshot2),
      task: task(overrides.task_ref === undefined ? {} : { task_ref: overrides.task_ref }),
      attempt: overrides.attempt ?? 1,
      base_head: HEAD,
      compiled_profile: world.profile,
      contract_sources: [{ path: "SPEC.md", bytes: new TextEncoder().encode("spec bytes\n") }],
      pipeline_id: SELECTION.pipeline_id,
      verification_profile: SELECTION.verification_profile,
      repository_scope: { allowed_paths: ["src/"], forbidden_paths: [] },
      manifests: manifests(),
      actor_grant_id: ULID.actorGrant,
      auditor_grant_id: ULID.auditorGrant,
      blobs: world.store.blobs,
    });
}

export const proposalFor = (world: DomainWorld, overrides: Record<string, unknown> = {}): ProposalV1 =>
  validateProposal({ ...selection({ profile: world.profile }), ...overrides });

export const gateDecision = (
  world: DomainWorld,
  overrides: { decision_id?: string; task_key?: string; proposal?: ProposalV1 } = {},
): PendingDecisionV1 =>
  buildHumanGateDecision({
    decision_id: overrides.decision_id ?? ULID.decision,
    proposal: overrides.proposal ?? proposalFor(world),
    task_key: overrides.task_key ?? TASK_KEY,
  });

export interface SeedTaskOptions {
  readonly ref: string;
  readonly state: "DISCOVERED" | "SELECTED" | "ACTIVE" | "HELD" | "COMPLETED" | "FAILED" | "DEFERRED";
  readonly pipeline_id?: string;
  readonly attempt_state?:
    | "READY"
    | "IMPLEMENTING"
    | "VERIFYING"
    | "AUDITING"
    | "REWORKING"
    | "READY_TO_MERGE"
    | "APPROVED_FOR_MANUAL_MERGE"
    | "MERGING"
    | "MERGED"
    | "INVALIDATED"
    | "FAILED";
  readonly snapshot_index?: number;
}

/**
 * Places one task (and optionally its attempt) directly in a durable state. Read-model tests need
 * arbitrary shapes, which the guards would not let them reach step by step.
 */
export function seedTask(world: DomainWorld, options: SeedTaskOptions): string {
  const taskKey = discover(world, options.ref);
  if (options.state === "DISCOVERED") return taskKey;

  world.store.withTransaction(() => {
    const seq = world.store.decisions.append({
      kind: "state_transition",
      refKey: taskKey,
      payload: { seeded: true },
    }).seq;

    world.store.tasks.write(taskKey, {
      platform_state: options.state,
      selection: {
        selection: { ...SELECTION, pipeline_id: options.pipeline_id ?? SELECTION.pipeline_id },
        repository_scope_id: SCOPE_ID,
        selection_binding: BINDING,
      },
      admitted_at: "t-admit",
      reason:
        options.state === "HELD" || options.state === "FAILED"
          ? { code: "RECOVERY_CONFLICT", log_seq: seq }
          : undefined,
    });

    if (options.attempt_state !== undefined) {
      const built = contractBuild(world, {
        snapshot_id: snapshotId(options.snapshot_index ?? 0),
        task_ref: options.ref,
      })();
      world.store.contracts.put(built.contract);
      world.store.attempts.create({
        attempt_key: `attempt:${taskKey}:1`,
        task_key: taskKey,
        n: 1,
        contract_snapshot_id: built.contract.body.snapshot_id,
        base_head: HEAD,
      });
      if (options.attempt_state !== "READY") {
        world.store.attempts.write(`attempt:${taskKey}:1`, {
          state: options.attempt_state,
          reason:
            options.attempt_state === "FAILED"
              ? { code: "RUNTIME_FAILED", log_seq: seq }
              : undefined,
        });
      }
    }
  });
  return taskKey;
}
