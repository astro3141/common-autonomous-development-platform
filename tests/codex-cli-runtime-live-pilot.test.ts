/**
 * Opt-in supervised Codex CLI vertical. Ordinary tests skip it because it uses an authenticated,
 * paid model. The entire candidate repository is disposable and removed in the test's finally.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import type {
  RuntimeTurnHandle,
  TaskContractSnapshot,
  VerificationProfile,
  VerificationRunHandle,
} from "../adapters/interfaces/handles.ts";
import type {
  RepositoryAdapter,
  RepositoryCanonicalSnapshot,
} from "../adapters/interfaces/repository-adapter.ts";
import type { RuntimeTurnResult } from "../adapters/interfaces/runtime-adapter.ts";
import type {
  AuditSettlementOperationContextV1,
  AuditSettlementResult,
  PlatformAuditVerdict,
  VerificationAdapter,
  VerificationEvidence,
  VerificationOperationContextV1,
  VerificationRunObservation,
  VerificationStartResult,
} from "../adapters/interfaces/verification-adapter.ts";
import {
  CODEX_CLI_INSPECTED_VERSION,
  CodexCliRuntimeAdapter,
  LocalCodexCliProcessRunner,
  codexCliPilotManifests,
  codexCliRuntimePreflight,
  type CodexCliRuntimeAdapterConfig,
} from "../adapters/codex-cli-runtime/index.ts";
import { LocalGitRepositoryAdapter } from "../adapters/local-git/index.ts";
import { submitProposal } from "../core/admission/submit-proposal.ts";
import { actorTurnMetadataKey } from "../core/execution/actor-operations.ts";
import { auditorTurnMetadataKey } from "../core/execution/audit-operations.ts";
import {
  REPOSITORY_ADAPTER,
  RUNTIME_ADAPTER,
  WORKSPACE_METADATA_KEY,
} from "../core/execution/start-implementation.ts";
import { supervisorTurnMetadataKey } from "../core/execution/supervisor-operations.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import { hashEnvelope, type SchemaEnvelope } from "../core/schemas/envelope.ts";
import { compose, type Composition } from "../deployment/compose.ts";
import { ulid } from "../deployment/identities.ts";
import { openRun } from "../deployment/open-run.ts";
import {
  PILOT_ACTOR_PROFILE,
  PILOT_CHECK,
  PILOT_CLASSIFICATION,
  PILOT_PIPELINE,
  PILOT_SCOPE,
  PILOT_TASK_REF,
  PILOT_VERIFICATION_PROFILE,
  pilotTaskDocument,
  pilotWorld,
} from "./support/deployment-fixtures.ts";

const LIVE = process.env["ADP_CODEX_CLI_LIVE_PILOT"] === "1";
const TASK_KEY = `task:pilot:${PILOT_TASK_REF}`;

interface PilotRun {
  readonly op_key: string;
  readonly material: string;
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
  readonly workspace: string;
  observation?: VerificationRunObservation;
  settlement?: PlatformAuditVerdict;
}

/** Bounded verifier that re-executes only commands frozen in the selected pilot profile. */
class LiveProcessVerification implements VerificationAdapter {
  readonly #repository: RepositoryAdapter;
  readonly #checks: Readonly<Record<string, readonly { check_id: string; argv: readonly string[] }[]>>;
  readonly #runs = new Map<string, PilotRun>();

  constructor(
    repository: RepositoryAdapter,
    checks: Readonly<Record<string, readonly { check_id: string; argv: readonly string[] }[]>>,
  ) {
    this.#repository = repository;
    this.#checks = checks;
  }

  start_verification(
    operation_context: VerificationOperationContextV1,
    verification_profile: VerificationProfile,
    repository_snapshot: RepositoryCanonicalSnapshot,
    task_contract_snapshot: TaskContractSnapshot,
    candidate_commit: string,
  ): VerificationStartResult {
    const profile = verification_profile as unknown as string;
    const checks = this.#checks[profile];
    if (checks === undefined || checks.length === 0) return { kind: "BLOCKED" };
    const task_contract_hash = hashEnvelope(task_contract_snapshot as unknown as SchemaEnvelope);
    const material = JSON.stringify([
      profile,
      repository_snapshot,
      task_contract_snapshot,
      candidate_commit,
      checks,
    ]);
    const existing = this.#runs.get(operation_context.op_key);
    if (existing !== undefined) {
      if (existing.material !== material) throw new Error("verification operation conflict");
      return { kind: "STARTED", run_handle: handle(existing) };
    }
    const workspace = this.#repository.create_feature_workspace({
      base_head: candidate_commit,
      op_key: operation_context.op_key,
    });
    const run: PilotRun = {
      op_key: operation_context.op_key,
      material,
      candidate_commit,
      task_contract_hash,
      workspace: workspace.path,
    };
    this.#runs.set(run.op_key, run);
    return { kind: "STARTED", run_handle: handle(run) };
  }

  get_verification_result(run_handle: VerificationRunHandle): VerificationRunObservation {
    const run = this.#run(run_handle);
    if (run.observation !== undefined) return run.observation;
    const checks = this.#checks[PILOT_VERIFICATION_PROFILE] ?? [];
    const evidence: VerificationEvidence[] = [];
    for (const check of checks) {
      let result: VerificationEvidence["result"] = "PASS";
      try {
        const [executable, ...args] = check.argv;
        if (executable === undefined) throw new Error("empty verifier command");
        execFileSync(executable, args, {
          cwd: run.workspace,
          encoding: "utf8",
          timeout: 30_000,
          stdio: "pipe",
        });
      } catch {
        result = "FAIL";
      }
      evidence.push({
        evidence_id: ulid(),
        check_id: check.check_id,
        result,
        assurance_level: "REEXECUTED",
        target_commit: run.candidate_commit,
        task_contract_hash: run.task_contract_hash,
        executor_identity: "local-process@codex-cli-supervised-pilot",
        run_reference: run.op_key,
        timestamp: new Date().toISOString(),
      });
    }
    run.observation = { state: "COMPLETED", evidence };
    return run.observation;
  }

  settle_audit(
    _operation_context: AuditSettlementOperationContextV1,
    run_handle: VerificationRunHandle,
    auditor_verdict: PlatformAuditVerdict,
    _evidence: readonly VerificationEvidence[],
  ): AuditSettlementResult {
    const run = this.#run(run_handle);
    if (run.settlement !== undefined && run.settlement !== auditor_verdict) {
      return { kind: "CONFLICT" };
    }
    run.settlement = auditor_verdict;
    return run.settlement === auditor_verdict ? { kind: "SETTLED" } : { kind: "UNAVAILABLE" };
  }

  #run(run_handle: VerificationRunHandle): PilotRun {
    const op_key = (run_handle as unknown as { op_key?: unknown }).op_key;
    if (typeof op_key !== "string") throw new Error("invalid pilot verification handle");
    const run = this.#runs.get(op_key);
    if (run === undefined) throw new Error(`unknown pilot verification run ${op_key}`);
    return run;
  }
}

function handle(run: PilotRun): VerificationRunHandle {
  return {
    adapter: "live-process-verification",
    op_key: run.op_key,
    candidate_commit: run.candidate_commit,
    task_contract_hash: run.task_contract_hash,
    workspace: run.workspace,
  } as unknown as VerificationRunHandle;
}

test(
  "CODEX-CLI-LIVE-1: fresh supervised vertical reaches the human merge boundary",
  {
    skip: LIVE
      ? false
      : "set ADP_CODEX_CLI_LIVE_PILOT=1 to use the authenticated Codex CLI",
  },
  () => {
    const world = pilotWorld({
      auto_merge: false,
      batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 },
      capability_requirements: {
        actor_execution: {
          "repository.feature_write": { accepted: ["NOT_YET_AUDITED"] },
          "shell.execute": { accepted: ["NOT_YET_AUDITED"] },
        },
        auditor_execution: {
          "repository.read": { accepted: ["NOT_YET_AUDITED"] },
        },
      },
    });
    let composition: Composition | undefined;
    try {
      const taskText = pilotTaskDocument().replace(
        "- src/feature.txt exists with the marker line\n",
        "- src/feature.txt exists with the marker line\n- Commit the implementation on the current feature branch\n",
      );
      world.repo.commit({
        path: "TASKS.md",
        content: taskText,
        message: "test: require a committed pilot candidate",
        cwd: world.repo.root,
      });

      const profilePath = world.config.profiles.project_profile_path;
      const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
        verification_profiles: Record<
          string,
          { config: { checks: { check_id: string; argv: string[] }[] } }
        >;
      };
      const markerCheck = [
        "node",
        "-e",
        "const fs=require('node:fs');if(fs.readFileSync('src/feature.txt','utf8')!=='marker\\n')process.exit(1)",
      ];
      profile.verification_profiles[PILOT_VERIFICATION_PROFILE]!.config.checks = [
        { check_id: PILOT_CHECK, argv: markerCheck },
      ];
      writeFileSync(profilePath, JSON.stringify(profile));

      const defaultModel = process.env["ADP_CODEX_CLI_MODEL"] ?? "gpt-5.6-sol";
      const runtimeConfig: CodexCliRuntimeAdapterConfig = {
        adapter_instance_id: `codex-cli-live-${process.pid}`,
        cli_executable: process.env["ADP_CODEX_CLI_BIN"] ?? "/opt/homebrew/bin/codex",
        expected_cli_version:
          process.env["ADP_CODEX_CLI_VERSION"] ?? CODEX_CLI_INSPECTED_VERSION,
        state_root: `${world.base}/codex-cli-runtime-state`,
        default_cwd: world.repo.root,
        turn_timeout_seconds: 1_200,
        profiles: {
          "supervisor-agent": {
            provider: "openai",
            model: process.env["ADP_CODEX_CLI_SUPERVISOR_MODEL"] ?? defaultModel,
            sandbox: "read-only",
          },
          "actor-agent": {
            provider: "openai",
            model: process.env["ADP_CODEX_CLI_ACTOR_MODEL"] ?? defaultModel,
            sandbox: "workspace-write",
          },
          "auditor-agent": {
            provider: "openai",
            model: process.env["ADP_CODEX_CLI_AUDITOR_MODEL"] ?? defaultModel,
            sandbox: "read-only",
          },
        },
      };
      const runtime = new CodexCliRuntimeAdapter(
        runtimeConfig,
        new LocalCodexCliProcessRunner(),
      );
      const repository = new LocalGitRepositoryAdapter({
        root: world.config.repository.root,
        canonical_ref: world.config.repository.canonical_ref,
        workspace_root: world.config.repository.workspace_root,
      });
      const verification = new LiveProcessVerification(repository, {
        [PILOT_VERIFICATION_PROFILE]: [{ check_id: PILOT_CHECK, argv: markerCheck }],
      });
      const manifests = codexCliPilotManifests(
        { backend_instance_id: world.config.backend.backend_instance_id },
        runtimeConfig,
      );
      const preflight = codexCliRuntimePreflight(runtime);
      assert.deepEqual(preflight(), { status: "READY" });

      composition = compose(world.config, {
        runtime,
        repository,
        verification,
        manifests,
        preflight,
      });
      const { store, coordinator, deps } = composition;
      const opened = openRun(composition);
      const attempt = () => store.attempts.current(TASK_KEY);

      assert.equal(coordinator.tickOnce(opened.run_id), "SUPERVISOR_REQUESTED");
      const supervisor = runtimeResult(
        runtime,
        store.adapterMetadata.get(
          opened.run_id,
          RUNTIME_ADAPTER,
          supervisorTurnMetadataKey(opened.batch_id, 1),
        )?.value,
      );
      assert.equal(supervisor.backend_status, "COMPLETED", turnFailure(supervisor));

      // PUBLIC_INGRESS is OFF. The supervised test constructs and submits the Platform Proposal;
      // the model response remains observed evidence and has no lifecycle authority.
      const definition = deps.taskSource.get_task(PILOT_TASK_REF);
      const head = deps.repository.snapshot_canonical().head;
      const submitted = submitProposal(
        { store, taskSource: deps.taskSource, repository: deps.repository, manifests },
        {
          run_id: opened.run_id,
          batch_id: opened.batch_id,
          observed_at: new Date().toISOString(),
          proposal: {
            proposal_id: ulid(),
            decision: "START_TASK",
            task_ref: PILOT_TASK_REF,
            classification: PILOT_CLASSIFICATION,
            pipeline_id: PILOT_PIPELINE,
            actor_profile: PILOT_ACTOR_PROFILE,
            verification_profile: PILOT_VERIFICATION_PROFILE,
            repository_scope_id: PILOT_SCOPE,
            expected: {
              task_version: definition.version,
              task_definition_hash: definition.definition_hash,
              base_head: head,
              compiled_profile_hash: composition.compiled.compiled_hash,
            },
            reason_refs: [],
          },
        },
      );
      assert.deepEqual(submitted.result, { kind: "ACCEPTED" });
      assert.equal(coordinator.tickOnce(opened.run_id), "ACTIVATED");
      assert.equal(coordinator.tickOnce(opened.run_id), "IMPLEMENTATION_STARTED");

      const current = attempt();
      assert.notEqual(current, undefined);
      const actor = runtimeResult(
        runtime,
        store.adapterMetadata.get(
          current!.attempt_key,
          RUNTIME_ADAPTER,
          actorTurnMetadataKey(1),
        )?.value,
      );
      assert.equal(actor.backend_status, "COMPLETED", turnFailure(actor));
      assert.equal(coordinator.tickOnce(opened.run_id), "VERIFICATION_STARTED");
      const candidate = attempt()?.candidate_commit;
      assert.equal(typeof candidate, "string");

      assert.equal(coordinator.tickOnce(opened.run_id), "AUDIT_STARTED");
      const evidence = store.verificationEvidence.forAttempt(current!.attempt_key);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.result, "PASS");
      assert.equal(evidence[0]?.assurance_level, "REEXECUTED");

      const auditorResults: RuntimeTurnResult[] = [];
      for (let turn = 1 as 1 | 2; turn <= 2; turn = (turn + 1) as 1 | 2) {
        const value = store.adapterMetadata.get(
          current!.attempt_key,
          RUNTIME_ADAPTER,
          auditorTurnMetadataKey(candidate!, turn),
        )?.value;
        if (value !== undefined) auditorResults.push(runtimeResult(runtime, value));
        assert.equal(coordinator.tickOnce(opened.run_id), "AUDIT_COMPLETED");
        if (attempt()?.state === "READY_TO_MERGE") break;
      }
      assert.equal(attempt()?.state, "READY_TO_MERGE");
      assert.equal(auditorResults.at(-1)?.structured_output?.body["verdict"], "AUDIT_PASS");

      assert.equal(coordinator.tickOnce(opened.run_id), "MERGE_APPROVAL_OPENED");
      const decisions = store.pendingDecisions.openFor(TASK_KEY);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.body.category, "MERGE_APPROVAL");
      assert.equal(deps.repository.snapshot_canonical().head, head, "no automatic merge occurred");

      const workspace = store.adapterMetadata.get(
        current!.attempt_key,
        REPOSITORY_ADAPTER,
        WORKSPACE_METADATA_KEY,
      )?.value as { path?: string } | undefined;
      assert.equal(readFileSync(`${workspace?.path}/src/feature.txt`, "utf8"), "marker\n");

      console.log(
        `CODEX_CLI_LIVE_PILOT_RESULT=${JSON.stringify({
          cli_version: runtimeConfig.expected_cli_version,
          fresh_run: true,
          disposable_repository: true,
          public_ingress: false,
          auto_merge: false,
          batch_max_tasks: 1,
          human_merge: true,
          candidate_commit: candidate,
          verification: evidence.map((row) => ({
            check_id: row.check_id,
            result: row.result,
            assurance_level: row.assurance_level,
            evidence_id: row.evidence_id,
          })),
          supervisor: turnSummary(supervisor),
          actor: turnSummary(actor),
          auditor: auditorResults.map(turnSummary),
          final_attempt_state: attempt()?.state,
          pending_decision: decisions[0]?.body.category,
          canonical_unchanged: deps.repository.snapshot_canonical().head === head,
        })}`,
      );
    } finally {
      composition?.dispose();
      world.dispose();
    }
  },
);

function runtimeResult(runtime: CodexCliRuntimeAdapter, value: unknown): RuntimeTurnResult {
  assert.notEqual(value, undefined, "runtime turn handle was not durably projected");
  return runtime.get_turn_result(value as RuntimeTurnHandle);
}

function turnFailure(result: RuntimeTurnResult): string {
  return JSON.stringify({
    termination_reason: result.termination_reason,
    backend_native_refs: result.backend_native_refs,
  });
}

function turnSummary(result: RuntimeTurnResult): CanonicalObject {
  return {
    status: result.backend_status,
    provider: result.execution_observation?.actual.provider ?? { availability: "UNKNOWN" },
    model: result.execution_observation?.actual.model ?? { availability: "UNKNOWN" },
    requested_provider: result.backend_native_refs?.["requested_provider"] ?? null,
    requested_model: result.backend_native_refs?.["requested_model"] ?? null,
    thread_id: result.backend_native_refs?.["thread_id"] ?? null,
    protocol: result.structured_output?.protocol ?? null,
    verdict: result.structured_output?.body["verdict"] ?? null,
    usage: result.execution_observation?.usage ?? { kind: "UNKNOWN" },
  } as CanonicalObject;
}
