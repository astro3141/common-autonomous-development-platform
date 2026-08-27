/**
 * Building a `ResolvedHumanGateAuthorization` from a durable record (TD §17.3 steps 1–4).
 *
 * The authorization object is never taken on a caller's word: it is projected from a stored
 * PendingHumanDecision, and the projection fails unless the record is genuinely a RESOLVED
 * `HUMAN_GATE_APPROVAL` whose frozen hash still matches its envelope and whose chosen option is
 * `APPROVE`.
 */

import type { ResolvedHumanGateAuthorization } from "../decision/human-gate-revalidation.ts";
import { HumanDecisionError } from "./errors.ts";
import { hashPendingDecision } from "./pending-decision.ts";
import type { PendingDecisionV1 } from "./types.ts";

/** Just enough of a stored record to authorize — no store type is imported. */
export interface TerminalDecisionRecord {
  readonly body: PendingDecisionV1;
  readonly record_hash: string | null;
}

export const APPROVE_OPTION = "APPROVE";

export function resolvedHumanGateAuthorization(
  record: TerminalDecisionRecord,
): ResolvedHumanGateAuthorization {
  const { body, record_hash } = record;

  if (body.status !== "RESOLVED") {
    throw conflict(`decision ${body.decision_id} is ${body.status}, not RESOLVED`);
  }
  if (body.category !== "HUMAN_GATE_APPROVAL") {
    throw conflict(`decision ${body.decision_id} is a ${body.category}, not a Human Gate approval`);
  }
  if (record_hash === null || record_hash !== hashPendingDecision(body)) {
    throw conflict(`decision ${body.decision_id} does not carry a valid terminal record hash`);
  }
  if (body.resolution === null || body.resolution.chosen_option !== APPROVE_OPTION) {
    // A REJECT — or a free-form answer — authorizes nothing.
    throw conflict(`decision ${body.decision_id} was not resolved with ${APPROVE_OPTION}`);
  }
  if (body.gate_proposal === null) {
    throw conflict(`decision ${body.decision_id} carries no approved Proposal`);
  }

  return {
    decision_id: body.decision_id,
    record_hash,
    normalized_gate_proposal: body.gate_proposal,
  };
}

function conflict(detail: string): HumanDecisionError {
  return new HumanDecisionError("DECISION_STATUS_CONFLICT", "/resolution", detail);
}
