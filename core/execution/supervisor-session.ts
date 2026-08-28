/**
 * The run-level Supervisor session and its request turns (TD §13.4, §26 step 4; M1-3, M1-15).
 *
 * The Supervisor is asked for a Proposal, and that is all this module does. Three separations make
 * it safe:
 *
 *   **The session belongs to the run, the operations to the batch.** One `platform_run` has one
 *   active Supervisor session, projected at `adapter_metadata(entity_key = run_id)`. The operation
 *   keys are batch-scoped because MVP 1 has one active batch and that is the axis a request ordinal
 *   runs along; a later batch reusing the same session performs no new spawn at all.
 *
 *   **Spawn and turn are different external effects.** They get separate INTENTs, because they have
 *   separate crash windows — the same rule M1-8 and M1-10 already fixed for the Actor and Auditor.
 *
 *   **The turn's answer is not a Proposal.** Whatever the Supervisor says in its turn, execution
 *   advances only when a structured Proposal arrives through the Platform API (§5.1). Nothing here
 *   reads the turn result at all, which is the strongest form of that guarantee.
 */

import type {
  CapabilityGrant,
  RuntimeProfile,
  RuntimeSessionHandle,
  RuntimeTurnHandle,
} from "../../adapters/interfaces/handles.ts";
import type { RuntimeAdapter, RuntimePreflight } from "../../adapters/interfaces/runtime-adapter.ts";
import type { CapabilityGrantV1Body } from "../capability/types.ts";
import { validateEnforcementReceipt } from "../capability/receipt.ts";
import { validateManifestSet, type ManifestSetInput } from "../capability/manifest-set.ts";
import type { CanonicalObject, CanonicalValue } from "../schemas/canonical-json.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { ExecutionStartError, RUNTIME_ADAPTER } from "./start-implementation.ts";
import {
  supervisorSpawnOp,
  supervisorTurnMetadataKey,
  supervisorTurnOp,
  SUPERVISOR_SESSION_METADATA_KEY,
} from "./supervisor-operations.ts";

/** TD §12.7 — the CoreExecutionRole. */
const SUPERVISOR_ROLE = "SUPERVISOR";

export interface SupervisorAuthorities {
  readonly store: PlatformStore;
  readonly runtime: RuntimeAdapter;
  readonly manifests: ManifestSetInput;
  readonly preflight: RuntimePreflight;
}

export interface SupervisorRequestCommand {
  readonly run_id: string;
  readonly batch_id: string;
  /** The Platform-owned read model this request is about. Never adapter-native metadata. */
  readonly decision_context: CanonicalObject;
  /** How the Supervisor is asked to run. Resolved by the caller from durable authority. */
  readonly runtime_profile: RuntimeProfile;
}

export type SupervisorRequestOutcome =
  | { readonly kind: "PREFLIGHT_BLOCKED"; readonly reasons: readonly string[] }
  | { readonly kind: "REQUESTED"; readonly turn: number; readonly spawned: boolean }
  /** M1-8 T2 — a turn may have been accepted and its handle never landed. Never resent. */
  | { readonly kind: "INDETERMINATE"; readonly turn: number };

/**
 * Issues Supervisor request turn `n`, spawning the run-level session first if there is not one.
 *
 * `n` comes from durable operation history alone (`supervisor-operations.ts`), so a rebuilt
 * Coordinator over the same store asks for the same ordinal.
 */
export function requestSupervisorProposal(
  authorities: SupervisorAuthorities,
  command: SupervisorRequestCommand,
): SupervisorRequestOutcome {
  const { store } = authorities;

  // A turn whose acceptance was never established blocks everything after it: Backend v1 can
  // prove neither that it happened nor that it did not, so no later ordinal may stand in for it.
  const indeterminate = indeterminateTurn(store, command);
  if (indeterminate !== undefined) return { kind: "INDETERMINATE", turn: indeterminate };

  const turn = nextSupervisorTurn(store, command.batch_id);
  const preflight = authorities.preflight();
  if (preflight.status === "BLOCKED") {
    return { kind: "PREFLIGHT_BLOCKED", reasons: preflight.reasons };
  }

  const existing = supervisorSession(store, command.run_id);
  const session =
    existing ?? spawnSupervisor(authorities, { ...command, turn });

  const op_key = supervisorTurnOp(command.batch_id, turn);
  store.withTransaction(() => {
    store.idempotency.beginIntent(op_key);
  });

  let handle: RuntimeTurnHandle;
  try {
    // Outside every transaction. The instruction carries the Platform's own read model and asks
    // for a Proposal through the Platform API — it never makes the reply authoritative.
    handle = authorities.runtime.send_turn(
      { op_key },
      session,
      supervisorInstruction(command),
    );
  } catch {
    return { kind: "INDETERMINATE", turn };
  }

  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: command.run_id,
      adapter_id: RUNTIME_ADAPTER,
      key: supervisorTurnMetadataKey(command.batch_id, turn),
      value: handle as unknown as CanonicalValue,
    });
    store.idempotency.markDone(op_key, handle as unknown as CanonicalValue);
  });
  return { kind: "REQUESTED", turn, spawned: existing === undefined };
}

/** The run's Supervisor session, if one has been established. Opaque to Core throughout. */
export function supervisorSession(
  store: PlatformStore,
  run_id: string,
): RuntimeSessionHandle | undefined {
  const row = store.adapterMetadata.get(run_id, RUNTIME_ADAPTER, SUPERVISOR_SESSION_METADATA_KEY);
  return row === undefined ? undefined : (row.value as unknown as RuntimeSessionHandle);
}

/**
 * §13.4 — the spawn that precedes request `n`, under its own operation identity.
 *
 * The grant is the run-scoped SUPERVISOR one `issueSupervisorGrant` issued when the run opened; it
 * is loaded and checked, never re-derived. A spawn whose acceptance cannot be established fails
 * closed rather than producing a second Supervisor session.
 */
function spawnSupervisor(
  authorities: SupervisorAuthorities,
  input: SupervisorRequestCommand & { readonly turn: number },
): RuntimeSessionHandle {
  const { store } = authorities;
  const op_key = supervisorSpawnOp(input.batch_id, input.turn);
  const record = store.idempotency.get(op_key);
  if (record?.state === "INTENT") {
    // The session may or may not exist. Backend v1 proves neither, so nothing is spawned again.
    throw new ExecutionStartError(`${op_key} is INTENT with no durable session; a second spawn is unsafe`);
  }
  if (record === undefined) {
    store.withTransaction(() => {
      store.idempotency.beginIntent(op_key);
    });
  }

  const { body: grant, grant_hash } = requireSupervisorGrant(store, input.run_id);
  const manifests = validateManifestSet(authorities.manifests);
  const spawn = authorities.runtime.spawn_session(
    { op_key },
    SUPERVISOR_ROLE,
    input.runtime_profile,
    "",
    supervisorBootstrap(input),
    grant as unknown as CapabilityGrant,
  );

  // §12.6 — presence follows `receipt_supported` and nothing else.
  const validation = validateEnforcementReceipt({
    runtime_manifest: { receipt_supported: manifests.runtime.body.receipt_supported } as never,
    spawn_result: spawn,
    grant,
    grant_hash,
    expected_runtime_manifest_hash: grant.source_runtime_manifest_hash,
  });
  if (!validation.valid) {
    throw new ExecutionStartError("the Supervisor spawn receipt does not match its grant");
  }

  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: input.run_id,
      adapter_id: RUNTIME_ADAPTER,
      key: SUPERVISOR_SESSION_METADATA_KEY,
      value: spawn.session_handle as unknown as CanonicalValue,
    });
    store.idempotency.markDone(op_key, { spawned: true } as unknown as CanonicalValue);
  });
  return spawn.session_handle;
}

// --- durable ordinal ---------------------------------------------------------------------------

/**
 * §13.4 — `next n = (max already allocated) + 1`, read from the durable operation rows. A narrow
 * reader over one Core-owned grammar; there is no generic op-key parser and no counter table.
 */
export function nextSupervisorTurn(store: PlatformStore, batch_id: string): number {
  return highestSupervisorTurn(store, batch_id) + 1;
}

/**
 * How many request turns this batch has already issued. The Coordinator uses it to decide whether
 * a request is still outstanding — which is why no `WAITING_FOR_PROPOSAL` state and no in-memory
 * flag exists: the durable operation rows already say it.
 */
export function supervisorTurnsIssued(store: PlatformStore, batch_id: string): number {
  return highestSupervisorTurn(store, batch_id);
}

/** A turn that was begun and whose handle never landed. Never resent, never replaced. */
function indeterminateTurn(
  store: PlatformStore,
  command: SupervisorRequestCommand,
): number | undefined {
  const highest = highestSupervisorTurn(store, command.batch_id);
  if (highest === 0) return undefined;
  if (store.idempotency.get(supervisorTurnOp(command.batch_id, highest))?.state !== "INTENT") {
    return undefined;
  }
  const handle = store.adapterMetadata.get(
    command.run_id,
    RUNTIME_ADAPTER,
    supervisorTurnMetadataKey(command.batch_id, highest),
  );
  return handle === undefined ? highest : undefined;
}

function highestSupervisorTurn(store: PlatformStore, batch_id: string): number {
  const prefix = supervisorTurnOp(batch_id, 0).replace(/0$/, "");
  let highest = 0;
  for (const key of store.idempotency.keysWithPrefix(prefix)) {
    const ordinal = Number.parseInt(key.slice(prefix.length), 10);
    if (Number.isInteger(ordinal) && ordinal > highest) highest = ordinal;
  }
  return highest;
}

// --- what the Supervisor is given ----------------------------------------------------------------

/** §13.4 — frozen run context. Nothing that changes per turn is bound here. */
function supervisorBootstrap(input: SupervisorRequestCommand): CanonicalObject {
  return {
    run_id: input.run_id,
    batch_id: input.batch_id,
    platform_role: SUPERVISOR_ROLE,
    proposal_submission: "submit one platform Proposal through the Platform API for this run/batch",
  } as unknown as CanonicalObject;
}

/**
 * §13.4 — the fresh decision context for one request, and an explicit statement that the reply
 * itself decides nothing. The operation identity never appears in the text.
 */
function supervisorInstruction(command: SupervisorRequestCommand): string {
  return [
    `Review the current state of ${command.batch_id} and propose the next decision.`,
    JSON.stringify(command.decision_context),
    "Submit exactly one Proposal through the Platform API, naming this run and batch.",
    "Your reply in this turn is not a decision: only a submitted Proposal is acted on.",
  ].join("\n");
}

/** The run-scoped SUPERVISOR grant the run was opened with. Loaded and checked, never derived. */
function requireSupervisorGrant(
  store: PlatformStore,
  run_id: string,
): { readonly body: CapabilityGrantV1Body; readonly grant_hash: string } {
  const row = store.grants.forRun(run_id).find((candidate) => candidate.role === "SUPERVISOR");
  if (row === undefined) {
    throw new ExecutionStartError(`run ${run_id} has no run-scoped SUPERVISOR grant`);
  }
  // §18.1a — the store re-hashes the envelope on load; a corrupt record never becomes authority.
  const envelope = store.grants.get(row.grant_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`SUPERVISOR grant ${row.grant_id} did not load`);
  }
  return { body: envelope.body as unknown as CapabilityGrantV1Body, grant_hash: row.grant_hash };
}
