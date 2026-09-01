/**
 * Production Proposal submission and task admission (TD §5.1, §5.4, §17.3, §19.3, §26 step 5–7).
 *
 * This is the front half of the MVP 1 control plane and nothing more:
 *
 *     Proposal + fresh authoritative facts → V1–V11 → ACCEPTED → DISCOVERED→SELECTED
 *
 * Two boundaries are load-bearing here.
 *
 * *Transport.* The Supervisor reaches the Platform over MCP (TD M1-3), but MCP is transport: what
 * the Platform owns is a routing context plus a structured Proposal. So this module is a plain
 * callable service — no server, no socket, no SDK — and a transport binds to it later. A
 * `RuntimeTurnResult` is never a Proposal source; the Proposal arrives as typed input.
 *
 * *Authority.* The validator decides whether a Proposal is admissible; the state machine decides
 * whether the transition is legal. An `ACCEPTED` result does not license a mutation — the
 * commit-time durable guard runs again inside the transition transaction and stays the final
 * word, so a batch that filled up between validation and commit still fails closed.
 */

import { decisionPayload, DECISION_VALIDATION_LOG_KIND } from "../decision/decision-log.ts";
import { validateDecisionAfterResolvedHumanGate } from "../decision/human-gate-revalidation.ts";
import type { DecisionValidationResult, ProposalV1 } from "../decision/types.ts";
import { validateAndRecordDecision } from "../decision/decision-log.ts";
import { buildHumanGateDecision } from "../humandecision/gate-request.ts";
import { resolvedHumanGateAuthorization } from "../humandecision/gate-authorization.ts";
import {
  commitAdmission,
  commitPendingDecision,
  commitTaskDeferral,
} from "../statemachine/transition-commit.ts";
import { resumeParentIfEligible } from "../execution/subflow-resume.ts";
import { commitMaterializationIntent } from "../materialization/materialize-child.ts";
import { sealMaterializationSnapshot } from "../materialization/snapshot.ts";
import { hashTaskDefinitionBody } from "../tasksource/task-definition.ts";
import type { TaskDependency } from "../tasksource/types.ts";
import { AdmissionError } from "./errors.ts";
import { evaluateHardDependencies } from "./dependency-admission.ts";
import {
  assembleDecisionInput,
  type AssembledDecision,
  type DecisionAuthorities,
  type SubmissionContext,
} from "./fact-assembly.ts";

export interface SubmitProposalCommand extends SubmissionContext {
  /** Caller-controlled observation time; nothing here reads a clock (TD §8.4, §19.3). */
  readonly observed_at: string;
  /** Caller-allocated ULID, required only if the Human Gate branch opens (TD §17.1). */
  readonly decision_id?: string;
  /** Opaque report channel for the pending-decision notification (TD §21.1). */
  readonly report_channel?: string;
}

export interface ProposalSubmissionResult {
  readonly result: DecisionValidationResult;
  /** `decision_log.seq` of the `decision_validation` entry this submission produced. */
  readonly validation_seq: number;
  readonly task_key: string | null;
  /** True only when `DISCOVERED→SELECTED` actually committed. */
  readonly admitted: boolean;
  /** `decision_log.seq` of the separate `state_transition` entry, when one happened. */
  readonly transition_seq: number | null;
  readonly pending_decision_id: string | null;
  /** Fresh direct dependencies observed for a selection. Reported, never persisted. */
  readonly observed_dependencies: readonly TaskDependency[];
}

/**
 * One submission: assemble fresh facts, validate, journal the outcome, and act on it.
 *
 * The only stateful outcome is `START_TASK` admission. Every other decision type is validated and
 * reported but not executed — their lifecycle orchestration belongs to later batches, and wiring
 * a general dispatcher here would quietly create a control plane this batch has not specified.
 */
export function submitProposal(
  authorities: DecisionAuthorities,
  command: SubmitProposalCommand,
): ProposalSubmissionResult {
  const assembled = assembleDecisionInput(authorities, command);
  const recorded = validateAndRecordDecision(authorities.store.decisions, assembled.input, {
    run_id: command.run_id,
    batch_id: command.batch_id,
  });

  return act(authorities, command, assembled, recorded.result, recorded.entry.seq);
}

/**
 * TD §17.3 — a resolved Human Gate is re-run through the *whole* validator against facts read
 * again now. The approval satisfies V7 for exactly the Proposal frozen in the resolved record;
 * V1–V6 and V8–V11 are fresh, so an approval that arrives after the repository moved, the
 * Backend weakened or the task drifted is rejected on those steps rather than honoured.
 */
export function resolveHumanGateAndAdmit(
  authorities: DecisionAuthorities,
  command: {
    readonly run_id: string;
    readonly batch_id: string;
    readonly decision_id: string;
    readonly observed_at: string;
  },
): ProposalSubmissionResult {
  const stored = authorities.store.pendingDecisions.require(command.decision_id);
  const authorization = resolvedHumanGateAuthorization({
    body: stored.body,
    record_hash: stored.record_hash,
  });

  // The approved Proposal is the submission input; the facts around it are read from scratch.
  const assembled = assembleDecisionInput(authorities, {
    run_id: command.run_id,
    batch_id: command.batch_id,
    proposal: wireForm(authorization.normalized_gate_proposal),
  });
  const result = validateDecisionAfterResolvedHumanGate(assembled.input, authorization);

  // Same journal convention as the ordinary path — one `decision_validation` entry per outcome.
  const entry = authorities.store.decisions.append({
    kind: DECISION_VALIDATION_LOG_KIND,
    refKey: authorization.normalized_gate_proposal.proposal_id,
    payload: decisionPayload(assembled.input.proposal, result, {
      run_id: command.run_id,
      batch_id: command.batch_id,
    }),
  });

  return act(
    authorities,
    { ...command, proposal: authorization.normalized_gate_proposal },
    assembled,
    result,
    entry.seq,
    command.decision_id,
  );
}

/**
 * The frozen record stores the *normalized* Proposal, whose `variant` the parser derived. V1
 * accepts only the wire form, so the derived field is dropped again here. This is the parser's
 * own inverse — no Proposal field is added, removed or reinterpreted (TD §9.1).
 */
function wireForm(proposal: ProposalV1): Record<string, unknown> {
  const { variant: _derived, ...wire } = proposal;
  return wire;
}

// --- outcome handling ----------------------------------------------------------------

function act(
  authorities: DecisionAuthorities,
  command: SubmitProposalCommand,
  assembled: AssembledDecision,
  result: DecisionValidationResult,
  validation_seq: number,
  resolvedDecisionId?: string,
): ProposalSubmissionResult {
  const base = {
    result,
    validation_seq,
    task_key: assembled.task_key,
    admitted: false,
    transition_seq: null,
    pending_decision_id: null,
    observed_dependencies: assembled.dependencies,
  } satisfies ProposalSubmissionResult;

  const proposal = assembled.proposal;

  // POLICY_REJECTED and BACKEND_INCOMPATIBLE change nothing at all: no transition, no Contract,
  // no Grant, no Attempt, no external call. TD §26's "ask the Supervisor again" needs a Runtime,
  // which this batch does not have, so the result is simply returned to the caller.
  if (result.kind === "POLICY_REJECTED" || result.kind === "BACKEND_INCOMPATIBLE") return base;

  if (result.kind === "HUMAN_GATE_REQUIRED") {
    if (proposal === null) return base;
    if (command.decision_id === undefined || command.report_channel === undefined) {
      throw new AdmissionError(
        "SUBMISSION_INPUT_INCOMPLETE",
        "/decision_id",
        "a Human Gate branch needs a caller-allocated decision_id and a report channel",
      );
    }

    // §17.2 — the existing dedup key is deterministic over (subject, category, created_from), so
    // resubmitting the same Proposal finds the OPEN record instead of opening a second one.
    // §9.2b (D24) — an F gate's subject is the exact parent the materialisation intent names.
    const decision = buildHumanGateDecision({
      decision_id: command.decision_id,
      proposal,
      ...(proposal.variant === "SUBFLOW_CHILD_MATERIALIZATION"
        ? { task_key: proposal.parent.task_key }
        : assembled.task_key === null
          ? {}
          : { task_key: assembled.task_key }),
      ...(proposal.variant === "BATCH_CONTROL" ? { batch_id: assembled.batch.batch_id } : {}),
    });
    const existing = authorities.store.pendingDecisions.byDedupKey(decision.dedup_key);
    if (existing !== undefined) {
      return { ...base, pending_decision_id: existing.body.decision_id };
    }

    const opened = commitPendingDecision(authorities.store, {
      decision,
      channel: command.report_channel,
    });
    // §17.3 (D24) — the gate's TASK subject is the F parent, so `commitPendingDecision` above
    // already parked it HELD(BLOCKED_BY_DECISION:<id>), freezing the tagged origin the approval
    // must later restore. Zero snapshot/INTENT/external effect exists yet.
    return { ...base, pending_decision_id: opened.decision_id };
  }

  // ACCEPTED. Selection decisions admit; MVP 3 also applies DEFER_TASK and RESUME_PARENT.
  // HOLD_TASK and CLOSE_BATCH-adjacent control remain reported-without-lifecycle: the TD defines
  // no held-reason vocabulary for a Supervisor-initiated hold, and inventing one is not this
  // module's authority.
  if (proposal === null) return base;

  if (proposal.decision === "DEFER_TASK" && assembled.task_key !== null) {
    // TD §19.3 — DEFERRED is entered only before selection, from a validated DEFER_TASK.
    const deferred = commitTaskDeferral(authorities.store, assembled.task_key);
    return { ...base, transition_seq: deferred.transition.seq };
  }

  if (proposal.decision === "RESUME_PARENT" && assembled.task_key !== null) {
    // §19.5.3 (D22) — the Proposal's V5 PASS is *not* resume authority. Normal resume is owned by
    // the deterministic eligibility predicate; this validated request only causes it to be
    // re-observed now. When the predicate does not hold, nothing moves and the refusal is a
    // durable observation — bypassing it takes a §17.4-mapped RECOVERY_DECISION or an approved
    // operator action, never a Supervisor Proposal.
    const outcome = resumeParentIfEligible(authorities.store, assembled.task_key);
    if (outcome.kind === "RESUMED") {
      return { ...base, transition_seq: outcome.transition_seq };
    }
    authorities.store.decisions.append({
      kind: "resume_predicate_not_met",
      refKey: assembled.task_key,
      payload: { reason: outcome.reason } as never,
    });
    return base;
  }

  // §8.4b (D24) — an accepted F freezes the validated semantics and the write-ahead INTENT in
  // one transaction. The adapter call is the Coordinator's next bounded step, never this one; F
  // acceptance is not admission and no state transition happens here.
  if (proposal.variant === "SUBFLOW_CHILD_MATERIALIZATION") {
    const compiled = authorities.store.batchView.compiledProfileFor(assembled.batch.batch_id);
    const sourceEntry = compiled.effective.project.task_sources.find(
      (entry) => entry.child_materializer !== undefined,
    );
    if (sourceEntry === undefined) return base;
    const body = proposal.child.task_definition_body;
    const sealed = sealMaterializationSnapshot({
      materialization_id: proposal.proposal_id,
      batch_id: assembled.batch.batch_id,
      compiled_profile_hash: assembled.batch.compiled_profile_hash,
      task_source_id: sourceEntry.id,
      parent_intent: proposal.parent,
      child_definition_body: body as never,
      child_definition_hash: hashTaskDefinitionBody(body as never),
      reason_refs: proposal.reason_refs,
    });
    const committed = commitMaterializationIntent(authorities.store, {
      sealed,
      ...(resolvedDecisionId === undefined
        ? {}
        : {
            resolved_decision_id: resolvedDecisionId,
            restore_parent_origin:
              proposal.parent.kind === "DISCOVERED_TASK" ? ("DISCOVERED" as const) : ("ACTIVE" as const),
          }),
    });
    return { ...base, transition_seq: committed.transition.seq };
  }

  if (proposal.variant !== "TASK_SELECTION" && proposal.variant !== "SUBFLOW_SELECTION") return base;
  if (assembled.task_key === null) return base;

  // TD §8.4a — computed as late as possible, from this invocation's own fresh observations, and
  // recomputed on the resolved-gate path too: a human approval does not carry a dependency fact.
  const { hard_dependencies_clear } = evaluateHardDependencies({
    store: authorities.store,
    taskSource: authorities.taskSource,
    project_id: assembled.run.project_id,
    dependencies: assembled.dependencies,
  });

  if (assembled.selection_basis === null) {
    throw new AdmissionError(
      "SUBMISSION_INPUT_INCOMPLETE",
      "/selection_basis",
      "an accepted selection must carry the authoritative facts it was validated against",
    );
  }

  // §19.5.1 — an E admission carries the Proposal's exact parent observation into the commit,
  // where the transaction re-reads and re-checks it against current durable rows. Child
  // selection, parent suspension and the relation land together or not at all.
  const admitted = commitAdmission(authorities.store, {
    task_key: assembled.task_key,
    hard_dependencies_clear,
    repository_scope_id: proposal.repository_scope_id,
    selection_binding: assembled.selection_basis,
    selection: {
      classification: proposal.classification,
      pipeline_id: proposal.pipeline_id,
      actor_profile: proposal.actor_profile,
      verification_profile: proposal.verification_profile,
    },
    admitted_at: command.observed_at,
    ...(resolvedDecisionId === undefined ? {} : { resolved_decision_id: resolvedDecisionId }),
    ...(proposal.variant === "SUBFLOW_SELECTION" ? { subflow_parent: proposal.parent } : {}),
  });

  return { ...base, admitted: true, transition_seq: admitted.transition.seq };
}
