/**
 * Concrete `ApprovalBindingView` lookup (TD §7.2 rule 7, §17.1f, M0-31).
 *
 * One routing function, not an approval subsystem: it connects the Batch 4 compiler's injected
 * `lookup_approval` seam to the two durable records that can actually carry an approval.
 *
 * An ordinary Human Gate approval is *not* a Profile-override authority: only a resolution that
 * explicitly carries an `approval_binding` projects a view, so approving an execution can never
 * be mistaken for approving a privilege expansion.
 */

import { hashPendingDecision } from "../humandecision/pending-decision.ts";
import type { ApprovalBindingView } from "../humandecision/types.ts";
import type { OperatorActionStore } from "./artifact-stores.ts";
import type { PendingDecisionStore } from "./pending-decision-store.ts";

export const HUMAN_DECISION_PREFIX = "human-decision:";
export const OPERATOR_ACTION_PREFIX = "operator-action:";

export interface ApprovalSources {
  readonly decisions: PendingDecisionStore;
  readonly operatorActions: OperatorActionStore;
}

/** Returns the view, or `undefined` when the reference cannot authorize anything. */
export function lookupApprovalBinding(
  sources: ApprovalSources,
  ref: string,
): ApprovalBindingView | undefined {
  if (ref.startsWith(HUMAN_DECISION_PREFIX)) {
    return humanDecisionBinding(sources, ref.slice(HUMAN_DECISION_PREFIX.length), ref);
  }
  if (ref.startsWith(OPERATOR_ACTION_PREFIX)) {
    return operatorActionBinding(sources, ref.slice(OPERATOR_ACTION_PREFIX.length), ref);
  }
  return undefined;
}

function humanDecisionBinding(
  sources: ApprovalSources,
  decisionId: string,
  ref: string,
): ApprovalBindingView | undefined {
  const record = sources.decisions.get(decisionId);
  if (record === undefined) return undefined;

  const { body, record_hash } = record;
  if (body.status !== "RESOLVED" || body.resolution === null) return undefined;
  if (body.resolution.approval_binding === null) return undefined;
  // A terminal record must still hash to what was frozen; otherwise it authorizes nothing.
  if (record_hash === null || record_hash !== hashPendingDecision(body)) return undefined;

  return {
    ref,
    status: "RESOLVED",
    field_path: body.resolution.approval_binding.field_path,
    approved_value: body.resolution.approval_binding.approved_value,
    record_hash,
  };
}

function operatorActionBinding(
  sources: ApprovalSources,
  actionId: string,
  ref: string,
): ApprovalBindingView | undefined {
  const record = sources.operatorActions.get(actionId);
  if (record === undefined) return undefined;
  return {
    ref,
    status: record.status,
    field_path: record.field_path,
    approved_value: record.approved_value,
    record_hash: record.record_hash,
  };
}
