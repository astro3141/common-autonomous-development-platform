/**
 * Durable append seam for a decision validation (TD §9.2, §18.1).
 *
 * The pure validator stays free of persistence; this thin wrapper is the only place in Batch 7
 * that writes anything, and the only thing it writes is one Batch 2 `decision_log` row. There is
 * no decision repository, no event bus and no proposal snapshot: the payload is a local
 * constrained-JSON projection, not a versioned artifact or a hashed one.
 *
 * `kind` and `ref_key` are local literals of this projection, not a new public contract.
 *
 * A store failure propagates. Reporting a successful validation while its journal row was lost
 * would misrepresent the durable record.
 */

import type { CanonicalObject } from "../schemas/canonical-json.ts";
import type { DecisionLogAppend, DecisionLogEntry } from "../store/decision-log.ts";
import { validateDecision, type DecisionValidationInput } from "./validator.ts";
import type { DecisionValidationResult } from "./types.ts";

export const DECISION_VALIDATION_LOG_KIND = "decision_validation";

/** The Batch 2 journal, narrowed to the one operation this seam needs. */
export interface DecisionLogAppender {
  append(entry: DecisionLogAppend): DecisionLogEntry;
}

export interface RecordedDecision {
  readonly result: DecisionValidationResult;
  readonly entry: DecisionLogEntry;
}

/** Validates once and appends exactly one entry, whatever the outcome. */
export function validateAndRecordDecision(
  log: DecisionLogAppender,
  input: DecisionValidationInput,
  context?: SubmissionJournalContext,
): RecordedDecision {
  const result = validateDecision(input);
  const entry = log.append({
    kind: DECISION_VALIDATION_LOG_KIND,
    refKey: identityOf(input.proposal).proposal_id ?? "",
    payload: decisionPayload(input.proposal, result, context),
  });
  return { result, entry };
}

/**
 * The submission's routing context (TD §5.1), journaled with the outcome so downstream read
 * models — Supervisor pacing in particular — can scope "this batch's answered proposals" without
 * guessing from a global count. Journal metadata only; never validation input.
 */
export interface SubmissionJournalContext {
  readonly run_id: string;
  readonly batch_id: string;
}

/**
 * The minimum auditable projection. The Proposal is not duplicated wholesale — only the identity
 * needed to correlate the entry and the fields that explain the outcome.
 */
export function decisionPayload(
  proposal: unknown,
  result: DecisionValidationResult,
  context?: SubmissionJournalContext,
): CanonicalObject {
  const identity = identityOf(proposal);
  const payload: Record<string, unknown> = {
    proposal_id: identity.proposal_id,
    decision: identity.decision,
    result: result.kind,
    ...(context === undefined ? {} : { run_id: context.run_id, batch_id: context.batch_id }),
  };

  if (result.kind === "POLICY_REJECTED") payload["reason_code"] = result.reason_code;
  if (result.kind === "BACKEND_INCOMPATIBLE") {
    const { operation_id, role, failure } = result.detail;
    payload["operation_id"] = operation_id;
    payload["role"] = role;
    payload["failure"] = {
      capability: failure.capability,
      requested: failure.requested,
      actual: failure.actual,
      accepted: [...failure.accepted],
      passed: failure.passed,
    };
  }
  return payload as CanonicalObject;
}

/**
 * Best-effort identity for correlation. A Proposal rejected by V1 may carry neither field, and
 * `null` records that honestly instead of inventing a value.
 */
function identityOf(proposal: unknown): {
  proposal_id: string | null;
  decision: string | null;
} {
  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) {
    return { proposal_id: null, decision: null };
  }
  const raw = proposal as Record<string, unknown>;
  return {
    proposal_id: typeof raw["proposal_id"] === "string" ? raw["proposal_id"] : null,
    decision: typeof raw["decision"] === "string" ? raw["decision"] : null,
  };
}
