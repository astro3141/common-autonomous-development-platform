/**
 * `Attempt READY → Attempt IMPLEMENTING` (TD §19.3e, §21, §22.2).
 *
 * This is the first Platform step that touches the world, and its whole shape is dictated by one
 * asymmetry: a durable write can be replayed, an external side effect cannot. So each of the three
 * external operations — create the workspace, spawn the Actor, start its first turn — is wrapped
 * in the §21 write-ahead pair:
 *
 *     TX{ INTENT } → call the adapter, with no transaction open → TX{ reference + DONE }
 *
 * and the last of those closing transactions also carries the state change, so there is no window
 * in which a turn has been started but no attempt owns it.
 *
 * Recovery is deliberately unclever. On re-entry each operation is decided from durable state
 * alone: `DONE` means use what was stored and call nothing; `INTENT` means the effect may or may
 * not exist. Where the adapter can *prove* the answer by re-acquiring (the workspace, the session),
 * it re-acquires; where it cannot (a started turn), the attempt is held rather than retried. Full
 * Runtime recovery is MVP 4 — this is the fail-closed boundary until then (TD §22.2).
 *
 * One READY attempt at a time. No loop, no timer, no queue, no scheduler.
 */

import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeTurnHandle,
} from "../../adapters/interfaces/handles.ts";
import type {
  FeatureWorkspace,
  RepositoryAdapter,
} from "../../adapters/interfaces/repository-adapter.ts";
import type {
  RuntimeAdapter,
  RuntimePreflight,
  RuntimeSpawnResult,
} from "../../adapters/interfaces/runtime-adapter.ts";
import { validateManifestSet, type ManifestSetInput } from "../capability/manifest-set.ts";
import { validateEnforcementReceipt } from "../capability/receipt.ts";
import type { CapabilityGrantV1Body, RuntimeManifestBody } from "../capability/types.ts";
import type { TaskContractV1Body } from "../contract/types.ts";
import type { CanonicalObject, CanonicalValue } from "../schemas/canonical-json.ts";
import { canonicalize } from "../schemas/canonical-json.ts";
import { commitAttemptFact } from "../statemachine/transition-commit.ts";
import {
  actorSpawnOp,
  actorTurnMetadataKey,
  actorTurnOp,
  actorWorkspaceOp,
} from "./actor-operations.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { StoreError } from "../store/errors.ts";
import type { TaskAttemptRow, TaskRow } from "../store/domain-types.ts";

/** TD §12.7 — the role whose session this step starts. The Auditor is a later stage. */
const ACTOR_ROLE = "ACTOR";

/**
 * What this step is asked to start: one attempt, and nothing else.
 *
 * There is deliberately no way to name a role, a runtime profile or a grant. Which Project Profile
 * role the Actor runs under was decided by the Supervisor at selection time, validated by V6
 * against the declared roles, and frozen as `task.actor_profile` in the `DISCOVERED → SELECTED`
 * transaction (TD §9.2). Accepting it again here would let a caller re-select it after the
 * decision, so the field simply does not exist.
 */
export interface StartImplementationCommand {
  readonly attempt_key: string;
}

/**
 * `adapter_metadata` addressing (TD §18.1c, §20). Three current projections on the attempt, using
 * the two adapter ids the boundary already has names for. Nothing here is lifecycle authority: the
 * attempt's state lives in `task_attempt`, and deleting these rows would not change it.
 */
export const REPOSITORY_ADAPTER = "repository";
export const RUNTIME_ADAPTER = "runtime";
export const WORKSPACE_METADATA_KEY = "feature_workspace";
export const SESSION_METADATA_KEY = "actor_session";
/** The first turn's projection. Later turns use their own ordinal (`actor-operations.ts`). */
export const TURN_METADATA_KEY = actorTurnMetadataKey(1);

/** TD §21 — identity lives in `actor-operations.ts`; this step is always the attempt's first turn. */
const workspaceOp = actorWorkspaceOp;
const spawnOp = actorSpawnOp;
const firstTurnOp = (attemptKey: string): string => actorTurnOp(attemptKey, 1);

/** The authoritative owners this step reads from. Every one is an interface, not a class. */
export interface ExecutionAuthorities {
  readonly store: PlatformStore;
  readonly repository: RepositoryAdapter;
  readonly runtime: RuntimeAdapter;
  readonly manifests: ManifestSetInput;
  /** TD §19.3e step 0 (RA-4). Read-only; a `BLOCKED` answer changes no durable state. */
  readonly preflight: RuntimePreflight;
}

export type StartImplementationOutcome =
  /**
   * The environment cannot support an external Runtime operation right now. The attempt stays
   * `READY` and the task stays `ACTIVE`: nothing was written, nothing was held, no retry was
   * counted, and the next invocation simply asks again.
   */
  | { readonly kind: "PREFLIGHT_BLOCKED"; readonly reasons: readonly string[] }
  | {
      readonly kind: "IMPLEMENTING";
      readonly attempt_key: string;
      readonly transition_seq: number;
    }
  /** TD §19.3e 9b / §29 — the attempt stays where it is and the task parks. Never a retry. */
  | {
      readonly kind: "HELD";
      readonly attempt_key: string;
      readonly reason_code: "RECOVERY_CONFLICT" | "CAPABILITY_BOUNDARY_CHANGED";
      readonly transition_seq: number;
    };

/** Something durable contradicts itself; there is no safe way forward, so nothing is attempted. */
export class ExecutionStartError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ExecutionStartError";
  }
}

/**
 * Runs §19.3e for exactly one `READY` attempt.
 *
 * Safe to call again after a crash at any point: every step reads its own durable record first.
 */
export function startImplementation(
  authorities: ExecutionAuthorities,
  command: StartImplementationCommand,
): StartImplementationOutcome {
  const attempt_key = command.attempt_key;
  // --- step 0 — RA-4 preflight, before any intent exists ---------------------------------
  const preflight = authorities.preflight();
  if (preflight.status === "BLOCKED") {
    return { kind: "PREFLIGHT_BLOCKED", reasons: preflight.reasons };
  }

  const { store } = authorities;
  const attempt = store.attempts.require(attempt_key);
  const task = store.tasks.require(attempt.task_key);
  if (attempt.state !== "READY") {
    throw new ExecutionStartError(`READY→IMPLEMENTING requires READY, not ${attempt.state}`);
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }

  const contract = requireContract(store, attempt);
  const manifests = validateManifestSet(authorities.manifests);
  // The three layers stay distinct (§9.2, §12.7): `ACTOR` is the CoreExecutionRole, the durable
  // `actor_profile` is the Project Profile role key the Supervisor selected, and the runtime
  // profile is what that role declares in the batch's own frozen Compiled Profile.
  const runtime_profile = resolveActorRuntimeProfile(store, task);

  const workspace = ensureWorkspace(authorities, attempt);
  const session = ensureActorSession(authorities, {
    attempt,
    contract,
    runtime_manifest_body: manifests.runtime.body,
    runtime_profile,
    workspace,
  });
  if (session.kind === "HELD") return session.outcome;

  return startFirstTurn(authorities, {
    attempt,
    contract,
    session_handle: session.session_handle,
    receipt_valid: session.receipt_valid,
  });
}

/**
 * `task.actor_profile → roles[...] → runtime_profile`, read from the Compiled Profile this batch
 * is bound to (§7.4) rather than from whatever the Profile Registry holds now.
 *
 * A task that is ACTIVE without a selected profile, or whose selected profile is not declared by
 * the batch's Compiled Profile, is a durable/configuration inconsistency. It fails closed: no
 * fallback role is chosen, and this runs before the first INTENT so no external effect exists.
 */
function resolveActorRuntimeProfile(store: PlatformStore, task: TaskRow): RuntimeProfile {
  const actor_profile = task.actor_profile;
  if (actor_profile === null) {
    throw new ExecutionStartError(`${task.task_key} is ACTIVE without a selected actor_profile`);
  }
  const compiled = store.batchView.compiledProfileFor(task.batch_id);
  const role = compiled.effective.project.roles[actor_profile];
  if (role === undefined) {
    throw new ExecutionStartError(
      `actor_profile ${actor_profile} is not declared by the compiled profile this batch is bound to`,
    );
  }
  return role.runtime_profile as unknown as RuntimeProfile;
}

// --- workspace (TD §19.3e steps 1–3, §14.3, W1–W4) ---------------------------------------

/**
 * The durable projection of a workspace. `repository_ref` is what makes the binding check a real
 * one: the same op key against a different repository is a conflict, not a re-acquisition.
 */
interface WorkspaceRef extends CanonicalObject {
  readonly path: string;
  readonly branch: string;
  readonly base_head: string;
  readonly repository_ref: string;
}

function ensureWorkspace(
  authorities: ExecutionAuthorities,
  attempt: TaskAttemptRow,
): FeatureWorkspace {
  const { store } = authorities;
  const op_key = workspaceOp(attempt.attempt_key);
  const record = store.idempotency.get(op_key);

  // W4 — the operation already completed. The stored result is used and the adapter is not called.
  if (record?.state === "DONE") {
    return fromWorkspaceRef(requireRef(record.result, op_key));
  }
  if (record?.state === "FAILED") {
    throw new ExecutionStartError(`${op_key} is FAILED; a new attempt is a human decision`);
  }

  // Step 1 — W1: the intent is durable before anything outside the process happens.
  if (record === undefined) {
    store.withTransaction(() => {
      store.idempotency.beginIntent(op_key);
    });
  }

  // Step 2 — outside every transaction. W2/W3: same op key, so this create-or-reacquires.
  const workspace = authorities.repository.create_feature_workspace({
    base_head: attempt.base_head,
    op_key,
  });
  const ref: WorkspaceRef = {
    path: workspace.path,
    branch: workspace.branch,
    base_head: workspace.base_head,
    repository_ref: authorities.repository.snapshot_canonical().ref,
  };
  if (workspace.base_head !== attempt.base_head) {
    throw new ExecutionStartError(
      `${op_key} produced a workspace at ${workspace.base_head}, not the attempt's base`,
    );
  }

  // W3 — a reference survived a crash without its DONE. It is the same workspace only if every
  // bound fact still agrees; anything else fails closed rather than making a second workspace.
  const stored = store.adapterMetadata.get(
    attempt.attempt_key,
    REPOSITORY_ADAPTER,
    WORKSPACE_METADATA_KEY,
  );
  if (stored !== undefined && canonicalize(stored.value) !== canonicalize(ref)) {
    throw new ExecutionStartError(
      `${op_key} re-acquired a workspace that does not match the durable reference`,
    );
  }

  // Step 3 — the reference and the completion commit together.
  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: attempt.attempt_key,
      adapter_id: REPOSITORY_ADAPTER,
      key: WORKSPACE_METADATA_KEY,
      value: ref,
    });
    store.idempotency.markDone(op_key, ref);
  });
  return workspace;
}

const fromWorkspaceRef = (ref: WorkspaceRef): FeatureWorkspace => ({
  path: ref.path,
  base_head: ref.base_head,
  branch: ref.branch,
});

// --- Actor session (TD §19.3e steps 4–6, §12.6, §19.3d) -----------------------------------

interface SessionResolution {
  readonly kind: "SESSION";
  readonly session_handle: RuntimeSessionHandle;
  readonly receipt_valid: boolean;
}

interface SessionHeld {
  readonly kind: "HELD";
  readonly outcome: StartImplementationOutcome;
}

interface SpawnInputs {
  readonly attempt: TaskAttemptRow;
  readonly contract: TaskContractV1Body;
  readonly runtime_manifest_body: RuntimeManifestBody;
  readonly runtime_profile: RuntimeProfile;
  readonly workspace: FeatureWorkspace;
}

function ensureActorSession(
  authorities: ExecutionAuthorities,
  inputs: SpawnInputs,
): SessionResolution | SessionHeld {
  const { store } = authorities;
  const attempt_key = inputs.attempt.attempt_key;
  const op_key = spawnOp(attempt_key);
  const record = store.idempotency.get(op_key);

  if (record?.state === "DONE") {
    // Already spawned and already validated: the receipt question was settled at that commit.
    const stored = requireMetadata(store, attempt_key, RUNTIME_ADAPTER, SESSION_METADATA_KEY);
    return {
      kind: "SESSION",
      session_handle: stored as unknown as RuntimeSessionHandle,
      receipt_valid: readReceiptValid(record.result, op_key),
    };
  }
  if (record?.state === "FAILED") {
    throw new ExecutionStartError(`${op_key} is FAILED; a new attempt is a human decision`);
  }

  // Step 4 — the intent, before the spawn.
  if (record === undefined) {
    store.withTransaction(() => {
      store.idempotency.beginIntent(op_key);
    });
  }

  // Step 5 — outside every transaction. The material inputs are all derived from frozen durable
  // state, so a same-op retry presents exactly the same ones and the adapter re-acquires.
  const spawn: RuntimeSpawnResult = authorities.runtime.spawn_session(
    { op_key },
    ACTOR_ROLE,
    inputs.runtime_profile,
    inputs.workspace.path,
    bootstrapContext(inputs.contract, inputs.workspace),
    actorGrant(store, inputs.contract) as unknown as CapabilityGrant,
  );

  // §19.3d / §12.6 — presence follows `receipt_supported` and nothing else. A receipt-free spawn
  // on a backend that declares no receipt support is conforming; a mismatch on a backend that
  // does support them is a boundary change, and no turn is sent.
  const validation = validateEnforcementReceipt({
    runtime_manifest: inputs.runtime_manifest_body,
    spawn_result: spawn,
    grant: actorGrant(store, inputs.contract),
    grant_hash: inputs.contract.capability_grants.actor.grant_hash,
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

  // Step 6 — the safe handle is durable before the operation is DONE, in one transaction. The
  // store's own I-TD7 key check is what rejects a handle carrying a raw backend credential.
  const handleValue = spawn.session_handle as unknown as CanonicalValue;
  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: attempt_key,
      adapter_id: RUNTIME_ADAPTER,
      key: SESSION_METADATA_KEY,
      value: handleValue,
    });
    store.idempotency.markDone(op_key, { receipt_valid: true });
  });

  return { kind: "SESSION", session_handle: spawn.session_handle, receipt_valid: true };
}

// --- Actor first turn (TD §19.3e steps 7–9b, §24 T1–T4, §25) -------------------------------

interface TurnInputs {
  readonly attempt: TaskAttemptRow;
  readonly contract: TaskContractV1Body;
  readonly session_handle: RuntimeSessionHandle;
  readonly receipt_valid: boolean;
}

function startFirstTurn(
  authorities: ExecutionAuthorities,
  inputs: TurnInputs,
): StartImplementationOutcome {
  const { store } = authorities;
  const attempt_key = inputs.attempt.attempt_key;
  const op_key = firstTurnOp(attempt_key);
  const record = store.idempotency.get(op_key);

  if (record?.state === "DONE") {
    // 9a commits the DONE and the state change together, so a DONE turn on a READY attempt is a
    // contradiction in the durable record rather than a situation to recover from.
    throw new ExecutionStartError(`${op_key} is DONE but ${attempt_key} is still READY`);
  }

  if (record?.state === "INTENT") {
    const stored = store.adapterMetadata.get(attempt_key, RUNTIME_ADAPTER, TURN_METADATA_KEY);
    if (stored !== undefined) {
      // T3 — the durable turn reference is itself the authoritative fact that the turn started.
      // Reconciled, not retried: the completion and the state change are promoted as they stand.
      return commitTurnStarted(store, {
        attempt_key,
        op_key,
        turn_value: stored.value,
        receipt_valid: inputs.receipt_valid,
        already_stored: true,
      });
    }
    // The intent is durable and no reference is. §21 permits a same-op retry only when the
    // adapter can prove the effect is *absent*; on this Backend nothing can (no request-identity
    // dedup, no durable turn lookup), so a crash before the call and a crash after acceptance
    // leave the same durable state and are treated as one indeterminate case: hold, never retry.
    // The generic rule is unchanged — an adapter that does offer that proof may retry.
    return held(store, attempt_key);
  }

  // Step 7 — the intent, before the send.
  store.withTransaction(() => {
    store.idempotency.beginIntent(op_key);
  });

  // Step 8 — outside every transaction. The operation identity travels as the operation context;
  // it is never written into the instruction, so the model cannot choose or observe it.
  let turn_handle: RuntimeTurnHandle;
  try {
    turn_handle = authorities.runtime.send_turn(
      { op_key },
      inputs.session_handle,
      firstTurnInstruction(inputs.contract),
    );
  } catch {
    // A throw does not prove the turn was refused, so this is the T2 situation immediately.
    return held(store, attempt_key);
  }

  // Step 9a — reference, completion and `READY → IMPLEMENTING` in one transaction, which is what
  // removes the T4 window rather than recovering from it.
  return commitTurnStarted(store, {
    attempt_key,
    op_key,
    turn_value: turn_handle as unknown as CanonicalValue,
    receipt_valid: inputs.receipt_valid,
    already_stored: false,
  });
}

function commitTurnStarted(
  store: PlatformStore,
  input: {
    readonly attempt_key: string;
    readonly op_key: string;
    readonly turn_value: CanonicalValue;
    readonly receipt_valid: boolean;
    readonly already_stored: boolean;
  },
): StartImplementationOutcome {
  const result = commitAttemptFact(store, {
    attempt_key: input.attempt_key,
    fact: { kind: "EXECUTION_STARTED", workspace_created: true, receipt_valid: input.receipt_valid },
    within: () => {
      if (!input.already_stored) {
        store.adapterMetadata.put({
          entity_key: input.attempt_key,
          adapter_id: RUNTIME_ADAPTER,
          key: TURN_METADATA_KEY,
          value: input.turn_value,
        });
      }
      store.idempotency.markDone(input.op_key, input.turn_value);
    },
  });
  return {
    kind: "IMPLEMENTING",
    attempt_key: input.attempt_key,
    transition_seq: result.transition.seq,
  };
}

function held(store: PlatformStore, attempt_key: string): StartImplementationOutcome {
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

// --- what the Actor is given ---------------------------------------------------------------

/**
 * The bootstrap context is a projection of the frozen contract and the workspace the Platform
 * created — never a place to smuggle policy, credentials or an operation identity.
 */
function bootstrapContext(
  contract: TaskContractV1Body,
  workspace: FeatureWorkspace,
): CanonicalObject {
  return {
    snapshot_id: contract.snapshot_id,
    task_ref: contract.task.ref,
    task_version: contract.task.version,
    attempt: contract.attempt,
    base_head: contract.base_head,
    workspace_path: workspace.path,
    workspace_branch: workspace.branch,
    repository_scope: contract.repository_scope,
    completion_conditions: contract.completion_conditions,
  } as unknown as CanonicalObject;
}

/** Deterministic instruction text, derived from the contract alone (I-TD3, §21). */
function firstTurnInstruction(contract: TaskContractV1Body): string {
  const conditions = contract.completion_conditions.map((line) => `- ${line}`).join("\n");
  return [
    `Implement ${contract.task.ref} (version ${contract.task.version}) in this workspace.`,
    `The workspace is checked out at ${contract.base_head}.`,
    "Completion conditions:",
    conditions,
  ].join("\n");
}

// --- durable reads -------------------------------------------------------------------------

function requireContract(store: PlatformStore, attempt: TaskAttemptRow): TaskContractV1Body {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  return envelope.body as unknown as TaskContractV1Body;
}

function actorGrant(store: PlatformStore, contract: TaskContractV1Body): CapabilityGrantV1Body {
  const envelope = store.grants.get(contract.capability_grants.actor.grant_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`the actor grant named by the contract is missing`);
  }
  return envelope.body as unknown as CapabilityGrantV1Body;
}

function requireMetadata(
  store: PlatformStore,
  entity_key: string,
  adapter_id: string,
  key: string,
): CanonicalValue {
  const row = store.adapterMetadata.get(entity_key, adapter_id, key);
  if (row === undefined) {
    throw new ExecutionStartError(`${entity_key} has no durable ${adapter_id}/${key} reference`);
  }
  return row.value;
}

function requireRef(result: CanonicalValue | undefined, op_key: string): WorkspaceRef {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new StoreError("DOMAIN_ROW_INVALID", `${op_key} is DONE without a stored workspace`);
  }
  return result as unknown as WorkspaceRef;
}

function readReceiptValid(result: CanonicalValue | undefined, op_key: string): boolean {
  const valid = (result as { receipt_valid?: unknown } | undefined)?.receipt_valid;
  if (typeof valid !== "boolean") {
    throw new StoreError("DOMAIN_ROW_INVALID", `${op_key} is DONE without a receipt verdict`);
  }
  return valid;
}
