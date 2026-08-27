/**
 * Human Gate → PendingHumanDecision construction (TD §17.2a, M0-31).
 *
 * The Batch 7 public result stays exactly `HUMAN_GATE_REQUIRED`: nothing here reopens it. The
 * gate predicate itself is *reused* from `core/decision`, so Rule A / Rule B are recomputed from
 * the Proposal and the Compiled Profile rather than smuggled through a new result field.
 *
 * The question and the options are Core-owned and deterministic — a model utterance never becomes
 * the thing a human is asked to authorize (I-TD3).
 */

import { effectiveDisposition, requiresHumanGate } from "../decision/decision-authority.ts";
import type { ProposalV1 } from "../decision/types.ts";
import type { CompiledProfileV1Body } from "../profile/types.ts";
import { decisionInvalid } from "./errors.ts";
import { computeDedupKey, normalizePendingDecision } from "./pending-decision.ts";
import type { BlockingScope, PendingDecisionSubject, PendingDecisionV1 } from "./types.ts";

/** The two answers a Human Gate offers, in this order. */
export const HUMAN_GATE_OPTIONS: readonly string[] = ["APPROVE", "REJECT"];

/** Reuses the Batch 7 gate predicate; no new gate logic is written here. */
export function isHumanGateRequired(
  proposal: ProposalV1,
  compiledProfile: CompiledProfileV1Body,
): boolean {
  const policy = compiledProfile.effective.policy;
  const disposition =
    proposal.variant === "TASK_SELECTION"
      ? effectiveDisposition(policy, proposal.classification)
      : undefined;
  return requiresHumanGate(proposal, policy, disposition);
}

export interface HumanGateRequestInput {
  /** Caller-supplied ULID — Core allocates no identity (TD §17.1). */
  readonly decision_id: string;
  readonly proposal: ProposalV1;
  /** Required for a task-bearing Proposal. */
  readonly task_key?: string;
  /** Required for `CLOSE_BATCH`. */
  readonly batch_id?: string;
  readonly blocking_scope?: BlockingScope;
  readonly evidence_refs?: readonly string[];
}

/**
 * Builds the OPEN record for a gated Proposal. Deterministic: the same normalized input always
 * produces a byte-identical record.
 */
export function buildHumanGateDecision(input: HumanGateRequestInput): PendingDecisionV1 {
  const subject = gateSubject(input);
  const created_from = `proposal:${input.proposal.proposal_id}`;
  const blocking_scope = input.blocking_scope ?? (subject.kind === "TASK" ? "TASK_ONLY" : "BATCH");

  return normalizePendingDecision({
    decision_id: input.decision_id,
    subject,
    status: "OPEN",
    category: "HUMAN_GATE_APPROVAL",
    question: gateQuestion(input.proposal),
    options: [...HUMAN_GATE_OPTIONS],
    recommendation: null,
    blocking_scope,
    evidence_refs: [...(input.evidence_refs ?? [])],
    dedup_key: computeDedupKey(subject, "HUMAN_GATE_APPROVAL", created_from),
    created_from,
    gate_proposal: input.proposal,
    resolution: null,
  } as unknown);
}

/**
 * Core-owned presentation. Exact wording is an implementation detail; determinism is not — the
 * same Proposal must always render the same string.
 */
export function gateQuestion(proposal: ProposalV1): string {
  return `Approve ${proposal.decision} proposed as ${proposal.proposal_id}?`;
}

function gateSubject(input: HumanGateRequestInput): PendingDecisionSubject {
  if (input.proposal.variant === "BATCH_CONTROL") {
    if (input.batch_id === undefined) {
      throw decisionInvalid("/subject", "a CLOSE_BATCH gate needs the batch it applies to");
    }
    // A taskless decision takes a BATCH subject; it never borrows a placeholder task_key.
    return { kind: "BATCH", batch_id: input.batch_id };
  }
  if (input.task_key === undefined) {
    throw decisionInvalid("/subject", "a task-bearing gate needs the task it applies to");
  }
  return { kind: "TASK", task_key: input.task_key };
}
