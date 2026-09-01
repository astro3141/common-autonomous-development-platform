/**
 * `Attempt IMPLEMENTING → Attempt VERIFYING` (TD §19.3, §21, §22.3).
 *
 * The transition has two authorities and they are deliberately different components:
 *
 *   the Runtime says only **"the turn is over"**
 *   the repository says **what was actually produced**
 *
 * Nothing the model said takes part. A turn result carries `model_declared_outcome` and may carry
 * `structured_output`; neither is read here (I-TD3), and the candidate is never a SHA the Actor
 * named — it is what `inspect_candidate` finds in the workspace the Platform created.
 *
 * The external side effect is the verification *run*, so it follows the same §21 pair B6 uses:
 * `TX{INTENT}` → adapter call outside every transaction → `TX{reference + DONE + transition}`.
 * Which backend executes it, and how, is the VerificationAdapter's business (TD §15.1a) — this
 * module never names a workflow, a controller or a readiness probe.
 * The candidate SHA is observed once and then bound everywhere — the operation key, the workflow
 * spec and `attempt.candidate_commit` all carry the same value, and a candidate that moves after
 * the intent was written fails closed rather than silently rebinding.
 *
 * Ends at `VERIFYING`. Starting a workflow means verification was *requested*, never that it
 * passed, so no evidence is produced here.
 */

import type { FeatureWorkspace, RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type {
  RuntimeTurnHandle,
  TaskContractSnapshot,
  VerificationProfile,
  VerificationRunHandle,
} from "../../adapters/interfaces/handles.ts";
import type {
  RuntimeAdapter,
  RuntimeBackendStatus,
} from "../../adapters/interfaces/runtime-adapter.ts";
import type { VerificationAdapter } from "../../adapters/interfaces/verification-adapter.ts";
import type { TaskContractV1Body } from "../contract/types.ts";
import type { CanonicalObject, CanonicalValue } from "../schemas/canonical-json.ts";
import { commitAttemptFact } from "../statemachine/transition-commit.ts";
import type { TaskAttemptRow } from "../store/domain-types.ts";
import { StoreError } from "../store/errors.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { actorTurnMetadataKey } from "./actor-operations.ts";
import {
  ExecutionStartError,
  REPOSITORY_ADAPTER,
  RUNTIME_ADAPTER,
  WORKSPACE_METADATA_KEY,
} from "./start-implementation.ts";

/**
 * TD §18.1c — the attempt's verification-run projection. One key, one authority: the generic
 * `VerificationRunHandle`. A run *table* is forbidden, and so is keeping a second backend-shaped
 * alias beside this one.
 */
const VERIFICATION_ADAPTER = "verification";
const VERIFICATION_RUN_METADATA_KEY = "run";

/** TD §19.3 — `op:<attempt>:verify:<candidate_sha>`. The candidate is the qualifier by design. */
const verifyOp = (attemptKey: string, candidate: string): string =>
  `op:${attemptKey}:verify:${candidate}`;

/**
 * The minimum this transition needs. `runtime` is here for one reason only — the Actor turn's
 * terminal fact — and not for anything to do with verification execution.
 */
export interface VerificationAuthorities {
  readonly store: PlatformStore;
  readonly repository: RepositoryAdapter;
  readonly runtime: RuntimeAdapter;
  readonly verification: VerificationAdapter;
}

export interface StartVerificationCommand {
  readonly attempt_key: string;
  /**
   * TD §22.3 (R-1) — set only by the recovery pass, after the RuntimeAdapter itself reported the
   * session/turn as lost (`SESSION_LOST`/`RUNTIME_ERROR`). It lets the candidate the repository
   * actually holds be judged on its own facts ("검증이 model 무관하게 판정") instead of waiting
   * forever for a turn that will never complete. It never bypasses the repository checks, and a
   * merely-unobservable turn (no terminal projection) is *not* a loss — the caller must have an
   * authoritative terminal answer in hand.
   */
  readonly recovered_turn_loss?: boolean;
}

export type StartVerificationOutcome =
  /** The turn has not ended in a way that admits candidate evaluation. Nothing is written. */
  | { readonly kind: "TURN_NOT_COMPLETED"; readonly backend_status: RuntimeBackendStatus }
  /** No usable candidate: the attempt reworks, or the task parks when rework is exhausted. */
  | {
      readonly kind: "CANDIDATE_REJECTED";
      readonly attempt_key: string;
      readonly reason: "ABSENT" | "LINEAGE" | "TRACKED_CLEAN";
      readonly transition_seq: number;
    }
  /**
   * The verification backend authoritatively started nothing. `IMPLEMENTING` is left exactly as it
   * was and the operation stays retriable under the same key — Core is told no reason, because the
   * reason is a backend detail it must not branch on.
   */
  | { readonly kind: "VERIFICATION_BLOCKED"; readonly attempt_key: string }
  | {
      readonly kind: "VERIFYING";
      readonly attempt_key: string;
      readonly candidate_commit: string;
      readonly transition_seq: number;
    };

/** Runs §19.3's `IMPLEMENTING → VERIFYING` for one attempt. Safe to call again after a crash. */
export function startVerification(
  authorities: VerificationAuthorities,
  command: StartVerificationCommand,
): StartVerificationOutcome {
  const { store } = authorities;
  const attempt_key = command.attempt_key;
  const attempt = store.attempts.require(attempt_key);
  const task = store.tasks.require(attempt.task_key);
  if (attempt.state !== "IMPLEMENTING") {
    throw new ExecutionStartError(
      `IMPLEMENTING→VERIFYING requires IMPLEMENTING, not ${attempt.state}`,
    );
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }
  const contract = requireContract(store, attempt);

  // --- step 1–2 — the Runtime's only contribution: the turn is over --------------------
  // The *current* turn, not the first one: after a rework the attempt's live turn is
  // `actor-turn:<rework_count + 1>` (M1-15), and consulting an earlier, already-terminal turn
  // would advance the lifecycle while the real work is still running (§19.3 — the trigger is
  // this turn's terminal observation).
  const turn_handle = requireMetadata(
    store,
    attempt_key,
    RUNTIME_ADAPTER,
    actorTurnMetadataKey(attempt.rework_count + 1),
  );
  const result = authorities.runtime.get_turn_result(turn_handle as unknown as RuntimeTurnHandle);
  if (result.backend_status !== "COMPLETED") {
    const recoverable_loss =
      command.recovered_turn_loss === true &&
      (result.backend_status === "SESSION_LOST" || result.backend_status === "RUNTIME_ERROR");
    if (!recoverable_loss) {
      // §7 — the other terminal states belong to the existing failure/recovery rules, and §22.3's
      // catch-up is a recovery pass, not this transition. Nothing is written either way.
      return { kind: "TURN_NOT_COMPLETED", backend_status: result.backend_status };
    }
    // §22.3 R-1 — the turn is treated as failed; what was actually produced is the repository's
    // question from here on, exactly as in the ordinary path below.
  }
  // §5.12 (durable source minimum) — the completed turn's redacted envelope is preserved as a
  // durable measurement source when the transition that consumes it commits. Structured bodies,
  // backend-native refs and anything I-TD7 restricts are deliberately not part of the projection.
  const turn_ordinal = attempt.rework_count + 1;
  // §13.2a / §13.5 — role, role_profile_id, subject and the resolved runtime_profile are supplied
  // by Core from the *frozen* authority chain, never by the adapter and never inferred from
  // provider output: the selection is durable on the task row and the chain is resolved from the
  // batch-bound Compiled Profile. Adapter-observed fields (provider/model/binding/usage/cost/
  // timing/attribution) pass through untouched.
  const adapter_observation = (result as { execution_observation?: CanonicalObject })
    .execution_observation;
  const frozen_chain = {
    subject: { attempt_key },
    role: "ACTOR",
    role_profile_id: task.actor_profile ?? "",
    runtime_profile: resolveFrozenActorRuntimeProfile(store, attempt, task.actor_profile),
  };
  const redacted_turn: CanonicalValue = {
    backend_status: result.backend_status,
    termination_reason: result.termination_reason,
    started_at: result.started_at,
    completed_at: result.completed_at,
    schema_version: (result as { schema_version?: number }).schema_version ?? 1,
    ...(adapter_observation === undefined
      ? {}
      : {
          execution_observation: {
            ...(adapter_observation as Record<string, unknown>),
            ...frozen_chain,
          } as unknown as CanonicalObject,
        }),
  } as unknown as CanonicalValue;

  // --- steps 3–5 — the repository decides what exists ----------------------------------
  const workspace = requireWorkspace(store, attempt_key);
  const inspection = authorities.repository.inspect_candidate(workspace);
  const candidate = inspection.present ? inspection.candidate_commit : null;
  if (candidate === null || candidate.length === 0) {
    return rejectCandidate(store, attempt_key, "ABSENT");
  }
  if (!authorities.repository.verify_lineage(attempt.base_head, candidate)) {
    return rejectCandidate(store, attempt_key, "LINEAGE");
  }
  if (!authorities.repository.verify_tracked_clean(workspace)) {
    return rejectCandidate(store, attempt_key, "TRACKED_CLEAN");
  }

  const op_key = verifyOp(attempt_key, candidate);
  assertCandidateStillBound(store, attempt_key, op_key);

  const record = store.idempotency.get(op_key);
  if (record?.state === "FAILED") {
    throw new ExecutionStartError(`${op_key} is FAILED; a new attempt is a human decision`);
  }

  // V4 — a run reference survived without its DONE. It is the same run, so it is reconciled and
  // promoted rather than started again.
  const stored = store.adapterMetadata.get(
    attempt_key,
    VERIFICATION_ADAPTER,
    VERIFICATION_RUN_METADATA_KEY,
  );
  if (record?.state === "DONE" || (record?.state === "INTENT" && stored !== undefined)) {
    return commitVerifying(store, {
      attempt_key,
      op_key,
      candidate,
      turn_projection: { key: `actor_turn_result:${turn_ordinal}`, value: redacted_turn },
      run_value: requireStoredRun(stored, record?.result, op_key),
      already_stored: stored !== undefined,
    });
  }

  // --- step 6 — the intent, before the start. It stays durable even if the backend answers
  // BLOCKED: BLOCKED is an authoritative *absence*, so the same operation is simply retried later
  // and there is nothing to undo (TD §21, M1-9).
  if (record === undefined) {
    store.withTransaction(() => {
      store.idempotency.beginIntent(op_key);
    });
  }

  // --- step 7 — outside every transaction. Same op key + same material re-acquires the run.
  const started = authorities.verification.start_verification(
    { op_key },
    contract.verification_profile as unknown as VerificationProfile,
    authorities.repository.snapshot_canonical(),
    contractSnapshot(store, attempt),
    candidate,
  );
  if (started.kind === "BLOCKED") {
    return { kind: "VERIFICATION_BLOCKED", attempt_key };
  }

  // --- step 8 — reference, completion, candidate and the state change, all in one TX ------
  return commitVerifying(store, {
    attempt_key,
    op_key,
    candidate,
    run_value: started.run_handle as unknown as CanonicalValue,
    already_stored: false,
    turn_projection: { key: `actor_turn_result:${turn_ordinal}`, value: redacted_turn },
  });
}

// --- the durable commit ----------------------------------------------------------------

function commitVerifying(
  store: PlatformStore,
  input: {
    readonly attempt_key: string;
    readonly op_key: string;
    readonly candidate: string;
    readonly run_value: CanonicalValue;
    readonly already_stored: boolean;
    readonly turn_projection?: { readonly key: string; readonly value: CanonicalValue };
  },
): StartVerificationOutcome {
  const result = commitAttemptFact(store, {
    attempt_key: input.attempt_key,
    fact: {
      kind: "CANDIDATE_OBSERVED",
      candidate_commit: input.candidate,
      // Both were established by the RepositoryAdapter above; the guard re-asserts them so a
      // caller cannot reach VERIFYING with anything weaker.
      lineage_valid: true,
      tracked_clean: true,
    },
    within: () => {
      if (!input.already_stored) {
        store.adapterMetadata.put({
          entity_key: input.attempt_key,
          adapter_id: VERIFICATION_ADAPTER,
          key: VERIFICATION_RUN_METADATA_KEY,
          value: input.run_value,
        });
      }
      if (store.idempotency.get(input.op_key)?.state !== "DONE") {
        store.idempotency.markDone(input.op_key, input.run_value);
      }
      if (
        input.turn_projection !== undefined &&
        store.adapterMetadata.get(input.attempt_key, RUNTIME_ADAPTER, input.turn_projection.key) ===
          undefined
      ) {
        store.adapterMetadata.put({
          entity_key: input.attempt_key,
          adapter_id: RUNTIME_ADAPTER,
          key: input.turn_projection.key,
          value: input.turn_projection.value,
        });
      }
    },
  });
  return {
    kind: "VERIFYING",
    attempt_key: input.attempt_key,
    candidate_commit: input.candidate,
    transition_seq: result.transition.seq,
  };
}

function rejectCandidate(
  store: PlatformStore,
  attempt_key: string,
  reason: "ABSENT" | "LINEAGE" | "TRACKED_CLEAN",
): StartVerificationOutcome {
  const result = commitAttemptFact(store, {
    attempt_key,
    fact: { kind: "CANDIDATE_REJECTED" },
  });
  return { kind: "CANDIDATE_REJECTED", attempt_key, reason, transition_seq: result.transition.seq };
}

// --- the candidate binding guard --------------------------------------------------------

/**
 * TD §19.3 — the candidate SHA *is* the operation qualifier, so a candidate that moved between one
 * pass and the next produces a different operation key. Reusing that key would mean verifying a
 * commit the intent was never written for, so another candidate **still in flight** fails closed.
 *
 * MVP1-B13 narrowed it: the conflict is another candidate whose verification is still *unfinished*,
 * not merely another candidate. A rework produces a second candidate for the same Attempt (§26 15
 * returns to step 8'), and the earlier candidate's run is `DONE` by then — refusing because it
 * exists at all would make the rework loop unreachable. What the check protects is unchanged: two
 * verification runs are never open for one Attempt at once, and no intent is ever reused for a
 * commit it was not written for.
 */
function assertCandidateStillBound(
  store: PlatformStore,
  attempt_key: string,
  op_key: string,
): void {
  const inFlight = store.idempotency
    .keysWithPrefix(`op:${attempt_key}:verify:`)
    .filter((key) => key !== op_key && store.idempotency.get(key)?.state !== "DONE");
  if (inFlight.length > 0) {
    throw new ExecutionStartError(
      `${attempt_key} already has an unfinished verification operation for a different candidate`,
    );
  }
}

// --- inputs ------------------------------------------------------------------------------

/**
 * The frozen contract as the adapter boundary sees it: the stored envelope, which carries the
 * hash-bound body every §15.2 evidence must later agree with. Nothing the Actor produced is in it.
 */
function contractSnapshot(store: PlatformStore, attempt: TaskAttemptRow): TaskContractSnapshot {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  if (store.contracts.hashOf(attempt.contract_snapshot_id) === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} has no hash`);
  }
  return envelope as unknown as TaskContractSnapshot;
}

function requireContract(store: PlatformStore, attempt: TaskAttemptRow): TaskContractV1Body {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  return envelope.body as unknown as TaskContractV1Body;
}

function requireWorkspace(store: PlatformStore, attempt_key: string): FeatureWorkspace {
  const ref = requireMetadata(
    store,
    attempt_key,
    REPOSITORY_ADAPTER,
    WORKSPACE_METADATA_KEY,
  ) as unknown as { path: string; base_head: string; branch: string };
  return { path: ref.path, base_head: ref.base_head, branch: ref.branch };
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

function requireStoredRun(
  stored: { readonly value: CanonicalValue } | undefined,
  result: CanonicalValue | undefined,
  op_key: string,
): CanonicalValue {
  const value = stored?.value ?? result;
  if (value === undefined) {
    throw new StoreError("DOMAIN_ROW_INVALID", `${op_key} completed without a run reference`);
  }
  return value;
}

/**
 * §13.5 — the frozen Actor runtime-profile chain: `task.actor_profile` (validated selection) →
 * batch-bound Compiled Profile `roles[...].runtime_profile`. Never the current registry, never a
 * default; an unresolvable chain is honestly empty rather than guessed.
 */
function resolveFrozenActorRuntimeProfile(
  store: PlatformStore,
  attempt: TaskAttemptRow,
  actor_profile: string | null,
): string {
  if (actor_profile === null) return "";
  try {
    const task = store.tasks.require(attempt.task_key);
    const compiled = store.batchView.compiledProfileFor(task.batch_id);
    return compiled.effective.project.roles[actor_profile]?.runtime_profile ?? "";
  } catch {
    return "";
  }
}
