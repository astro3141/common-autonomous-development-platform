/**
 * MVP 2 Repository Gate — strategy A, local guarded fast-forward (TD §14.4, §14.5, §19.3; Spec §67).
 *
 * Two narrow operations, split exactly where the crash windows are:
 *
 *   `startAutomaticMerge`     READY_TO_MERGE → MERGING. Every G1–G5 precondition is judged from
 *                             authoritative facts *before* the merge INTENT is written; the commit
 *                             of the INTENT and the transition is one transaction, and no external
 *                             effect has happened when it returns.
 *   `completeAutomaticMerge`  MERGING → MERGED. The one place in the whole Platform that performs
 *                             a canonical mutation, guarded by the write-ahead INTENT (§21): an
 *                             effect that may already exist is re-observed, never re-executed.
 *
 * G1 holds structurally: the Actor is never handed this module, the Gate runs in the Platform
 * process, and `commit_merge` has no other production caller (a source guard proves that). G5 is
 * the op key `op:<attempt>:merge:<candidate>` plus the completion rules below.
 *
 * The Gate enforces policy over adapter facts; it builds no git command (TD §14.3), and it never
 * weakens a precondition to make a merge possible — every refusal is fail-closed with the
 * existing vocabulary (`REPOSITORY_CONFLICT`, `POLICY_BACKEND_INCOMPATIBLE`, `RECOVERY_CONFLICT`).
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import { evaluateCapabilityRequirements } from "../capability/compatibility.ts";
import { deriveRequestedCapabilities } from "../capability/derive.ts";
import { validateManifestSet, type ManifestSetInput } from "../capability/manifest-set.ts";
import type { ContractSourceReader, TaskContractV1Body } from "../contract/types.ts";
import type { ProfileSource } from "../profile/types.ts";
import { commitAttemptFact, commitBatchFact } from "../statemachine/transition-commit.ts";
import type { TaskAttemptRow, TaskRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { TaskSourceV1 } from "../tasksource/types.ts";
import { assembleDriftObservation } from "./assemble-drift-observation.ts";
import { candidateEvidence } from "./auditor-review.ts";
import { applyDriftStop, type DriftStopOutcome } from "./drift-lifecycle.ts";
import { evaluateStageBoundaryDrift } from "./stage-boundary-drift.ts";
import { loadFrozenAuditorCapability } from "./start-auditing.ts";
import {
  ExecutionStartError,
  REPOSITORY_ADAPTER,
  WORKSPACE_METADATA_KEY,
} from "./start-implementation.ts";
import { evaluateVerificationGate } from "./verification-gate.ts";

/** §9.2d — the one operation id the automatic path answers to. Policy-owned vocabulary. */
const AUTOMATIC_MERGE_OPERATION = "automatic_merge";

export const mergeOp = (attempt_key: string, candidate: string): string =>
  `op:${attempt_key}:merge:${candidate}`;

export interface AutomaticMergeAuthorities {
  readonly store: PlatformStore;
  readonly repository: RepositoryAdapter;
  readonly profiles: ProfileSource;
  readonly taskSource: TaskSourceV1;
  readonly contractSources: ContractSourceReader;
  /** The configured component manifests — §14.5's capability precondition reads them fresh. */
  readonly manifests: ManifestSetInput;
}

export interface AutomaticMergeCommand {
  readonly attempt_key: string;
  /** Caller-allocated ULID for the decision a drift stop opens. */
  readonly decision_id?: string;
  readonly report_channel?: string;
}

export type StartAutomaticMergeOutcome =
  | { readonly kind: "MERGING"; readonly attempt_key: string; readonly transition_seq: number }
  /** A Gate precondition failed. The exact unmet conditions ride along for diagnostics only. */
  | {
      readonly kind: "HELD";
      readonly attempt_key: string;
      readonly reason_code: "REPOSITORY_CONFLICT" | "POLICY_BACKEND_INCOMPATIBLE";
      readonly unmet: readonly string[];
      readonly transition_seq: number;
    }
  | DriftStopOutcome;

/**
 * §19.3 — `A: READY_TO_MERGE→MERGING (MVP 2)`. Preconditions first, INTENT last, no side effect.
 */
export function startAutomaticMerge(
  authorities: AutomaticMergeAuthorities,
  command: AutomaticMergeCommand,
): StartAutomaticMergeOutcome {
  const { store } = authorities;
  const attempt = store.attempts.require(command.attempt_key);
  const task = store.tasks.require(attempt.task_key);
  if (attempt.state !== "READY_TO_MERGE") {
    throw new ExecutionStartError(`automatic merge requires READY_TO_MERGE, not ${attempt.state}`);
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }
  const compiled = store.batchView.compiledProfileFor(task.batch_id);
  if (compiled.effective.policy.auto_merge !== true) {
    throw new ExecutionStartError("the frozen policy does not enable automatic merge");
  }
  const candidate = attempt.candidate_commit;
  if (candidate === null || candidate.length === 0) {
    throw new ExecutionStartError(`${attempt.attempt_key} has no candidate to merge`);
  }
  const contract = requireContract(store, attempt);

  // --- §11 merge boundary, before anything else (M1-14's placement, automatic side) -----------
  const drift = evaluateStageBoundaryDrift(
    assembleDriftObservation(authorities, {
      boundary: "READY_TO_MERGE_TO_MERGING",
      attempt,
      contract,
      compiled,
      auditor_grant: loadFrozenAuditorCapability(store, attempt.attempt_key, contract),
    }),
  );
  if (drift.kind !== "CONTINUE") {
    return applyDriftStop(store, {
      attempt_key: attempt.attempt_key,
      task_key: task.task_key,
      outcome: drift,
      ...(command.decision_id === undefined ? {} : { decision_id: command.decision_id }),
      ...(command.report_channel === undefined ? {} : { report_channel: command.report_channel }),
    });
  }

  // --- §14.5 / §12.2 — the Backend must satisfy the operation's declared requirements ----------
  const requirements =
    compiled.effective.policy.capability_requirements[AUTOMATIC_MERGE_OPERATION] ?? {};
  const manifests = validateManifestSet(authorities.manifests);
  const compatibility = evaluateCapabilityRequirements(
    deriveRequestedCapabilities(compiled.effective.policy, "ACTOR"),
    manifests.runtime.body,
    requirements,
  );
  if (!compatibility.compatible) {
    return held(store, attempt, "POLICY_BACKEND_INCOMPATIBLE", [
      ...compatibility.failures.map((failure) => `capability:${failure.capability}`),
    ]);
  }

  // --- G2/G3/G4 + strategy A preconditions, every one an authoritative fact --------------------
  const unmet = gatePreconditions(authorities, { attempt, task, contract, candidate, compiled });
  if (unmet.length > 0) return held(store, attempt, "REPOSITORY_CONFLICT", unmet);

  // --- the INTENT and the transition, one transaction, zero external effect --------------------
  const committed = commitAttemptFact(store, {
    attempt_key: attempt.attempt_key,
    fact: { kind: "AUTOMATIC_MERGE_STARTED", gate_preconditions_met: true },
    within: () => {
      store.idempotency.beginIntent(mergeOp(attempt.attempt_key, candidate));
    },
  });
  return { kind: "MERGING", attempt_key: attempt.attempt_key, transition_seq: committed.transition.seq };
}

/** The strategy-A precondition table (§14.4). Returns every unmet condition, or the empty list. */
function gatePreconditions(
  authorities: AutomaticMergeAuthorities,
  input: {
    readonly attempt: TaskAttemptRow;
    readonly task: TaskRow;
    readonly contract: TaskContractV1Body;
    readonly candidate: string;
    readonly compiled: ReturnType<PlatformStore["batchView"]["compiledProfileFor"]>;
  },
): string[] {
  const { store, repository } = authorities;
  const { attempt, task, contract, candidate } = input;
  const unmet: string[] = [];

  // canonical tracked clean + HEAD CAS (G3): the expected head is the attempt's own frozen base.
  if (!repository.verify_tracked_clean()) unmet.push("canonical_tracked_clean");
  if (!repository.verify_canonical_head(attempt.base_head)) unmet.push("canonical_head_cas");

  // candidate parent lineage + candidate tracked clean.
  if (!repository.verify_lineage(attempt.base_head, candidate)) unmet.push("candidate_lineage");
  const workspace = store.adapterMetadata.get(
    attempt.attempt_key,
    REPOSITORY_ADAPTER,
    WORKSPACE_METADATA_KEY,
  );
  if (workspace === undefined) {
    unmet.push("workspace_projection_missing");
  } else if (!repository.verify_tracked_clean(workspace.value as never)) {
    unmet.push("candidate_tracked_clean");
  }

  // required verification, recomputed from immutable evidence and the frozen policy (§15.3).
  const unsatisfied = evaluateVerificationGate(
    input.compiled.effective.policy.verification_policy.required_verification,
    candidateEvidence(store, attempt),
  );
  for (const check of Object.keys(unsatisfied)) unmet.push(`verification:${check}`);

  // settled AUDIT_PASS about exactly this candidate under exactly this contract (G2).
  const contractHash = store.contracts.hashOf(attempt.contract_snapshot_id);
  const audit = store.auditRecords
    .forAttempt(attempt.attempt_key)
    .filter(
      (row) =>
        row.candidate_commit === candidate &&
        row.verdict === "AUDIT_PASS" &&
        row.task_contract_hash === contractHash,
    );
  if (audit.length === 0) unmet.push("audit_pass");

  // expected-file scope (repository_scope 대조): the mechanical path questions.
  const scope = contract.repository_scope;
  if (
    scope.allowed_paths.length > 0 &&
    !repository.verify_expected_files({
      from: attempt.base_head,
      to: candidate,
      allowed_paths: scope.allowed_paths,
    })
  ) {
    unmet.push("scope_allowed_paths");
  }
  if (scope.forbidden_paths.length > 0) {
    const diff = repository.get_diff({ from: attempt.base_head, to: candidate });
    const touched = diff.changed_paths.some((path) =>
      scope.forbidden_paths.some(
        (prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`),
      ),
    );
    if (touched) unmet.push("scope_forbidden_paths");
  }

  // no conflicting writer: this attempt is the only writable candidate holder in the batch.
  for (const other of store.tasks.inBatch(task.batch_id)) {
    if (other.task_key === task.task_key || other.platform_state !== "ACTIVE") continue;
    const current = store.attempts.current(other.task_key);
    if (
      current !== undefined &&
      (current.state === "READY" ||
        current.state === "IMPLEMENTING" ||
        current.state === "REWORKING")
    ) {
      unmet.push(`conflicting_writer:${other.task_key}`);
    }
  }

  return unmet;
}

export type CompleteAutomaticMergeOutcome =
  | { readonly kind: "MERGED"; readonly attempt_key: string; readonly canonical_head: string }
  /** The effect's existence could not be decided, or the world contradicts the intent. */
  | {
      readonly kind: "PAUSED_SAFELY";
      readonly attempt_key: string;
      readonly reason_code: "RECOVERY_CONFLICT";
    }
  | {
      readonly kind: "HELD";
      readonly attempt_key: string;
      readonly reason_code: "REPOSITORY_CONFLICT";
    };

/**
 * §19.3 — `A: MERGING→MERGED + T: ACTIVE→COMPLETED`, with the §21 recovery rules for a canonical
 * mutation:
 *
 *   INTENT + effect observable (canonical contains the candidate) → promote to DONE, no re-run
 *   INTENT + effect provably absent (canonical still at the base)  → perform the ff-only merge
 *   anything else                                                  → PAUSED_SAFELY, never a guess
 */
export function completeAutomaticMerge(
  authorities: AutomaticMergeAuthorities,
  command: { readonly attempt_key: string },
): CompleteAutomaticMergeOutcome {
  const { store, repository } = authorities;
  const attempt = store.attempts.require(command.attempt_key);
  if (attempt.state !== "MERGING") {
    throw new ExecutionStartError(`merge completion requires MERGING, not ${attempt.state}`);
  }
  const candidate = attempt.candidate_commit as string;
  const op = mergeOp(attempt.attempt_key, candidate);
  const record = store.idempotency.get(op);
  if (record === undefined) {
    throw new ExecutionStartError(`${op} has no write-ahead INTENT (I-TD2)`);
  }

  const head = repository.snapshot_canonical().head;
  const merged = head === candidate || repository.verify_lineage(candidate, head);

  if (record.state === "DONE" || merged) {
    // The effect exists (or was already settled): observation, not re-execution (G5).
    return settleMerged(store, attempt, op, head);
  }

  if (head !== attempt.base_head) {
    // Someone else moved canonical while our merge intent was open: a conflicting writer the
    // preconditions did not see. Canonical mutation risk → the batch stops (Spec §52).
    return pause(store, attempt);
  }

  // Effect provably absent: canonical is exactly where the Gate verified it. Merge now.
  let canonical_head: string;
  try {
    const preparation = repository.prepare_merge({
      candidate_commit: candidate,
      expected_canonical_head: attempt.base_head,
    });
    if (!preparation.fast_forwardable) {
      const committed = commitAttemptFact(store, {
        attempt_key: attempt.attempt_key,
        fact: { kind: "EXECUTION_HELD", reason_code: "REPOSITORY_CONFLICT" },
      });
      void committed;
      return {
        kind: "HELD",
        attempt_key: attempt.attempt_key,
        reason_code: "REPOSITORY_CONFLICT",
      };
    }
    canonical_head = repository.commit_merge(preparation).canonical_head;
  } catch {
    // The merge may or may not have happened. Nothing is assumed either way (§21).
    return pause(store, attempt);
  }

  if (canonical_head !== candidate && !repository.verify_lineage(candidate, canonical_head)) {
    // The repository answered with a head that does not contain the candidate: fail closed.
    return pause(store, attempt);
  }
  return settleMerged(store, attempt, op, canonical_head);
}

function settleMerged(
  store: PlatformStore,
  attempt: TaskAttemptRow,
  op: string,
  head: string,
): CompleteAutomaticMergeOutcome {
  commitAttemptFact(store, {
    attempt_key: attempt.attempt_key,
    fact: { kind: "MERGE_OBSERVED", canonical_contains_candidate: true },
    within: () => {
      store.idempotency.markDone(op, { canonical_head: head });
    },
  });
  return { kind: "MERGED", attempt_key: attempt.attempt_key, canonical_head: head };
}

function pause(store: PlatformStore, attempt: TaskAttemptRow): CompleteAutomaticMergeOutcome {
  const task = store.tasks.require(attempt.task_key);
  // The safe state first (§19.4h's ordering): the batch stops, then the attempt is parked.
  commitBatchFact(store, {
    batch_id: task.batch_id,
    fact: { kind: "CIRCUIT_BREAKER", also_pause_run: true },
  });
  commitAttemptFact(store, {
    attempt_key: attempt.attempt_key,
    fact: { kind: "EXECUTION_HELD", reason_code: "RECOVERY_CONFLICT" },
  });
  return {
    kind: "PAUSED_SAFELY",
    attempt_key: attempt.attempt_key,
    reason_code: "RECOVERY_CONFLICT",
  };
}

function held(
  store: PlatformStore,
  attempt: TaskAttemptRow,
  reason_code: "REPOSITORY_CONFLICT" | "POLICY_BACKEND_INCOMPATIBLE",
  unmet: readonly string[],
): StartAutomaticMergeOutcome {
  const committed = commitAttemptFact(store, {
    attempt_key: attempt.attempt_key,
    fact: { kind: "EXECUTION_HELD", reason_code },
  });
  return {
    kind: "HELD",
    attempt_key: attempt.attempt_key,
    reason_code,
    unmet,
    transition_seq: committed.transition.seq,
  };
}

function requireContract(store: PlatformStore, attempt: TaskAttemptRow): TaskContractV1Body {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  return envelope.body as unknown as TaskContractV1Body;
}
