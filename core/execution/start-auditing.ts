/**
 * `Attempt VERIFYING → Attempt AUDITING` (TD §16.1, §19.3, §21; M1-10).
 *
 * Launching the Auditor is the last place in MVP 1 where the Platform starts something outside
 * itself, and it is deliberately the most suspicious step in the lifecycle:
 *
 *   nothing is taken on trust from the previous step — B9 wrote no "gate passed" marker, so the
 *   verification gate is **recomputed** here from the immutable evidence and the frozen policy;
 *
 *   nothing is chosen at launch time — the Auditor's runtime profile is resolved through the
 *   batch's frozen Compiled Profile, and its capability grant is the immutable one the Task
 *   Contract already names. Neither is issued, defaulted or derived from the other;
 *
 *   spawn and turn are separate operations with separate intents, because they are separate
 *   external effects with separate crash windows (M1-8, restated for the Auditor by M1-10).
 *
 * The attempt becomes `AUDITING` only in the final transaction — once the session exists, the turn
 * has been accepted, and its handle can be written. There is no state in which the Platform records
 * an audit in progress without being able to name the turn that is running it.
 */

import type { FeatureWorkspace, RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeTurnHandle,
} from "../../adapters/interfaces/handles.ts";
import type {
  RuntimeAdapter,
  RuntimePreflight,
  RuntimeSpawnResult,
} from "../../adapters/interfaces/runtime-adapter.ts";
import { validateManifestSet, type ManifestSetInput } from "../capability/manifest-set.ts";
import { validateEnforcementReceipt } from "../capability/receipt.ts";
import type { CapabilityGrantV1Body } from "../capability/types.ts";
import type { ContractSourceReader, TaskContractV1Body } from "../contract/types.ts";
import type { CompiledProfileV1Body, ProfileSource } from "../profile/types.ts";
import type { CanonicalObject, CanonicalValue } from "../schemas/canonical-json.ts";
import { commitAttemptFact } from "../statemachine/transition-commit.ts";
import type { TaskAttemptRow, TaskRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { TaskSourceV1 } from "../tasksource/types.ts";
import { assembleDriftObservation } from "./assemble-drift-observation.ts";
import {
  auditorTurn1Op,
  auditorTurnMetadataKey,
  auditSpawnOp,
} from "./audit-operations.ts";
import {
  auditInstruction,
  auditorReviewContext,
  candidateEvidence,
  type AuditorReviewContextV1,
} from "./auditor-review.ts";
import { applyDriftStop, type DriftStopOutcome } from "./drift-lifecycle.ts";
import { evaluateStageBoundaryDrift } from "./stage-boundary-drift.ts";
import { evaluateVerificationGate, type UnsatisfiedReason } from "./verification-gate.ts";
import {
  ExecutionStartError,
  REPOSITORY_ADAPTER,
  RUNTIME_ADAPTER,
  WORKSPACE_METADATA_KEY,
} from "./start-implementation.ts";

/** TD §12.7 — the CoreExecutionRole. Distinct from the Project Profile role the pipeline names. */
const AUDITOR_ROLE = "AUDITOR";

/** TD §18.1c — the attempt's Auditor projection. One semantic key, no aliases. */
const AUDITOR_SESSION_METADATA_KEY = "auditor_session";

/**
 * TD §11.4 (M1-11) — the boundary is evaluated here, from authoritative reads.
 *
 * There is deliberately **no injectable drift outcome**. A caller supplies the three read seams
 * and nothing else; the observation is assembled and the pure evaluator decides. That is the whole
 * point of the correction: `() => CONTINUE` is not something production can be handed, and a
 * drift answer is never an argument.
 */
export interface AuditingAuthorities {
  readonly store: PlatformStore;
  readonly repository: RepositoryAdapter;
  readonly runtime: RuntimeAdapter;
  readonly manifests: ManifestSetInput;
  /** TD §11.4 — the current Project Profile / Execution Policy. Observation only. */
  readonly profiles: ProfileSource;
  /** TD §11.4 — the current authoritative TaskDefinition. */
  readonly taskSource: TaskSourceV1;
  /** TD §11.4 — the current raw bytes of each declared Contract Source. */
  readonly contractSources: ContractSourceReader;
  /** TD §19.3e step 0 (RA-4). Read-only; a `BLOCKED` answer changes no durable state. */
  readonly preflight: RuntimePreflight;
}

export interface StartAuditingCommand {
  readonly attempt_key: string;
  /**
   * Caller-allocated ULID for the decision a stopping drift outcome opens (TD §17.1 — Core
   * allocates no identity). Required only on that path; its absence there fails closed before any
   * Runtime effect rather than holding a task nobody can be asked about.
   */
  readonly decision_id?: string;
  /** Opaque report channel for that decision's single notification (TD §17.2). */
  readonly report_channel?: string;
}

export type StartAuditingOutcome =
  /** The durable evidence does not satisfy the frozen policy. Nothing external happens. */
  | {
      readonly kind: "NOT_ELIGIBLE";
      readonly attempt_key: string;
      readonly unsatisfied: Readonly<Record<string, UnsatisfiedReason>>;
    }
  /** TD §11.4 — a boundary that did not say CONTINUE. One shared lifecycle (M1-11/M1-12). */
  | DriftStopOutcome
  /** The environment cannot support a Runtime operation right now; `VERIFYING` is untouched. */
  | { readonly kind: "PREFLIGHT_BLOCKED"; readonly attempt_key: string; readonly reasons: readonly string[] }
  | {
      readonly kind: "HELD";
      readonly attempt_key: string;
      readonly reason_code: "RECOVERY_CONFLICT" | "CAPABILITY_BOUNDARY_CHANGED";
      readonly transition_seq: number;
    }
  | { readonly kind: "AUDITING"; readonly attempt_key: string; readonly transition_seq: number };

/** Runs the Auditor launch for one `VERIFYING` attempt. Safe to call again after a crash. */
export function startAuditing(
  authorities: AuditingAuthorities,
  command: StartAuditingCommand,
): StartAuditingOutcome {
  const { store } = authorities;
  const attempt_key = command.attempt_key;
  const attempt = store.attempts.require(attempt_key);
  const task = store.tasks.require(attempt.task_key);
  requireAuditable(attempt, task);

  // --- step 1 — the frozen state, loaded and checked before anything else ----------------------
  const contract = requireContract(store, attempt);
  const compiled = store.batchView.compiledProfileFor(task.batch_id);
  // Also §11.4's frozen capability basis. A grant that does not cohere with the contract fails
  // closed here, with no transition and no reason code — that is durable-state incoherence, not
  // evidence that anything drifted.
  const grant = loadFrozenAuditorCapability(store, attempt_key, contract);

  // --- step 2 — recompute eligibility. B9 stored no verdict, so there is none to trust ---------
  const unsatisfied = evaluateVerificationGate(
    compiled.effective.policy.verification_policy.required_verification,
    // The gate is about the candidate under review: a reworked Attempt also holds the previous
    // candidate's immutable evidence, and two rows for one check would read as ambiguous (B13).
    candidateEvidence(store, attempt),
  );
  if (Object.keys(unsatisfied).length > 0) {
    return { kind: "NOT_ELIGIBLE", attempt_key, unsatisfied };
  }

  // --- steps 3–5 — the §11 stage boundary, before anything external ---------------------------
  const drift = evaluateStageBoundaryDrift(
    assembleDriftObservation(authorities, {
      boundary: "VERIFYING_TO_AUDITING",
      attempt,
      contract,
      compiled,
      auditor_grant: grant,
    }),
  );
  if (drift.kind !== "CONTINUE") {
    return applyDriftStop(store, {
      attempt_key,
      task_key: task.task_key,
      outcome: drift,
      ...(command.decision_id === undefined ? {} : { decision_id: command.decision_id }),
      ...(command.report_channel === undefined ? {} : { report_channel: command.report_channel }),
    });
  }

  // --- step 6/7 — RA-4 preflight, still before the first intent --------------------------------
  const preflight = authorities.preflight();
  if (preflight.status === "BLOCKED") {
    return { kind: "PREFLIGHT_BLOCKED", attempt_key, reasons: preflight.reasons };
  }

  // --- the launch inputs, all resolved from frozen authority -----------------------------------
  const runtime_profile = resolveAuditorRuntimeProfile(store, task, contract);
  const workspace = requireReviewWorkspace(authorities, attempt);
  const manifests = validateManifestSet(authorities.manifests);

  const session = ensureAuditorSession(authorities, {
    attempt_key,
    contract,
    runtime_profile,
    workspace,
    grant,
    receipt_supported: manifests.runtime.body.receipt_supported,
  });
  if (session.kind === "HELD") return session.outcome;

  return startFirstAuditorTurn(authorities, {
    attempt_key,
    contract,
    workspace,
    session_handle: session.session_handle,
    receipt_valid: session.receipt_valid,
    review: auditorReviewContext(store, attempt, contract),
  });
}


// --- the Auditor session (M1-10 spawn operation) ------------------------------------------------

interface SessionResolution {
  readonly kind: "SESSION";
  readonly session_handle: RuntimeSessionHandle;
  readonly receipt_valid: boolean;
}

interface SessionHeld {
  readonly kind: "HELD";
  readonly outcome: StartAuditingOutcome;
}

function ensureAuditorSession(
  authorities: AuditingAuthorities,
  inputs: {
    readonly attempt_key: string;
    readonly contract: TaskContractV1Body;
    readonly runtime_profile: RuntimeProfile;
    readonly workspace: FeatureWorkspace;
    readonly grant: CapabilityGrantV1Body;
    readonly receipt_supported: boolean;
  },
): SessionResolution | SessionHeld {
  const { store } = authorities;
  const attempt_key = inputs.attempt_key;
  const op_key = auditSpawnOp(attempt_key);
  const record = store.idempotency.get(op_key);

  if (record?.state === "DONE") {
    const stored = store.adapterMetadata.get(
      attempt_key,
      RUNTIME_ADAPTER,
      AUDITOR_SESSION_METADATA_KEY,
    );
    if (stored === undefined) {
      throw new ExecutionStartError(`${op_key} is DONE without a durable session reference`);
    }
    return {
      kind: "SESSION",
      session_handle: stored.value as unknown as RuntimeSessionHandle,
      receipt_valid: true,
    };
  }
  if (record?.state === "FAILED") {
    throw new ExecutionStartError(`${op_key} is FAILED; a new attempt is a human decision`);
  }

  if (record === undefined) {
    store.withTransaction(() => {
      store.idempotency.beginIntent(op_key);
    });
  }

  // Outside every transaction. Every material input is derived from frozen durable state, so a
  // same-op retry presents exactly the same ones and the adapter re-acquires (M1-8 S1–S3).
  const spawn: RuntimeSpawnResult = authorities.runtime.spawn_session(
    { op_key },
    AUDITOR_ROLE,
    inputs.runtime_profile,
    inputs.workspace.path,
    auditorBootstrap(inputs.contract, inputs.workspace),
    inputs.grant as unknown as CapabilityGrant,
  );

  // §12.6 — presence follows `receipt_supported` and nothing else; the applied enforcement is
  // compared against the *immutable* grant, never a freshly derived one.
  const validation = validateEnforcementReceipt({
    runtime_manifest: { receipt_supported: inputs.receipt_supported } as never,
    spawn_result: spawn,
    grant: inputs.grant,
    grant_hash: inputs.contract.capability_grants.auditor.grant_hash,
    expected_runtime_manifest_hash: inputs.contract.backend_requirements.runtime_manifest_hash,
  });
  if (!validation.valid) {
    const held = commitAttemptFact(store, {
      attempt_key,
      fact: { kind: "EXECUTION_HELD", reason_code: "CAPABILITY_BOUNDARY_CHANGED" },
    });
    return {
      kind: "HELD",
      outcome: {
        kind: "HELD",
        attempt_key,
        reason_code: "CAPABILITY_BOUNDARY_CHANGED",
        transition_seq: held.transition.seq,
      },
    };
  }

  // The handle is durable before the operation is DONE, in one transaction. The attempt is still
  // VERIFYING here: a session with no turn is not an audit in progress.
  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: attempt_key,
      adapter_id: RUNTIME_ADAPTER,
      key: AUDITOR_SESSION_METADATA_KEY,
      value: spawn.session_handle as unknown as CanonicalValue,
    });
    store.idempotency.markDone(op_key, { receipt_valid: true });
  });

  return { kind: "SESSION", session_handle: spawn.session_handle, receipt_valid: true };
}

// --- the first Auditor turn (M1-10 turn operation) -----------------------------------------------

function startFirstAuditorTurn(
  authorities: AuditingAuthorities,
  inputs: {
    readonly attempt_key: string;
    readonly contract: TaskContractV1Body;
    readonly workspace: FeatureWorkspace;
    readonly session_handle: RuntimeSessionHandle;
    readonly receipt_valid: boolean;
    readonly review: AuditorReviewContextV1;
  },
): StartAuditingOutcome {
  const { store } = authorities;
  const attempt_key = inputs.attempt_key;
  const candidate = inputs.review.candidate_commit;
  const op_key = auditorTurn1Op(attempt_key, candidate);
  const turn_metadata_key = auditorTurnMetadataKey(candidate);
  const record = store.idempotency.get(op_key);

  if (record?.state === "DONE") {
    throw new ExecutionStartError(`${op_key} is DONE but ${attempt_key} is still VERIFYING`);
  }
  if (record?.state === "INTENT") {
    const stored = store.adapterMetadata.get(attempt_key, RUNTIME_ADAPTER, turn_metadata_key);
    if (stored !== undefined) {
      // The durable turn reference is itself the authoritative fact that the turn started.
      return commitAuditing(store, {
        attempt_key,
        op_key,
        turn_metadata_key,
        turn_value: stored.value,
        receipt_valid: inputs.receipt_valid,
        already_stored: true,
      });
    }
    // An intent with no reference. Backend v1 can prove neither that the turn was accepted nor
    // that it was not, and the ResultChannel slot is not acceptance authority, so the one thing
    // that must not happen is a second Auditor turn.
    return held(store, attempt_key);
  }

  store.withTransaction(() => {
    store.idempotency.beginIntent(op_key);
  });

  // Outside every transaction. The adapter owns the result channel: it selects the Auditor
  // protocol from the session's role and arms the turn-bound slot inside `send_turn`, before the
  // backend turn starts. Core has no channel operation and names no protocol here.
  let turn_handle: RuntimeTurnHandle;
  try {
    turn_handle = authorities.runtime.send_turn(
      { op_key },
      inputs.session_handle,
      auditInstruction(inputs.contract, inputs.workspace, inputs.review),
    );
  } catch {
    // A throw does not prove the turn was refused — including an arming failure, which is only
    // proof within this call and not across a restart. Fail closed rather than resend.
    return held(store, attempt_key);
  }

  return commitAuditing(store, {
    attempt_key,
    op_key,
    turn_metadata_key,
    turn_value: turn_handle as unknown as CanonicalValue,
    receipt_valid: inputs.receipt_valid,
    already_stored: false,
  });
}

/** The one transaction that makes an attempt `AUDITING` — never before this point. */
function commitAuditing(
  store: PlatformStore,
  input: {
    readonly attempt_key: string;
    readonly op_key: string;
    readonly turn_metadata_key: string;
    readonly turn_value: CanonicalValue;
    readonly receipt_valid: boolean;
    readonly already_stored: boolean;
  },
): StartAuditingOutcome {
  const result = commitAttemptFact(store, {
    attempt_key: input.attempt_key,
    fact: { kind: "AUDIT_STARTED", session_ready: true, receipt_valid: input.receipt_valid },
    within: () => {
      if (!input.already_stored) {
        store.adapterMetadata.put({
          entity_key: input.attempt_key,
          adapter_id: RUNTIME_ADAPTER,
          key: input.turn_metadata_key,
          value: input.turn_value,
        });
      }
      if (store.idempotency.get(input.op_key)?.state !== "DONE") {
        store.idempotency.markDone(input.op_key, input.turn_value);
      }
    },
  });
  return { kind: "AUDITING", attempt_key: input.attempt_key, transition_seq: result.transition.seq };
}

function held(store: PlatformStore, attempt_key: string): StartAuditingOutcome {
  const result = commitAttemptFact(store, {
    attempt_key,
    fact: { kind: "EXECUTION_HELD", reason_code: "RECOVERY_CONFLICT" },
  });
  return {
    kind: "HELD",
    attempt_key,
    reason_code: "RECOVERY_CONFLICT",
    transition_seq: result.transition.seq,
  };
}

// --- frozen authority ----------------------------------------------------------------------------

/**
 * M1-10 — the only authority for the Auditor's runtime profile:
 *
 *   contract.pipeline_id → frozen Compiled Profile → pipelines[…].auditor_profile → roles[…]
 *
 * Every link is checked and every link is immutable, so a restart resolves the identical value.
 * The live Profile Registry is never consulted, and no default is substituted for a missing link.
 */
function resolveAuditorRuntimeProfile(
  store: PlatformStore,
  task: TaskRow,
  contract: TaskContractV1Body,
): RuntimeProfile {
  const compiled = store.batchView.compiledProfileFor(task.batch_id);
  const pipeline = compiled.effective.project.pipelines[contract.pipeline_id];
  if (pipeline === undefined) {
    throw new ExecutionStartError(
      `pipeline ${contract.pipeline_id} is not declared by the compiled profile this batch is bound to`,
    );
  }
  const auditor_profile = pipeline.auditor_profile;
  if (auditor_profile === undefined) {
    throw new ExecutionStartError(
      `pipeline ${contract.pipeline_id} declares no auditor_profile; the Auditor has no runtime authority`,
    );
  }
  const role = compiled.effective.project.roles[auditor_profile];
  if (role === undefined) {
    throw new ExecutionStartError(`auditor_profile ${auditor_profile} is not a declared role`);
  }
  return role.runtime_profile as unknown as RuntimeProfile;
}

/**
 * The Auditor grant is the immutable one activation already issued and the Task Contract names.
 * It is loaded and checked, never reissued and never re-derived from current policy.
 *
 * TD §11.4 (M1-11) also makes it the frozen capability basis for stage-boundary drift, so all
 * three bindings are checked here: the role, the envelope hash the contract names, and the
 * manifest hash the contract froze. Failing any of them is durable-state incoherence — it fails
 * closed with no transition, no reason code and no Runtime effect, and is explicitly *not*
 * `DRIFT_CHECK_UNAVAILABLE`, which is about a current value that could not be read.
 */
export function loadFrozenAuditorCapability(
  store: PlatformStore,
  attempt_key: string,
  contract: TaskContractV1Body,
): CapabilityGrantV1Body {
  const reference = contract.capability_grants.auditor;
  const row = store.grants
    .forAttempt(attempt_key)
    .find((candidate) => candidate.grant_id === reference.grant_id);
  if (row === undefined) {
    throw new ExecutionStartError(`the auditor grant named by the contract is missing`);
  }
  if (row.grant_hash !== reference.grant_hash) {
    throw new ExecutionStartError(`auditor grant ${reference.grant_id} does not match the contract`);
  }
  if (row.role !== AUDITOR_ROLE) {
    throw new ExecutionStartError(`grant ${reference.grant_id} is a ${row.role} grant`);
  }
  // §18.1a — the store re-hashes the envelope on load; a corrupt record never becomes a basis.
  const envelope = store.grants.get(reference.grant_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`auditor grant ${reference.grant_id} did not load`);
  }
  const body = envelope.body as unknown as CapabilityGrantV1Body;
  if (body.source_runtime_manifest_hash !== contract.backend_requirements.runtime_manifest_hash) {
    throw new ExecutionStartError(
      `auditor grant ${reference.grant_id} was issued against a different backend manifest than the contract froze`,
    );
  }
  return body;
}

/**
 * M1-10 — the review path is the workspace B6 created, read-only by virtue of the Auditor grant.
 * Before it may be shown to an Auditor, the repository must still report the candidate the attempt
 * is about: an unrelated or moved workspace view is never Auditor input.
 */
function requireReviewWorkspace(
  authorities: AuditingAuthorities,
  attempt: TaskAttemptRow,
): FeatureWorkspace {
  const ref = authorities.store.adapterMetadata.get(
    attempt.attempt_key,
    REPOSITORY_ADAPTER,
    WORKSPACE_METADATA_KEY,
  );
  if (ref === undefined) {
    throw new ExecutionStartError(`${attempt.attempt_key} has no durable workspace reference`);
  }
  const stored = ref.value as unknown as { path: string; base_head: string; branch: string };
  const workspace: FeatureWorkspace = {
    path: stored.path,
    base_head: stored.base_head,
    branch: stored.branch,
  };
  const inspection = authorities.repository.inspect_candidate(workspace);
  if (!inspection.present || inspection.candidate_commit !== attempt.candidate_commit) {
    throw new ExecutionStartError(
      `${attempt.attempt_key}'s workspace no longer shows the candidate under review`,
    );
  }
  if (!authorities.repository.verify_lineage(attempt.base_head, attempt.candidate_commit as string)) {
    throw new ExecutionStartError(`${attempt.attempt_key}'s candidate is not a child of its base`);
  }
  return workspace;
}

// --- what the Auditor is given ---------------------------------------------------------------------

/**
 * Assembled only from Platform-authoritative material (§16.1): the frozen contract, the two commits
 * the repository confirmed, and the durable evidence identities. Nothing a model said is in it.
 */
function auditorBootstrap(
  contract: TaskContractV1Body,
  workspace: FeatureWorkspace,
): CanonicalObject {
  return {
    snapshot_id: contract.snapshot_id,
    task_ref: contract.task.ref,
    task_version: contract.task.version,
    attempt: contract.attempt,
    base_head: contract.base_head,
    review_path: workspace.path,
    repository_scope: contract.repository_scope,
    completion_conditions: contract.completion_conditions,
  } as unknown as CanonicalObject;
}



// --- preconditions ------------------------------------------------------------------------------------

function requireAuditable(attempt: TaskAttemptRow, task: TaskRow): void {
  if (attempt.state !== "VERIFYING") {
    throw new ExecutionStartError(`VERIFYING→AUDITING requires VERIFYING, not ${attempt.state}`);
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }
  if (attempt.candidate_commit === null) {
    throw new ExecutionStartError(`${attempt.attempt_key} is VERIFYING without a candidate`);
  }
}

function requireContract(store: PlatformStore, attempt: TaskAttemptRow): TaskContractV1Body {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  return envelope.body as unknown as TaskContractV1Body;
}
