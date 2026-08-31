/**
 * The MVP 1 production Coordinator (TD §5.6, §5.6a, §26; MVP1-B13).
 *
 * This is composition, and almost nothing else. Every lifecycle rule already lives in a sealed
 * use-case; what was missing was something that looks at durable state and calls the right one.
 * So the whole module reads as: *what does the store say, and whose job is that?*
 *
 *   **Durable state is the only authority.** There is no cursor, no queue, no in-memory "current
 *   task" and no remembered stage. Destroy this object, build another over the same store, and the
 *   next tick means exactly what it would have meant — which is the property that makes a crash
 *   uninteresting rather than dangerous.
 *
 *   **A tick is one bounded step.** It performs the work durable state already authorises and then
 *   returns. It never loops to completion, never sleeps, never reschedules itself; cadence belongs
 *   to whoever invokes it. Repeated invocation is what converges a run.
 *
 *   **Dispatch, never duplicate.** No guard, transition or binding rule is re-implemented here. If
 *   a lifecycle question has an answer, some other module already owns it.
 *
 * Priority is fixed and deterministic: finish an external operation that has already begun before
 * starting a new one, advance an existing Attempt before asking the Supervisor for more work,
 * settle completion after a task goes terminal, and treat report transport as transport — last,
 * and never as lifecycle authority.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type { ReportAdapter } from "../../adapters/interfaces/report-adapter.ts";
import type { RuntimeAdapter, RuntimePreflight } from "../../adapters/interfaces/runtime-adapter.ts";
import type { RuntimeProfile } from "../../adapters/interfaces/handles.ts";
import type { VerificationAdapter } from "../../adapters/interfaces/verification-adapter.ts";
import type { ManifestSetInput } from "../capability/manifest-set.ts";
import type { ContractSourceReader } from "../contract/types.ts";
import { activateSelectedTask } from "../admission/activate-task.ts";
import {
  completeAutomaticMerge,
  startAutomaticMerge,
} from "../execution/automatic-merge.ts";
import { completeAuditing } from "../execution/complete-auditing.ts";
import { completeVerification } from "../execution/complete-verification.ts";
import {
  applyResolvedMergeApproval,
  observeHumanMerge,
  requestMergeApproval,
} from "../execution/human-merge.ts";
import { startAuditing } from "../execution/start-auditing.ts";
import { startImplementation } from "../execution/start-implementation.ts";
import { startRework } from "../execution/start-rework.ts";
import { ExecutionStartError } from "../execution/start-implementation.ts";
import { startVerification } from "../execution/start-verification.ts";
import {
  requestSupervisorProposal,
  supervisorTurnsIssued,
} from "../execution/supervisor-session.ts";
import { mergeDecisionCause } from "../humandecision/merge-decision.ts";
import type { ProfileSource } from "../profile/types.ts";
import { commitBatchFact, commitParentResume } from "../statemachine/transition-commit.ts";
import { DECISION_VALIDATION_LOG_KIND } from "../decision/decision-log.ts";
import type { TaskAttemptRow, TaskRow } from "../store/domain-types.ts";
import { isTerminalTask } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { TaskSourceV1 } from "../tasksource/types.ts";
import { deliverOneReport } from "./report-delivery.ts";

/**
 * Everything one tick may reach. All interfaces — the Coordinator holds no adapter implementation
 * and no state of its own beyond these references.
 */
export interface ProductionCoordinatorDependencies {
  readonly store: PlatformStore;
  readonly repository: RepositoryAdapter;
  readonly runtime: RuntimeAdapter;
  readonly verification: VerificationAdapter;
  readonly report: ReportAdapter;
  readonly taskSource: TaskSourceV1;
  readonly profiles: ProfileSource;
  readonly contractSources: ContractSourceReader;
  readonly manifests: ManifestSetInput;
  readonly preflight: RuntimePreflight;
  /** Caller-supplied identities and clock — Core allocates neither (TD §17.1, §18.1a). */
  readonly identities: CoordinatorIdentities;
}

/**
 * The Coordinator allocates no identity and reads no clock, so both are supplied. `nextUlid` is
 * called only where a use-case needs a caller-allocated id it cannot derive.
 */
export interface CoordinatorIdentities {
  readonly nextUlid: () => string;
  readonly now: () => string;
  readonly reportChannel: string;
  /** How the Supervisor is run. Deployment configuration, not a Platform-derived value. */
  readonly supervisorRuntimeProfile: RuntimeProfile;
}

/** What one tick did. Diagnostics for the caller; never consulted as authority by anything. */
export type TickStep =
  | "NOTHING_TO_DO"
  | "SUPERVISOR_REQUESTED"
  | "SUPERVISOR_AWAITING_PROPOSAL"
  | "ACTIVATED"
  | "IMPLEMENTATION_STARTED"
  | "VERIFICATION_STARTED"
  | "VERIFICATION_COMPLETED"
  | "AUDIT_STARTED"
  | "AUDIT_COMPLETED"
  | "REWORK_STARTED"
  | "MERGE_APPROVAL_OPENED"
  | "MERGE_APPROVAL_APPLIED"
  | "AUTO_MERGE_STARTED"
  | "AUTO_MERGE_COMPLETED"
  | "MERGE_OBSERVED"
  | "PARENT_RESUMED"
  | "BATCH_WAITING"
  | "BATCH_RESUMED"
  | "BATCH_COMPLETED"
  | "RUN_COMPLETED"
  | "REPORT_DELIVERED"
  | "BLOCKED";

export class ProductionCoordinator {
  readonly #deps: ProductionCoordinatorDependencies;

  constructor(dependencies: ProductionCoordinatorDependencies) {
    this.#deps = dependencies;
  }

  /**
   * One bounded coordination step over one run. Returns what it did so a caller can loop until a
   * condition it cares about; the value carries no authority and nothing durable depends on it.
   */
  tickOnce(run_id: string): TickStep {
    const store = this.#deps.store;
    const run = store.runs.require(run_id);
    if (run.status !== "RUNNING") return this.#deliver();

    for (const batch of store.batches.forRun(run_id)) {
      if (batch.status !== "RUNNING" && batch.status !== "WAITING") continue;

      // Advance whatever is already in flight before asking for anything new.
      for (const task of store.tasks.inBatch(batch.batch_id)) {
        const step = this.#advanceTask(task);
        if (step !== undefined) return step;
      }

      // Nothing to advance: settle completion, then consider asking for more work.
      const completion = this.#settleBatch(batch.batch_id, run_id);
      if (completion !== undefined) return completion;

      const requested = this.#requestProposalIfNeeded(run_id, batch.batch_id);
      if (requested !== undefined) return requested;

      // §20.1 — with nothing to advance and nothing to ask, the batch may be WAITING on people,
      // or a WAITING batch may have become runnable again. The guard owns the condition.
      const waited = this.#settleWaiting(batch.batch_id);
      if (waited !== undefined) return waited;
    }

    // Transport last. It is not lifecycle work and never gates any of the above.
    return this.#deliver();
  }

  /**
   * §21.1 — one pending notification per tick. It runs even for a completed or paused run: the
   * lifecycle being over is exactly when the last summary still needs delivering, and transport
   * has never been a precondition for the fact it describes.
   */
  #deliver(): TickStep {
    const delivered = deliverOneReport({
      store: this.#deps.store,
      report: this.#deps.report,
      now: this.#deps.identities.now,
    });
    return delivered.kind === "DELIVERED" ? "REPORT_DELIVERED" : "NOTHING_TO_DO";
  }

  // --- one task ---------------------------------------------------------------------------------

  /**
   * The whole dispatch table, and it is a table on purpose: each branch names a durable state and
   * the one use-case that owns it. `undefined` means "this task has nothing to do right now".
   */
  #advanceTask(task: TaskRow): TickStep | undefined {
    const store = this.#deps.store;
    if (isTerminalTask(task.platform_state)) return undefined;

    // A task blocked on a person stays blocked — unless the one decision MVP 1 knows how to apply
    // has been answered. Every other category is a safe held endpoint (M1-15).
    if (task.platform_state === "HELD") return this.#applyResolvedMerge(task);

    // MVP 3 (Spec §47) — a suspended parent advances nothing itself; it resumes when every
    // subflow child COMPLETED. A child that failed or deferred leaves the parent suspended for an
    // explicit RESUME_PARENT or human decision — never a guessed resume.
    if (task.platform_state === "SUSPENDED") {
      const children = store.tasks.childrenOf(task.task_key);
      const allComplete =
        children.length > 0 && children.every((child) => child.platform_state === "COMPLETED");
      if (!allComplete) return undefined;
      commitParentResume(store, task.task_key);
      return "PARENT_RESUMED";
    }

    const attempt = store.attempts.current(task.task_key);
    // §26 step 7 — a selected task with no Attempt is waiting to be activated. This has to come
    // *before* requiring an Attempt: activation is precisely the step that creates one.
    if (attempt === undefined) {
      return task.platform_state === "SELECTED" ? this.#activate(task) : undefined;
    }

    switch (attempt.state) {
      case "READY":
        return this.#step(startImplementation(this.#deps, { attempt_key: attempt.attempt_key }), {
          IMPLEMENTING: "IMPLEMENTATION_STARTED",
        });
      case "IMPLEMENTING":
        return this.#step(startVerification(this.#deps, { attempt_key: attempt.attempt_key }), {
          VERIFYING: "VERIFICATION_STARTED",
        });
      case "VERIFYING":
        return this.#completeVerification(attempt);
      case "AUDITING":
        return this.#completeAudit(attempt);
      case "REWORKING":
        return this.#step(startRework(this.#deps, { attempt_key: attempt.attempt_key }), {
          IMPLEMENTING: "REWORK_STARTED",
        });
      case "READY_TO_MERGE":
        // Spec §67 — the automatic path exists only where the frozen policy enables it; every
        // other run keeps MVP 1's mandatory human decision. Reading the flag is not a policy
        // judgement: the Gate re-judges everything itself.
        return store.batchView.compiledProfileFor(task.batch_id).effective.policy.auto_merge ===
          true
          ? this.#startAutoMerge(attempt)
          : this.#openMergeApproval(task, attempt);
      case "MERGING":
        return this.#completeAutoMerge(attempt);
      case "APPROVED_FOR_MANUAL_MERGE":
        return this.#observeMerge(attempt);
      default:
        return undefined;
    }
  }

  /**
   * §26 step 7 — activation, dispatched and nothing more.
   *
   * Every rule it applies is the use-case's: the M1-7 selection-binding equality gate, the M1-6
   * repository-scope resolution from the batch-bound Compiled Profile, the §12.7 compatibility
   * recheck, both Grants, the contract snapshot and the transition. The Coordinator supplies only
   * the two things a caller must: the identities Core will not allocate for itself, and the bytes
   * of the Contract Sources the frozen profile declares — read through the same M1-11 seam §11
   * already uses, so there is one reader rather than two.
   *
   * The identities are allocated per attempt at activation. That is safe because the whole
   * activation is one transaction: until it commits nothing durable refers to them, and once it
   * commits the Attempt exists, so this branch is never reached again for that task.
   */
  #activate(task: TaskRow): TickStep | undefined {
    const store = this.#deps.store;
    const compiled = store.batchView.compiledProfileFor(task.batch_id);
    const contract_sources = compiled.effective.project.contract_sources.map((entry) => {
      const read = this.#deps.contractSources.read_contract_source(entry.path);
      if (read.kind === "ABSENT") {
        // A declared source that is not there cannot be frozen into a contract. The use-case's own
        // capture would refuse it too; failing here keeps the refusal a read failure, not a build
        // failure with a half-assembled input.
        throw new ExecutionStartError(`declared contract source ${entry.path} is missing`);
      }
      return { path: entry.path, bytes: read.bytes };
    });

    const outcome = activateSelectedTask(this.#deps, {
      task_key: task.task_key,
      snapshot_id: this.#deps.identities.nextUlid(),
      actor_grant_id: this.#deps.identities.nextUlid(),
      auditor_grant_id: this.#deps.identities.nextUlid(),
      contract_sources,
    });
    // `SELECTION_STALE` and `BACKEND_INCOMPATIBLE` are durable states the use-case already
    // committed. Neither is retried here with different material.
    return outcome.kind === "ACTIVATED" ? "ACTIVATED" : "BLOCKED";
  }

  /**
   * B9's completion is a two-step: a run that is still going changes nothing, and a completed one
   * is either eligible for the Auditor or not. Only the eligible case starts something external.
   */
  #completeVerification(attempt: TaskAttemptRow): TickStep | undefined {
    const outcome = completeVerification(this.#deps, { attempt_key: attempt.attempt_key });
    if (outcome.kind === "RUNNING") return undefined;
    if (outcome.kind !== "GATE_PASSED") return "BLOCKED";

    const launched = startAuditing(this.#deps, {
      attempt_key: attempt.attempt_key,
      decision_id: this.#deps.identities.nextUlid(),
      report_channel: this.#deps.identities.reportChannel,
    });
    return launched.kind === "AUDITING" ? "AUDIT_STARTED" : "BLOCKED";
  }

  #completeAudit(attempt: TaskAttemptRow): TickStep | undefined {
    const outcome = completeAuditing(this.#deps, {
      attempt_key: attempt.attempt_key,
      audit_id: this.#deps.identities.nextUlid(),
      decision_id: this.#deps.identities.nextUlid(),
      report_channel: this.#deps.identities.reportChannel,
      recorded_at: this.#deps.identities.now(),
    });
    switch (outcome.kind) {
      case "TURN_UNOBSERVABLE":
        return undefined;
      case "AUDIT_DECIDED":
      case "AUDIT_RETRY_STARTED":
        return "AUDIT_COMPLETED";
      default:
        return "BLOCKED";
    }
  }

  // --- automatic merge (MVP 2 Repository Gate) ----------------------------------------------------

  #startAutoMerge(attempt: TaskAttemptRow): TickStep | undefined {
    const outcome = startAutomaticMerge(this.#deps, {
      attempt_key: attempt.attempt_key,
      decision_id: this.#deps.identities.nextUlid(),
      report_channel: this.#deps.identities.reportChannel,
    });
    return outcome.kind === "MERGING" ? "AUTO_MERGE_STARTED" : "BLOCKED";
  }

  #completeAutoMerge(attempt: TaskAttemptRow): TickStep | undefined {
    const outcome = completeAutomaticMerge(this.#deps, { attempt_key: attempt.attempt_key });
    return outcome.kind === "MERGED" ? "AUTO_MERGE_COMPLETED" : "BLOCKED";
  }

  // --- human merge (B12 composition) --------------------------------------------------------------

  #openMergeApproval(task: TaskRow, attempt: TaskAttemptRow): TickStep | undefined {
    const outcome = requestMergeApproval(this.#deps, {
      attempt_key: attempt.attempt_key,
      decision_id: this.#deps.identities.nextUlid(),
      report_channel: this.#deps.identities.reportChannel,
    });
    void task;
    return outcome.kind === "MERGE_APPROVAL_OPEN" ? "MERGE_APPROVAL_OPENED" : undefined;
  }

  /**
   * The one resolved-decision category MVP 1 applies. Everything else — `AUDIT_DECISION`,
   * `REATTEMPT_DECISION`, `CONTRACT_DECISION`, `RECOVERY_DECISION` — is left exactly where it is:
   * the durable record is the answer to a question MVP 1 has no contract for resuming, and
   * guessing one would be inventing a lifecycle rule the TD does not define.
   */
  #applyResolvedMerge(task: TaskRow): TickStep | undefined {
    const store = this.#deps.store;
    for (const record of store.pendingDecisions.forSubject(task.task_key)) {
      const decision = record.body;
      if (decision.category !== "MERGE_APPROVAL" || decision.status !== "RESOLVED") continue;
      if (decision.resolution?.applied_transition_ref !== null) continue;
      // A resolved approval whose provenance does not read is not one this path can apply.
      if (mergeDecisionCause(decision) === undefined) continue;

      const outcome = applyResolvedMergeApproval(this.#deps, {
        decision_id: decision.decision_id,
        follow_up_decision_id: this.#deps.identities.nextUlid(),
        report_channel: this.#deps.identities.reportChannel,
      });
      return outcome.kind === "APPROVED_FOR_MANUAL_MERGE" ? "MERGE_APPROVAL_APPLIED" : "BLOCKED";
    }
    return undefined;
  }

  #observeMerge(attempt: TaskAttemptRow): TickStep | undefined {
    const outcome = observeHumanMerge(this.#deps, {
      attempt_key: attempt.attempt_key,
      decision_id: this.#deps.identities.nextUlid(),
      report_channel: this.#deps.identities.reportChannel,
    });
    switch (outcome.kind) {
      case "MERGED":
        return "MERGE_OBSERVED";
      case "MERGE_MISMATCH":
        return "BLOCKED";
      default:
        return undefined;
    }
  }

  // --- completion --------------------------------------------------------------------------------

  /**
   * §20.2's own condition decides whether the batch is finished — the guard owns it, and this only
   * asks. Run completion follows immediately for MVP 1's single batch (§20, M1-15), through the
   * existing `platform_run.status` projection: no new fact, framework, state or table.
   */
  #settleBatch(batch_id: string, run_id: string): TickStep | undefined {
    const store = this.#deps.store;
    const batch = store.batches.require(batch_id);
    if (batch.status !== "RUNNING") return undefined;

    try {
      commitBatchFact(store, {
        batch_id,
        fact: { kind: "EVALUATE_COMPLETION" },
        within: (_transition, outcome) => {
          if (outcome.batch_state !== "COMPLETED") return;
          // §20.2 — exactly one summary, enqueued with the completion it describes.
          store.outbox.enqueue({
            op_key: `op:${batch_id}:report-batch:complete`,
            channel: this.#deps.identities.reportChannel,
            payload: { event: "BATCH_COMPLETE", batch_id, run_id } as never,
          });
          // §20 / M1-15 — MVP 1 has one batch, so its completion completes the run. The existing
          // status projection owns this: no new fact, framework, state or table.
          const remaining = store.batches
            .forRun(run_id)
            .filter((other) => other.batch_id !== batch_id)
            .some((other) => other.status !== "COMPLETED" && other.status !== "FAILED");
          if (!remaining) store.runs.setStatus(run_id, "COMPLETED");
        },
      });
    } catch {
      // §20.2 does not hold yet. That is an ordinary answer, not a failure.
      return undefined;
    }
    return store.runs.require(run_id).status === "COMPLETED" ? "RUN_COMPLETED" : "BATCH_COMPLETED";
  }

  /**
   * §20.1 — WAITING and its resumption, judged by the guard from durable counts. The Coordinator
   * supplies only `safe_independent_runnable_exists`: whether admission is open and an undecided
   * candidate exists (Spec §48's Hold-and-Continue judgement, kept deliberately simple).
   */
  #settleWaiting(batch_id: string): TickStep | undefined {
    const store = this.#deps.store;
    const batch = store.batches.require(batch_id);
    const safe =
      !batch.admission_closed &&
      store.tasks.inBatch(batch_id).some((task) => task.platform_state === "DISCOVERED");

    try {
      if (batch.status === "RUNNING") {
        commitBatchFact(store, {
          batch_id,
          fact: { kind: "EVALUATE_WAITING", safe_independent_runnable_exists: safe },
        });
        return "BATCH_WAITING";
      }
      if (batch.status === "WAITING") {
        commitBatchFact(store, {
          batch_id,
          fact: { kind: "RESUME", safe_independent_runnable_exists: safe },
        });
        return "BATCH_RESUMED";
      }
    } catch {
      // The §20.1 condition does not hold in this direction. An ordinary answer, not a failure.
    }
    return undefined;
  }

  // --- supervisor --------------------------------------------------------------------------------

  /**
   * §26 step 4 — ask for a Proposal when there is nothing else to do and something still needs
   * deciding. The turn's own reply is never read here: a Proposal arrives through the Platform API
   * or it does not arrive at all (§13.4, I-TD3).
   */
  #requestProposalIfNeeded(run_id: string, batch_id: string): TickStep | undefined {
    const store = this.#deps.store;
    const batch = store.batches.require(batch_id);
    if (batch.status !== "RUNNING" || batch.admission_closed) return undefined;
    const undecided = store.tasks
      .inBatch(batch_id)
      .some((task) => task.platform_state === "DISCOVERED");
    if (!undecided) return undefined;

    // MVP 3 pacing — a next turn is requested only when the previous one has been answered (a
    // Proposal was validated, whatever its verdict) and a concurrency slot is actually free, so a
    // turn is never spent on work V11 would refuse. Both inputs are durable: the turn operations
    // and the `decision_validation` journal. There is still no `WAITING_FOR_PROPOSAL` state.
    const turns = supervisorTurnsIssued(store, batch_id);
    const answered = store.decisions.countByKind(DECISION_VALIDATION_LOG_KIND);
    if (turns > answered) return "SUPERVISOR_AWAITING_PROPOSAL";
    const view = store.batchView.project(batch_id);
    const policy = store.batchView.compiledProfileFor(batch_id).effective.policy.batch_policy;
    if (view.active_task_count >= policy.concurrency) return undefined;

    // §13.5 / §7.1d — a v2 Compiled Profile freezes the Supervisor's binding; only a v1 profile
    // may fall back to the deployment's configured value, and a production unattended composition
    // is expected to be v2 (the fallback exists for v1 worlds, not as a second authority).
    const project = store.batchView.compiledProfileFor(batch_id).effective.project;
    const boundProfile =
      project.supervisor_profile === undefined
        ? undefined
        : project.roles[project.supervisor_profile]?.runtime_profile;
    const configured = this.#deps.identities.supervisorRuntimeProfile;
    const outcome = requestSupervisorProposal(this.#deps, {
      run_id,
      batch_id,
      decision_context: this.#decisionContext(batch_id),
      runtime_profile: (boundProfile ?? configured) as typeof configured,
    });
    switch (outcome.kind) {
      case "REQUESTED":
        return "SUPERVISOR_REQUESTED";
      case "INDETERMINATE":
        return "BLOCKED";
      default:
        return "BLOCKED";
    }
  }

  /**
   * §13.4 — the fresh read model one request is about. Platform-owned projections only: no adapter
   * handle, no runtime identity, nothing a backend would recognise as its own.
   */
  #decisionContext(batch_id: string) {
    const store = this.#deps.store;
    const batch = store.batches.require(batch_id);
    return {
      batch_id,
      compiled_profile_hash: batch.compiled_profile_hash,
      candidates: store.tasks
        .inBatch(batch_id)
        .filter((task) => task.platform_state === "DISCOVERED")
        .map((task) => ({
          task_ref: task.external_task_ref,
          external_state: task.external_snapshot.external_state,
          version: task.external_snapshot.version,
        })),
      open_decisions: store.pendingDecisions
        .openFor(batch_id)
        .map((record) => record.body.category),
    } as never;
  }

  /** Maps a use-case outcome onto a tick step without interpreting it as lifecycle authority. */
  #step<Outcome extends { kind: string }>(
    outcome: Outcome,
    onSuccess: Readonly<Record<string, TickStep>>,
  ): TickStep {
    return onSuccess[outcome.kind] ?? "BLOCKED";
  }
}
