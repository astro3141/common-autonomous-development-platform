/**
 * V5 decision authority and V7 Human Gate (TD §9.2a, §9.2b, M0-26).
 *
 * These two steps judge *policy*, never lifecycle legality. Whether the current AttemptState
 * admits a rework, whether the task is READY_TO_MERGE, whether a parent is really suspended and
 * whether the batch may close are all fail-closed preconditions of the state machine (§19.3/§20);
 * duplicating them here would create a second, divergent guard table.
 */

import type { ExecutionDisposition, ExecutionPolicyV1Body } from "../profile/types.ts";
import { inputInvalid } from "./errors.ts";
import type { DecisionRejectReason, ProposalV1 } from "./types.ts";

/**
 * TD §9.2 / M0-26 — the authoritative disposition source is the compiled
 * `effective.policy.classification_policy`. The compiler has already folded the Project Profile
 * default into it (§7.2 rule 2), so nothing is merged again here and no raw policy is read.
 *
 * The classification is known to be declared by the time this is called (V4), so a missing entry
 * means the compiled profile violates its own invariant — a caller-contract failure.
 */
export function effectiveDisposition(
  policy: ExecutionPolicyV1Body,
  classification: string,
): ExecutionDisposition {
  const disposition = policy.classification_policy[classification];
  if (disposition === undefined) {
    throw inputInvalid(
      `/compiled_profile/effective/policy/classification_policy/${classification}`,
      "compiled profile declares the classification but resolves no disposition",
    );
  }
  return disposition;
}

/**
 * V5. Returns the rejection reason, or `undefined` when the decision is authorized.
 *
 * `disposition` is supplied only for a TaskSelection proposal; the other variants do not select a
 * classification, so nothing here demands a placeholder one.
 */
export function authorizeDecision(
  proposal: ProposalV1,
  policy: ExecutionPolicyV1Body,
  disposition: ExecutionDisposition | undefined,
): DecisionRejectReason | undefined {
  switch (proposal.decision) {
    case "START_TASK":
      // HOLD_HUMAN passes V5 and is routed to the gate by V7; AUTO_SUBFLOW is a different request.
      return disposition === "AUTO_SUBFLOW" ? "DECISION_NOT_ALLOWED" : undefined;

    case "START_SUBFLOW":
      // A policy that forbids automatic subflows cannot be overridden by a human gate: allowing
      // that would make approval an implicit Execution Policy edit.
      if (!policy.allow_auto_subflow) return "DECISION_NOT_ALLOWED";
      return disposition === "AUTO_EXECUTE" ? "DECISION_NOT_ALLOWED" : undefined;

    // `auto_merge` is the authority over the automatic canonical side effect, not over the right
    // to propose a merge — rejecting here would remove the human merge path (§19.4).
    case "PROPOSE_MERGE":
    case "REQUEST_REWORK":
    case "HOLD_TASK":
    case "DEFER_TASK":
    case "RESUME_PARENT":
    case "CLOSE_BATCH":
      return undefined;
  }
}

/**
 * V7. Either rule alone is enough and both together still yield a single gate result.
 *
 * A gate is not an approval and not a rejection: the caller obtains a deterministic branch and
 * nothing else. Creating a pending human decision, or resuming one, belongs to the Coordinator.
 */
export function requiresHumanGate(
  proposal: ProposalV1,
  policy: ExecutionPolicyV1Body,
  disposition: ExecutionDisposition | undefined,
): boolean {
  if (policy.human_gate_policy.required_decisions.includes(proposal.decision)) return true;
  return proposal.variant === "TASK_SELECTION" && disposition === "HOLD_HUMAN";
}
