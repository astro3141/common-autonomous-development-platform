/**
 * What one Auditor review cycle is about (TD §16.1, §16.2; M1-13).
 *
 * §16.2 requires the verdict's `reviewed.*` to match the Attempt's authoritative values exactly,
 * which is only a fair demand if the Auditor was told what they are. So the same three values are
 * assembled here, handed to the Auditor in the review turn, and — in `core/execution/complete-
 * auditing.ts` — compared against the verdict that comes back. One assembly, two uses: the thing
 * the Auditor is asked to echo cannot drift from the thing the Platform then checks.
 *
 * It is per **cycle**, not per session. A rework changes the candidate and the evidence while the
 * same Attempt and the same Auditor session continue, so binding this to the spawn would go stale
 * at exactly the moment it matters.
 */

import type { FeatureWorkspace } from "../../adapters/interfaces/repository-adapter.ts";
import type { TaskContractV1Body } from "../contract/types.ts";
import type { TaskAttemptRow } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { ExecutionStartError } from "./start-implementation.ts";

/**
 * Every value is Platform-authoritative — the Attempt's own candidate, the immutable contract's
 * hash, and the evidence identities in the store's own order. Nothing is derived from a model or
 * from the current mutable Profile, and the list is neither sorted nor deduplicated.
 */
export interface AuditorReviewContextV1 {
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
  readonly evidence_ids: readonly string[];
}

/**
 * `evidence_ids` is the store's own `ORDER BY evidence_id` sequence, which is a ULID order and
 * therefore identical after a restart. It is passed through as-is: sorting or deduplicating it
 * would make the sequence the Auditor is asked to echo different from the one compared later
 * (M0-13).
 */
export function auditorReviewContext(
  store: PlatformStore,
  attempt: TaskAttemptRow,
  contract: TaskContractV1Body,
): AuditorReviewContextV1 {
  const task_contract_hash = store.contracts.hashOf(attempt.contract_snapshot_id);
  if (task_contract_hash === undefined) {
    throw new ExecutionStartError(`contract ${contract.snapshot_id} has no durable hash`);
  }
  return {
    candidate_commit: attempt.candidate_commit as string,
    task_contract_hash,
    evidence_ids: candidateEvidence(store, attempt).map((row) => row.evidence_id),
  };
}

/**
 * The Attempt's evidence **for the candidate under review**, in the store's own order.
 *
 * MVP1-B13 — an Attempt that reworked has evidence from more than one candidate, and evidence is
 * immutable, so the earlier rows stay. Everything downstream is about one candidate: the gate asks
 * whether *this* candidate passed, and the Auditor is asked to echo *this* candidate's evidence.
 * Before the rework path existed the distinction could not arise, so nothing drew it.
 */
export function candidateEvidence(store: PlatformStore, attempt: TaskAttemptRow) {
  const candidate = attempt.candidate_commit;
  return store.verificationEvidence
    .forAttempt(attempt.attempt_key)
    .filter((row) => row.target_commit === candidate);
}

/**
 * Deterministic instruction text. It names what to review and which envelope to return, and asks
 * the model to choose nothing else — not an identity, not a protocol target, not a verdict basis.
 *
 * `correction` is present only on the one permitted retry. It says what was structurally wrong
 * with the previous output and nothing more: it is descriptive, carries no authority, and cannot
 * change the reviewed basis, which is re-stated verbatim above it.
 */
export function auditInstruction(
  contract: TaskContractV1Body,
  workspace: FeatureWorkspace,
  review: AuditorReviewContextV1,
  correction?: string,
): string {
  return [
    `Review ${contract.task.ref} (version ${contract.task.version}) at ${workspace.path}.`,
    `The candidate is ${review.candidate_commit}; its base is ${contract.base_head}.`,
    `The task contract hash is ${review.task_contract_hash}.`,
    `The verification evidence for this review, in order, is: ${review.evidence_ids.join(", ")}.`,
    "Return exactly one platform-auditor-verdict-v1 envelope through the structured result",
    "mechanism this session provides. Its reviewed.candidate_commit, reviewed.task_contract_hash",
    "and reviewed.evidence_ids must be exactly the three values above, in that order.",
    "Do not write to the repository.",
    ...(correction === undefined
      ? []
      : [
          `The previous structured result was unusable: ${correction}.`,
          "That is a description of the fault, not a new basis: review the same candidate against",
          "the same contract and the same evidence, and return a well-formed envelope.",
        ]),
  ].join("\n");
}
