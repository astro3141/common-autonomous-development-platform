/**
 * The MVP 1 production-Coordinator world (MVP1-B13).
 *
 * Everything below the Coordinator is real: the SQLite store, the state machines, every B6–B12
 * use-case. Only the four things outside the Platform are doubles — the Runtime, the repository,
 * the verification backend and the report transport — and each is the *semantic* stub the earlier
 * batches already established, so a test moves one external fact at a time rather than scripting
 * a lifecycle.
 *
 * The vocabulary is the project-neutral fixture vocabulary the rest of the suite uses.
 */

import assert from "node:assert/strict";

import type { RuntimeProfile, RuntimeSessionHandle, RuntimeTurnHandle } from "../../adapters/interfaces/handles.ts";
import type { RuntimeTurnResult } from "../../adapters/interfaces/runtime-adapter.ts";
import { issueSupervisorGrant } from "../../core/admission/supervisor-grant.ts";
import {
  ProductionCoordinator,
  type CoordinatorIdentities,
  type ProductionCoordinatorDependencies,
  type TickStep,
} from "../../core/coordinator/production-coordinator.ts";
import { submitProposal } from "../../core/admission/submit-proposal.ts";
import { actorTurnMetadataKey } from "../../core/execution/actor-operations.ts";
import { DocumentProfileSource, FileContractSourceReader } from "../../adapters/local-drift-source/index.ts";
import { FakeReportAdapter } from "../../testdoubles/fake-report-adapter.ts";
import { FakeVerificationAdapter } from "../../testdoubles/fake-verification-adapter.ts";
import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import type { ContractSourceInput } from "../../core/contract/types.ts";
import { manifestSetInput, StubTaskSource } from "./admission-fixtures.ts";
import { HEAD, selection } from "./decision-fixtures.ts";
import { BATCH_ID, discover, RUN_ID, TASK_KEY, type DomainWorld } from "./domain-fixtures.ts";
import {
  CurrentSources,
  PROFILE_DOCUMENTS,
  RecordingRepository,
  RecordingRuntime,
  readyPreflight,
  receiptFreeManifests,
  CANDIDATE_COMMIT,
} from "./execution-fixtures.ts";

const OBSERVED_AT = "2026-08-20T09:00:00Z";
const SUPERVISOR_GRANT = "01JQ8ZK5T7RC9V2W4X6Y8Z0G01";
export const REPORT_CHANNEL = "operations";

const encoder = new TextEncoder();
const sources = (): ContractSourceInput[] => [{ path: "SPEC.md", bytes: encoder.encode("spec\n") }];

/** A caller-owned ULID allocator. Core allocates no identity, so the deployment does (TD §17.1). */
export function ulidAllocator(prefix = "01JQ8ZK5T7RC9V2W4X6Y8Z0H"): () => string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let next = 0;
  return () => {
    const value = next++;
    const a = alphabet[Math.floor(value / 32) % 32] as string;
    const b = alphabet[value % 32] as string;
    return `${prefix}${a}${b}`;
  };
}

/** A counting clock. Deterministic and ordered; the Coordinator reads no clock of its own. */
export function fixedNow(prefix = "d"): () => string {
  let tick = 0;
  return () => `${prefix}${String(++tick).padStart(4, "0")}`;
}

export interface CoordinatorWorld extends ProductionCoordinatorDependencies {
  readonly coordinator: ProductionCoordinator;
  readonly repository: RecordingRepository;
  readonly runtime: RecordingRuntime;
  readonly verification: FakeVerificationAdapter;
  readonly report: FakeReportAdapter;
  readonly tasks: StubTaskSource;
  readonly current: CurrentSources;
  /** Runs one bounded tick and returns what it did. */
  tick(): TickStep;
  /** Runs bounded ticks until the predicate holds, or the budget is spent. */
  until(predicate: () => boolean, budget?: number): TickStep[];
}

/**
 * A run and batch with a compiled profile, a run-scoped SUPERVISOR grant, one discovered task and
 * a production Coordinator over all of it. Nothing has been executed yet.
 */
export function coordinatorWorld(
  world: DomainWorld,
  overrides: Partial<{ repository: RecordingRepository; manifests: ReturnType<typeof receiptFreeManifests> }> = {},
): CoordinatorWorld {
  const manifests = overrides.manifests ?? receiptFreeManifests();

  // §13.4 — the run-scoped SUPERVISOR grant is issued before the first Supervisor session exists,
  // through the Core use-case that owns it. The fixture supplies only the caller-owned ULID.
  issueSupervisorGrant(world.store, {
    run_id: RUN_ID,
    grant_id: SUPERVISOR_GRANT,
    manifests,
  });

  discover(world);

  const current = new CurrentSources();
  current.put(PROFILE_DOCUMENTS.project_profile_path, world.inputs.project);
  current.put(PROFILE_DOCUMENTS.execution_policy_path, world.inputs.policy);
  for (const source of sources()) current.bytes.set(source.path, source.bytes);

  const repository = overrides.repository ?? new RecordingRepository(HEAD);
  const runtime = new RecordingRuntime();
  const identities: CoordinatorIdentities = {
    nextUlid: ulidAllocator(),
    now: fixedNow(),
    reportChannel: REPORT_CHANNEL,
    supervisorRuntimeProfile: "supervisor" as unknown as RuntimeProfile,
  };

  const deps: ProductionCoordinatorDependencies = {
    store: world.store,
    repository,
    runtime,
    verification: new FakeVerificationAdapter(),
    report: new FakeReportAdapter(),
    taskSource: new StubTaskSource(),
    profiles: new DocumentProfileSource(PROFILE_DOCUMENTS, current.readProfileDocument),
    contractSources: new FileContractSourceReader("", current.readContractSource),
    manifests,
    preflight: readyPreflight,
    identities,
  };

  const coordinator = new ProductionCoordinator(deps);
  const w: CoordinatorWorld = {
    ...deps,
    coordinator,
    repository,
    runtime,
    verification: deps.verification as FakeVerificationAdapter,
    report: deps.report as FakeReportAdapter,
    tasks: deps.taskSource as StubTaskSource,
    current,
    tick: () => coordinator.tickOnce(RUN_ID),
    until(predicate, budget = 40) {
      const steps: TickStep[] = [];
      for (let index = 0; index < budget && !predicate(); index += 1) {
        steps.push(coordinator.tickOnce(RUN_ID));
      }
      assert.equal(predicate(), true, `the condition never held: ${steps.join(", ")}`);
      return steps;
    },
  };
  return w;
}

/**
 * The MCP / Platform API ingress: the Supervisor submits a structured Proposal naming this run and
 * batch. This is the *only* thing that can select a task — a Runtime turn body cannot (§13.4).
 */
export function submitSupervisorProposal(w: CoordinatorWorld, world: DomainWorld): void {
  const submitted = submitProposal(
    {
      store: w.store,
      taskSource: w.tasks,
      repository: w.repository as never,
      manifests: w.manifests,
    },
    {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      proposal: selection({ profile: world.profile }),
      observed_at: OBSERVED_AT,
    },
  );
  assert.deepEqual(submitted.result, { kind: "ACCEPTED" });
}

/**
 * What the Actor's turn produced. A test moves the candidate; nothing infers it from a model.
 *
 * The result is keyed on the turn handle the Platform actually stored, not on a guessed one — the
 * Supervisor's own turns share the fake Runtime's counter, so guessing would be brittle *and*
 * would stop proving that the Coordinator reads the handle it persisted.
 */
export function actorProduced(w: CoordinatorWorld, candidate: string, turn: number): void {
  w.repository.candidate = candidate;
  const attempt = w.store.attempts.current(TASK_KEY) as { attempt_key: string };
  const stored = w.store.adapterMetadata.get(
    attempt.attempt_key,
    "runtime",
    actorTurnMetadataKey(turn),
  );
  assert.notEqual(stored, undefined, `there is no durable actor_turn:${turn} handle`);
  w.runtime.turnResults.set(JSON.stringify(stored?.value), {
    session_handle: { agent: "actor", session: "session-1" } as unknown as RuntimeSessionHandle,
    turn_handle: stored?.value as unknown as RuntimeTurnHandle,
    backend_status: "COMPLETED",
    termination_reason: "end_turn",
    started_at: "t1",
    completed_at: "t2",
    provenance: {
      runtime_backend: "fake",
      identity_authority: "BACKEND",
      result_channel: "TURN_TEXT",
    },
    // Deliberately contradictory: nothing here may reach a transition (I-TD3).
    model_declared_outcome: { declared_status: "DONE", summary: "done", refs: [] },
  } satisfies RuntimeTurnResult);
}

/** The durable Actor turn projection for one ordinal, so a test can name what it asserts. */
export const actorTurnKey = actorTurnMetadataKey;

/** A person answers a merge approval, recorded exactly as §17.1d requires. */
export function mergeAnswer(
  w: CoordinatorWorld,
  decision_id: string,
  chosen_option: "APPROVE" | "REJECT",
): void {
  w.store.withTransaction(() => {
    w.store.pendingDecisions.resolve(decision_id, {
      kind: "OPTION",
      chosen_option,
      free_form: null,
      resolved_by: "operator@example",
      resolved_at: "2026-08-20T10:00:00.000Z",
      approval_binding: null,
      applied_transition_ref: null,
    });
  });
}

export { CANDIDATE_COMMIT };
export type { CanonicalObject };
