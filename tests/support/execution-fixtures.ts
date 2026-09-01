/**
 * Fixtures for `READY → IMPLEMENTING` (MVP1-B6).
 *
 * The two adapters here are *semantic* stubs, not scripted ones: they implement the same
 * idempotency contract a production adapter owes — the same operation identity re-acquires, a
 * different one does not alias, and the same identity with different material inputs is a
 * conflict — so a test can restart the use-case and count what actually happened outside the
 * Platform. Neither of them talks to git or to a runtime.
 */

import assert from "node:assert/strict";

import type { CapabilityEnforcementReceipt } from "../../adapters/interfaces/capability.ts";
import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeSessionStatus,
  RuntimeTurnHandle,
  WorkflowControllerHandle,
  WorkflowHandle,
  WorkflowSpec,
} from "../../adapters/interfaces/handles.ts";
import type {
  CandidateInspection,
  CreateFeatureWorkspaceRequestV1,
  ExpectedFilesRequest,
  FeatureWorkspace,
  MergeCommit,
  MergePreparation,
  MergeRequest,
  RepositoryAdapter,
  RepositoryCanonicalSnapshot,
  RepositoryDiff,
  RepositoryRange,
} from "../../adapters/interfaces/repository-adapter.ts";
import type {
  WorkflowAdapter,
  WorkflowObservation,
} from "../../adapters/interfaces/workflow-adapter.ts";
import type {
  RuntimeAdapter,
  RuntimeOperationContextV1,
  RuntimePreflightOutcome,
  RuntimeSpawnResult,
  RuntimeTurnResult,
} from "../../adapters/interfaces/runtime-adapter.ts";
import { activateSelectedTask } from "../../core/admission/activate-task.ts";
import { startImplementation } from "../../core/execution/start-implementation.ts";
import { startVerification } from "../../core/execution/start-verification.ts";
import {
  completeVerification,
  type VerificationCompletionAuthorities,
} from "../../core/execution/complete-verification.ts";
import { startAuditing, type AuditingAuthorities } from "../../core/execution/start-auditing.ts";
import {
  completeAuditing,
  type AuditCompletionAuthorities,
} from "../../core/execution/complete-auditing.ts";
import type { HumanMergeAuthorities } from "../../core/execution/human-merge.ts";
import {
  auditorReviewContext,
  type AuditorReviewContextV1,
} from "../../core/execution/auditor-review.ts";
import type { TaskContractV1Body } from "../../core/contract/types.ts";
import type { VerificationEvidence } from "../../adapters/interfaces/verification-adapter.ts";
import type { VerificationAuthorities } from "../../core/execution/start-verification.ts";
import {
  LocalVerificationAdapter,
  type BackendAuditGateStatus,
  type BackendStageStatus,
  type BackendVerificationStatus,
  type LocalVerificationDependencies,
  type VerificationBackendSeam,
  type VerificationRunRefV1,
} from "../../adapters/local-verification/index.ts";
import { FakeVerificationAdapter } from "../../testdoubles/fake-verification-adapter.ts";
import { submitProposal } from "../../core/admission/submit-proposal.ts";
import { seedAllocationForProposal } from "./coordinator-fixtures.ts";
import type { ExecutionAuthorities } from "../../core/execution/start-implementation.ts";
import { canonicalize, type CanonicalObject } from "../../core/schemas/canonical-json.ts";
import type { ContractSourceInput } from "../../core/contract/types.ts";
import {
  DocumentProfileSource,
  FileContractSourceReader,
  type ProfileDocuments,
} from "../../adapters/local-drift-source/index.ts";
import {
  authoritiesFor,
  manifestSetInput,
  StubTaskSource,
  type AdmissionWorld,
} from "./admission-fixtures.ts";
import type { ManifestSetInput } from "../../core/capability/manifest-set.ts";
import { HEAD, selection } from "./decision-fixtures.ts";
import { BATCH_ID, discover, RUN_ID, TASK_KEY, type DomainWorld } from "./domain-fixtures.ts";

const OBSERVED_AT = "2026-08-13T09:00:00Z";
const SNAPSHOT_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0F01";
const ACTOR_GRANT = "01JQ8ZK5T7RC9V2W4X6Y8Z0F02";
const AUDITOR_GRANT = "01JQ8ZK5T7RC9V2W4X6Y8Z0F03";

const encoder = new TextEncoder();
const sources = (): ContractSourceInput[] => [{ path: "SPEC.md", bytes: encoder.encode("spec\n") }];

/** A path/branch name that is total and injective over operation identities. */
const nameFor = (opKey: string): string =>
  `ws-${[...opKey].map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : `_${c.codePointAt(0)?.toString(16)}_`)).join("")}`;

// --- repository --------------------------------------------------------------------------

/**
 * A repository that implements TD §14.3's create-or-reacquire in memory. It counts the workspaces
 * it actually made, which is the number a duplicate-side-effect test is really about.
 */
export class RecordingRepository implements RepositoryAdapter {
  readonly calls: string[] = [];
  /** One entry per workspace that was genuinely created — never one per call. */
  readonly created: string[] = [];
  readonly #workspaces = new Map<string, FeatureWorkspace>();
  head: string;
  ref = "refs/heads/trunk";
  /** Runs at the *start* of `create_feature_workspace`, before any effect. */
  onCreate: (() => void) | undefined;
  /**
   * Thrown *after* the workspace exists — the W2 window, where the external effect happened but
   * the Platform never got to persist it.
   */
  failAfterCreate: Error | undefined;
  /** Forces every created/reacquired workspace to this path, for execution-location assertions. */
  workspacePath: string | undefined;
  /** When set, `create_feature_workspace` throws this instead of answering. */
  failWorkspace: Error | undefined;

  constructor(head: string) {
    this.head = head;
  }

  get workspaceCount(): number {
    return this.#workspaces.size;
  }

  snapshot_canonical(): RepositoryCanonicalSnapshot {
    this.calls.push("snapshot_canonical");
    return { ref: this.ref, head: this.head };
  }

  create_feature_workspace(request: CreateFeatureWorkspaceRequestV1): FeatureWorkspace {
    this.calls.push(`create_feature_workspace:${request.op_key}`);
    this.onCreate?.();
    if (this.failWorkspace !== undefined) throw this.failWorkspace;

    const existing = this.#workspaces.get(request.op_key);
    if (existing !== undefined) {
      if (existing.base_head !== request.base_head) {
        throw new Error(`${request.op_key} already names a workspace at ${existing.base_head}`);
      }
      return this.workspacePath === undefined ? existing : { ...existing, path: this.workspacePath };
    }

    const branch = nameFor(request.op_key);
    const workspace = {
      path: this.workspacePath ?? `/workspaces/${branch}`,
      base_head: request.base_head,
      branch,
    };
    this.#workspaces.set(request.op_key, workspace);
    this.created.push(request.op_key);
    if (this.failAfterCreate !== undefined) throw this.failAfterCreate;
    return workspace;
  }

  /** Drops the in-memory record without touching what the Platform stored. */
  forgetWorkspaces(): void {
    this.#workspaces.clear();
  }

  /** What the workspace currently holds. A test moves these; nothing is inferred from a model. */
  candidate: string | null = null;
  lineageValid = true;
  trackedClean = true;

  inspect_candidate(workspace: FeatureWorkspace): CandidateInspection {
    this.calls.push("inspect_candidate");
    return this.candidate === null
      ? { present: false, candidate_commit: null, base_head: workspace.base_head }
      : { present: true, candidate_commit: this.candidate, base_head: workspace.base_head };
  }
  get_diff(_range: RepositoryRange): RepositoryDiff {
    throw this.#unexpected("get_diff");
  }
  verify_tracked_clean(_workspace?: FeatureWorkspace): boolean {
    this.calls.push("verify_tracked_clean");
    return this.trackedClean;
  }
  verify_expected_files(_request: ExpectedFilesRequest): boolean {
    throw this.#unexpected("verify_expected_files");
  }
  verify_lineage(ancestor: string, descendant: string): boolean {
    this.calls.push(`verify_lineage:${ancestor}:${descendant}`);
    return this.lineageValid;
  }
  verify_canonical_head(expected_head: string): boolean {
    this.calls.push("verify_canonical_head");
    return this.head === expected_head;
  }
  prepare_merge(_request: MergeRequest): MergePreparation {
    throw this.#unexpected("prepare_merge");
  }
  commit_merge(_preparation: MergePreparation): MergeCommit {
    throw this.#unexpected("commit_merge");
  }

  #unexpected(method: string): Error {
    this.calls.push(method);
    return new Error(`READY→IMPLEMENTING must not call ${method}`);
  }
}

// --- runtime -----------------------------------------------------------------------------

interface SpawnedSession {
  readonly handle: RuntimeSessionHandle;
  readonly material: string;
}

/**
 * A runtime that re-acquires by operation identity. The session handle it hands back is a plain
 * plain projection admissible under I-TD7, exactly what TD §12 says a
 * Platform-facing handle is.
 */
export interface RecordedSpawn {
  readonly op_key: string;
  readonly role: string;
  readonly runtime_profile: unknown;
  readonly cwd: string;
  readonly capability_grant: unknown;
}

export class RecordingRuntime implements RuntimeAdapter {
  readonly spawnCalls: string[] = [];
  readonly turnResultCalls: CanonicalObject[] = [];
  controllerAcquisitions = 0;
  /** The full argument list of each spawn, so authority questions can be asked of it. */
  readonly spawns: RecordedSpawn[] = [];
  readonly sendCalls: { op_key: string; instruction: string }[] = [];
  readonly #sessions = new Map<string, SpawnedSession>();
  #turns = 0;
  /** When set, the spawn result carries this receipt (default: none, per `receipt_supported`). */
  receipt: CapabilityEnforcementReceipt | undefined;
  /** When set, `send_turn` throws this instead of answering. */
  sendFailure: Error | undefined;
  /** Runs at the *start* of `spawn_session` / `send_turn`, before any effect. */
  onExternalCall: (() => void) | undefined;
  /** Thrown *after* the session exists — the spawn equivalent of the W2 window. */
  failAfterSpawn: Error | undefined;
  /** Handle content the spawn returns; a test can make it carry a forbidden key. */
  sessionValue: ((index: number) => CanonicalObject) | undefined;

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get turnCount(): number {
    return this.#turns;
  }

  spawn_session(
    operation_context: RuntimeOperationContextV1,
    role: string,
    runtime_profile: RuntimeProfile,
    cwd: string,
    bootstrap_context: CanonicalObject,
    capability_grant: CapabilityGrant,
  ): RuntimeSpawnResult {
    this.spawnCalls.push(operation_context.op_key);
    this.spawns.push({
      op_key: operation_context.op_key,
      role,
      runtime_profile,
      cwd,
      capability_grant,
    });
    this.onExternalCall?.();

    const material = canonicalize({
      role,
      runtime_profile,
      cwd,
      bootstrap_context,
      capability_grant,
    } as unknown as CanonicalObject);

    const existing = this.#sessions.get(operation_context.op_key);
    if (existing !== undefined) {
      if (existing.material !== material) {
        throw new Error(`${operation_context.op_key} was spawned with different material inputs`);
      }
      return this.#result(existing.handle);
    }

    const index = this.#sessions.size + 1;
    const handle = (this.sessionValue?.(index) ?? {
      agent: "actor",
      session: `session-${index}`,
    }) as unknown as RuntimeSessionHandle;
    this.#sessions.set(operation_context.op_key, { handle, material });
    if (this.failAfterSpawn !== undefined) throw this.failAfterSpawn;
    return this.#result(handle);
  }

  send_turn(
    operation_context: RuntimeOperationContextV1,
    _session_handle: RuntimeSessionHandle,
    instruction: string,
  ): RuntimeTurnHandle {
    this.sendCalls.push({ op_key: operation_context.op_key, instruction });
    this.onExternalCall?.();
    if (this.sendFailure !== undefined) throw this.sendFailure;
    this.#turns += 1;
    return { turn: `turn-${this.#turns}` } as unknown as RuntimeTurnHandle;
  }

  /** Drops the in-memory sessions without touching what the Platform stored. */
  forgetSessions(): void {
    this.#sessions.clear();
  }

  #result(session_handle: RuntimeSessionHandle): RuntimeSpawnResult {
    return this.receipt === undefined
      ? { session_handle }
      : { session_handle, enforcement_receipt: this.receipt };
  }

  /** The terminal fact a later batch reads back. Backend-owned; no model text takes part. */
  turnResult: RuntimeTurnResult | undefined;
  /** Per-turn results, keyed by the handle's own value — one cycle's turns differ from another's. */
  readonly turnResults = new Map<string, RuntimeTurnResult>();

  get_turn_result(turn_handle: RuntimeTurnHandle): RuntimeTurnResult {
    this.turnResultCalls.push(turn_handle as unknown as CanonicalObject);
    const scripted = this.turnResults.get(
      canonicalize(turn_handle as unknown as CanonicalObject),
    );
    if (scripted !== undefined) return scripted;
    if (this.turnResult === undefined) throw new Error("no scripted turn result");
    return this.turnResult;
  }
  get_session_status(_session_handle: RuntimeSessionHandle): RuntimeSessionStatus {
    throw new Error("READY→IMPLEMENTING must not poll a session");
  }
  cancel_session(_session_handle: RuntimeSessionHandle): void {
    throw new Error("READY→IMPLEMENTING must not cancel a session");
  }
  close_session(_session_handle: RuntimeSessionHandle): void {
    throw new Error("READY→IMPLEMENTING must not close a session");
  }
  acquire_workflow_controller(): WorkflowControllerHandle {
    this.controllerAcquisitions += 1;
    // TD §13.3 — a stable reference to the managed controller session, admissible under I-TD7.
    // The raw identity never leaves the adapter, so the fixture carries nothing privileged.
    return { controller: "platform-controller-1" } as unknown as WorkflowControllerHandle;
  }
}

/**
 * The Backend v1 manifest shape (MVP1-B6 §14): `receipt_supported` is false, so a conforming spawn
 * returns no receipt and there is nothing to validate. The fixture states that honestly rather
 * than pretending the backend enforces something it does not.
 */
export const receiptFreeManifests = (): ManifestSetInput => {
  const base = manifestSetInput();
  const runtime = base.runtime as { readonly body: Record<string, unknown> };
  return {
    ...base,
    runtime: { ...runtime, body: { ...runtime.body, receipt_supported: false } },
  };
};

// --- workflow -----------------------------------------------------------------------------

/**
 * A workflow backend that implements the Backend v1 start contract in memory: one logical workflow
 * per `(controller, request_id)`, the same payload reuses it, and a different payload under the
 * same request id is a conflict. That is the only behaviour B7 depends on.
 */
export class RecordingWorkflow implements WorkflowAdapter {
  readonly starts: { controller: unknown; spec: CanonicalObject }[] = [];
  readonly #workflows = new Map<string, { handle: WorkflowHandle; payload: string }>();
  /** Runs at the start of `start`, so a test can observe the ambient state. */
  onStart: (() => void) | undefined;
  /** When set, `start` throws this instead of answering. */
  startFailure: Error | undefined;

  get workflowCount(): number {
    return this.#workflows.size;
  }

  start(controller: WorkflowControllerHandle, workflow_spec: WorkflowSpec): WorkflowHandle {
    const spec = workflow_spec as unknown as CanonicalObject & { request_id?: string };
    this.starts.push({ controller, spec });
    this.onStart?.();
    if (this.startFailure !== undefined) throw this.startFailure;

    const key = canonicalize([controller, spec.request_id] as unknown as CanonicalObject);
    const payload = canonicalize(spec);
    const existing = this.#workflows.get(key);
    if (existing !== undefined) {
      if (existing.payload !== payload) {
        throw new Error("WORKFLOW_REQUEST_CONFLICT: same request id, different payload");
      }
      return existing.handle;
    }
    const handle = {
      workflow_id: `wf-${this.#workflows.size + 1}`,
    } as unknown as WorkflowHandle;
    this.#workflows.set(key, { handle, payload });
    return handle;
  }

  /** Drops the in-memory record without touching what the Platform stored. */
  forgetWorkflows(): void {
    this.#workflows.clear();
  }

  status(_handle: WorkflowHandle): WorkflowObservation {
    throw new Error("IMPLEMENTING→VERIFYING must not observe a workflow");
  }
  resume(_handle: WorkflowHandle): void {
    throw new Error("IMPLEMENTING→VERIFYING must not resume a workflow");
  }
  cancel(_handle: WorkflowHandle): void {
    throw new Error("IMPLEMENTING→VERIFYING must not cancel a workflow");
  }
  /** M1-13 — every audit decision the adapter made, in order. Core never reaches this. */
  readonly auditDecisions: { controller: unknown; handle: unknown; verdict: string }[] = [];
  /** When set, `audit_decide` throws this — the "call failed, may still have applied" window. */
  auditFailure: Error | undefined;

  audit_decide(
    controller: WorkflowControllerHandle,
    handle: WorkflowHandle,
    verdict: string,
  ): void {
    this.auditDecisions.push({ controller, handle, verdict });
    if (this.auditFailure !== undefined) throw this.auditFailure;
  }
  recover(_handle: WorkflowHandle): void {
    throw new Error("IMPLEMENTING→VERIFYING must not recover a workflow");
  }
}

// --- preflight ----------------------------------------------------------------------------

export const readyPreflight = (): RuntimePreflightOutcome => ({ status: "READY" });

export const blockedPreflight =
  (...reasons: readonly string[]) =>
  (): RuntimePreflightOutcome => ({ status: "BLOCKED", reasons });

/**
 * The Project Profile role key the decision fixture's Proposal selects, and therefore what
 * `task.actor_profile` holds once the task is SELECTED. Tests assert against it; nothing passes
 * it in.
 */
export const SELECTED_ACTOR_PROFILE = "implementation";

// --- an activated world --------------------------------------------------------------------

export interface ExecutionWorld extends ExecutionAuthorities {
  readonly repository: RecordingRepository;
  readonly runtime: RecordingRuntime;
  readonly attempt_key: string;
  readonly admission: AdmissionWorld;
}

/**
 * Drives the earlier batches for real — discovery, admission, activation — so the attempt this
 * returns is a genuine `READY` attempt with a frozen contract and both grants, not a hand-written
 * row. The Runtime and preflight seams are the only things substituted.
 */
export function activatedWorld(
  world: DomainWorld,
  overrides: Partial<{
    runtime: RecordingRuntime;
    preflight: ExecutionAuthorities["preflight"];
    manifests: ExecutionAuthorities["manifests"];
  }> = {},
): ExecutionWorld {
  const manifests = overrides.manifests ?? receiptFreeManifests();
  const admission = authoritiesFor(world, { manifests });
  const repository = new RecordingRepository(admission.repository.head);

  discover(world);
  seedAllocationForProposal(world.store, BATCH_ID, selection({ profile: world.profile }));
  const submitted = submitProposal(admission, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    proposal: selection({ profile: world.profile }),
    observed_at: OBSERVED_AT,
  });
  assert.deepEqual(submitted.result, { kind: "ACCEPTED" });

  const activated = activateSelectedTask(admission, {
    task_key: TASK_KEY,
    snapshot_id: SNAPSHOT_ID,
    actor_grant_id: ACTOR_GRANT,
    auditor_grant_id: AUDITOR_GRANT,
    contract_sources: sources(),
  });
  assert.equal(activated.kind, "ACTIVATED");

  return {
    store: world.store,
    repository,
    runtime: overrides.runtime ?? new RecordingRuntime(),
    manifests,
    preflight: overrides.preflight ?? readyPreflight,
    attempt_key: activated.kind === "ACTIVATED" ? activated.attempt_key : "",
    admission,
  };
}

// --- an attempt already in IMPLEMENTING ------------------------------------------------------

export interface VerificationWorld extends VerificationAuthorities {
  readonly repository: RecordingRepository;
  readonly runtime: RecordingRuntime;
  readonly verification: FakeVerificationAdapter;
  readonly attempt_key: string;
}

/**
 * Drives B6 for real so the attempt is genuinely `IMPLEMENTING` with all three B6 references
 * durable, then scripts a COMPLETED turn and a valid candidate. A test moves one fact at a time.
 */
export function implementingWorld(
  world: DomainWorld,
  overrides: Partial<{ verification: FakeVerificationAdapter }> = {},
): VerificationWorld {
  const started = activatedWorld(world);
  assert.equal(
    startImplementation(started, { attempt_key: started.attempt_key }).kind,
    "IMPLEMENTING",
  );

  const runtime = started.runtime;
  runtime.turnResult = {
    session_handle: { agent: "actor", session: "session-1" } as unknown as RuntimeSessionHandle,
    turn_handle: { turn: "turn-1" } as unknown as RuntimeTurnHandle,
    backend_status: "COMPLETED",
    termination_reason: "end_turn",
    started_at: "t1",
    completed_at: "t2",
    provenance: {
      runtime_backend: "fake",
      identity_authority: "BACKEND",
      result_channel: "TURN_TEXT",
    },
    // Present and deliberately contradictory: nothing here may reach a transition (I-TD3).
    model_declared_outcome: { declared_status: "DONE", summary: "all done", refs: [] },
  };
  started.repository.candidate = CANDIDATE_COMMIT;

  return {
    store: world.store,
    repository: started.repository,
    runtime,
    verification: overrides.verification ?? new FakeVerificationAdapter(),
    attempt_key: started.attempt_key,
  };
}

/**
 * The Backend v1 composition, wired from the existing doubles (TD §15.1). Tests use it to prove
 * the layering itself: what the adapter does above the workflow, and what Core never sees.
 */
/**
 * The Backend v1 read/advance seam, in memory. It records what the backend was asked to do and
 * lets a test move one execution fact at a time; it runs no process and advances nothing by itself.
 */
export class RecordingBackendSeam implements VerificationBackendSeam {
  readonly approvals: string[] = [];
  readonly inspections: string[] = [];
  /** Every audit-gate read, so observe-before-act and re-observe-after can be counted. */
  readonly gateReads: string[] = [];
  /** What the gate currently says. A test moves it exactly as a backend would. */
  gate: BackendAuditGateStatus = { settled: false, verdict: null };
  /** When set, reading the gate fails this way instead of answering. */
  gateFailure: Error | undefined;
  /** The whole backend picture a test wants observed. Replaced wholesale between assertions. */
  status: BackendVerificationStatus | undefined;
  /** Runs after each approval, so a test can script what the next inspection sees. */
  onApprove: ((stage_id: string) => void) | undefined;

  inspect_verification_workflow(run: VerificationRunRefV1): BackendVerificationStatus {
    this.inspections.push(run.workflow_id);
    if (this.status === undefined) throw new Error("no scripted backend status");
    return this.status;
  }

  approve_verified_stage(
    _run: VerificationRunRefV1,
    stage: { readonly stage_id: string; readonly attempt: number },
  ): void {
    this.approvals.push(stage.stage_id);
    this.onApprove?.(stage.stage_id);
  }

  inspect_audit_gate(run: VerificationRunRefV1): BackendAuditGateStatus {
    this.gateReads.push(run.workflow_id);
    if (this.gateFailure !== undefined) throw this.gateFailure;
    return this.gate;
  }
}

/** A terminal check record, with the pieces a test usually leaves alone filled in. */
export const backendStage = (
  overrides: Partial<BackendStageStatus> & { readonly stage_name: string },
): BackendStageStatus => ({
  stage_id: `st-${overrides.stage_name}`,
  stage_state: "UNVERIFIED",
  current_attempt: 1,
  process_state: "COMPLETED",
  provider_state: "OK",
  finished_at: "2026-08-14T10:00:00.000Z",
  ...overrides,
});

export const backendStatus = (
  stages: readonly BackendStageStatus[],
  overrides: Partial<BackendVerificationStatus> = {},
): BackendVerificationStatus => ({
  workflow_id: "wf-1",
  workflow_state: "RUNNING",
  worktree: "/workspaces/ws-op_3a_verify",
  stages,
  ...overrides,
});

/** The check declarations a profile hands the adapter, as the Project Profile's `config` would. */
export const DECLARED_CHECKS = {
  full: [
    { check_id: "unit", argv: ["npm", "test"] },
    { check_id: "lint", argv: ["npm", "run", "lint"] },
  ],
  docs_only: [{ check_id: "docs", argv: ["npm", "run", "docs"] }],
} as const;

export interface LocalVerificationWorld {
  readonly adapter: LocalVerificationAdapter;
  readonly runtime: RecordingRuntime;
  readonly workflow: RecordingWorkflow;
  readonly repository: RecordingRepository;
  readonly backend: RecordingBackendSeam;
}

export function localVerification(
  overrides: Partial<{
    preflight: LocalVerificationDependencies["preflight"];
    profiles: LocalVerificationDependencies["profiles"];
  }> = {},
): LocalVerificationWorld {
  const runtime = new RecordingRuntime();
  const workflow = new RecordingWorkflow();
  const repository = new RecordingRepository(HEAD);
  const backend = new RecordingBackendSeam();
  return {
    adapter: new LocalVerificationAdapter({
      preflight: overrides.preflight ?? readyPreflight,
      runtime,
      workflow,
      repository,
      backend,
      profiles: overrides.profiles ?? DECLARED_CHECKS,
    }),
    runtime,
    workflow,
    repository,
    backend,
  };
}

/** The candidate the fixture repository reports. Never a value the Actor named. */
export const CANDIDATE_COMMIT = "9a8b7c6d5e4f30211203344556677889900aabbc";

// --- an attempt already in VERIFYING ------------------------------------------------------------

export interface CompletionWorld extends VerificationCompletionAuthorities {
  readonly repository: RecordingRepository;
  readonly runtime: RecordingRuntime;
  readonly verification: FakeVerificationAdapter;
  readonly attempt_key: string;
  readonly task_contract_hash: string;
}

/**
 * Drives B6 and B7 for real so the attempt is genuinely `VERIFYING` with a durable candidate, a run
 * reference and a completed verify operation. Only the verification *observation* is scripted.
 */
export function verifyingWorld(world: DomainWorld): CompletionWorld {
  const started = implementingWorld(world);
  assert.equal(startVerification(started, { attempt_key: started.attempt_key }).kind, "VERIFYING");
  const attempt = world.store.attempts.require(started.attempt_key);
  return {
    store: world.store,
    repository: started.repository,
    runtime: started.runtime,
    verification: started.verification,
    attempt_key: started.attempt_key,
    task_contract_hash: world.store.contracts.hashOf(attempt.contract_snapshot_id) as string,
  };
}

/** Three Crockford-safe characters, derived deterministically from a check id. */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulidSuffix = (check_id: string): string =>
  [0, 1, 2]
    .map((index) => ULID_ALPHABET[(check_id.charCodeAt(index % check_id.length) + index) % 32])
    .join("");

/** One well-formed evidence item. Callers move exactly the field under test. */
export const evidenceItem = (
  overrides: Partial<VerificationEvidence> & { readonly check_id: string },
): VerificationEvidence => ({
  evidence_id: `01JQ8ZK5T7RC9V2W4X6Y8Z0${ulidSuffix(overrides.check_id)}`,
  result: "PASS",
  assurance_level: "REEXECUTED",
  target_commit: CANDIDATE_COMMIT,
  task_contract_hash: `sha256:${"a".repeat(64)}`,
  executor_identity: "platform-verifier@local-verification-adapter:1",
  timestamp: "2026-08-14T10:00:00.000Z",
  ...overrides,
});

// --- an attempt whose verification gate is satisfied ---------------------------------------------

/** Where the fixture's `DocumentProfileSource` reads the *current* Profile and Policy from. */
export const PROFILE_DOCUMENTS: ProfileDocuments = {
  project_profile_path: "current-project-profile.json",
  execution_policy_path: "current-execution-policy.json",
};

/** The caller-allocated identity a drifting boundary needs, and where its notification goes. */
export const DRIFT_DECISION_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0D01";
export const DRIFT_CHANNEL = "example-channel";

/**
 * The mutable world the two M1-11 read seams look at, behind the *real* implementations. A test
 * edits a document or a byte string and the production reader does the rest; nothing scripts an
 * observation status directly, so ABSENT and UNAVAILABLE can only arise the way they really do.
 */
export class CurrentSources {
  /** Profile documents by path. Removing one makes that read fail — an operational failure. */
  readonly documents: Record<string, string> = {};
  /** Contract-source bytes by declared path. Removing one makes that source genuinely absent. */
  readonly bytes = new Map<string, Uint8Array>();
  /** When set, every contract-source read fails this way instead of answering. */
  contractFailure: Error | undefined;

  readProfileDocument = (path: string): string => {
    const document = this.documents[path];
    if (document === undefined) throw new Error(`no profile document at ${path}`);
    return document;
  };

  readContractSource = (path: string): Uint8Array | undefined => {
    if (this.contractFailure !== undefined) throw this.contractFailure;
    return this.bytes.get(path);
  };

  /** Replaces one current Profile document. The seam re-reads and re-validates on every call. */
  put(path: string, body: unknown): void {
    this.documents[path] = JSON.stringify(body);
  }
}

export interface AuditingWorld extends AuditingAuthorities {
  readonly repository: RecordingRepository;
  readonly runtime: RecordingRuntime;
  readonly attempt_key: string;
  /** The current-world documents and bytes the two read seams observe. */
  readonly current: CurrentSources;
  /** The same TaskSource stub the admission fixtures use, with its failure switches. */
  readonly tasks: StubTaskSource;
}

/** The check the decision fixture's policy requires, and the role its pipeline audits under. */
export const REQUIRED_CHECK = "unit";
export const AUDITOR_ROLE_PROFILE = "review";

/**
 * Drives B6, B7 and B9 for real, so the attempt is genuinely `VERIFYING` with durable, bound,
 * policy-satisfying evidence.
 *
 * The §11 seams are real implementations over a mutable current world that starts out identical
 * to what the Attempt froze — so the default is "nothing drifted" *because the world agrees*,
 * not because a stub said `CONTINUE`.
 */
export function auditingWorld(
  world: DomainWorld,
  overrides: Partial<{
    preflight: AuditingAuthorities["preflight"];
    manifests: AuditingAuthorities["manifests"];
    /** Skip B9 entirely, leaving a VERIFYING attempt with no durable evidence at all. */
    withoutEvidence: boolean;
  }> = {},
): AuditingWorld {
  const verifying = verifyingWorld(world);
  if (overrides.withoutEvidence !== true) {
    verifying.verification.completeWith([
      evidenceItem({ check_id: REQUIRED_CHECK, task_contract_hash: verifying.task_contract_hash }),
    ]);
    assert.equal(
      completeVerification(verifying, { attempt_key: verifying.attempt_key }).kind,
      "GATE_PASSED",
    );
  }

  const current = new CurrentSources();
  // The current world starts as the frozen one: the batch's own validated bodies, and the exact
  // bytes activation captured.
  current.put(PROFILE_DOCUMENTS.project_profile_path, world.inputs.project);
  current.put(PROFILE_DOCUMENTS.execution_policy_path, world.inputs.policy);
  for (const source of sources()) current.bytes.set(source.path, source.bytes);

  const tasks = new StubTaskSource();
  const started = verifying as unknown as { runtime: RecordingRuntime };
  return {
    store: world.store,
    repository: verifying.repository,
    runtime: started.runtime,
    manifests: overrides.manifests ?? receiptFreeManifests(),
    profiles: new DocumentProfileSource(PROFILE_DOCUMENTS, current.readProfileDocument),
    taskSource: tasks,
    contractSources: new FileContractSourceReader("", current.readContractSource),
    preflight: overrides.preflight ?? readyPreflight,
    attempt_key: verifying.attempt_key,
    current,
    tasks,
  };
}

// --- an attempt already in AUDITING (MVP1-B11) ----------------------------------------------------

export interface AuditingCompletionWorld extends AuditCompletionAuthorities {
  readonly repository: RecordingRepository;
  readonly runtime: RecordingRuntime;
  readonly verification: FakeVerificationAdapter;
  readonly attempt_key: string;
  readonly candidate_commit: string;
  readonly review: AuditorReviewContextV1;
}

/** The identities one audit cycle needs. Core allocates none of them (TD §17.1). */
export const AUDIT_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0F11";
export const AUDIT_DECISION_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0F12";
export const RECORDED_AT = "2026-08-15T09:00:00.000Z";

/**
 * Drives B6, B7, B9 and B10 for real, so the attempt is genuinely `AUDITING` with both Auditor
 * operations DONE and the candidate-bound turn handle durable. Only the Auditor's *answer* is
 * scripted — everything it is judged against is what the Platform actually stored.
 */
export function auditingCompletionWorld(world: DomainWorld): AuditingCompletionWorld {
  const w = auditingWorld(world);
  assert.equal(
    startAuditing(w, {
      attempt_key: w.attempt_key,
      decision_id: DRIFT_DECISION_ID,
      report_channel: DRIFT_CHANNEL,
    }).kind,
    "AUDITING",
  );

  const attempt = world.store.attempts.require(w.attempt_key);
  const contract = world.store.contracts.get(attempt.contract_snapshot_id)
    ?.body as unknown as TaskContractV1Body;
  return {
    store: world.store,
    runtime: w.runtime,
    verification: new FakeVerificationAdapter(),
    repository: w.repository,
    profiles: w.profiles,
    taskSource: w.taskSource,
    contractSources: w.contractSources,
    attempt_key: w.attempt_key,
    candidate_commit: attempt.candidate_commit as string,
    review: auditorReviewContext(world.store, attempt, contract),
  };
}

/** A well-formed Auditor verdict bound to a cycle. Callers move exactly the field under test. */
export const auditorVerdict = (
  review: AuditorReviewContextV1,
  overrides: Partial<{
    verdict: "AUDIT_PASS" | "FIX_REQUIRED" | "HUMAN_REQUIRED";
    reviewed: Partial<AuditorReviewContextV1>;
  }> = {},
): CanonicalObject => {
  const verdict = overrides.verdict ?? "AUDIT_PASS";
  return {
    verdict,
    findings: [],
    ...(verdict === "FIX_REQUIRED" ? { required_fix: [] } : {}),
    reviewed: {
      candidate_commit: overrides.reviewed?.candidate_commit ?? review.candidate_commit,
      task_contract_hash: overrides.reviewed?.task_contract_hash ?? review.task_contract_hash,
      evidence_ids: [...(overrides.reviewed?.evidence_ids ?? review.evidence_ids)],
    },
  } as unknown as CanonicalObject;
};

/** A terminal Auditor turn result. `structured` absent means the channel collected nothing. */
export const auditorTurnResult = (
  overrides: Partial<{
    backend_status: RuntimeTurnResult["backend_status"];
    protocol: string;
    body: CanonicalObject;
  }> = {},
): RuntimeTurnResult => ({
  session_handle: { agent: "actor", session: "session-2" } as unknown as RuntimeSessionHandle,
  turn_handle: { turn: "turn-2" } as unknown as RuntimeTurnHandle,
  backend_status: overrides.backend_status ?? "COMPLETED",
  termination_reason: "end_turn",
  started_at: "t1",
  completed_at: "t2",
  provenance: {
    runtime_backend: "fake",
    identity_authority: "BACKEND",
    result_channel: overrides.body === undefined ? "TURN_TEXT" : "RUNTIME_RESULT_CHANNEL",
  },
  ...(overrides.body === undefined
    ? {}
    : { structured_output: { protocol: overrides.protocol ?? AUDITOR_VERDICT_PROTOCOL, body: overrides.body } }),
  // Present and deliberately contradictory: nothing here may reach a transition (I-TD3).
  model_declared_outcome: { declared_status: "DONE", summary: "audit passed", refs: [] },
});

/** TD §16.2 — the one protocol a verdict may arrive on. */
export const AUDITOR_VERDICT_PROTOCOL = "platform-auditor-verdict-v1";

// --- an attempt already in READY_TO_MERGE (MVP1-B12) ----------------------------------------------

export interface HumanMergeWorld extends HumanMergeAuthorities {
  readonly repository: RecordingRepository;
  readonly runtime: RecordingRuntime;
  readonly attempt_key: string;
  readonly candidate_commit: string;
  readonly audit_id: string;
}

/** The identities one human-merge cycle needs. Core allocates none of them (TD §17.1). */
export const MERGE_DECISION_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0F21";
export const MERGE_FOLLOW_UP_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0F22";
export const RESOLVED_AT = "2026-08-16T09:00:00.000Z";

/**
 * Drives B6 through B11 for real, so the attempt is genuinely `READY_TO_MERGE` with a settled
 * immutable `AUDIT_PASS` record. Nothing about the merge itself is scripted — the repository's
 * canonical head is the only thing a test moves.
 */
export function humanMergeWorld(world: DomainWorld): HumanMergeWorld {
  const w = auditingCompletionWorld(world);
  w.runtime.turnResult = auditorTurnResult({ body: auditorVerdict(w.review) });
  w.verification.settlement = { kind: "SETTLED" };
  assert.equal(
    completeAuditing(w, {
      attempt_key: w.attempt_key,
      audit_id: AUDIT_ID,
      decision_id: AUDIT_DECISION_ID,
      report_channel: DRIFT_CHANNEL,
      recorded_at: RECORDED_AT,
    }).kind,
    "AUDIT_DECIDED",
  );
  assert.equal(world.store.attempts.require(w.attempt_key).state, "READY_TO_MERGE");

  return {
    store: world.store,
    repository: w.repository,
    runtime: w.runtime,
    profiles: w.profiles,
    taskSource: w.taskSource,
    contractSources: w.contractSources,
    attempt_key: w.attempt_key,
    candidate_commit: w.candidate_commit,
    audit_id: AUDIT_ID,
  };
}

/** The human's answer, recorded exactly as §17.1d requires. */
export const mergeResolution = (chosen_option: "APPROVE" | "REJECT") => ({
  kind: "OPTION" as const,
  chosen_option,
  free_form: null,
  resolved_by: "operator@example",
  resolved_at: RESOLVED_AT,
  approval_binding: null,
  applied_transition_ref: null,
});
