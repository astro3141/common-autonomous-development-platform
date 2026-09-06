/**
 * Commodity orchestration (TD §7): the `cadpWork` Temporal workflow. Owns continuation and
 * step bounds (`max_steps`, deadline → WORK_BOUND_STOP); NEVER holds credentials or effect
 * authority — every external effect goes through kernel `admit_and_dispatch` inside
 * activities that read durable kernel state before acting (§7.4). Temporal history is never
 * consulted as effect authority.
 */

import { condition, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { ActivityOptions } from "@temporalio/workflow";

import { ACTIVITY_HEARTBEAT_TIMEOUT_MS, KERNEL_ACTIVITY_ATTEMPT_MS, SURFACE_BUDGETS } from "./timeouts.ts";
import type * as activities from "./activities.ts";

export interface WorkArgs {
  vertical: "development" | "record";
  bounds: { max_steps: number; max_effects: number; deadline?: string };
  development?: {
    repo_id: string;
    repo_full_name: string;
    base_ref: string;
    base_sha: string;
    work_item: string;
    worker_product: string;
    review_product?: string;
    require_human_merge: boolean;
  };
  record?: {
    tenant: string;
    resource_prefix: string;
    payloads: string[];
  };
}

export const humanDecisionSignal = defineSignal<[string]>("humanDecision");

import { malformedWorkBounds } from "./workBounds.ts";
export { malformedWorkBounds };

const ACTIVITY_BASE = {
  // Long activities heartbeat; a killed worker is detected within ~30s instead of the full
  // start-to-close timeout, so restart recovery (P4) converges quickly.
  heartbeatTimeout: ACTIVITY_HEARTBEAT_TIMEOUT_MS,
  retry: {
    // Activities converge via durable kernel state reads (get_effect_state), never via blind
    // re-dispatch: the PEP refuses non-admissible ordinals, so retries are safe reads.
    maximumAttempts: 3,
  },
} as const satisfies ActivityOptions;

/**
 * #128: each activity that waits on a model surface runs under ITS operation's attempt budget,
 * strictly above that operation's broker-RPC budget (./timeouts.ts). Before the repair every
 * activity shared one 15-minute budget that was EQUAL to the inner worker budget, so an in-bound
 * long `/implement` had no margin left for the RPC and its response. Exported so the conformance
 * control asserts the ordering over the exact options the workflow proxies with.
 */
export const SURFACE_ACTIVITY_OPTIONS = {
  implementCandidate: { ...ACTIVITY_BASE, startToCloseTimeout: SURFACE_BUDGETS.implement.activity_attempt_ms },
  verifyCandidate: { ...ACTIVITY_BASE, startToCloseTimeout: SURFACE_BUDGETS.verify.activity_attempt_ms },
  reviewCandidate: { ...ACTIVITY_BASE, startToCloseTimeout: SURFACE_BUDGETS.review.activity_attempt_ms },
} as const satisfies Record<string, ActivityOptions>;

/** Kernel-only activities (allocate → seal → evaluate → admit, evidence): no surface wait. */
const acts = proxyActivities<typeof activities>({ ...ACTIVITY_BASE, startToCloseTimeout: KERNEL_ACTIVITY_ATTEMPT_MS });
const implementActs = proxyActivities<typeof activities>(SURFACE_ACTIVITY_OPTIONS.implementCandidate);
const verifyActs = proxyActivities<typeof activities>(SURFACE_ACTIVITY_OPTIONS.verifyCandidate);
const reviewActs = proxyActivities<typeof activities>(SURFACE_ACTIVITY_OPTIONS.reviewCandidate);

export async function cadpWork(args: WorkArgs): Promise<Record<string, unknown>> {
  const memo = workflowInfo().memo as { cadp_effect_id?: string };
  const workRunRef = memo.cadp_effect_id;
  if (workRunRef === undefined) throw new Error("workflow started without cadp_effect_id memo");

  let humanEvidenceId: string | undefined;
  setHandler(humanDecisionSignal, (evidenceId) => {
    humanEvidenceId = evidenceId;
  });

  const trace: Record<string, unknown> = { work_run_ref: workRunRef };

  // #127: fail closed on malformed bounds before the first step. The reference policy already
  // DENIES such a WORK_START; this guard keeps the run bounded under any conforming policy.
  const malformed = malformedWorkBounds(args.bounds);
  if (malformed !== undefined) {
    await acts.submitBoundStop(workRunRef, 0, `MALFORMED_BOUNDS ${malformed}`);
    return { ...trace, stopped: "MALFORMED_BOUNDS", detail: malformed };
  }

  let stepOrdinal = 0;
  let priorStepDigest: string | undefined;

  const nextStep = async (): Promise<number | undefined> => {
    if (args.bounds.deadline !== undefined && Date.now() >= Date.parse(args.bounds.deadline)) {
      await acts.submitBoundStop(workRunRef, stepOrdinal + 1, "DEADLINE", priorStepDigest);
      return undefined;
    }
    if (stepOrdinal + 1 > args.bounds.max_steps) {
      await acts.submitBoundStop(workRunRef, stepOrdinal + 1, "MAX_STEPS", priorStepDigest);
      return undefined;
    }
    stepOrdinal += 1;
    return stepOrdinal;
  };

  if (args.vertical === "record") {
    const record = args.record!;
    let priorEffect: string | undefined;
    const written: Array<Record<string, unknown>> = [];
    for (let index = 0; index < record.payloads.length; index += 1) {
      const step = await nextStep();
      if (step === undefined) return { ...trace, stopped: "BOUND", written };
      const result = await acts.recordWriteStep({
        work_run_ref: workRunRef,
        step_ordinal: step,
        tenant: record.tenant,
        resource_id: `${record.resource_prefix}-${index + 1}`,
        payload: record.payloads[index]!,
        prior_effect_id: priorEffect,
        prior_step_envelope_digest: priorStepDigest,
      });
      if (result.outcome !== "COMMITTED") {
        return { ...trace, stopped: `RECORD_${result.outcome}`, detail: result.detail, written };
      }
      priorEffect = result.effect_id;
      priorStepDigest = result.work_step_envelope_digest;
      written.push({ step, effect_id: result.effect_id, record_ref: result.target_operation_ref });
    }
    return { ...trace, completed: true, written };
  }

  // ---- development vertical ----
  const dev = args.development!;

  // Iterate: implement → push → verify → review; on REQUEST_CHANGES revise once with the
  // reviewer's stated reason (P1: address feedback with a NEW candidate — a new immutable ref).
  let baseSha = dev.base_sha;
  let workItem = dev.work_item;
  let implemented!: Awaited<ReturnType<typeof implementActs.implementCandidate>>;
  let verified!: Awaited<ReturnType<typeof verifyActs.verifyCandidate>>;
  let reviewed!: Awaited<ReturnType<typeof reviewActs.reviewCandidate>>;
  let approved = false;
  for (let round = 1; round <= 2 && !approved; round += 1) {
    const implStep = await nextStep();
    if (implStep === undefined) return { ...trace, stopped: "BOUND" };
    implemented = await implementActs.implementCandidate({
      work_run_ref: workRunRef,
      step_ordinal: implStep,
      repo_full_name: dev.repo_full_name,
      base_sha: baseSha,
      work_item: workItem,
      worker_product: dev.worker_product,
      prior_step_envelope_digest: priorStepDigest,
    });
    priorStepDigest = implemented.work_step_envelope_digest;
    trace["candidate_sha"] = implemented.candidate_sha;

    const pushStep = await nextStep();
    if (pushStep === undefined) return { ...trace, stopped: "BOUND" };
    const pushed = await acts.governedGitPush({
      work_run_ref: workRunRef,
      step_ordinal: pushStep,
      repo_id: dev.repo_id,
      candidate_sha: implemented.candidate_sha,
      bundle_cas_key: implemented.bundle_cas_key,
      prior_step_envelope_digest: priorStepDigest,
    });
    priorStepDigest = pushed.work_step_envelope_digest;
    if (pushed.outcome !== "COMMITTED") return { ...trace, stopped: `PUSH_${pushed.outcome}`, detail: pushed.detail };
    trace["push_effect_id"] = pushed.effect_id;

    const verifyStep = await nextStep();
    if (verifyStep === undefined) return { ...trace, stopped: "BOUND" };
    verified = await verifyActs.verifyCandidate({
      work_run_ref: workRunRef,
      step_ordinal: verifyStep,
      repo_full_name: dev.repo_full_name,
      candidate_sha: implemented.candidate_sha,
      repo_id: dev.repo_id,
      prior_step_envelope_digest: priorStepDigest,
    });
    priorStepDigest = verified.work_step_envelope_digest;
    trace["verification_evidence_id"] = verified.verification_evidence_id;

    const reviewStep = await nextStep();
    if (reviewStep === undefined) return { ...trace, stopped: "BOUND" };
    reviewed = await reviewActs.reviewCandidate({
      work_run_ref: workRunRef,
      step_ordinal: reviewStep,
      repo_full_name: dev.repo_full_name,
      candidate_sha: implemented.candidate_sha,
      repo_id: dev.repo_id,
      work_item: dev.work_item,
      ...(dev.review_product !== undefined ? { review_product: dev.review_product } : {}),
      prior_step_envelope_digest: priorStepDigest,
    });
    priorStepDigest = reviewed.work_step_envelope_digest;
    trace["review_evidence_id"] = reviewed.review_evidence_id;

    approved = reviewed.verdict === "APPROVE" && verified.conclusion === "success";
    if (!approved) {
      baseSha = implemented.candidate_sha;
      workItem = `${dev.work_item}\n\nA reviewer requested changes on the previous candidate with this reason: ${reviewed.reason}. Address the feedback with a minimal follow-up commit.`;
      trace[`round_${round}_verdict`] = `${reviewed.verdict}/${verified.conclusion}`;
    }
  }
  if (!approved) return { ...trace, stopped: "REVIEW_NOT_APPROVED", detail: reviewed.reason };

  const prStep = await nextStep();
  if (prStep === undefined) return { ...trace, stopped: "BOUND" };
  const pr = await acts.governedPrCreate({
    work_run_ref: workRunRef,
    step_ordinal: prStep,
    repo_id: dev.repo_id,
    base_ref: dev.base_ref,
    candidate_sha: implemented.candidate_sha,
    work_item: dev.work_item,
    evidence_refs: [
      verified.verification_evidence_id,
      reviewed.review_evidence_id,
      implemented.backend_evidence_id,
      implemented.work_step_envelope_id,
    ],
    prior_step_envelope_digest: priorStepDigest,
  });
  priorStepDigest = pr.work_step_envelope_digest;
  if (pr.outcome !== "COMMITTED") return { ...trace, stopped: `PR_${pr.outcome}`, detail: pr.detail };
  trace["pr_effect_id"] = pr.effect_id;
  trace["pr_operation_ref"] = pr.target_operation_ref;

  if (dev.require_human_merge) {
    const mergeStep = await nextStep();
    if (mergeStep === undefined) return { ...trace, stopped: "BOUND" };
    // Seal → evaluate → REQUIRE_EVIDENCE(HUMAN_DECISION) → wait for the Human product surface.
    const prepared = await acts.prepareMergeEffect({
      work_run_ref: workRunRef,
      step_ordinal: mergeStep,
      repo_id: dev.repo_id,
      pr_number: pr.pr_number!,
      expected_head_sha: implemented.candidate_sha,
      // The implementer evidence (BACKEND_EXECUTION + WORK_STEP) MUST reach the merge admission:
      // the policy's 8.4/5.3 independence comparison runs over the implementer set visible in the
      // input, and an input without it made the comparison vacuous (12th/13th pilots: a
      // claude-implemented run auto-merged by the claude-product delegate — twice, because only
      // the rule was fixed the first time, not this assembly).
      evidence_refs: [verified.verification_evidence_id, reviewed.review_evidence_id, implemented.backend_evidence_id, implemented.work_step_envelope_id],
      prior_step_envelope_digest: priorStepDigest,
    });
    priorStepDigest = prepared.work_step_envelope_digest;
    trace["merge_effect_id"] = prepared.effect_id;
    if (prepared.requires_human) {
      await condition(() => humanEvidenceId !== undefined);
      const merged = await acts.completeMergeWithHumanDecision({
        effect_id: prepared.effect_id,
        human_evidence_id: humanEvidenceId!,
        evidence_refs: [verified.verification_evidence_id, reviewed.review_evidence_id, implemented.backend_evidence_id, implemented.work_step_envelope_id],
      });
      trace["merge_outcome"] = merged.outcome;
      trace["merge_detail"] = merged.detail;
      // A refused merge is a STOP, never a completion — the first hands-off supervision pilot
      // measured a REFUSED_MAX_EFFECTS_IN_WORK_RUN being reported as completed:true.
      if (merged.outcome !== "COMMITTED") {
        return { ...trace, stopped: `MERGE_${merged.outcome}`, detail: merged.detail };
      }
    }
  }

  return { ...trace, completed: true };
}
