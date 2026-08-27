/**
 * Verification completion and the evidence gate (TD §15.2, §15.3, §19.3).
 *
 * The verification backend produces facts; it does not decide anything. This module takes what it
 * returned, re-binds every item to the Platform's own authoritative state, stores it immutably, and
 * only then asks the frozen policy whether the attempt may proceed. Three separations do the work:
 *
 *   `binding_valid` is computed here and never accepted from a verifier;
 *   the policy comes from the batch's frozen Compiled Profile, never the live Registry;
 *   a satisfied gate writes **no** marker — the evidence rows and the frozen policy are the record,
 *   so the next step recomputes eligibility rather than trusting a flag someone set earlier.
 *
 * A successful gate therefore leaves the attempt exactly where it was: `VERIFYING`. Spawning the
 * Auditor is a separate step with its own external side effects.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type { VerificationRunHandle } from "../../adapters/interfaces/handles.ts";
import type {
  VerificationAdapter,
  VerificationEvidence,
} from "../../adapters/interfaces/verification-adapter.ts";
import { commitAttemptFact } from "../statemachine/transition-commit.ts";
import type { TaskAttemptRow, TaskRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { VerificationEvidenceV1 } from "../store/mvp1-artifact-stores.ts";
import { evaluateVerificationGate, type UnsatisfiedReason } from "./verification-gate.ts";
import {
  ExecutionStartError,
  REPOSITORY_ADAPTER,
  WORKSPACE_METADATA_KEY,
} from "./start-implementation.ts";

/** TD §18.1c — where B7 left the run's opaque reference. */
const VERIFICATION_ADAPTER = "verification";
const VERIFICATION_RUN_METADATA_KEY = "run";

export interface VerificationCompletionAuthorities {
  readonly store: PlatformStore;
  readonly repository: RepositoryAdapter;
  readonly verification: VerificationAdapter;
}

export interface CompleteVerificationCommand {
  readonly attempt_key: string;
}

export type CompleteVerificationOutcome =
  /** The run is not terminal. Nothing was read as a fact and nothing was written. */
  | { readonly kind: "RUNNING"; readonly attempt_key: string }
  /** The verification execution itself failed; no evidence set can represent the run. */
  | { readonly kind: "VERIFICATION_INFRA"; readonly attempt_key: string; readonly transition_seq: number }
  /**
   * Every required check is satisfied. The attempt stays `VERIFYING` and **no gate marker is
   * written** — eligibility is recomputed from the stored evidence and the frozen policy.
   */
  | { readonly kind: "GATE_PASSED"; readonly attempt_key: string; readonly evidence_ids: readonly string[] }
  | {
      readonly kind: "GATE_FAILED";
      readonly attempt_key: string;
      readonly unsatisfied: Readonly<Record<string, UnsatisfiedReason>>;
      readonly transition_seq: number;
    };

/** Runs one completion pass for a `VERIFYING` attempt. Safe to call again at any point. */
export function completeVerification(
  authorities: VerificationCompletionAuthorities,
  command: CompleteVerificationCommand,
): CompleteVerificationOutcome {
  const { store } = authorities;
  const attempt_key = command.attempt_key;
  const attempt = store.attempts.require(attempt_key);
  const task = store.tasks.require(attempt.task_key);
  requireVerifiable(attempt, task);

  const candidate_commit = attempt.candidate_commit as string;
  const task_contract_hash = store.contracts.hashOf(attempt.contract_snapshot_id);
  if (task_contract_hash === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} has no hash`);
  }
  requireCompletedRun(store, attempt_key, candidate_commit);

  const observation = authorities.verification.get_verification_result(
    runHandle(store, attempt_key),
  );
  if (observation.state === "RUNNING") {
    return { kind: "RUNNING", attempt_key };
  }
  if (observation.state === "FAILED") {
    // §5 — the run itself failed. This is the existing whole-run infrastructure path; no evidence
    // is invented to stand in for it, and no new reason code is created.
    const held = commitAttemptFact(store, {
      attempt_key,
      fact: { kind: "VERIFICATION_FAILED", infrastructure: true },
    });
    return { kind: "VERIFICATION_INFRA", attempt_key, transition_seq: held.transition.seq };
  }

  // --- §8 — the candidate the evidence must be about, re-confirmed with the repository ---------
  const confirmed_candidate = confirmCandidate(authorities, attempt, candidate_commit);

  // --- §6/§13 — bind everything first, then persist the whole set in one transaction -----------
  const rows = observation.evidence.map((evidence) => ({
    evidence,
    binding_valid:
      confirmed_candidate !== undefined &&
      evidence.target_commit === confirmed_candidate &&
      evidence.task_contract_hash === task_contract_hash,
  }));

  store.withTransaction(() => {
    for (const row of rows) {
      store.verificationEvidence.put({
        attempt_key,
        evidence: row.evidence as unknown as VerificationEvidenceV1,
        // §10 — the Coordinator's own verdict. A verifier has no way to supply this.
        binding_valid: row.binding_valid,
      });
    }
  });

  // --- §15/§16 — the frozen policy decides, on set membership alone ----------------------------
  const compiled = store.batchView.compiledProfileFor(task.batch_id);
  const unsatisfied = evaluateVerificationGate(
    compiled.effective.policy.verification_policy.required_verification,
    rows.map((row) => ({ ...row.evidence, binding_valid: row.binding_valid })),
  );
  if (Object.keys(unsatisfied).length === 0) {
    return {
      kind: "GATE_PASSED",
      attempt_key,
      evidence_ids: rows.map((row) => row.evidence.evidence_id),
    };
  }

  const failed = commitAttemptFact(store, {
    attempt_key,
    fact: { kind: "VERIFICATION_FAILED", infrastructure: false },
  });
  return { kind: "GATE_FAILED", attempt_key, unsatisfied, transition_seq: failed.transition.seq };
}

// --- authoritative reads ------------------------------------------------------------------------

/**
 * §8 / TD §15.2 — the Coordinator re-confirms the candidate with the RepositoryAdapter rather than
 * trusting a SHA that travelled with the evidence or inside the run handle. If the repository no
 * longer shows the attempt's candidate, the binding cannot be confirmed and every item is recorded
 * unbound — the attempt is never silently rebound to whatever is there now.
 */
function confirmCandidate(
  authorities: VerificationCompletionAuthorities,
  attempt: TaskAttemptRow,
  candidate_commit: string,
): string | undefined {
  const ref = authorities.store.adapterMetadata.get(
    attempt.attempt_key,
    REPOSITORY_ADAPTER,
    WORKSPACE_METADATA_KEY,
  );
  if (ref === undefined) return undefined;
  const workspace = ref.value as unknown as { path: string; base_head: string; branch: string };
  try {
    const inspection = authorities.repository.inspect_candidate(workspace);
    return inspection.present && inspection.candidate_commit === candidate_commit
      ? candidate_commit
      : undefined;
  } catch {
    return undefined;
  }
}

function requireVerifiable(attempt: TaskAttemptRow, task: TaskRow): void {
  if (attempt.state !== "VERIFYING") {
    throw new ExecutionStartError(`verification completion requires VERIFYING, not ${attempt.state}`);
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }
  if (attempt.candidate_commit === null) {
    throw new ExecutionStartError(`${attempt.attempt_key} is VERIFYING without a candidate`);
  }
}

/**
 * The verify operation must already have completed; B9 never starts a run.
 *
 * MVP1-B13 scoped this to the attempt's *current* candidate. The check used to require exactly one
 * completed verification per Attempt, which a rework makes false — the previous candidate's run is
 * also DONE. The candidate is the operation's own qualifier, so asking about it directly is both
 * narrower and more precise than counting.
 */
function requireCompletedRun(store: PlatformStore, attempt_key: string, candidate: string): void {
  const record = store.idempotency.get(`op:${attempt_key}:verify:${candidate}`);
  if (record?.state !== "DONE") {
    throw new ExecutionStartError(
      `${attempt_key} has no completed verification operation for ${candidate}`,
    );
  }
}

function runHandle(store: PlatformStore, attempt_key: string): VerificationRunHandle {
  const row = store.adapterMetadata.get(
    attempt_key,
    VERIFICATION_ADAPTER,
    VERIFICATION_RUN_METADATA_KEY,
  );
  if (row === undefined) {
    throw new ExecutionStartError(`${attempt_key} has no durable verification run reference`);
  }
  // Opaque on the way in and on the way out: Core never looks inside it.
  return row.value as unknown as VerificationRunHandle;
}
