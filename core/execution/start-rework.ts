/**
 * `Attempt REWORKING → Attempt IMPLEMENTING` (TD §19.3, §26 step 15; MVP1-B13).
 *
 * An ordinary `FIX_REQUIRED` is the Actor being asked to do more work on the *same* job. So almost
 * nothing is re-created: the Attempt, its immutable Task Contract, its workspace, its Actor session
 * and both CapabilityGrants are the ones it already had. What changes is the turn — and the count
 * of how many times this has happened, which is the only thing the rework budget is measured on.
 *
 * The turn ordinal comes from `attempt.rework_count` **after** `REWORK_STARTED` has incremented it,
 * so the first rework is `actor-turn:2`. Reading it before the transition would be off by one, and
 * a same-key collision with the first turn is exactly the failure that would hide.
 *
 * The Auditor's findings are not carried in as authority. What the Actor is told is Core-owned and
 * deterministic; the verdict itself lives in the immutable `audit_record` (I-TD3).
 */

import type { RuntimeAdapter, RuntimePreflight } from "../../adapters/interfaces/runtime-adapter.ts";
import type { RuntimeSessionHandle, RuntimeTurnHandle } from "../../adapters/interfaces/handles.ts";
import type { TaskContractV1Body } from "../contract/types.ts";
import type { CanonicalValue } from "../schemas/canonical-json.ts";
import { commitAttemptFact } from "../statemachine/transition-commit.ts";
import type { TaskAttemptRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { actorTurnMetadataKey, actorTurnOp, actorTurnOrdinal } from "./actor-operations.ts";
import {
  ExecutionStartError,
  RUNTIME_ADAPTER,
  SESSION_METADATA_KEY,
} from "./start-implementation.ts";

export interface ReworkAuthorities {
  readonly store: PlatformStore;
  readonly runtime: RuntimeAdapter;
  /** TD §19.3e step 0 (RA-4). Read-only; a `BLOCKED` answer changes no durable state. */
  readonly preflight: RuntimePreflight;
}

export interface StartReworkCommand {
  readonly attempt_key: string;
}

export type StartReworkOutcome =
  /** The environment cannot support a Runtime operation right now; `REWORKING` is untouched. */
  | { readonly kind: "PREFLIGHT_BLOCKED"; readonly attempt_key: string; readonly reasons: readonly string[] }
  | {
      readonly kind: "IMPLEMENTING";
      readonly attempt_key: string;
      readonly turn: number;
      readonly transition_seq: number;
    }
  /** The rework budget is spent, or a turn's acceptance cannot be established. */
  | {
      readonly kind: "HELD";
      readonly attempt_key: string;
      readonly reason_code: "REWORK_LIMIT" | "RECOVERY_CONFLICT";
      readonly transition_seq: number;
    };

/** Runs one rework pass for a `REWORKING` attempt. Safe to call again after a crash. */
export function startRework(
  authorities: ReworkAuthorities,
  command: StartReworkCommand,
): StartReworkOutcome {
  const { store } = authorities;
  const attempt_key = command.attempt_key;
  const attempt = store.attempts.require(attempt_key);
  const task = store.tasks.require(attempt.task_key);
  if (attempt.state !== "REWORKING") {
    throw new ExecutionStartError(`REWORKING→IMPLEMENTING requires REWORKING, not ${attempt.state}`);
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }
  const contract = requireContract(store, attempt);

  // The budget is the batch's frozen one, and the sealed guard owns the comparison — this is only
  // the early exit that keeps a spent budget from reaching the Runtime at all.
  const compiled = store.batchView.compiledProfileFor(task.batch_id);
  if (attempt.rework_count >= compiled.effective.policy.batch_policy.max_rework) {
    const held = commitAttemptFact(store, {
      attempt_key,
      fact: { kind: "REWORK_STARTED", snapshot_valid: true },
    });
    return {
      kind: "HELD",
      attempt_key,
      reason_code: "REWORK_LIMIT",
      transition_seq: held.transition.seq,
    };
  }

  // RA-4 — asked before the first intent, exactly as the initial launch does.
  const preflight = authorities.preflight();
  if (preflight.status === "BLOCKED") {
    return { kind: "PREFLIGHT_BLOCKED", attempt_key, reasons: preflight.reasons };
  }

  // §19.3 — the counter moves first, inside the transition, and the turn's identity is read from
  // the durable result. Nothing derives the ordinal from anything this process remembers.
  const started = commitAttemptFact(store, {
    attempt_key,
    fact: { kind: "REWORK_STARTED", snapshot_valid: true },
  });
  const turn = actorTurnOrdinal(store.attempts.require(attempt_key).rework_count);
  if (started.attempt_state !== "IMPLEMENTING") {
    // The guard parked the task instead — the budget was spent after all.
    return {
      kind: "HELD",
      attempt_key,
      reason_code: "REWORK_LIMIT",
      transition_seq: started.transition.seq,
    };
  }

  const op_key = actorTurnOp(attempt_key, turn);
  const metadata_key = actorTurnMetadataKey(turn);
  const record = store.idempotency.get(op_key);
  if (record?.state === "DONE") {
    // The turn already went out for this ordinal; the attempt is where it should be.
    return { kind: "IMPLEMENTING", attempt_key, turn, transition_seq: started.transition.seq };
  }
  if (record?.state === "INTENT") {
    const stored = store.adapterMetadata.get(attempt_key, RUNTIME_ADAPTER, metadata_key);
    if (stored === undefined) {
      // M1-8 T2 — accepted or not, Backend v1 can prove neither. Never a second Actor turn.
      return held(store, attempt_key);
    }
    store.withTransaction(() => {
      store.idempotency.markDone(op_key, stored.value);
    });
    return { kind: "IMPLEMENTING", attempt_key, turn, transition_seq: started.transition.seq };
  }

  store.withTransaction(() => {
    store.idempotency.beginIntent(op_key);
  });

  // Outside every transaction, on the session this Attempt already has.
  let handle: RuntimeTurnHandle;
  try {
    handle = authorities.runtime.send_turn(
      { op_key },
      requireActorSession(store, attempt_key),
      reworkInstruction(contract, turn),
    );
  } catch {
    return held(store, attempt_key);
  }

  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: attempt_key,
      adapter_id: RUNTIME_ADAPTER,
      key: metadata_key,
      value: handle as unknown as CanonicalValue,
    });
    store.idempotency.markDone(op_key, handle as unknown as CanonicalValue);
  });
  return { kind: "IMPLEMENTING", attempt_key, turn, transition_seq: started.transition.seq };
}

/**
 * Deterministic instruction text. It names the same contract and asks for another candidate; the
 * Auditor's own words are not repeated here, because a finding is evidence, not an instruction
 * the Platform is authorised to relay as if it were its own (I-TD3).
 */
function reworkInstruction(contract: TaskContractV1Body, turn: number): string {
  return [
    `Continue ${contract.task.ref} (version ${contract.task.version}); this is turn ${turn}.`,
    "The audit of the previous candidate required changes. The task contract, its acceptance",
    "conditions and the repository scope are unchanged.",
    "Commit the corrected work in this checkout; its base is still " + contract.base_head + ".",
  ].join("\n");
}

function requireActorSession(store: PlatformStore, attempt_key: string): RuntimeSessionHandle {
  const row = store.adapterMetadata.get(attempt_key, RUNTIME_ADAPTER, SESSION_METADATA_KEY);
  if (row === undefined) {
    throw new ExecutionStartError(`${attempt_key} has no durable Actor session to rework in`);
  }
  // Opaque on the way in and on the way out: Core never looks inside it.
  return row.value as unknown as RuntimeSessionHandle;
}

function requireContract(store: PlatformStore, attempt: TaskAttemptRow): TaskContractV1Body {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  return envelope.body as unknown as TaskContractV1Body;
}

function held(store: PlatformStore, attempt_key: string): StartReworkOutcome {
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
